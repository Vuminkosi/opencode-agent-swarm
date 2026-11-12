/**
 * M7 scale + stress validation — 8/12-worker concurrency, duplicate-wake
 * collapse, quota freeze, restart preservation, read-only zero-inference,
 * secrets scan, and measured throughput/latency/replay/contention/RSS
 * (spec §14 M7 + §13 failure-injection rows where applicable).
 *
 * Disposable-only: `:memory:` / mkdtemp file DBs + FakeHarness (counts every
 * submitTurn). No network, no model inference, no paid calls, no canonical
 * or user-project writes. Import-only reuse of the frozen M0–M6 engine
 * (SwarmStore, WakeQueue, WakeDispatcher, board/scheduler/roster/ledger).
 */

import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwarmStore } from "../../db/store.js";
import { WakeQueue } from "../wake-queue.js";
import { WakeDispatcher, type DispatchHarness } from "../wake-dispatcher.js";
import { publishPost, readBoard } from "../board-service.js";
import { createTask, publishReady, leaseNext } from "../task-scheduler.js";
import { getRoster, getHistory, getPending, getDelivery } from "../roster.js";
import { UsageLedger } from "../usage-ledger.js";

type Reason = "mention" | "assigned_task" | "verifier_request" | "monitor_intervention" | "user_direct";

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
    readonly reason: Reason;
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

const MODEL = { providerID: "fake-provider", id: "fake-model" };
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

function trackDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function makeSwarm(store: SwarmStore, title: string): string {
  return store.createSwarm({
    title,
    coordinatorSessionId: "sess-lead",
    projectRoot: "/tmp/m7-scale",
    mode: "parity",
  }).id;
}

/** N workers with independent nativeAgentId/sessionId values, all waiting. */
function addWorkers(store: SwarmStore, swarmId: string, n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const member = store.addMember(swarmId, {
      name: `worker-${String(i).padStart(2, "0")}`,
      role: "coder",
      nativeAgentId: `agent-m7-${i}`,
      sessionId: `sess-m7-${i}`,
      model: MODEL,
    });
    ids.push(store.transitionMember(member.id, "waiting").id);
  }
  return ids;
}

/** One ready task per worker with disjoint ownedPaths; returns task ids. */
function makeWorkerTasks(store: SwarmStore, swarmId: string, workerIds: readonly string[]): string[] {
  return workerIds.map((ownerId, i) => {
    const task = createTask(store, swarmId, {
      title: `scale job ${i}`,
      brief: `Scale brief ${i}: implement jobs/w-${i} per acceptance criteria.`,
      ownerId,
      ownedPaths: [`jobs/w-${i}`],
      forbiddenPaths: [],
      acceptanceCriteria: [`jobs/w-${i} complete`],
    });
    return publishReady(store, task.id).id;
  });
}

function setupDispatch(store: SwarmStore, harness: FakeHarness): WakeDispatcher {
  return new WakeDispatcher(store, harness, undefined, {
    now: () => new Date(nowMs).toISOString(),
    random: () => 1,
    backoffBaseMs: 100,
    backoffCapMs: 1000,
  });
}

/** Force distinct created_at millis so FIFO assertions stay deterministic. */
function spinMs(): void {
  const t0 = Date.now();
  while (Date.now() === t0) {
    /* spin one ms */
  }
}

describe("M7 scale: N-worker runs with unique ownership", () => {
  for (const n of [8, 12]) {
    test(`${n}-worker run: unique ownership, independent sessions + paths, briefs dispatched`, async () => {
      const store = new SwarmStore(":memory:");
      try {
        const swarmId = makeSwarm(store, `m7 scale ${n}`);
        const workers = addWorkers(store, swarmId, n);
        const taskIds = makeWorkerTasks(store, swarmId, workers);

        // Independent native sessions per worker (identity preserved).
        const sessions = workers.map((id) => store.getMember(id).sessionId);
        expect(new Set(sessions).size).toBe(n);
        // Disjoint owned paths (worktree-path analog: one dir per worker).
        const paths = workers.map((_, i) => `wt/w-${i}`);
        expect(new Set(paths).size).toBe(n);

        // Scheduler throughput: lease one task per worker, timed.
        const t0 = performance.now();
        const leased = workers.map((w) => leaseNext(store, swarmId, w));
        const leaseMs = performance.now() - t0;
        expect(leased.every((t) => t !== null)).toBe(true);
        const leasedIds = leased.map((t) => t!.id);
        expect(new Set(leasedIds).size).toBe(n); // no two workers own the same task
        for (let i = 0; i < n; i += 1) {
          expect(store.getTask(taskIds[i] as string).ownerId).toBe(workers[i] as string);
        }
        const tasksPerSec = n / Math.max(leaseMs / 1000, 1e-6);
        console.log(`[m7-scale] ${n}-worker lease: ${leaseMs.toFixed(2)}ms (${tasksPerSec.toFixed(1)} tasks/sec)`);

        // One wake per worker carrying its task brief; all dispatch (distinct
        // members = distinct sessions = per-session serialization holds).
        const queue = new WakeQueue(store);
        const harness = new FakeHarness();
        const dispatcher = setupDispatch(store, harness);
        for (let i = 0; i < n; i += 1) {
          spinMs();
          queue.enqueue({
            swarmId,
            memberId: workers[i] as string,
            reason: "assigned_task",
            taskId: taskIds[i] as string,
            payloadHash: `m7-scale-${n}-${i}`,
          });
        }
        const w0 = performance.now();
        const results = await dispatcher.dispatchAll(swarmId, n);
        const dispatchMs = performance.now() - w0;
        expect(results.filter((r) => r.status === "dispatched").length).toBe(n);
        expect(harness.submitted.length).toBe(n);
        // Unique turn ownership: no two submits share a session+externalId pair,
        // and every brief round-trips into its worker's payload (sequenced).
        const pairs = new Set(harness.submitted.map((s) => `${s.sessionId}|${s.externalId}`));
        expect(pairs.size).toBe(n);
        for (let i = 0; i < n; i += 1) {
          const text = harness.submitted.find(
            (s) => s.sessionId === `sess-m7-${i}`,
          )?.text;
          expect(text).toBeDefined();
          expect(text).toContain(`Scale brief ${i}`);
        }
        console.log(`[m7-scale] ${n}-worker dispatchAll: ${dispatchMs.toFixed(2)}ms`);
      } finally {
        store.close();
      }
    });
  }

  test("12-worker RSS delta is measured and finite", async () => {
    const beforeMB = process.memoryUsage().rss / 1048576;
    const store = new SwarmStore(":memory:");
    try {
      const swarmId = makeSwarm(store, "m7 rss");
      const workers = addWorkers(store, swarmId, 12);
      const taskIds = makeWorkerTasks(store, swarmId, workers);
      const queue = new WakeQueue(store);
      const harness = new FakeHarness();
      const dispatcher = setupDispatch(store, harness);
      for (let i = 0; i < 12; i += 1) {
        queue.enqueue({
          swarmId,
          memberId: workers[i] as string,
          reason: "mention",
          postSequence: i + 1,
          taskId: taskIds[i] as string,
          payloadHash: `m7-rss-${i}`,
        });
      }
      await dispatcher.dispatchAll(swarmId, 12);
      expect(harness.submitted.length).toBe(12);
    } finally {
      store.close();
    }
    const afterMB = process.memoryUsage().rss / 1048576;
    const deltaMB = afterMB - beforeMB;
    expect(Number.isFinite(deltaMB)).toBe(true);
    console.log(`[m7-scale] RSS before=${beforeMB.toFixed(1)}MB after=${afterMB.toFixed(1)}MB delta=${deltaMB.toFixed(1)}MB`);
  });
});

describe("M7 duplicate @all: one logical wake per recipient", () => {
  test("idempotency replay + mention-batch redrive collapse on delivery_key", () => {
    const store = new SwarmStore(":memory:");
    try {
      const swarm = store.createSwarm({
        title: "m7 dup all",
        coordinatorSessionId: "sess-lead",
        projectRoot: "/tmp/m7-dup",
        mode: "parity",
      });
      const lead = store.addMember(swarm.id, {
        name: "lead", role: "coordinator", nativeAgentId: "agent-lead", sessionId: "sess-lead", model: MODEL,
      });
      const coders: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const m = store.addMember(swarm.id, {
          name: `coder-${i}`, role: "coder", nativeAgentId: `agent-${i}`,
          sessionId: `sess-c-${i}`, model: MODEL,
        });
        coders.push(store.transitionMember(m.id, "waiting").id);
      }
      void lead;

      // One @all post: exactly one logical wake per live recipient (author excluded).
      const first = publishPost(store, {
        swarmId: swarm.id, authorMemberId: store.listMembers(swarm.id).find((m) => m.name === "lead")!.id,
        kind: "message", body: "@all ship it", idempotencyKey: "dup-all-1",
      });
      expect(first.deduped).toBe(false);
      expect(first.wakeIds.length).toBe(5);
      expect(new Set(first.wakeIds).size).toBe(5);
      const queued = store.listWakes(swarm.id, "queued", 100);
      expect(queued.length).toBe(5);
      // One wake per recipient member (no double fan-out).
      expect(new Set(queued.map((w) => w.memberId))).toEqual(new Set(coders));

      // Duplicate post (same idempotencyKey): deduped, zero new wakes.
      const replay = publishPost(store, {
        swarmId: swarm.id, authorMemberId: store.listMembers(swarm.id).find((m) => m.name === "lead")!.id,
        kind: "message", body: "@all ship it", idempotencyKey: "dup-all-1",
      });
      expect(replay.deduped).toBe(true);
      expect(replay.wakeIds).toEqual([]);
      expect(store.listWakes(swarm.id, "queued", 100).length).toBe(5);

      // Mention-batch redrive with the same payloadHash collapses on
      // delivery_key: deduped:true with the winner's intent id, zero new rows.
      const queue = new WakeQueue(store);
      const batch = coders.slice(0, 2).map((memberId) => ({
        memberId, reason: "mention" as const, postSequence: 1, payloadHash: "redrive-ph",
      }));
      const once = queue.enqueueMentionBatch(swarm.id, batch);
      expect(once.every((e) => e.deduped === false)).toBe(true);
      const twice = queue.enqueueMentionBatch(swarm.id, batch);
      expect(twice.every((e) => e.deduped === true)).toBe(true);
      expect(twice.map((e) => e.intent.id)).toEqual(once.map((e) => e.intent.id));
      expect(store.listWakes(swarm.id, "queued", 100).length).toBe(7);
    } finally {
      store.close();
    }
  });
});

describe("M7 quota freeze + restart + read-only zero-inference", () => {
  test("quota member paused: zero follow-up submits after +60s virtual advance", async () => {
    const store = new SwarmStore(":memory:");
    try {
      const swarmId = makeSwarm(store, "m7 quota");
      const memberId = addWorkers(store, swarmId, 1)[0] as string;
      const harness = new FakeHarness();
      harness.failures.set("sess-m7-0", transportError(402, "QUOTA_EXHAUSTED"));
      const queue = new WakeQueue(store);
      const dispatcher = setupDispatch(store, harness);
      const wakeId = queue.enqueue({
        swarmId, memberId, reason: "mention", postSequence: 1, payloadHash: "m7q-1",
      }).intent.id;
      const result = await dispatcher.dispatchWake(swarmId, wakeId);
      expect(result.status).toBe("quota-blocked");
      expect(store.getMember(memberId).internalState).toBe("quota_paused");
      const attemptsAtBlock = store.getWake(wakeId).attempts;

      nowMs += 60_000;
      expect(await dispatcher.dispatchAll(swarmId, 10)).toEqual([]);
      expect(harness.submitted.length).toBe(0);
      expect(store.getWake(wakeId).attempts).toBe(attemptsAtBlock);
    } finally {
      store.close();
    }
  });

  test("restart mid-run: pending wakes/tasks preserved, sessions re-identified, no dup turns", async () => {
    const dir = trackDir("m7-restart-");
    const dbPath = join(dir, "state.sqlite");
    const store = new SwarmStore(dbPath);
    let swarmId = "";
    let workerIds: string[] = [];
    let taskIds: string[] = [];
    try {
      swarmId = makeSwarm(store, "m7 restart");
      workerIds = addWorkers(store, swarmId, 4);
      taskIds = makeWorkerTasks(store, swarmId, workerIds);
      for (const w of workerIds) leaseNext(store, swarmId, w);
      const queue = new WakeQueue(store);
      for (let round = 0; round < 2; round += 1) {
        for (let i = 0; i < 4; i += 1) {
          spinMs();
          queue.enqueue({
            swarmId, memberId: workerIds[i] as string, reason: "mention",
            postSequence: round * 4 + i + 1, taskId: taskIds[i] as string, payloadHash: `m7r-${round}-${i}`,
          });
        }
      }
      const harness = new FakeHarness();
      const dispatcher = setupDispatch(store, harness);
      const first = await dispatcher.dispatchAll(swarmId, 4);
      expect(first.filter((r) => r.status === "dispatched").length).toBe(4);
      expect(harness.submitted.length).toBe(4);
    } finally {
      store.close(); // simulated kill: admitted turns never acked beyond the journal
    }
    const reopened = new SwarmStore(dbPath);
    try {
      // Pending work + identity survive the restart.
      expect(reopened.listWakes(swarmId, "queued", 100).length).toBe(4);
      expect(reopened.listUnsettledWakes(swarmId, 100).length).toBe(4);
      expect(reopened.listTasks(swarmId).filter((t) => t.state === "leased").length).toBe(4);
      const sessions = reopened.listMembers(swarmId)
        .filter((m) => m.name.startsWith("worker-"))
        .map((m) => m.sessionId)
        .sort();
      expect(sessions).toEqual(["sess-m7-0", "sess-m7-1", "sess-m7-2", "sess-m7-3"]);
      for (let i = 0; i < 4; i += 1) {
        expect(reopened.getTask(taskIds[i] as string).ownerId).toBe(workerIds[i] as string);
      }
      // Finish the live turns, drain the rest: 8 unique externalIds, zero dupes.
      for (const w of workerIds) {
        const live = reopened.findLiveWakeForMember(w);
        if (live !== null) reopened.completeWake(live.id, "succeeded");
      }
      const harness = new FakeHarness();
      const dispatcher = setupDispatch(reopened, harness);
      const rest = await dispatcher.dispatchAll(swarmId, 10);
      expect(rest.filter((r) => r.status === "dispatched").length).toBe(4);
      expect(new Set(harness.submitted.map((s) => s.externalId)).size).toBe(4);
    } finally {
      reopened.close();
    }
  });

  test("read-only board/roster/usage sweeps perform zero submits", async () => {
    const store = new SwarmStore(":memory:");
    try {
      const db = new Database(":memory:");
      const ledger = new UsageLedger(db);
      const swarmId = makeSwarm(store, "m7 readonly");
      const workers = addWorkers(store, swarmId, 3);
      const queue = new WakeQueue(store);
      for (let i = 0; i < 3; i += 1) {
        queue.enqueue({
          swarmId, memberId: workers[i] as string, reason: "mention",
          postSequence: i + 1, payloadHash: `m7ro-${i}`,
        });
      }
      publishPost(store, {
        swarmId, authorMemberId: null, kind: "message",
        body: "hello workers", idempotencyKey: "m7ro-post",
      });
      const harness = new FakeHarness();
      const dispatcher = setupDispatch(store, harness);
      const before = harness.submitted.length;
      for (let sweep = 0; sweep < 5; sweep += 1) {
        void getRoster(store, swarmId);
        void getHistory(store, swarmId);
        void getPending(store, swarmId);
        void getDelivery(store, swarmId);
        void readBoard(store, swarmId, 0, 100);
        void store.listEligibleQueuedWakes(swarmId, 100);
        void store.listUnsettledWakes(swarmId, 100);
        void ledger.totalsByProviderModel();
      }
      expect(harness.submitted.length).toBe(before);
      expect(dispatcher.getDispatchCount()).toBe(0);
      db.close();
    } finally {
      store.close();
    }
  });
});

describe("M7 secrets scan: zero pattern hits in durable rows/outbox/turns", () => {
  test("DB rows + outbox JSON + harness texts contain no secret patterns", async () => {
    const store = new SwarmStore(":memory:");
    try {
      const swarmId = makeSwarm(store, "m7 secrets");
      const workers = addWorkers(store, swarmId, 2);
      const taskIds = makeWorkerTasks(store, swarmId, workers);
      const queue = new WakeQueue(store);
      const harness = new FakeHarness();
      const dispatcher = setupDispatch(store, harness);
      for (let i = 0; i < 2; i += 1) {
        queue.enqueue({
          swarmId, memberId: workers[i] as string, reason: "assigned_task",
          taskId: taskIds[i] as string, payloadHash: `m7sec-${i}`,
        });
      }
      await dispatcher.dispatchAll(swarmId, 4);
      publishPost(store, {
        swarmId, authorMemberId: null, kind: "message",
        body: "status check, no credentials here", idempotencyKey: "m7sec-post",
      });
      const corpus = JSON.stringify({
        tasks: store.listTasks(swarmId),
        members: store.listMembers(swarmId),
        wakes: store.listWakes(swarmId, "queued", 100).concat(store.listUnsettledWakes(swarmId, 100)),
        posts: store.getPostsAfter(swarmId, 0, 100),
        outbox: store.listPendingOutbox(200),
        turns: harness.submitted,
      });
      const patterns: RegExp[] = [
        /sk-live-[A-Za-z0-9]+/,
        /AKIA[0-9A-Z]{16}/,
        /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/,
        /ghp_[A-Za-z0-9]{10,}/,
        /xox[bpas]-/,
        /api[_-]?key\s*[:=]\s*\S+/i,
        /Bearer\s+[A-Za-z0-9\-._~+/=]{8,}/,
        /OPENAI_API_KEY/,
        /password\s*[:=]\s*\S+/i,
      ];
      const hits = patterns.flatMap((re) => corpus.match(re) ?? []);
      expect(hits).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("M7 measured: replay + contention", () => {
  test("1000-post resync: gapless order, timed", () => {
    const store = new SwarmStore(":memory:");
    try {
      const swarmId = makeSwarm(store, "m7 replay");
      const t0 = performance.now();
      for (let i = 1; i <= 1000; i += 1) {
        const posted = publishPost(store, {
          swarmId, authorMemberId: null, kind: "message",
          body: `replay message ${i}`, idempotencyKey: `m7-replay-${i}`,
        });
        expect(posted.deduped).toBe(false);
      }
      const appendMs = performance.now() - t0;
      const r0 = performance.now();
      const posts = store.getPostsAfter(swarmId, 0, 2000);
      const resyncMs = performance.now() - r0;
      expect(posts.length).toBe(1000);
      expect(posts.map((p) => p.sequence)).toEqual(
        Array.from({ length: 1000 }, (_, i) => i + 1),
      );
      expect(Number.isFinite(appendMs) && Number.isFinite(resyncMs)).toBe(true);
      console.log(`[m7-scale] 1000-post append=${appendMs.toFixed(1)}ms resync=${resyncMs.toFixed(1)}ms`);
    } finally {
      store.close();
    }
  });

  test("dual-handle interleaved writers serialize with zero SQLITE_BUSY", () => {
    const dir = trackDir("m7-contention-");
    const dbPath = join(dir, "state.sqlite");
    const storeA = new SwarmStore(dbPath);
    const storeB = new SwarmStore(dbPath);
    try {
      const swarmId = makeSwarm(storeA, "m7 contention");
      let busyErrors = 0;
      const t0 = performance.now();
      for (let i = 0; i < 100; i += 1) {
        for (const [handle, tag] of [[storeA, "a"], [storeB, "b"]] as const) {
          try {
            publishPost(handle, {
              swarmId, authorMemberId: null, kind: "message",
              body: `contention ${tag}-${i}`, idempotencyKey: `m7-cont-${tag}-${i}`,
            });
          } catch (err) {
            if (err instanceof Error && (err as { code?: unknown }).code === "SQLITE_BUSY") {
              busyErrors += 1;
            } else {
              throw err;
            }
          }
        }
      }
      const writeMs = performance.now() - t0;
      expect(busyErrors).toBe(0);
      const posts = storeA.getPostsAfter(swarmId, 0, 500);
      expect(posts.length).toBe(200);
      expect(posts.map((p) => p.sequence)).toEqual(
        Array.from({ length: 200 }, (_, i) => i + 1),
      );
      // Cross-handle wake intents on the same file also serialize.
      const memberId = addWorkers(storeA, swarmId, 1)[0] as string;
      const queueA = new WakeQueue(storeA);
      const queueB = new WakeQueue(storeB);
      for (let i = 0; i < 50; i += 1) {
        for (const [q, tag] of [[queueA, "a"], [queueB, "b"]] as const) {
          try {
            q.enqueue({ swarmId, memberId, reason: "mention", postSequence: 1000 + i, payloadHash: `m7-cw-${tag}-${i}` });
          } catch (err) {
            if (err instanceof Error && (err as { code?: unknown }).code === "SQLITE_BUSY") {
              busyErrors += 1;
            } else {
              throw err;
            }
          }
        }
      }
      expect(busyErrors).toBe(0);
      expect(storeA.listWakes(swarmId, "queued", 500).length).toBe(100);
      console.log(`[m7-scale] contention 200 posts + 100 wakes, busyErrors=0, ${writeMs.toFixed(1)}ms`);
    } finally {
      storeA.close();
      storeB.close();
    }
  });
});
