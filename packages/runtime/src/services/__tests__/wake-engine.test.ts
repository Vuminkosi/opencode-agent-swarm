/**
 * M2 wake-engine tests — deterministic, hermetic (spec §§7, 8 M2).
 *
 * Uses disposable tmp-dir SQLite files (never the canonical tree) and a
 * FakeHarness counting every submitTurn call (no network, no model
 * inference, no billed calls). Simulated failures are labelled
 * "(simulated, no inference)".
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProtocolError } from "@opencode-swarm/protocol";
import { SwarmStore } from "../../db/store.js";
import { WakeQueue } from "../wake-queue.js";
import { WakeDispatcher, type DispatchHarness } from "../wake-dispatcher.js";
import { InboxReconciler, type ReconcileSnapshot } from "../inbox-reconciler.js";
import { WakeEventEmitter } from "../wake-events.js";
import { SwarmLifecycle } from "../lifecycle.js";

interface SubmittedTurn {
  readonly sessionId: string;
  readonly text: string;
  readonly delivery: string;
  readonly externalId: string;
  readonly reason: string;
}

function quotaError(): unknown {
  return Object.assign(new Error("model quota exhausted (simulated 402, no inference)"), {
    status: 402,
    code: "QUOTA_EXHAUSTED",
  });
}

function transientError(): unknown {
  return Object.assign(new Error("upstream unavailable (simulated 503, no inference)"), {
    status: 503,
    code: "UPSTREAM_UNAVAILABLE",
  });
}

class FakeHarness implements DispatchHarness {
  submitted: SubmittedTurn[] = [];
  liveSessions = new Set<string>();
  failures = new Map<string, unknown>();
  failOnce = new Map<string, unknown>();
  snapshotThrows = new Set<string>();
  submittedBySession = new Map<string, Set<string>>();
  terminalBySession = new Map<string, Map<string, "succeeded" | "failed">>();

  async submitTurn(request: {
    readonly sessionId: string;
    readonly text: string;
    readonly delivery: "queue";
    readonly externalId: string;
    readonly reason: "mention" | "assigned_task" | "verifier_request" | "monitor_intervention" | "user_direct";
  }): Promise<{ readonly externalId: string; readonly admittedAt: string; readonly transportNote: string }> {
    const once = this.failOnce.get(request.sessionId);
    if (once !== undefined) {
      this.failOnce.delete(request.sessionId);
      throw once;
    }
    const always = this.failures.get(request.sessionId);
    if (always !== undefined) throw always;
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
    if (this.snapshotThrows.has(sessionId)) throw new Error("snapshot down (simulated, no inference)");
    const term = this.terminalBySession.get(sessionId);
    return {
      hasLiveExecution: this.liveSessions.has(sessionId),
      knownTerminalExternalIds: term === undefined ? [] : [...term.keys()],
    };
  }

  noteSubmitted(sessionId: string, externalId: string): void {
    let set = this.submittedBySession.get(sessionId);
    if (set === undefined) {
      set = new Set();
      this.submittedBySession.set(sessionId, set);
    }
    set.add(externalId);
  }

  markTerminal(sessionId: string, externalId: string, outcome: "succeeded" | "failed"): void {
    let map = this.terminalBySession.get(sessionId);
    if (map === undefined) {
      map = new Map();
      this.terminalBySession.set(sessionId, map);
    }
    map.set(externalId, outcome);
  }

  snapshotFor(sessionId: string, wakeId?: string): ReconcileSnapshot {
    const term = this.terminalBySession.get(sessionId);
    const outcomes: Record<string, "succeeded" | "failed"> = {};
    if (term !== undefined) {
      for (const [id, outcome] of term) outcomes[id] = outcome;
    }
    const submitted = this.submittedBySession.get(sessionId);
    return {
      hasLiveExecution: this.liveSessions.has(sessionId),
      knownTerminalExternalIds: term === undefined ? [] : [...term.keys()],
      terminalOutcomes: outcomes,
      wasSubmitted: wakeId === undefined ? (submitted?.size ?? 0) > 0 : (submitted?.has(wakeId) ?? false),
    };
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

function setupStore(): { dir: string; dbPath: string; store: SwarmStore } {
  const dir = mkdtempSync(join(tmpdir(), "m2-engine-"));
  dirs.push(dir);
  const dbPath = join(dir, "state.sqlite");
  return { dir, dbPath, store: new SwarmStore(dbPath) };
}

function makeSwarm(store: SwarmStore): { swarmId: string } {
  const swarm = store.createSwarm({
    title: "m2 engine",
    coordinatorSessionId: "sess-lead",
    projectRoot: "/tmp/m2",
    mode: "parity",
  });
  return { swarmId: swarm.id };
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

/** Force distinct created_at millis so FIFO assertions are deterministic. */
function tickClock(): void {
  const t0 = Date.now();
  while (Date.now() === t0) {
    /* spin one ms */
  }
  nowMs += 7;
}

describe("wake engine: one logical action, one turn, FIFO", () => {
  test("mention → one persisted logical wake → exactly one queue-only turn", async () => {
    const { store } = setupStore();
    try {
      const { swarmId } = makeSwarm(store);
      const memberId = addWaitingMember(store, swarmId, "coder-a", "sess-a");
      const events = new WakeEventEmitter();
      const harness = new FakeHarness();
      const queue = new WakeQueue(store, events);
      const dispatcher = setupDispatch(store, harness, events);

      const enqueued = queue.enqueue({
        swarmId, memberId, reason: "mention", postSequence: 1, payloadHash: "ph-1",
      });
      expect(enqueued.deduped).toBe(false);

      const result = await dispatcher.dispatchWake(swarmId, enqueued.intent.id);
      expect(result.status).toBe("dispatched");
      expect(harness.submitted.length).toBe(1);
      expect(harness.submitted[0]?.delivery).toBe("queue");
      expect(harness.submitted[0]?.externalId).toBe(enqueued.intent.id);
      expect(store.getWake(enqueued.intent.id).state).toBe("observed_running");
      expect(store.getMember(memberId).internalState).toBe("working");
      expect(dispatcher.getDispatchCount()).toBe(1);
      expect(events.history().some((e) => e.kind === "dispatched" && e.wakeId === enqueued.intent.id)).toBe(true);
    } finally {
      store.close();
    }
  });

  test("duplicate intents → one persisted logical action, no duplicate turn", async () => {
    const { store } = setupStore();
    try {
      const { swarmId } = makeSwarm(store);
      const memberId = addWaitingMember(store, swarmId, "coder-a", "sess-a");
      const harness = new FakeHarness();
      const queue = new WakeQueue(store);
      const dispatcher = setupDispatch(store, harness);

      const first = queue.enqueue({ swarmId, memberId, reason: "mention", postSequence: 1, payloadHash: "ph-dup" });
      const second = queue.enqueue({ swarmId, memberId, reason: "mention", postSequence: 1, payloadHash: "ph-dup" });
      expect(second.deduped).toBe(true);
      expect(second.intent.id).toBe(first.intent.id);

      const r1 = await dispatcher.dispatchWake(swarmId, first.intent.id);
      expect(r1.status).toBe("dispatched");
      const r2 = await dispatcher.dispatchWake(swarmId, second.intent.id);
      expect(r2.status).toBe("skipped-not-queued");
      expect(harness.submitted.length).toBe(1);
      expect(store.listWakes(swarmId, "observed_running").length).toBe(1);
    } finally {
      store.close();
    }
  });

  test("per-session serialization: live turn defers the second wake, coalesces after completion", async () => {
    const { store } = setupStore();
    try {
      const { swarmId } = makeSwarm(store);
      const memberId = addWaitingMember(store, swarmId, "coder-a", "sess-a");
      const harness = new FakeHarness();
      const queue = new WakeQueue(store);
      const dispatcher = setupDispatch(store, harness);

      const w1 = queue.enqueue({ swarmId, memberId, reason: "mention", postSequence: 1, payloadHash: "ph-1" });
      tickClock();
      const w2 = queue.enqueue({ swarmId, memberId, reason: "mention", postSequence: 2, payloadHash: "ph-2" });

      expect((await dispatcher.dispatchWake(swarmId, w1.intent.id)).status).toBe("dispatched");
      const deferred = await dispatcher.dispatchWake(swarmId, w2.intent.id);
      expect(deferred.status).toBe("deferred-live-turn");
      expect(harness.submitted.length).toBe(1);
      expect(store.listEligibleQueuedWakes(swarmId, 10)).toEqual([]);

      store.completeWake(w1.intent.id, "succeeded");
      expect((await dispatcher.dispatchWake(swarmId, w2.intent.id)).status).toBe("dispatched");
      expect(harness.submitted.length).toBe(2);
      expect(harness.submitted[1]?.externalId).toBe(w2.intent.id);
    } finally {
      store.close();
    }
  });

  test("FIFO ordering across members is preserved", async () => {
    const { store } = setupStore();
    try {
      const { swarmId } = makeSwarm(store);
      const a = addWaitingMember(store, swarmId, "coder-a", "sess-a");
      tickClock();
      const b = addWaitingMember(store, swarmId, "coder-b", "sess-b");
      const harness = new FakeHarness();
      const queue = new WakeQueue(store);
      const dispatcher = setupDispatch(store, harness);

      tickClock();
      const wa = queue.enqueue({ swarmId, memberId: a, reason: "mention", postSequence: 1, payloadHash: "ph-a" });
      tickClock();
      const wb = queue.enqueue({ swarmId, memberId: b, reason: "mention", postSequence: 1, payloadHash: "ph-b" });

      const results = await dispatcher.dispatchAll(swarmId, 10);
      expect(results.map((r) => r.status)).toEqual(["dispatched", "dispatched"]);
      expect(harness.submitted.map((s) => s.externalId)).toEqual([wa.intent.id, wb.intent.id]);
    } finally {
      store.close();
    }
  });
});

describe("wake engine: eligibility guards (paused/killed/quota never invoked)", () => {
  test("killed member rejects the wake; quota/approval-paused members defer with zero submits", async () => {
    const { store } = setupStore();
    try {
      const { swarmId } = makeSwarm(store);
      const killed = addWaitingMember(store, swarmId, "coder-k", "sess-k");
      store.transitionMember(killed, "killed");
      expect(() =>
        store.createWakeIntent(swarmId, {
          memberId: killed, memberGeneration: 1, reason: "mention", postSequence: 1, payloadHash: "ph",
        }),
      ).toThrow(ProtocolError);

      const quota = addWaitingMember(store, swarmId, "coder-q", "sess-q");
      store.transitionMember(quota, "working");
      store.markQuotaBlocked(quota);
      const harness = new FakeHarness();
      const queue = new WakeQueue(store);
      const dispatcher = setupDispatch(store, harness);

      const wq = queue.enqueue({ swarmId, memberId: quota, reason: "mention", postSequence: 2, payloadHash: "ph-q" });
      expect((await dispatcher.dispatchWake(swarmId, wq.intent.id)).status).toBe("deferred-ineligible");
      expect(harness.submitted.length).toBe(0);
      expect(store.listEligibleQueuedWakes(swarmId, 10)).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("paused swarm dispatches nothing (zero submits)", async () => {
    const { dbPath, store } = setupStore();
    try {
      const { swarmId } = makeSwarm(store);
      const memberId = addWaitingMember(store, swarmId, "coder-a", "sess-a");
      const harness = new FakeHarness();
      const queue = new WakeQueue(store);
      const dispatcher = setupDispatch(store, harness);

      const w = queue.enqueue({ swarmId, memberId, reason: "mention", postSequence: 1, payloadHash: "ph" });
      const lifecycle = new SwarmLifecycle(dbPath);
      try {
        lifecycle.pauseSwarm(swarmId);
        expect((await dispatcher.dispatchWake(swarmId, w.intent.id)).status).toBe("skipped-swarm-paused");
        expect(await dispatcher.dispatchNext(swarmId)).toBeNull();
        expect(await dispatcher.dispatchAll(swarmId)).toEqual([]);
        expect(harness.submitted.length).toBe(0);
      } finally {
        lifecycle.close();
      }
    } finally {
      store.close();
    }
  });
});

describe("wake engine: restart, backoff, quota, lost-ack, idle-zero", () => {
  test("restart preserves actionable events (queued + unsettled survive reopen)", async () => {
    const { dbPath, store } = setupStore();
    let queuedId = "";
    let runningId = "";
    try {
      const { swarmId } = makeSwarm(store);
      const memberA = addWaitingMember(store, swarmId, "coder-a", "sess-a");
      const memberB = addWaitingMember(store, swarmId, "coder-b", "sess-b");
      const harness = new FakeHarness();
      const queue = new WakeQueue(store);
      const dispatcher = setupDispatch(store, harness);

      runningId = queue.enqueue({ swarmId, memberId: memberA, reason: "mention", postSequence: 1, payloadHash: "ph-1" }).intent.id;
      expect((await dispatcher.dispatchWake(swarmId, runningId)).status).toBe("dispatched");
      tickClock();
      queuedId = queue.enqueue({ swarmId, memberId: memberB, reason: "mention", postSequence: 2, payloadHash: "ph-2" }).intent.id;
      expect(harness.submitted.length).toBe(1);
    } finally {
      store.close();
    }
    const reopened = new SwarmStore(dbPath);
    try {
      expect(reopened.getWake(queuedId).state).toBe("queued");
      expect(reopened.getWake(runningId).state).toBe("observed_running");
      expect(reopened.listEligibleQueuedWakes("unused-swarm", 10)).toEqual([]);
      const { swarmId } = { swarmId: reopened.getWake(queuedId).swarmId };
      expect(reopened.listEligibleQueuedWakes(swarmId, 10).map((w) => w.id)).toEqual([queuedId]);
      expect(reopened.listUnsettledWakes(swarmId, 10).map((w) => w.id)).toEqual([runningId]);
    } finally {
      reopened.close();
    }
  });

  test("transient 503 → bounded backoff, then redispatch; no retry storm", async () => {
    const { store } = setupStore();
    try {
      const { swarmId } = makeSwarm(store);
      const memberId = addWaitingMember(store, swarmId, "coder-a", "sess-a");
      const harness = new FakeHarness();
      harness.failOnce.set("sess-a", transientError());
      const queue = new WakeQueue(store);
      const dispatcher = setupDispatch(store, harness);

      const w = queue.enqueue({ swarmId, memberId, reason: "mention", postSequence: 1, payloadHash: "ph" });
      const failed = await dispatcher.dispatchWake(swarmId, w.intent.id);
      expect(failed.status).toBe("failed-transient-scheduled");
      expect(failed.notBefore).toBeDefined();
      expect(harness.submitted.length).toBe(0);
      // The wake is ADMITTED now: dispatchWake never double-submits a
      // non-queued row (at-least-once transport needs idle verification).
      const immediate = await dispatcher.dispatchWake(swarmId, w.intent.id);
      expect(immediate.status).toBe("skipped-not-queued");
      expect(harness.submitted.length).toBe(0);
      // Too-early admitted retry is gated by backoff — still zero submits.
      const early = await dispatcher.retryAdmittedWake(swarmId, w.intent.id);
      expect(early.status).toBe("deferred-backoff");
      expect(harness.submitted.length).toBe(0);

      nowMs += 5000;
      const reconciler = new InboxReconciler(store, async (s) => harness.snapshotFor(s));
      const report = await reconciler.reconcileSwarm(swarmId);
      expect(report.releasedForRetry).toBe(1);
      const retried = await dispatcher.retryAdmittedWake(swarmId, w.intent.id);
      expect(retried.status).toBe("dispatched");
      expect(harness.submitted.length).toBe(1);
      expect(harness.submitted[0]?.externalId).toBe(w.intent.id);
    } finally {
      store.close();
    }
  });

  test("quota 402 → quota-blocked member, never auto-retries the paid path", async () => {
    const { store } = setupStore();
    try {
      const { swarmId } = makeSwarm(store);
      const memberId = addWaitingMember(store, swarmId, "coder-a", "sess-a");
      const harness = new FakeHarness();
      harness.failures.set("sess-a", quotaError());
      const queue = new WakeQueue(store);
      const dispatcher = setupDispatch(store, harness);

      const w = queue.enqueue({ swarmId, memberId, reason: "mention", postSequence: 1, payloadHash: "ph" });
      const blocked = await dispatcher.dispatchWake(swarmId, w.intent.id);
      expect(blocked.status).toBe("quota-blocked");
      expect(store.getMember(memberId).internalState).toBe("quota_paused");
      const attemptsAfterBlock = store.getWake(w.intent.id).attempts;
      expect(harness.submitted.length).toBe(0);

      nowMs += 60_000;
      // The wake is ADMITTED with a quota-paused member: the dispatcher
      // never resubmits it (skipped, zero new submits, attempts frozen).
      const again = await dispatcher.dispatchWake(swarmId, w.intent.id);
      expect(again.status).toBe("skipped-not-queued");
      expect(harness.submitted.length).toBe(0);
      expect(store.getWake(w.intent.id).attempts).toBe(attemptsAfterBlock);
      expect(store.listEligibleQueuedWakes(swarmId, 10)).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("lost-ack reconciles: never-submitted releases for retry, submitted-ambiguous quarantines", async () => {
    const { store } = setupStore();
    try {
      const { swarmId } = makeSwarm(store);
      const memberId = addWaitingMember(store, swarmId, "coder-a", "sess-a");
      const harness = new FakeHarness();
      const queue = new WakeQueue(store);
      const events = new WakeEventEmitter();
      const dispatcher = setupDispatch(store, harness, events);

      // Case A: crash between claim and submitTurn — nothing reached the backend.
      const wA = queue.enqueue({ swarmId, memberId, reason: "mention", postSequence: 1, payloadHash: "ph-a" });
      const claimed = store.claimWakeForDispatch(wA.intent.id, { nowIso: new Date(nowMs).toISOString() });
      expect(claimed.status).toBe("admitted");

      const reconciler = new InboxReconciler(store, async (s) => harness.snapshotFor(s), events);
      const reportA = await reconciler.reconcileWake(swarmId, store.getWake(wA.intent.id));
      expect(reportA.decision).toBe("released-for-retry");
      nowMs += 5000; // restart takes wall-clock time; backoff ceiling elapses
      const retried = await dispatcher.retryAdmittedWake(swarmId, wA.intent.id);
      expect(retried.status).toBe("dispatched");
      expect(harness.submitted.length).toBe(1);
      expect(harness.submitted[0]?.externalId).toBe(wA.intent.id);
      expect(store.getWake(wA.intent.id).state).toBe("observed_running");

      // Case B: submitted but no terminal record and session idle — ambiguous, quarantine.
      store.completeWake(wA.intent.id, "succeeded");
      const wB = queue.enqueue({ swarmId, memberId, reason: "mention", postSequence: 2, payloadHash: "ph-b" });
      const claimedB = store.claimWakeForDispatch(wB.intent.id, { nowIso: new Date(nowMs).toISOString() });
      expect(claimedB.status).toBe("admitted");
      harness.noteSubmitted("sess-a", wB.intent.id);
      const reportB = await reconciler.reconcileWake(swarmId, store.getWake(wB.intent.id));
      expect(reportB.decision).toBe("quarantined");
      expect(store.isWakeQuarantined(wB.intent.id)).toBe(true);
      const before = harness.submitted.length;
      expect((await dispatcher.dispatchWake(swarmId, wB.intent.id)).status).toBe("skipped-not-queued");
      expect(harness.submitted.length).toBe(before);
    } finally {
      store.close();
    }
  });

  test("idle swarm performs zero harness calls (zero inference)", async () => {
    const { store } = setupStore();
    try {
      const { swarmId } = makeSwarm(store);
      const memberId = addWaitingMember(store, swarmId, "coder-a", "sess-a");
      const harness = new FakeHarness();
      const queue = new WakeQueue(store);
      const dispatcher = setupDispatch(store, harness);

      expect(await dispatcher.dispatchNext(swarmId)).toBeNull();
      expect(await dispatcher.dispatchAll(swarmId)).toEqual([]);
      expect(harness.submitted.length).toBe(0);

      const w = queue.enqueue({ swarmId, memberId, reason: "mention", postSequence: 1, payloadHash: "ph" });
      expect((await dispatcher.dispatchWake(swarmId, w.intent.id)).status).toBe("dispatched");
      expect(harness.submitted.length).toBe(1);
      store.completeWake(w.intent.id, "succeeded");

      expect(await dispatcher.dispatchNext(swarmId)).toBeNull();
      expect(await dispatcher.dispatchAll(swarmId)).toEqual([]);
      expect(harness.submitted.length).toBe(1);
      expect(dispatcher.getDispatchCount()).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe("M2-01-FIX-01 S2-1: TOCTOU quota-pause preserves admitted intent", () => {
  test("claim→quota→dispatch stays admitted + lease released; resume redrives", async () => {
    const { store } = setupStore();
    const origGetMember = store.getMember.bind(store);
    try {
      const { swarmId } = makeSwarm(store);
      const memberId = addWaitingMember(store, swarmId, "coder-a", "sess-a");
      const harness = new FakeHarness();
      const queue = new WakeQueue(store);
      const dispatcher = setupDispatch(store, harness);

      const w = queue.enqueue({ swarmId, memberId, reason: "mention", postSequence: 1, payloadHash: "ph-toctou" });
      expect(store.getWake(w.intent.id).attempts).toBe(0);

      // Interleave a quota-pause between the fenced claim and the member
      // re-read: the dispatcher must preserve (not cancel) the admitted wake.
      let intercepted = false;
      store.getMember = ((id: string) => {
        const current = origGetMember(id);
        if (!intercepted && id === memberId) {
          intercepted = true;
          store.markQuotaBlocked(id, w.intent.id, "s2-1-toctou");
        }
        return origGetMember(id);
      }) as typeof store.getMember;

      const result = await dispatcher.dispatchWake(swarmId, w.intent.id);
      store.getMember = origGetMember;
      expect(intercepted).toBe(true);
      expect(result.status).toBe("deferred-ineligible");
      expect(harness.submitted.length).toBe(0);
      const after = store.getWake(w.intent.id);
      expect(after.state).toBe("admitted");
      expect(after.attempts).toBe(1);
      expect(store.getMember(memberId).internalState).toBe("quota_paused");
      expect(store.getWakeLeaseInfo(memberId)).toBeNull();

      // Resume redrives the SAME logical intent (no silent loss).
      store.transitionMember(memberId, "working");
      nowMs += 5000;
      const reconciler = new InboxReconciler(store, async (s) => harness.snapshotFor(s));
      const report = await reconciler.reconcileSwarm(swarmId);
      expect(report.releasedForRetry).toBe(1);
      const retried = await dispatcher.retryAdmittedWake(swarmId, w.intent.id);
      expect(retried.status).toBe("dispatched");
      expect(harness.submitted.map((s) => s.externalId)).toEqual([w.intent.id]);
      expect(store.getWake(w.intent.id).state).toBe("observed_running");
    } finally {
      store.getMember = origGetMember;
      store.close();
    }
  });
});

describe("M2-01-FIX-01 S2-2: store-level paused-swarm guard", () => {
  test("pause→claim stays queued; pause→reacquire stays admitted", async () => {
    const { dbPath, store } = setupStore();
    const lifecycle = new SwarmLifecycle(dbPath);
    try {
      const { swarmId } = makeSwarm(store);
      const memberId = addWaitingMember(store, swarmId, "coder-a", "sess-a");
      const queue = new WakeQueue(store);

      const w = queue.enqueue({ swarmId, memberId, reason: "mention", postSequence: 1, payloadHash: "ph-pause" });
      lifecycle.pauseSwarm(swarmId);
      const claim = store.claimWakeForDispatch(w.intent.id, { nowIso: new Date(nowMs).toISOString() });
      expect(claim.status).toBe("deferred-ineligible");
      expect(store.getWake(w.intent.id).state).toBe("queued");
      expect(store.getWake(w.intent.id).attempts).toBe(0);
      expect(store.getWakeLeaseInfo(memberId)).toBeNull();

      // Admitted path: resume, admit, pause again — reacquire preserves.
      lifecycle.resumeSwarm(swarmId);
      const admitted = store.claimWakeForDispatch(w.intent.id, { nowIso: new Date(nowMs).toISOString() });
      expect(admitted.status).toBe("admitted");
      lifecycle.pauseSwarm(swarmId);
      const reacquired = store.reacquireWakeLease(w.intent.id, { nowIso: new Date(nowMs).toISOString() });
      expect(reacquired.status).toBe("deferred-ineligible");
      expect(store.getWake(w.intent.id).state).toBe("admitted");
      expect(store.getWake(w.intent.id).attempts).toBe(1);
    } finally {
      lifecycle.close();
      store.close();
    }
  });
});
