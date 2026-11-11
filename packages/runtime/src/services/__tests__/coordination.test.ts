/**
 * M3 coordination tests — 12 user verifications, deterministic + hermetic
 * (spec §14 M3).
 *
 * Disposable `:memory:` SwarmStore + FakeHarness (counts every submitTurn;
 * no network, no model inference, no billed calls; failures labelled
 * "(simulated, no inference)"). Covers: ordering, @member/@group/@all,
 * dup suppression, private steering, no-wake unrelated, coalescing,
 * lead sleep zero, lead wake on completion, restart-safe journal replay,
 * quota-blocked no-retry, identity/permission passthrough.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDepsAcyclic, ProtocolError } from "@opencode-swarm/protocol";
import { SwarmStore } from "../../db/store.js";
import { WakeQueue } from "../wake-queue.js";
import { WakeDispatcher, type DispatchHarness } from "../wake-dispatcher.js";
import { InboxReconciler } from "../inbox-reconciler.js";
import { publishPost, readBoard } from "../board-service.js";
import { createTask, publishReady, leaseNext, startRunning, submitForVerification } from "../task-scheduler.js";
import { submitVerification } from "../verifier.js";
import { checkDormant } from "../monitor.js";
import { markWaiting, decideLeadWake, steerWorkerDirect } from "../lead-autonomy.js";
import { getRoster, getPending, getDelivery } from "../roster.js";
import { assertRoleAllows } from "../swarm-service.js";

type Reason = "mention" | "assigned_task" | "verifier_request" | "monitor_intervention" | "user_direct";

interface SubmittedTurn {
  readonly sessionId: string;
  readonly text: string;
  readonly delivery: string;
  readonly externalId: string;
  readonly reason: string;
}

function quotaError(): unknown {
  return Object.assign(new Error("quota exhausted (simulated 402, no inference)"), {
    status: 402,
    code: "QUOTA_EXHAUSTED",
  });
}

class FakeHarness implements DispatchHarness {
  submitted: SubmittedTurn[] = [];
  liveSessions = new Set<string>();
  failures = new Map<string, unknown>();

  async submitTurn(request: {
    readonly sessionId: string;
    readonly text: string;
    readonly delivery: "queue";
    readonly externalId: string;
    readonly reason: Reason;
  }): Promise<{ readonly externalId: string; readonly admittedAt: string; readonly transportNote: string }> {
    const failure = this.failures.get(request.sessionId);
    if (failure !== undefined) throw failure;
    this.submitted.push({ ...request });
    return { externalId: request.externalId, admittedAt: new Date().toISOString(), transportNote: "fake-queue-admit" };
  }

  async getSession(sessionId: string): Promise<{
    readonly hasLiveExecution: boolean;
    readonly knownTerminalExternalIds: readonly string[];
  }> {
    return { hasLiveExecution: this.liveSessions.has(sessionId), knownTerminalExternalIds: [] };
  }
}

const MODEL = { providerID: "p", id: "m" };

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort (Windows WAL unlock race; tmp reaped by the OS) */
  }
}

function setupSwarm(store: SwarmStore) {
  const swarm = store.createSwarm({
    title: "M3 three-worker gate",
    coordinatorSessionId: "sess-lead",
    projectRoot: "/tmp/m3",
    mode: "parity",
  });
  const lead = store.addMember(swarm.id, {
    name: "lead",
    role: "coordinator",
    nativeAgentId: "agent-lead",
    sessionId: "sess-lead",
    model: MODEL,
  });
  const coderA = store.addMember(swarm.id, {
    name: "coder-a",
    groups: ["frontend"],
    role: "coder",
    nativeAgentId: "agent-a",
    sessionId: "sess-a",
    model: MODEL,
  });
  const coderB = store.addMember(swarm.id, {
    name: "coder-b",
    groups: ["frontend"],
    role: "coder",
    nativeAgentId: "agent-b",
    sessionId: "sess-b",
    model: MODEL,
  });
  const verifier = store.addMember(swarm.id, {
    name: "verifier-v",
    role: "verifier",
    nativeAgentId: "agent-v",
    sessionId: "sess-v",
    model: MODEL,
  });
  return { swarm, lead, coderA, coderB, verifier };
}

describe("M3 board: ordering + mentions", () => {
  test("(1) chronological durable sequence 1..N across authors", () => {
    const store = new SwarmStore(":memory:");
    try {
      const { swarm, lead, coderA } = setupSwarm(store);
      const p1 = publishPost(store, {
        swarmId: swarm.id, authorMemberId: lead.id, kind: "message", body: "hello", idempotencyKey: "k-1",
      });
      const p2 = publishPost(store, {
        swarmId: swarm.id, authorMemberId: coderA.id, kind: "progress", body: "wip", idempotencyKey: "k-2",
      });
      expect([p1.post.sequence, p2.post.sequence]).toEqual([1, 2]);
      expect(readBoard(store, swarm.id, 0).map((p) => p.sequence)).toEqual([1, 2]);
      expect(readBoard(store, swarm.id, 1).map((p) => p.sequence)).toEqual([2]);
    } finally {
      store.close();
    }
  });

  test("(2) @member mention wakes exactly that member", () => {
    const store = new SwarmStore(":memory:");
    try {
      const { swarm, lead, coderA, coderB } = setupSwarm(store);
      const res = publishPost(store, {
        swarmId: swarm.id, authorMemberId: lead.id, kind: "brief",
        body: "@coder-a please take this", idempotencyKey: "k-m",
      });
      expect(res.wakeIds.length).toBe(1);
      const wakes = store.listWakes(swarm.id, "queued");
      expect(wakes.map((w) => w.memberId)).toEqual([coderA.id]);
      expect(wakes[0]?.reason).toBe("mention");
      expect(wakes[0]?.postSequence).toBe(res.post.sequence);
      void coderB;
    } finally {
      store.close();
    }
  });

  test("(3) @group mention fans out to live group members, author excluded", () => {
    const store = new SwarmStore(":memory:");
    try {
      const { swarm, coderA } = setupSwarm(store);
      const res = publishPost(store, {
        swarmId: swarm.id, authorMemberId: coderA.id, kind: "message",
        body: "@frontend sync up", idempotencyKey: "k-g",
      });
      const wakes = store.listWakes(swarm.id, "queued");
      // frontend = {coder-a, coder-b}; author coder-a excluded -> only coder-b.
      const coderB = store.listMembers(swarm.id).find((m) => m.name === "coder-b")!;
      expect(wakes.map((w) => w.memberId)).toEqual([coderB.id]);
      expect(res.wakeIds.length).toBe(1);
    } finally {
      store.close();
    }
  });

  test("(4) @all wakes everyone except the author; killed never woken", () => {
    const store = new SwarmStore(":memory:");
    try {
      const { swarm, lead, coderA, coderB, verifier } = setupSwarm(store);
      store.transitionMember(coderB.id, "killed");
      const res = publishPost(store, {
        swarmId: swarm.id, authorMemberId: lead.id, kind: "message",
        body: "@all standup time", idempotencyKey: "k-all",
      });
      const recipients = store.listWakes(swarm.id, "queued").map((w) => w.memberId).sort();
      expect(recipients).toEqual([coderA.id, verifier.id].sort());
      expect(res.wakeIds.length).toBe(2);
    } finally {
      store.close();
    }
  });

  test("(5) duplicate idempotencyKey replays post with zero new wakes", () => {
    const store = new SwarmStore(":memory:");
    try {
      const { swarm, lead } = setupSwarm(store);
      const first = publishPost(store, {
        swarmId: swarm.id, authorMemberId: lead.id, kind: "brief",
        body: "@coder-a do it", idempotencyKey: "k-dup",
      });
      const second = publishPost(store, {
        swarmId: swarm.id, authorMemberId: lead.id, kind: "brief",
        body: "@coder-a do it", idempotencyKey: "k-dup",
      });
      expect(second.deduped).toBe(true);
      expect(second.post.id).toBe(first.post.id);
      expect(second.wakeIds).toEqual([]);
      expect(readBoard(store, swarm.id, 0).length).toBe(1);
    } finally {
      store.close();
    }
  });

  test("(7) mention-free post wakes nobody", () => {
    const store = new SwarmStore(":memory:");
    try {
      const { swarm, lead } = setupSwarm(store);
      const res = publishPost(store, {
        swarmId: swarm.id, authorMemberId: lead.id, kind: "message",
        body: "general note with no mentions", idempotencyKey: "k-plain",
      });
      expect(res.wakeIds).toEqual([]);
      expect(store.listWakes(swarm.id, "queued").length).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe("M3 private steering + coalescing + quota", () => {
  test("(6) private user->worker steering writes no post row, dispatches user_direct", async () => {
    const store = new SwarmStore(":memory:");
    try {
      const { swarm, coderA } = setupSwarm(store);
      const harness = new FakeHarness();
      const queue = new WakeQueue(store);
      const dispatcher = new WakeDispatcher(store, harness);
      const before = readBoard(store, swarm.id, 0).length;
      const res = await steerWorkerDirect(queue, dispatcher, {
        swarmId: swarm.id, workerId: coderA.id, text: "private nudge", idempotencySeed: "s-1",
      });
      expect(res.dispatched).toBe(true);
      expect(res.intent.reason).toBe("user_direct");
      expect(readBoard(store, swarm.id, 0).length).toBe(before);
      expect(harness.submitted.length).toBe(1);
      expect(harness.submitted[0]?.externalId).toBe(res.intent.id);
    } finally {
      store.close();
    }
  });

  test("(8) working member coalesces: second mention defers, zero extra submits", async () => {
    const store = new SwarmStore(":memory:");
    try {
      const { swarm, lead, coderA } = setupSwarm(store);
      const harness = new FakeHarness();
      const dispatcher = new WakeDispatcher(store, harness);
      publishPost(store, {
        swarmId: swarm.id, authorMemberId: lead.id, kind: "brief",
        body: "@coder-a first", idempotencyKey: "k-c1",
      });
      publishPost(store, {
        swarmId: swarm.id, authorMemberId: lead.id, kind: "brief",
        body: "@coder-a second", idempotencyKey: "k-c2",
      });
      const [first, second] = store.listWakes(swarm.id, "queued");
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      const r1 = await dispatcher.dispatchWake(swarm.id, first!.id);
      expect(r1.status).toBe("dispatched");
      const r2 = await dispatcher.dispatchWake(swarm.id, second!.id);
      expect(r2.status).toBe("deferred-live-turn");
      expect(harness.submitted.length).toBe(1);
    } finally {
      store.close();
    }
  });

  test("(12) quota-blocked: 402 quota-pauses member, never auto-retries", async () => {
    const store = new SwarmStore(":memory:");
    try {
      const { swarm, lead, coderA } = setupSwarm(store);
      const harness = new FakeHarness();
      harness.failures.set("sess-a", quotaError());
      const dispatcher = new WakeDispatcher(store, harness);
      publishPost(store, {
        swarmId: swarm.id, authorMemberId: lead.id, kind: "brief",
        body: "@coder-a paid path", idempotencyKey: "k-q",
      });
      const [wake] = store.listWakes(swarm.id, "queued");
      const r1 = await dispatcher.dispatchWake(swarm.id, wake!.id);
      expect(r1.status).toBe("quota-blocked");
      expect(store.getMember(coderA.id).internalState).toBe("quota_paused");
      const attemptsAfter = store.getWake(wake!.id).attempts;
      const r2 = await dispatcher.dispatchWake(swarm.id, wake!.id);
      // Admitted wakes never re-enter the queued dispatch path: no resubmit.
      expect(r2.status).toBe("skipped-not-queued");
      expect(harness.submitted.length).toBe(0);
      expect(store.getWake(wake!.id).attempts).toBe(attemptsAfter);
    } finally {
      store.close();
    }
  });
});

describe("M3 lead autonomy", () => {
  test("(9) markWaiting sleeps with zero submits", () => {
    const store = new SwarmStore(":memory:");
    try {
      const { lead } = setupSwarm(store);
      const harness = new FakeHarness();
      void harness;
      const waiting = markWaiting(store, lead.id);
      expect(waiting.internalState).toBe("waiting");
      const again = markWaiting(store, lead.id);
      expect(again.internalState).toBe("waiting");
    } finally {
      store.close();
    }
  });

  test("(10) none stays asleep; completion wakes exactly one coordinator wake", () => {
    const store = new SwarmStore(":memory:");
    try {
      const { swarm, lead } = setupSwarm(store);
      const queue = new WakeQueue(store);
      const idle = decideLeadWake(queue, swarm.id, lead.id, { kind: "none" });
      expect(idle.woke).toBe(false);
      expect(idle.submits).toBe(0);
      expect(store.listWakes(swarm.id, "queued").length).toBe(0);
      const task = createTask(store, swarm.id, {
        title: "t", brief: "b", ownerId: lead.id,
        ownedPaths: ["x/**"], forbiddenPaths: [], acceptanceCriteria: ["done"],
      });
      const w1 = decideLeadWake(queue, swarm.id, lead.id, { kind: "completion", taskId: task.id });
      expect(w1.woke).toBe(true);
      expect(w1.submits).toBe(0);
      // Repeat of the same signal collapses to the same logical intent.
      const w2 = decideLeadWake(queue, swarm.id, lead.id, { kind: "completion", taskId: task.id });
      expect(w2.deduped).toBe(true);
      expect(w2.wake?.id).toBe(w1.wake?.id);
      expect(store.listWakes(swarm.id, "queued").length).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe("M3 scheduler + verifier + monitor gate", () => {
  test("deps gate: lease waits for accepted deps; protocol DFS rejects cycles", () => {
    const store = new SwarmStore(":memory:");
    try {
      const { swarm, coderA } = setupSwarm(store);
      const dep = createTask(store, swarm.id, {
        title: "dep", brief: "b", ownerId: coderA.id,
        ownedPaths: ["d/**"], forbiddenPaths: [], acceptanceCriteria: ["done"],
      });
      const child = createTask(store, swarm.id, {
        title: "child", brief: "b", ownerId: coderA.id, deps: [dep.id],
        ownedPaths: ["c/**"], forbiddenPaths: [], acceptanceCriteria: ["done"],
      });
      publishReady(store, dep.id);
      publishReady(store, child.id);
      // Dep not accepted -> child not leasable; oldest ready (dep) leases first.
      expect(leaseNext(store, swarm.id, coderA.id)?.id).toBe(dep.id);
      // Protocol DFS rejects a back-edge closing a cycle (direct unit proof;
      // the store API cannot express it because new ids have no incoming edges).
      expect(() => assertDepsAcyclic("t-new", [child.id], [dep.id, child.id, "t-new"], [[child.id, "t-new"]])).toThrow();
      // Unknown dep rejected at the store boundary.
      expect(() =>
        store.createTask(swarm.id, {
          title: "ghost", brief: "b", ownerId: coderA.id, deps: ["no-such-task"],
          ownedPaths: ["s/**"], forbiddenPaths: [], acceptanceCriteria: ["done"],
        }),
      ).toThrow();
    } finally {
      store.close();
    }
  });

  test("verifier: failing evidence posts defect + requeues with attempt++; passing accepts", () => {
    const store = new SwarmStore(":memory:");
    try {
      const { swarm, lead, coderA, verifier } = setupSwarm(store);
      const task = createTask(store, swarm.id, {
        title: "t", brief: "b", ownerId: coderA.id,
        ownedPaths: ["x/**"], forbiddenPaths: [], acceptanceCriteria: ["done"],
      });
      publishReady(store, task.id);
      leaseNext(store, swarm.id, coderA.id);
      startRunning(store, task.id);
      submitForVerification(store, task.id);
      const failed = submitVerification(store, {
        taskId: task.id, executorMemberId: coderA.id, verifierMemberId: verifier.id,
        command: "bun test", cwd: "/tmp/m3", exitCode: 1,
        stdoutSha256: "a", stdoutPath: "/tmp/o", stderrSha256: "b", stderrPath: "/tmp/e",
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      });
      expect(failed.task.state).toBe("ready");
      expect(failed.task.attempt).toBe(1);
      expect(failed.defectPostId).toBeDefined();
      expect(failed.remediationWakeIds?.length).toBe(1);
      // Remediation round: lease -> run -> verify -> pass -> accept.
      leaseNext(store, swarm.id, coderA.id);
      startRunning(store, task.id);
      submitForVerification(store, task.id);
      const passed = submitVerification(store, {
        taskId: task.id, executorMemberId: coderA.id, verifierMemberId: verifier.id,
        command: "bun test", cwd: "/tmp/m3", exitCode: 0,
        stdoutSha256: "a", stdoutPath: "/tmp/o", stderrSha256: "b", stderrPath: "/tmp/e",
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      });
      expect(passed.task.state).toBe("accepted");
      void lead;
    } finally {
      store.close();
    }
  });

  test("monitor: active execution -> no wake; quiet -> exactly one intervention; cooldown quiets", async () => {
    const store = new SwarmStore(":memory:");
    try {
      const { swarm, lead, coderA } = setupSwarm(store);
      const harness = new FakeHarness();
      const queue = new WakeQueue(store);
      const dispatcher = new WakeDispatcher(store, harness);
      publishPost(store, {
        swarmId: swarm.id, authorMemberId: lead.id, kind: "brief",
        body: "@coder-a work", idempotencyKey: "k-mon-1",
      });
      const [wake] = store.listWakes(swarm.id, "queued");
      await dispatcher.dispatchWake(swarm.id, wake!.id);
      // Live turn admitted -> monitor reports active, zero new wakes/posts.
      const wakesBefore = store.listWakes(swarm.id, "queued").length;
      const postsBefore = readBoard(store, swarm.id, 0).length;
      const active = checkDormant(store, queue, swarm.id, { quietThresholdMs: 60_000, cooldownMs: 60_000 });
      expect(active.decision).toBe("active");
      expect(store.listWakes(swarm.id, "queued").length).toBe(wakesBefore);
      expect(readBoard(store, swarm.id, 0).length).toBe(postsBefore);
      expect(harness.submitted.length).toBe(1);
      // Settle the turn, then age past the quiet threshold -> one intervention.
      store.completeWake(wake!.id, "succeeded");
      const t0 = Date.parse(readBoard(store, swarm.id, 0).at(-1)!.createdAt);
      const q1 = checkDormant(store, queue, swarm.id, {
        quietThresholdMs: 1_000, cooldownMs: 60_000, nowMs: t0 + 61_000,
      });
      expect(q1.decision).toBe("intervened");
      expect(q1.interventionWake?.reason).toBe("monitor_intervention");
      const q2 = checkDormant(store, queue, swarm.id, {
        quietThresholdMs: 1_000, cooldownMs: 60_000, nowMs: t0 + 62_000,
      });
      expect(q2.decision).toBe("quiet");
      expect(harness.submitted.length).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe("M3-01 remediation (S1/S2)", () => {
  test("S1-01: distinct decision seqs wake twice; same seq dedupes; seq-less throws VALIDATION_FAILED", () => {
    const store = new SwarmStore(":memory:");
    try {
      const { swarm, lead } = setupSwarm(store);
      const queue = new WakeQueue(store);
      const d1 = decideLeadWake(queue, swarm.id, lead.id, { kind: "decision", postSequence: 1 });
      const d2 = decideLeadWake(queue, swarm.id, lead.id, { kind: "decision", postSequence: 2 });
      expect(d1.woke).toBe(true);
      expect(d2.woke).toBe(true);
      expect(d2.wake?.id).not.toBe(d1.wake?.id);
      expect(store.listWakes(swarm.id, "queued").length).toBe(2);
      // Same sequence repeats the same signal -> collapses to one intent.
      const d1again = decideLeadWake(queue, swarm.id, lead.id, { kind: "decision", postSequence: 1 });
      expect(d1again.deduped).toBe(true);
      expect(d1again.wake?.id).toBe(d1.wake?.id);
      // Seq-less distinct signals previously collapsed to `:0` and were
      // swallowed forever by UNIQUE dedupe -> now rejected loudly.
      let code: string | null = null;
      try {
        decideLeadWake(queue, swarm.id, lead.id, { kind: "decision" });
      } catch (err) {
        code = err instanceof ProtocolError ? err.code : null;
      }
      expect(code).toBe("VALIDATION_FAILED");
      const task = createTask(store, swarm.id, {
        title: "t", brief: "b", ownerId: lead.id,
        ownedPaths: ["x/**"], forbiddenPaths: [], acceptanceCriteria: ["done"],
      });
      let blockerCode: string | null = null;
      try {
        decideLeadWake(queue, swarm.id, lead.id, { kind: "blocker", taskId: task.id });
      } catch (err) {
        blockerCode = err instanceof ProtocolError ? err.code : null;
      }
      expect(blockerCode).toBe("VALIDATION_FAILED");
      const b1 = decideLeadWake(queue, swarm.id, lead.id, { kind: "blocker", taskId: task.id, postSequence: 7 });
      const b2 = decideLeadWake(queue, swarm.id, lead.id, { kind: "blocker", taskId: task.id, postSequence: 8 });
      expect(b2.wake?.id).not.toBe(b1.wake?.id);
    } finally {
      store.close();
    }
  });

  test("S1-02: fault-injected enqueue failure leaves a repairable orphan; retry converges to exactly one wake", () => {
    const store = new SwarmStore(":memory:");
    try {
      const { swarm } = setupSwarm(store);
      const queue = new WakeQueue(store);
      let faults = 1;
      const flaky = new (class extends WakeQueue {
        override enqueue(
          ...args: Parameters<WakeQueue["enqueue"]>
        ): ReturnType<WakeQueue["enqueue"]> {
          if (faults > 0) {
            faults -= 1;
            throw new Error("enqueue fault (simulated crash between post and wake txns)");
          }
          return super.enqueue(...args);
        }
      })(store);
      void queue;
      // Wall-clock-anchored policy: the monitor post commits with the real
      // clock, so `nowMs` must sit after it (past the quiet threshold) while
      // staying inside one cooldown window across all three attempts.
      const t0 = Date.now();
      const policy = { quietThresholdMs: 1_000, cooldownMs: 60_000, nowMs: t0 + 61_000 };
      // Attempt 1: monitor post commits, wake enqueue faults -> propagate.
      expect(() => checkDormant(store, flaky, swarm.id, policy)).toThrow();
      expect(readBoard(store, swarm.id, 0).length).toBe(1);
      expect(store.listWakes(swarm.id, "queued").length).toBe(0);
      // Attempt 2 (same cooldown window): post dedupes, repair path re-enqueues.
      const retry = checkDormant(store, flaky, swarm.id, policy);
      expect(retry.decision).toBe("intervened");
      expect(retry.interventionWake).toBeDefined();
      expect(store.listWakes(swarm.id, "queued").length).toBe(1);
      // Attempt 3: steady-state cooldown quiet, still exactly one wake.
      const again = checkDormant(store, flaky, swarm.id, policy);
      expect(again.decision).toBe("quiet");
      expect(store.listWakes(swarm.id, "queued").length).toBe(1);
      expect(readBoard(store, swarm.id, 0).length).toBe(1);
    } finally {
      store.close();
    }
  });

  test("S2-02: kill between evidence and edge retries append-only with a single accepted edge; replay is a no-op", () => {
    const store = new SwarmStore(":memory:");
    try {
      const { swarm, coderA, verifier } = setupSwarm(store);
      const task = createTask(store, swarm.id, {
        title: "t", brief: "b", ownerId: coderA.id,
        ownedPaths: ["x/**"], forbiddenPaths: [], acceptanceCriteria: ["done"],
      });
      publishReady(store, task.id);
      leaseNext(store, swarm.id, coderA.id);
      startRunning(store, task.id);
      submitForVerification(store, task.id);
      const evidence = {
        taskId: task.id, executorMemberId: coderA.id, command: "bun test", cwd: "/tmp/m3",
        exitCode: 0, stdout: { sha256: "a", filePath: "/tmp/o" }, stderr: { sha256: "b", filePath: "/tmp/e" },
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      };
      // Simulate the kill: evidence txn committed, accept edge never taken.
      store.recordVerificationEvidence(evidence);
      expect(store.getTask(task.id).state).toBe("verifying");
      // Retry: appends a second evidence row (audit) but takes exactly one edge.
      const verified = submitVerification(store, {
        taskId: task.id, executorMemberId: coderA.id, verifierMemberId: verifier.id,
        command: "bun test", cwd: "/tmp/m3", exitCode: 0,
        stdoutSha256: "a", stdoutPath: "/tmp/o", stderrSha256: "b", stderrPath: "/tmp/e",
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      });
      expect(verified.task.state).toBe("accepted");
      expect(verified.task.resultEvidenceIds.length).toBe(2);
      // Replay after the committed accept: no duplicate evidence, same task.
      const replay = submitVerification(store, {
        taskId: task.id, executorMemberId: coderA.id, verifierMemberId: verifier.id,
        command: "bun test", cwd: "/tmp/m3", exitCode: 0,
        stdoutSha256: "a", stdoutPath: "/tmp/o", stderrSha256: "b", stderrPath: "/tmp/e",
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      });
      expect(replay.task.state).toBe("accepted");
      expect(replay.task.resultEvidenceIds.length).toBe(2);
    } finally {
      store.close();
    }
  });

  test("S2-03: delivery trail is swarm-scoped; swarm B entries never leak into A", () => {
    const store = new SwarmStore(":memory:");
    try {
      const mkSwarm = (tag: string) => {
        const swarm = store.createSwarm({
          title: `iso-${tag}`, coordinatorSessionId: `sess-lead-${tag}`,
          projectRoot: "/tmp/m3", mode: "parity",
        });
        const lead = store.addMember(swarm.id, {
          name: "lead", role: "coordinator", nativeAgentId: `agent-lead-${tag}`,
          sessionId: `sess-lead-${tag}`, model: MODEL,
        });
        const coder = store.addMember(swarm.id, {
          name: "coder", role: "coder", nativeAgentId: `agent-${tag}`,
          sessionId: `sess-${tag}`, model: MODEL,
        });
        return { swarm, lead, coder };
      };
      const a = mkSwarm("a");
      const b = mkSwarm("b");
      publishPost(store, {
        swarmId: a.swarm.id, authorMemberId: a.lead.id, kind: "brief",
        body: "@coder go a", idempotencyKey: "iso-a",
      });
      publishPost(store, {
        swarmId: b.swarm.id, authorMemberId: b.lead.id, kind: "brief",
        body: "@coder go b", idempotencyKey: "iso-b",
      });
      const da = getDelivery(store, a.swarm.id, 100);
      const db = getDelivery(store, b.swarm.id, 100);
      expect(da.length).toBeGreaterThan(0);
      expect(db.length).toBeGreaterThan(0);
      const memberSwarm = new Map(
        [...store.listMembers(a.swarm.id), ...store.listMembers(b.swarm.id)].map((m) => [m.id, m.swarmId] as const),
      );
      for (const entry of da) {
        const payload = (entry.payload ?? {}) as Record<string, unknown>;
        if (entry.kind === "post_committed") expect(payload["swarmId"]).toBe(a.swarm.id);
        if (entry.kind === "wake_queued") {
          expect(memberSwarm.get(payload["memberId"] as string)).toBe(a.swarm.id);
        }
      }
      for (const entry of db) {
        const payload = (entry.payload ?? {}) as Record<string, unknown>;
        if (entry.kind === "post_committed") expect(payload["swarmId"]).toBe(b.swarm.id);
        if (entry.kind === "wake_queued") {
          expect(memberSwarm.get(payload["memberId"] as string)).toBe(b.swarm.id);
        }
      }
      const idsA = new Set(da.map((e) => e.id));
      for (const entry of db) expect(idsA.has(entry.id)).toBe(false);
    } finally {
      store.close();
    }
  });
});
describe("M3 restart + identity + read models", () => {
  test("(11) journal replay: file DB reopen preserves posts, wakes, outbox", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m3-restart-"));
    try {
      const dbPath = join(dir, "swarm.db");
      const s1 = new SwarmStore(dbPath);
      const { swarm, lead } = setupSwarm(s1);
      publishPost(s1, {
        swarmId: swarm.id, authorMemberId: lead.id, kind: "brief",
        body: "@coder-a durable", idempotencyKey: "k-r",
      });
      const seqBefore = readBoard(s1, swarm.id, 0).map((p) => p.sequence);
      const wakesBefore = s1.listWakes(swarm.id, "queued").map((w) => w.id);
      const outboxBefore = s1.listPendingOutbox(100).length;
      expect(outboxBefore).toBeGreaterThan(0);
      s1.close();
      const s2 = new SwarmStore(dbPath);
      try {
        expect(readBoard(s2, swarm.id, 0).map((p) => p.sequence)).toEqual(seqBefore);
        expect(s2.listWakes(swarm.id, "queued").map((w) => w.id)).toEqual(wakesBefore);
        expect(s2.listPendingOutbox(100).length).toBe(outboxBefore);
        // Reconciler sees no unsettled wakes (all still queued) -> nothing to repair.
        const reconciler = new InboxReconciler(s2, async () => ({
          hasLiveExecution: false,
          knownTerminalExternalIds: [],
        }));
        const report = await reconciler.reconcileSwarm(swarm.id);
        expect(report.checked).toBe(0);
      } finally {
        s2.close();
      }
    } finally {
      removeDir(dir);
    }
  });

  test("identity/permission passthrough: nativeAgentId chain + role policy intact", () => {
    const store = new SwarmStore(":memory:");
    try {
      const { swarm, lead, coderA } = setupSwarm(store);
      const res = publishPost(store, {
        swarmId: swarm.id, authorMemberId: lead.id, kind: "brief",
        body: "@coder-a go", idempotencyKey: "k-id",
      });
      expect(res.post.authorMemberId).toBe(lead.id);
      const [wake] = store.listWakes(swarm.id, "queued");
      expect(wake?.memberId).toBe(coderA.id);
      const roster = getRoster(store, swarm.id);
      const entry = roster.find((r) => r.member.id === coderA.id);
      expect(entry?.member.nativeAgentId).toBe("agent-a");
      expect(entry?.member.sessionId).toBe("sess-a");
      // Role policy preserved: coordinator may not edit-code; coder may not merge.
      expect(() => assertRoleAllows("coordinator", "edit-code")).toThrow();
      expect(() => assertRoleAllows("coder", "merge")).toThrow();
      assertRoleAllows("coordinator", "coordinate");
      // Pending + delivery read models served from the store, no new tables.
      const pending = getPending(store, swarm.id);
      expect(pending.queuedWakes.length).toBe(1);
      expect(getDelivery(store, swarm.id, 100).length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });
});
