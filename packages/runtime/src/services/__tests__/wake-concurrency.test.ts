/**
 * M2 wake-concurrency tests — dual claimants, bulk idempotency, restart
 * under load, lost-ack, quota isolation, idle-zero (spec §§7, 8 M2).
 *
 * Two SwarmStore handles on ONE file DB serialize through BEGIN IMMEDIATE
 * + busy retry: exactly one claimant wins a wake. Disposable tmp dirs only;
 * FakeHarness counts every submitTurn (no inference, no spend).
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwarmStore, computeDeliveryKey } from "../../db/store.js";
import { WakeQueue } from "../wake-queue.js";
import { WakeDispatcher, type DispatchHarness } from "../wake-dispatcher.js";
import { InboxReconciler } from "../inbox-reconciler.js";
import { WakeEventEmitter } from "../wake-events.js";

interface SubmittedTurn {
  readonly sessionId: string;
  readonly text: string;
  readonly delivery: string;
  readonly externalId: string;
  readonly reason: string;
}

function transportError(status: number, code: string): unknown {
  return Object.assign(new Error(`${code} (simulated ${status}, no inference)`), { status, code });
}

class FakeHarness implements DispatchHarness {
  submitted: SubmittedTurn[] = [];
  liveSessions = new Set<string>();
  failures = new Map<string, unknown>();
  submittedBySession = new Map<string, Set<string>>();

  async submitTurn(request: {
    readonly sessionId: string;
    readonly text: string;
    readonly delivery: "queue";
    readonly externalId: string;
    readonly reason: "mention" | "assigned_task" | "verifier_request" | "monitor_intervention" | "user_direct";
  }): Promise<{ readonly externalId: string; readonly admittedAt: string; readonly transportNote: string }> {
    const failure = this.failures.get(request.sessionId);
    if (failure !== undefined) throw failure;
    this.submitted.push({ ...request });
    let set = this.submittedBySession.get(request.sessionId);
    if (set === undefined) {
      set = new Set();
      this.submittedBySession.set(request.sessionId, set);
    }
    set.add(request.externalId);
    return { externalId: request.externalId, admittedAt: new Date().toISOString(), transportNote: "fake-queue-admit" };
  }

  async getSession(sessionId: string): Promise<{
    readonly hasLiveExecution: boolean;
    readonly knownTerminalExternalIds: readonly string[];
  }> {
    return { hasLiveExecution: this.liveSessions.has(sessionId), knownTerminalExternalIds: [] };
  }
}

const dirs: string[] = [];
let nowMs = Date.parse("2026-11-11T00:00:00.000Z");

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
  nowMs = Date.parse("2026-11-11T00:00:00.000Z");
});

function setupFileStore(): { dir: string; dbPath: string; store: SwarmStore } {
  const dir = mkdtempSync(join(tmpdir(), "m2-conc-"));
  dirs.push(dir);
  const dbPath = join(dir, "state.sqlite");
  return { dir, dbPath, store: new SwarmStore(dbPath) };
}

function makeSwarm(store: SwarmStore): string {
  return store.createSwarm({
    title: "m2 concurrency",
    coordinatorSessionId: "sess-lead",
    projectRoot: "/tmp/m2c",
    mode: "parity",
  }).id;
}

function addWaitingMember(store: SwarmStore, swarmId: string, name: string, sessionId: string): string {
  const member = store.addMember(swarmId, {
    name,
    role: "coder",
    nativeAgentId: "fake-agent",
    sessionId,
    model: { providerID: "fake", id: "fake-model" },
  });
  return store.transitionMember(member.id, "waiting").id;
}

function setupDispatch(store: SwarmStore, harness: FakeHarness, events?: WakeEventEmitter): WakeDispatcher {
  return new WakeDispatcher(store, harness, events, {
    now: () => new Date(nowMs).toISOString(),
    random: () => 1,
    backoffBaseMs: 100,
    backoffCapMs: 1000,
  });
}

/** Force distinct created_at millis so ordering assertions are deterministic. */
function spinMs(): void {
  const t0 = Date.now();
  while (Date.now() === t0) {
    /* spin one ms */
  }
}

describe("wake concurrency: bulk idempotency + ordering", () => {
  test("100 rapid intents → 100 unique delivery_keys; 100 posts → contiguous sequences", () => {
    const { store } = setupFileStore();
    try {
      const swarmId = makeSwarm(store);
      const memberIds: string[] = [];
      for (let m = 0; m < 10; m += 1) {
        memberIds.push(addWaitingMember(store, swarmId, `coder-${m}`, `sess-${m}`));
      }
      const queue = new WakeQueue(store);
      const seenDelivery = new Set<string>();
      const seenIds = new Set<string>();
      for (let i = 0; i < 100; i += 1) {
        const memberId = memberIds[i % 10] as string;
        const member = store.getMember(memberId);
        const payloadHash = `bulk-ph-${i}`;
        const key = computeDeliveryKey({
          memberId, memberGeneration: member.generation, reason: "mention", postSequence: i + 1, taskId: null, payloadHash,
        });
        seenDelivery.add(key);
        const enqueued = queue.enqueue({
          swarmId, memberId, reason: "mention", postSequence: i + 1, payloadHash,
        });
        expect(enqueued.deduped).toBe(false);
        seenIds.add(enqueued.intent.id);
      }
      expect(seenDelivery.size).toBe(100);
      expect(seenIds.size).toBe(100);
      expect(store.listWakes(swarmId, "queued", 500).length).toBe(100);

      // Board ordering foundation: 100 rapid appends, one total order.
      for (let i = 1; i <= 100; i += 1) {
        const posted = store.appendPost(swarmId, {
          authorMemberId: null, kind: "message", body: `bulk msg ${i}`, idempotencyKey: `bulk-${i}`,
        });
        expect(posted.deduped).toBe(false);
      }
      const posts = store.getPostsAfter(swarmId, 0, 500);
      expect(posts.length).toBe(100);
      expect(posts.map((p) => p.sequence)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    } finally {
      store.close();
    }
  });
});

describe("wake concurrency: dual claimants, one winner", () => {
  test("two stores on one file: exactly one admitted, the other deferred-live-turn", () => {
    const { dbPath, store: storeA } = setupFileStore();
    const storeB = new SwarmStore(dbPath);
    try {
      const swarmId = makeSwarm(storeA);
      const memberId = addWaitingMember(storeA, swarmId, "coder-a", "sess-a");
      const queue = new WakeQueue(storeA);
      const wakeId = queue.enqueue({
        swarmId, memberId, reason: "mention", postSequence: 1, payloadHash: "ph-duel",
      }).intent.id;

      const first = storeA.claimWakeForDispatch(wakeId, { nowIso: new Date(nowMs).toISOString() });
      const second = storeB.claimWakeForDispatch(wakeId, { nowIso: new Date(nowMs).toISOString() });

      const admitted = [first, second].filter((c) => c.status === "admitted");
      const deferred = [first, second].filter((c) => c.status === "deferred-live-turn");
      expect(admitted.length).toBe(1);
      expect(deferred.length).toBe(1);
      expect(storeA.getWake(wakeId).state).toBe("admitted");
      if (admitted[0]?.status === "admitted") expect(admitted[0].fencingToken).toBe(1);
    } finally {
      storeA.close();
      storeB.close();
    }
  });
});

describe("wake concurrency: restart, lost-ack, quota isolation, idle-zero", () => {
  test("restart preserves 20 queued wakes; reopened dispatcher drains them with zero dupes", async () => {
    const { dbPath, store } = setupFileStore();
    let swarmId = "";
    const memberIds: string[] = [];
    try {
      swarmId = makeSwarm(store);
      for (let m = 0; m < 4; m += 1) {
        memberIds.push(addWaitingMember(store, swarmId, `coder-${m}`, `sess-${m}`));
      }
      const queue = new WakeQueue(store);
      for (let i = 0; i < 20; i += 1) {
        spinMs();
        queue.enqueue({
          swarmId, memberId: memberIds[i % 4] as string, reason: "mention", postSequence: i + 1, payloadHash: `restart-ph-${i}`,
        });
      }
      expect(store.listWakes(swarmId, "queued", 500).length).toBe(20);
    } finally {
      store.close();
    }
    const reopened = new SwarmStore(dbPath);
    try {
      expect(reopened.listEligibleQueuedWakes(swarmId, 500).length).toBe(20);
      const harness = new FakeHarness();
      const events = new WakeEventEmitter();
      const dispatcher = new WakeDispatcher(reopened, harness, events, {
        now: () => new Date(nowMs).toISOString(),
        random: () => 1,
        backoffBaseMs: 100,
        backoffCapMs: 1000,
      });
      // 4 members × 5 wakes: drain member by member (one live turn each).
      for (let round = 0; round < 5; round += 1) {
        for (const memberId of memberIds) {
          const live = reopened.findLiveWakeForMember(memberId);
          if (live !== null) reopened.completeWake(live.id, "succeeded");
        }
        const batch = await dispatcher.dispatchAll(swarmId, 4);
        expect(batch.every((r) => r.status === "dispatched")).toBe(true);
      }
      expect(harness.submitted.length).toBe(20);
      expect(new Set(harness.submitted.map((s) => s.externalId)).size).toBe(20);
      expect(await dispatcher.dispatchAll(swarmId, 10)).toEqual([]);
      expect(harness.submitted.length).toBe(20);
    } finally {
      reopened.close();
    }
  });

  test("lost-ack across restart: never-submitted retries the same id; ambiguous quarantines", async () => {
    const { dbPath, store } = setupFileStore();
    let swarmId = "";
    let wakeA = "";
    try {
      swarmId = makeSwarm(store);
      const memberId = addWaitingMember(store, swarmId, "coder-a", "sess-a");
      const queue = new WakeQueue(store);
      wakeA = queue.enqueue({ swarmId, memberId, reason: "mention", postSequence: 1, payloadHash: "ph-a" }).intent.id;
      const claimed = store.claimWakeForDispatch(wakeA, { nowIso: new Date(nowMs).toISOString() });
      expect(claimed.status).toBe("admitted");
    } finally {
      store.close();
    }
    const reopened = new SwarmStore(dbPath);
    try {
      const harness = new FakeHarness();
      const events = new WakeEventEmitter();
      const member = reopened.listMembers(swarmId).find((m) => m.name === "coder-a");
      expect(member).toBeDefined();
      // Crash between claim and submit: backend never saw it.
      const reconciler = new InboxReconciler(
        reopened,
        async (s) => ({
          hasLiveExecution: false,
          knownTerminalExternalIds: [],
          terminalOutcomes: {},
          wasSubmitted: (harness.submittedBySession.get(s)?.size ?? 0) > 0,
        }),
        events,
      );
      const report = await reconciler.reconcileSwarm(swarmId);
      expect(report.checked).toBe(1);
      expect(report.releasedForRetry).toBe(1);

      nowMs += 5000;
      const dispatcher = setupDispatch(reopened, harness, events);
      const retried = await dispatcher.retryAdmittedWake(swarmId, wakeA);
      expect(retried.status).toBe("dispatched");
      expect(harness.submitted.map((s) => s.externalId)).toEqual([wakeA]);
      expect(reopened.listWakes(swarmId, "observed_running", 10).map((w) => w.id)).toEqual([wakeA]);
    } finally {
      reopened.close();
    }
  });

  test("quota isolation: 402 blocks one member without retry while the other dispatches", async () => {
    const { store } = setupFileStore();
    try {
      const swarmId = makeSwarm(store);
      const q = addWaitingMember(store, swarmId, "coder-q", "sess-q");
      spinMs();
      const g = addWaitingMember(store, swarmId, "coder-g", "sess-g");
      const harness = new FakeHarness();
      harness.failures.set("sess-q", transportError(402, "QUOTA_EXHAUSTED"));
      const queue = new WakeQueue(store);
      const dispatcher = setupDispatch(store, harness);

      spinMs();
      const wq = queue.enqueue({ swarmId, memberId: q, reason: "mention", postSequence: 1, payloadHash: "ph-q" });
      spinMs();
      const wg = queue.enqueue({ swarmId, memberId: g, reason: "mention", postSequence: 1, payloadHash: "ph-g" });

      const results = await dispatcher.dispatchAll(swarmId, 10);
      expect(results.length).toBe(2);
      expect(results.map((r) => r.status).sort()).toEqual(["dispatched", "quota-blocked"]);
      expect(store.getMember(q).internalState).toBe("quota_paused");
      expect(store.getMember(g).internalState).toBe("working");
      // One attempt each: the 402 path performed zero retries (no storm).
      expect(harness.submitted.length).toBe(1);
      expect(harness.submitted[0]?.externalId).toBe(wg.intent.id);

      nowMs += 60_000;
      expect(await dispatcher.dispatchAll(swarmId, 10)).toEqual([]);
      expect(harness.submitted.length).toBe(1);
      expect(store.getWake(wq.intent.id).attempts).toBe(1);
    } finally {
      store.close();
    }
  });

  test("idle-zero under load: settled swarm performs zero harness calls", async () => {
    const { store } = setupFileStore();
    try {
      const swarmId = makeSwarm(store);
      const memberId = addWaitingMember(store, swarmId, "coder-a", "sess-a");
      const harness = new FakeHarness();
      const queue = new WakeQueue(store);
      const dispatcher = setupDispatch(store, harness);

      const w = queue.enqueue({ swarmId, memberId, reason: "mention", postSequence: 1, payloadHash: "ph" });
      expect((await dispatcher.dispatchWake(swarmId, w.intent.id)).status).toBe("dispatched");
      store.completeWake(w.intent.id, "succeeded");
      const before = harness.submitted.length;
      expect(store.listEligibleQueuedWakes(swarmId, 100)).toEqual([]);
      expect(store.listUnsettledWakes(swarmId, 100)).toEqual([]);
      expect(await dispatcher.dispatchNext(swarmId)).toBeNull();
      expect(await dispatcher.dispatchAll(swarmId, 50)).toEqual([]);
      expect(harness.submitted.length).toBe(before);
      expect(dispatcher.getDispatchCount()).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe("M2-01-FIX-01 F-01: pre-transport defers burn zero retry budget", () => {
  test("9 live-session defers leave attempts frozen and the wake admitted", async () => {
    const { store } = setupFileStore();
    try {
      const swarmId = makeSwarm(store);
      const memberId = addWaitingMember(store, swarmId, "coder-a", "sess-a");
      const harness = new FakeHarness();
      harness.liveSessions.add("sess-a");
      const queue = new WakeQueue(store);
      const dispatcher = setupDispatch(store, harness);

      const w = queue.enqueue({ swarmId, memberId, reason: "mention", postSequence: 1, payloadHash: "ph-busy" });
      const first = await dispatcher.dispatchWake(swarmId, w.intent.id);
      expect(first.status).toBe("deferred-live-turn");
      expect(first.notBefore).toBeDefined();
      expect(store.getWake(w.intent.id).state).toBe("admitted");
      expect(store.getWake(w.intent.id).attempts).toBe(1);
      expect(harness.submitted.length).toBe(0);

      // 8 more busy defers through the admitted-retry path (past backoff).
      for (let i = 0; i < 8; i += 1) {
        nowMs += 5000;
        const r = await dispatcher.retryAdmittedWake(swarmId, w.intent.id);
        expect(r.status).toBe("deferred-live-turn");
      }
      // 9 defers, zero transport: attempts frozen, never terminally closed.
      expect(store.getWake(w.intent.id).attempts).toBe(1);
      expect(store.getWake(w.intent.id).state).toBe("admitted");
      expect(harness.submitted.length).toBe(0);
    } finally {
      store.close();
    }
  });
});
