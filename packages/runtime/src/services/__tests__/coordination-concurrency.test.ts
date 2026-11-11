/**
 * M3 coordination concurrency tests — per-session serialization under
 * simultaneous mentions, duplicate suppression, restart recovery
 * (spec §14 M3).
 *
 * Deterministic + hermetic: `:memory:` / tmp-file SQLite + FakeHarness, no
 * network, no model inference, no billed calls.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwarmStore } from "../../db/store.js";
import { ProtocolError } from "@opencode-swarm/protocol";
import { WakeQueue } from "../wake-queue.js";
import { WakeDispatcher, type DispatchHarness } from "../wake-dispatcher.js";
import { InboxReconciler } from "../inbox-reconciler.js";
import { publishPost } from "../board-service.js";
import { createTask, publishReady, leaseNext } from "../task-scheduler.js";
import { steerWorkerDirect } from "../lead-autonomy.js";
import { getRoster } from "../roster.js";

type Reason = "mention" | "assigned_task" | "verifier_request" | "monitor_intervention" | "user_direct";

class FakeHarness implements DispatchHarness {
  submitted: string[] = [];
  liveSessions = new Set<string>();

  async submitTurn(request: {
    readonly sessionId: string;
    readonly text: string;
    readonly delivery: "queue";
    readonly externalId: string;
    readonly reason: Reason;
  }): Promise<{ readonly externalId: string; readonly admittedAt: string; readonly transportNote: string }> {
    this.submitted.push(request.externalId);
    return { externalId: request.externalId, admittedAt: new Date().toISOString(), transportNote: "fake-queue-admit" };
  }

  async getSession(sessionId: string): Promise<{
    readonly hasLiveExecution: boolean;
    readonly knownTerminalExternalIds: readonly string[];
  }> {
    return { hasLiveExecution: this.liveSessions.has(sessionId), knownTerminalExternalIds: [] };
  }
}

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort (Windows WAL unlock race; tmp reaped by the OS) */
  }
}

const MODEL = { providerID: "p", id: "m" };

function setupSwarm(store: SwarmStore) {
  const swarm = store.createSwarm({
    title: "M3 concurrency gate",
    coordinatorSessionId: "sess-lead",
    projectRoot: "/tmp/m3c",
    mode: "parity",
  });
  const lead = store.addMember(swarm.id, {
    name: "lead", role: "coordinator", nativeAgentId: "agent-lead", sessionId: "sess-lead", model: MODEL,
  });
  const coderA = store.addMember(swarm.id, {
    name: "coder-a", role: "coder", nativeAgentId: "agent-a", sessionId: "sess-a", model: MODEL,
  });
  const coderB = store.addMember(swarm.id, {
    name: "coder-b", role: "coder", nativeAgentId: "agent-b", sessionId: "sess-b", model: MODEL,
  });
  return { swarm, lead, coderA, coderB };
}

function store2Settled(store: SwarmStore, swarmId: string): number {
  return store.listUnsettledWakes(swarmId, 100).length;
}

describe("M3 simultaneous mentions", () => {
  test("back-to-back mentions to two members: gapless sequences, one wake each, parallel sessions both dispatch", async () => {
    const store = new SwarmStore(":memory:");
    try {
      const { swarm, lead } = setupSwarm(store);
      const harness = new FakeHarness();
      const dispatcher = new WakeDispatcher(store, harness);
      const r1 = publishPost(store, {
        swarmId: swarm.id, authorMemberId: lead.id, kind: "brief",
        body: "@coder-a task one", idempotencyKey: "cc-1",
      });
      const r2 = publishPost(store, {
        swarmId: swarm.id, authorMemberId: lead.id, kind: "brief",
        body: "@coder-b task two", idempotencyKey: "cc-2",
      });
      expect([r1.post.sequence, r2.post.sequence]).toEqual([1, 2]);
      const queued = store.listWakes(swarm.id, "queued");
      expect(queued.length).toBe(2);
      expect(new Set(queued.map((w) => w.memberId)).size).toBe(2);
      // Distinct members = distinct sessions: both dispatch (per-session serialization).
      const results = await dispatcher.dispatchAll(swarm.id, 10);
      expect(results.filter((r) => r.status === "dispatched").length).toBe(2);
      expect(harness.submitted.length).toBe(2);
    } finally {
      store.close();
    }
  });

  test("same member mentioned twice: sequences stay gapless, turns serialize (one live, one deferred)", async () => {
    const store = new SwarmStore(":memory:");
    try {
      const { swarm, lead } = setupSwarm(store);
      const harness = new FakeHarness();
      const dispatcher = new WakeDispatcher(store, harness);
      publishPost(store, {
        swarmId: swarm.id, authorMemberId: lead.id, kind: "brief",
        body: "@coder-a first", idempotencyKey: "cs-1",
      });
      publishPost(store, {
        swarmId: swarm.id, authorMemberId: lead.id, kind: "brief",
        body: "@coder-a second", idempotencyKey: "cs-2",
      });
      expect(store.getPostsAfter(swarm.id, 0).map((p) => p.sequence)).toEqual([1, 2]);
      const d1 = await dispatcher.dispatchNext(swarm.id);
      expect(d1?.status).toBe("dispatched");
      const d2 = await dispatcher.dispatchNext(swarm.id);
      // Second wake for the same member is ineligible while the first turn is
      // live, so the dispatcher reports idle (null) instead of double-submit.
      expect(d2).toBeNull();
      expect(harness.submitted.length).toBe(1);
    } finally {
      store.close();
    }
  });

  test("duplicate private steering collapses to one logical intent, one submit", async () => {
    const store = new SwarmStore(":memory:");
    try {
      const { swarm, coderA } = setupSwarm(store);
      const harness = new FakeHarness();
      const queue = new WakeQueue(store);
      const dispatcher = new WakeDispatcher(store, harness);
      const first = await steerWorkerDirect(queue, dispatcher, {
        swarmId: swarm.id, workerId: coderA.id, text: "nudge", idempotencySeed: "dup-1",
      });
      expect(first.dispatched).toBe(true);
      // Replay with the same seed: same intent (deduped), already admitted ->
      // dispatcher reports not-queued, zero additional submits.
      const second = await steerWorkerDirect(queue, dispatcher, {
        swarmId: swarm.id, workerId: coderA.id, text: "nudge", idempotencySeed: "dup-1",
      });
      expect(second.deduped).toBe(true);
      expect(second.intent.id).toBe(first.intent.id);
      expect(second.dispatched).toBe(false);
      expect(harness.submitted.length).toBe(1);
    } finally {
      store.close();
    }
  });

  test("restart during admitted turn: reconciler keeps running, no duplicate submit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m3-conc-"));
    try {
      const dbPath = join(dir, "swarm.db");
      const s1 = new SwarmStore(dbPath);
      const { swarm, lead } = setupSwarm(s1);
      publishPost(s1, {
        swarmId: swarm.id, authorMemberId: lead.id, kind: "brief",
        body: "@coder-a crash window", idempotencyKey: "cw-1",
      });
      const [wake] = s1.listWakes(swarm.id, "queued");
      const harness = new FakeHarness();
      const d1 = new WakeDispatcher(s1, harness);
      const admitted = await d1.dispatchWake(swarm.id, wake!.id);
      expect(admitted.status).toBe("dispatched");
      // Crash window: the turn is admitted/observed_running while the native
      // session is (still) executing.
      harness.liveSessions.add("sess-a");
      s1.close();

      // "Restart": fresh store handle + fresh dispatcher over the same journal.
      const s2 = new SwarmStore(dbPath);
      try {
        const reconciler = new InboxReconciler(s2, async (sessionId) => ({
          hasLiveExecution: harness.liveSessions.has(sessionId),
          knownTerminalExternalIds: [],
        }));
        const report = await reconciler.reconcileSwarm(swarm.id);
        expect(report.keptRunning).toBe(1);
        // Session still live -> the observed_running turn is kept, the queue
        // is empty, and no path resubmits the same logical intent.
        const harness2 = new FakeHarness();
        harness2.liveSessions.add("sess-a");
        const d2 = new WakeDispatcher(s2, harness2);
        expect(await d2.dispatchNext(swarm.id)).toBeNull();
        expect(store2Settled(s2, swarm.id)).toBe(1);
        expect(harness2.submitted.length).toBe(0);
      } finally {
        s2.close();
      }
    } finally {
      removeDir(dir);
    }
  });

  test("S2-01: lease race falls through to the next candidate; all-lost returns null (no INVALID_TRANSITION leak)", () => {
    const store = new SwarmStore(":memory:");
    try {
      const { swarm, coderA } = setupSwarm(store);
      const mk = (title: string) =>
        createTask(store, swarm.id, {
          title, brief: "b", ownerId: coderA.id,
          ownedPaths: ["x/**"], forbiddenPaths: [], acceptanceCriteria: ["done"],
        });
      const a = mk("task-a");
      const b = mk("task-b");
      publishReady(store, a.id);
      publishReady(store, b.id);
      // Simulate the list-then-lease window: the winning row leaves `ready`
      // between the snapshot and the claim (leased/blocked by a concurrent
      // worker). The scheduler must fall through, not throw.
      const claim = store.transitionTask.bind(store);
      const raced = new Set<string>([a.id]);
      store.transitionTask = ((id, to, opts) => {
        if (to === "leased" && raced.has(id)) {
          throw new ProtocolError("INVALID_TRANSITION", "simulated lease race: row left ready", {
            taskId: id,
          });
        }
        return claim(id, to, opts);
      }) as SwarmStore["transitionTask"];
      // Winner A loses the race -> next candidate B is leased.
      expect(leaseNext(store, swarm.id, coderA.id)?.id).toBe(b.id);
      // Same-member replay for the same logical id: B is now held, A still
      // loses -> null instead of a leaked INVALID_TRANSITION.
      expect(leaseNext(store, swarm.id, coderA.id)).toBeNull();
      // Race clears: A leases normally.
      raced.clear();
      expect(leaseNext(store, swarm.id, coderA.id)?.id).toBe(a.id);
      // Nothing left ready for this member -> null.
      expect(leaseNext(store, swarm.id, coderA.id)).toBeNull();
    } finally {
      store.close();
    }
  });

  test("roster preserves nativeAgentId/sessionId per member after fanout + dispatch", async () => {
    const store = new SwarmStore(":memory:");
    try {
      const { swarm, lead } = setupSwarm(store);
      const harness = new FakeHarness();
      const dispatcher = new WakeDispatcher(store, harness);
      publishPost(store, {
        swarmId: swarm.id, authorMemberId: lead.id, kind: "brief",
        body: "@coder-a @coder-b go", idempotencyKey: "id-1",
      });
      await dispatcher.dispatchAll(swarm.id, 10);
      const roster = getRoster(store, swarm.id);
      const byName = new Map(roster.map((r) => [r.member.name, r]));
      expect(byName.get("coder-a")?.member.nativeAgentId).toBe("agent-a");
      expect(byName.get("coder-a")?.member.sessionId).toBe("sess-a");
      expect(byName.get("coder-b")?.member.nativeAgentId).toBe("agent-b");
      expect(byName.get("coder-a")?.hasLiveTurn).toBe(true);
      expect(byName.get("lead")?.hasLiveTurn).toBe(false);
    } finally {
      store.close();
    }
  });
});
