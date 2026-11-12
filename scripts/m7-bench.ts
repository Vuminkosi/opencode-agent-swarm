/**
 * M7 benchmark runner — measured scale/stress evidence for 8–12 worker
 * concurrency (spec §14 M7). Disposable-only: mkdtemp roots under the OS
 * tmp dir, file or `:memory:` DBs, FakeHarness (counts every submitTurn).
 * No network, no model inference, no paid calls, no canonical or
 * user-project writes. Import-only reuse of the frozen M0–M6 engine.
 *
 * Usage:
 *   bun scripts/m7-bench.ts --dry-run      # print the plan, do zero work
 *   bun scripts/m7-bench.ts [--out <dir>]  # full run, report JSON to tmp
 *
 * The report JSON is written to `<out>/m7-bench-report.json` (default: a
 * fresh mkdtemp dir under os.tmpdir()). The path is printed on stdout.
 * Intermediate repos/DBs are removed; the report dir is retained.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SwarmStore } from "../packages/runtime/src/db/store.ts";
import { WakeQueue } from "../packages/runtime/src/services/wake-queue.ts";
import { WakeDispatcher, type DispatchHarness } from "../packages/runtime/src/services/wake-dispatcher.ts";
import { publishPost } from "../packages/runtime/src/services/board-service.ts";
import { createTask, publishReady, leaseNext } from "../packages/runtime/src/services/task-scheduler.ts";
import { getRoster, getHistory, getPending, getDelivery } from "../packages/runtime/src/services/roster.ts";
import { IntegrationService, loadM4Surfaces } from "../packages/runtime/src/services/integration.ts";

type Reason = "mention" | "assigned_task" | "verifier_request" | "monitor_intervention" | "user_direct";

class FakeHarness implements DispatchHarness {
  submitted: Array<{ sessionId: string; text: string; externalId: string }> = [];
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
    this.submitted.push({ sessionId: request.sessionId, text: request.text, externalId: request.externalId });
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
let nowMs = Date.parse("2026-11-11T00:00:00.000Z");

function gitSync(cwd: string, ...args: string[]): string {
  const out = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${out.stderr.toString().slice(0, 300)}`);
  }
  return out.stdout.toString().trim();
}

const PLAN = [
  "scheduler-throughput: 12 workers x 10 tasks, timed leaseNext drain",
  "wake-latency: 20x publishPost->dispatchWake, median ms",
  "event-replay: 1000-post append + full resync, ms + gapless check",
  "sqlite-contention: dual-handle 200 interleaved posts, busy-error count",
  "memory-rss: 12-worker setup+dispatch delta MB",
  "integration-safety: tmp repo, 4-way parallel integrates + dup-dedupe",
  "gates: dup-collapse, quota-freeze(+60s), restart-preserved, read-only-zero-submits, secrets-scan",
] as const;

interface BenchReport {
  generatedAt: string;
  baseline: { gitSha: string | null; bun: string; platform: string };
  mode: "full";
  results: Record<string, unknown>;
  gates: Record<string, boolean>;
}

function gitShaBestEffort(): string | null {
  try {
    return gitSync(process.cwd(), "rev-parse", "HEAD");
  } catch {
    return null;
  }
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--dry-run")) {
    console.log(JSON.stringify({ mode: "dry-run", plan: PLAN, writes: "none (tmp-only on full run)" }, null, 2));
    return;
  }
  const outFlag = args.indexOf("--out");
  const root = outFlag >= 0 && args[outFlag + 1] !== undefined
    ? (args[outFlag + 1] as string)
    : mkdtempSync(join(tmpdir(), "m7-bench-"));
  const results: Record<string, unknown> = {};
  const gates: Record<string, boolean> = {};
  const subdirs: string[] = [];
  const mkSub = (name: string): string => {
    const d = mkdtempSync(join(tmpdir(), `m7-bench-${name}-`));
    subdirs.push(d);
    return d;
  };

  // --- scheduler throughput (12 workers x 10 tasks) ---
  {
    const store = new SwarmStore(":memory:");
    try {
      const swarmId = store.createSwarm({
        title: "m7 bench sched", coordinatorSessionId: "sess-lead",
        projectRoot: "/tmp/m7-bench", mode: "parity",
      }).id;
      const workers: string[] = [];
      for (let i = 0; i < 12; i += 1) {
        const m = store.addMember(swarmId, {
          name: `bw-${i}`, role: "coder", nativeAgentId: `agent-bw-${i}`,
          sessionId: `sess-bw-${i}`, model: MODEL,
        });
        workers.push(store.transitionMember(m.id, "waiting").id);
      }
      for (const w of workers) {
        for (let k = 0; k < 10; k += 1) {
          const t = createTask(store, swarmId, {
            title: `bench job ${w}-${k}`, brief: `Bench brief ${k} for ${w}.`,
            ownerId: w, ownedPaths: [`bench/${w}/${k}`], forbiddenPaths: [],
            acceptanceCriteria: ["done"],
          });
          publishReady(store, t.id);
        }
      }
      const t0 = performance.now();
      let leased = 0;
      for (const w of workers) {
        for (;;) {
          const next = leaseNext(store, swarmId, w);
          if (next === null) break;
          leased += 1;
        }
      }
      const ms = performance.now() - t0;
      results["schedulerThroughput"] = {
        tasks: leased, workers: 12, ms: Number(ms.toFixed(2)),
        tasksPerSec: Number((leased / Math.max(ms / 1000, 1e-6)).toFixed(1)),
      };
      gates["schedulerUniqueOwnership"] = leased === 120;
    } finally {
      store.close();
    }
  }

  // --- wake latency: post-commit -> dispatch decision (median of 20) ---
  {
    const store = new SwarmStore(":memory:");
    try {
      const swarmId = store.createSwarm({
        title: "m7 bench latency", coordinatorSessionId: "sess-lead",
        projectRoot: "/tmp/m7-bench", mode: "parity",
      }).id;
      const m = store.addMember(swarmId, {
        name: "bw-0", role: "coder", nativeAgentId: "agent-bw-0",
        sessionId: "sess-bw-0", model: MODEL,
      });
      const worker = store.transitionMember(m.id, "waiting").id;
      const harness = new FakeHarness();
      const dispatcher = new WakeDispatcher(store, harness, undefined, {
        now: () => new Date(nowMs).toISOString(), random: () => 1,
      });
      const queue = new WakeQueue(store);
      const samples: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        const wakeId = queue.enqueue({
          swarmId, memberId: worker, reason: "mention",
          postSequence: i + 1, payloadHash: `bench-lat-${i}`,
        }).intent.id;
        const t0 = performance.now();
        const r = await dispatcher.dispatchWake(swarmId, wakeId);
        samples.push(performance.now() - t0);
        if (r.status !== "dispatched") throw new Error(`unexpected dispatch status ${r.status}`);
        store.completeWake(wakeId, "succeeded");
      }
      results["wakeLatencyMs"] = {
        runs: 20, median: Number(median(samples).toFixed(3)),
        p95: Number(samples.slice().sort((a, b) => a - b)[Math.min(18, samples.length - 1)]!.toFixed(3)),
      };
      gates["wakeLatencyMeasured"] = samples.every((s) => Number.isFinite(s));
    } finally {
      store.close();
    }
  }

  // --- event replay: 1000 posts ---
  {
    const store = new SwarmStore(":memory:");
    try {
      const swarmId = store.createSwarm({
        title: "m7 bench replay", coordinatorSessionId: "sess-lead",
        projectRoot: "/tmp/m7-bench", mode: "parity",
      }).id;
      const t0 = performance.now();
      for (let i = 1; i <= 1000; i += 1) {
        publishPost(store, {
          swarmId, authorMemberId: null, kind: "message",
          body: `bench replay ${i}`, idempotencyKey: `bench-replay-${i}`,
        });
      }
      const appendMs = performance.now() - t0;
      const r0 = performance.now();
      const posts = store.getPostsAfter(swarmId, 0, 2000);
      const resyncMs = performance.now() - r0;
      const gapless = posts.length === 1000 && posts.every((p, i) => p.sequence === i + 1);
      results["eventReplay"] = {
        posts: 1000, appendMs: Number(appendMs.toFixed(1)),
        resyncMs: Number(resyncMs.toFixed(1)), gapless,
      };
      gates["eventReplayGapless"] = gapless;
    } finally {
      store.close();
    }
  }

  // --- sqlite contention: dual handles, 200 interleaved posts ---
  {
    const dir = mkSub("contention");
    const dbPath = join(dir, "state.sqlite");
    const storeA = new SwarmStore(dbPath);
    const storeB = new SwarmStore(dbPath);
    try {
      const swarmId = storeA.createSwarm({
        title: "m7 bench contention", coordinatorSessionId: "sess-lead",
        projectRoot: "/tmp/m7-bench", mode: "parity",
      }).id;
      let busyErrors = 0;
      const t0 = performance.now();
      for (let i = 0; i < 100; i += 1) {
        for (const [h, tag] of [[storeA, "a"], [storeB, "b"]] as const) {
          try {
            publishPost(h, {
              swarmId, authorMemberId: null, kind: "message",
              body: `bench cont ${tag}-${i}`, idempotencyKey: `bench-cont-${tag}-${i}`,
            });
          } catch (err) {
            if (err instanceof Error && (err as { code?: unknown }).code === "SQLITE_BUSY") busyErrors += 1;
            else throw err;
          }
        }
      }
      const ms = performance.now() - t0;
      const posts = storeA.getPostsAfter(swarmId, 0, 500);
      const gapless = posts.length === 200 && posts.every((p, i) => p.sequence === i + 1);
      results["sqliteContention"] = {
        interleavedWrites: 200, busyErrors, gapless, ms: Number(ms.toFixed(1)),
      };
      gates["sqliteSerializedNoBusy"] = busyErrors === 0 && gapless;
    } finally {
      storeA.close();
      storeB.close();
    }
  }

  // --- RSS delta: 12-worker setup + dispatch ---
  {
    const beforeMB = process.memoryUsage().rss / 1048576;
    const store = new SwarmStore(":memory:");
    try {
      const swarmId = store.createSwarm({
        title: "m7 bench rss", coordinatorSessionId: "sess-lead",
        projectRoot: "/tmp/m7-bench", mode: "parity",
      }).id;
      const queue = new WakeQueue(store);
      const harness = new FakeHarness();
      const dispatcher = new WakeDispatcher(store, harness, undefined, {
        now: () => new Date(nowMs).toISOString(), random: () => 1,
      });
      for (let i = 0; i < 12; i += 1) {
        const m = store.addMember(swarmId, {
          name: `rw-${i}`, role: "coder", nativeAgentId: `agent-rw-${i}`,
          sessionId: `sess-rw-${i}`, model: MODEL,
        });
        const w = store.transitionMember(m.id, "waiting").id;
        queue.enqueue({ swarmId, memberId: w, reason: "mention", postSequence: i + 1, payloadHash: `bench-rss-${i}` });
      }
      await dispatcher.dispatchAll(swarmId, 12);
      gates["rssDispatchComplete"] = harness.submitted.length === 12;
    } finally {
      store.close();
    }
    const afterMB = process.memoryUsage().rss / 1048576;
    results["memoryRssMB"] = {
      before: Number(beforeMB.toFixed(1)), after: Number(afterMB.toFixed(1)),
      delta: Number((afterMB - beforeMB).toFixed(1)),
    };
  }

  // --- duplicate @all collapse (delivery_key) ---
  {
    const store = new SwarmStore(":memory:");
    try {
      const swarmId = store.createSwarm({
        title: "m7 bench dup", coordinatorSessionId: "sess-lead",
        projectRoot: "/tmp/m7-bench", mode: "parity",
      }).id;
      const lead = store.addMember(swarmId, {
        name: "lead", role: "coordinator", nativeAgentId: "agent-lead",
        sessionId: "sess-lead", model: MODEL,
      });
      const coders: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const m = store.addMember(swarmId, {
          name: `dc-${i}`, role: "coder", nativeAgentId: `agent-dc-${i}`,
          sessionId: `sess-dc-${i}`, model: MODEL,
        });
        coders.push(store.transitionMember(m.id, "waiting").id);
      }
      const first = publishPost(store, {
        swarmId, authorMemberId: lead.id, kind: "message",
        body: "@all go", idempotencyKey: "bench-dup-1",
      });
      const replay = publishPost(store, {
        swarmId, authorMemberId: lead.id, kind: "message",
        body: "@all go", idempotencyKey: "bench-dup-1",
      });
      const queue = new WakeQueue(store);
      const batch = coders.slice(0, 2).map((memberId) => ({
        memberId, reason: "mention" as const, postSequence: 99, payloadHash: "bench-redrive",
      }));
      const once = queue.enqueueMentionBatch(swarmId, batch);
      const twice = queue.enqueueMentionBatch(swarmId, batch);
      gates["dupCollapse"] = first.wakeIds.length === 5
        && replay.deduped && replay.wakeIds.length === 0
        && twice.every((e) => e.deduped)
        && twice.map((e) => e.intent.id).join() === once.map((e) => e.intent.id).join();
      results["dupCollapse"] = { firstWakes: first.wakeIds.length, redriveDeduped: twice.filter((e) => e.deduped).length };
    } finally {
      store.close();
    }
  }

  // --- quota freeze (+60s virtual advance) ---
  {
    const store = new SwarmStore(":memory:");
    try {
      const swarmId = store.createSwarm({
        title: "m7 bench quota", coordinatorSessionId: "sess-lead",
        projectRoot: "/tmp/m7-bench", mode: "parity",
      }).id;
      const m = store.addMember(swarmId, {
        name: "q", role: "coder", nativeAgentId: "agent-q",
        sessionId: "sess-q", model: MODEL,
      });
      const worker = store.transitionMember(m.id, "waiting").id;
      const harness = new FakeHarness();
      harness.failures.set("sess-q", Object.assign(new Error("QUOTA_EXHAUSTED (simulated 402, no inference)"), { status: 402 }));
      const queue = new WakeQueue(store);
      const dispatcher = new WakeDispatcher(store, harness, undefined, {
        now: () => new Date(nowMs).toISOString(), random: () => 1,
      });
      const wakeId = queue.enqueue({ swarmId, memberId: worker, reason: "mention", postSequence: 1, payloadHash: "bench-q" }).intent.id;
      const r = await dispatcher.dispatchWake(swarmId, wakeId);
      const attempts = store.getWake(wakeId).attempts;
      nowMs += 60_000;
      const idle = await dispatcher.dispatchAll(swarmId, 10);
      gates["quotaFreeze"] = r.status === "quota-blocked"
        && idle.length === 0 && harness.submitted.length === 0
        && store.getWake(wakeId).attempts === attempts;
      results["quotaFreeze"] = { status: r.status, attempts, followUps: harness.submitted.length };
    } finally {
      store.close();
    }
  }

  // --- restart preservation ---
  {
    const dir = mkSub("restart");
    const dbPath = join(dir, "state.sqlite");
    const store = new SwarmStore(dbPath);
    let swarmId = "";
    const workerIds: string[] = [];
    try {
      swarmId = store.createSwarm({
        title: "m7 bench restart", coordinatorSessionId: "sess-lead",
        projectRoot: "/tmp/m7-bench", mode: "parity",
      }).id;
      for (let i = 0; i < 4; i += 1) {
        const m = store.addMember(swarmId, {
          name: `rr-${i}`, role: "coder", nativeAgentId: `agent-rr-${i}`,
          sessionId: `sess-rr-${i}`, model: MODEL,
        });
        workerIds.push(store.transitionMember(m.id, "waiting").id);
      }
      const queue = new WakeQueue(store);
      for (let round = 0; round < 2; round += 1) {
        for (let i = 0; i < 4; i += 1) {
          queue.enqueue({
            swarmId, memberId: workerIds[i] as string, reason: "mention",
            postSequence: round * 4 + i + 1, payloadHash: `bench-rr-${round}-${i}`,
          });
        }
      }
      const harness = new FakeHarness();
      const dispatcher = new WakeDispatcher(store, harness, undefined, {
        now: () => new Date(nowMs).toISOString(), random: () => 1,
      });
      await dispatcher.dispatchAll(swarmId, 4);
    } finally {
      store.close();
    }
    const reopened = new SwarmStore(dbPath);
    try {
      const queued = reopened.listWakes(swarmId, "queued", 100).length;
      const unsettled = reopened.listUnsettledWakes(swarmId, 100).length;
      const sessions = reopened.listMembers(swarmId).filter((m) => m.name.startsWith("rr-")).map((m) => m.sessionId).sort();
      for (const w of workerIds) {
        const live = reopened.findLiveWakeForMember(w);
        if (live !== null) reopened.completeWake(live.id, "succeeded");
      }
      const harness = new FakeHarness();
      const dispatcher = new WakeDispatcher(reopened, harness, undefined, {
        now: () => new Date(nowMs).toISOString(), random: () => 1,
      });
      // Post-restart drain delivers the 4 preserved wakes exactly once.
      const rest = await dispatcher.dispatchAll(swarmId, 10);
      const unique = new Set(harness.submitted.map((s) => s.externalId)).size;
      gates["restartPreserved"] = queued === 4 && unsettled === 4
        && sessions.join() === "sess-rr-0,sess-rr-1,sess-rr-2,sess-rr-3"
        && rest.filter((r) => r.status === "dispatched").length === 4
        && unique === 4;
      results["restartPreserved"] = { queuedAfterReopen: queued, unsettledAfterReopen: unsettled, redispatches: harness.submitted.length };
    } finally {
      reopened.close();
    }
  }

  // --- read-only sweeps: zero submits ---
  {
    const store = new SwarmStore(":memory:");
    try {
      const swarmId = store.createSwarm({
        title: "m7 bench ro", coordinatorSessionId: "sess-lead",
        projectRoot: "/tmp/m7-bench", mode: "parity",
      }).id;
      const m = store.addMember(swarmId, {
        name: "ro", role: "coder", nativeAgentId: "agent-ro",
        sessionId: "sess-ro", model: MODEL,
      });
      const worker = store.transitionMember(m.id, "waiting").id;
      new WakeQueue(store).enqueue({ swarmId, memberId: worker, reason: "mention", postSequence: 1, payloadHash: "bench-ro" });
      const harness = new FakeHarness();
      const dispatcher = new WakeDispatcher(store, harness, undefined, {
        now: () => new Date(nowMs).toISOString(), random: () => 1,
      });
      for (let s = 0; s < 5; s += 1) {
        void getRoster(store, swarmId);
        void getHistory(store, swarmId);
        void getPending(store, swarmId);
        void getDelivery(store, swarmId);
        void store.listEligibleQueuedWakes(swarmId, 100);
        void store.listUnsettledWakes(swarmId, 100);
      }
      gates["readOnlyZeroSubmits"] = harness.submitted.length === 0 && dispatcher.getDispatchCount() === 0;
      results["readOnlyZeroSubmits"] = { sweeps: 5, submits: harness.submitted.length };
    } finally {
      store.close();
    }
  }

  // --- secrets scan over durable rows + turn texts ---
  {
    const store = new SwarmStore(":memory:");
    try {
      const swarmId = store.createSwarm({
        title: "m7 bench secrets", coordinatorSessionId: "sess-lead",
        projectRoot: "/tmp/m7-bench", mode: "parity",
      }).id;
      const m = store.addMember(swarmId, {
        name: "sec", role: "coder", nativeAgentId: "agent-sec",
        sessionId: "sess-sec", model: MODEL,
      });
      const worker = store.transitionMember(m.id, "waiting").id;
      const t = createTask(store, swarmId, {
        title: "bench secrets job", brief: "Bench brief: implement bench/sec per acceptance criteria.",
        ownerId: worker, ownedPaths: ["bench/sec"], forbiddenPaths: [],
        acceptanceCriteria: ["done"],
      });
      publishReady(store, t.id);
      const harness = new FakeHarness();
      const dispatcher = new WakeDispatcher(store, harness, undefined, {
        now: () => new Date(nowMs).toISOString(), random: () => 1,
      });
      const queue = new WakeQueue(store);
      queue.enqueue({ swarmId, memberId: worker, reason: "assigned_task", taskId: t.id, payloadHash: "bench-sec" });
      await dispatcher.dispatchAll(swarmId, 4);
      const corpus = JSON.stringify({
        tasks: store.listTasks(swarmId), members: store.listMembers(swarmId),
        wakes: store.listWakes(swarmId, "queued", 100).concat(store.listUnsettledWakes(swarmId, 100)),
        posts: store.getPostsAfter(swarmId, 0, 100),
        outbox: store.listPendingOutbox(200), turns: harness.submitted,
      });
      const patterns = [
        /sk-live-[A-Za-z0-9]+/, /AKIA[0-9A-Z]{16}/, /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/,
        /ghp_[A-Za-z0-9]{10,}/, /xox[bpas]-/, /api[_-]?key\s*[:=]\s*\S+/i,
        /Bearer\s+[A-Za-z0-9\-._~+/=]{8,}/, /OPENAI_API_KEY/, /password\s*[:=]\s*\S+/i,
      ];
      const hits = patterns.flatMap((re) => corpus.match(re) ?? []);
      gates["secretsZeroHits"] = hits.length === 0;
      results["secretsScan"] = { patterns: patterns.length, hits: hits.length };
    } finally {
      store.close();
    }
  }

  // --- integration safety: tmp repo, 4-way parallel + dup dedupe ---
  {
    const M4 = await loadM4Surfaces();
    const repoDir = mkSub("repo");
    gitSync(repoDir, "init", "-b", "main");
    gitSync(repoDir, "config", "user.email", "m7-bench@test.local");
    gitSync(repoDir, "config", "user.name", "m7-bench");
    const { writeFileSync: write } = await import("node:fs");
    write(join(repoDir, "README.md"), "# disposable m7 bench\n");
    gitSync(repoDir, "add", "README.md");
    gitSync(repoDir, "commit", "-m", "init");
    const head = gitSync(repoDir, "rev-parse", "HEAD");
    const wtRoot = mkSub("worktrees");
    const db = new Database(":memory:");
    db.exec(M4.LEASES_DDL);
    const service = new IntegrationService({ repoRoot: repoDir, db });
    const t0 = performance.now();
    try {
      const mgr = new M4.WorktreeManager(repoDir);
      const live: Array<{ taskId: string; worktreePath: string | null; ownedPaths: readonly string[] }> = [];
      const ids = ["b-01", "b-02", "b-03", "b-04"];
      const ev = mkSub("ev");
      const wts: string[] = [];
      for (const id of ids) {
        const rec = await mgr.createWorktree({
          worktreeRoot: wtRoot, canonicalRoot: repoDir, taskId: id,
          baseCommit: head, ownedPaths: [`bench/${id}`], liveAssignments: live,
        });
        live.push({ taskId: id, worktreePath: rec.worktreePath, ownedPaths: [`bench/${id}`] });
        write(join(rec.worktreePath, `${id}.txt`), `payload-${id}\n`);
        gitSync(rec.worktreePath, "add", `${id}.txt`);
        gitSync(rec.worktreePath, "commit", "-m", `work ${id}`);
        wts.push(rec.worktreePath);
      }
      const settled = await Promise.all(
        ids.map((id, i) => service.integrate({
          taskId: id, worktreePath: wts[i] as string, branch: `task/${id}`,
          baseCommit: head, verifyCommand: "git rev-parse HEAD", evidenceDir: ev,
        })),
      );
      const dup = await service.integrate({
        taskId: "b-01", worktreePath: wts[0] as string, branch: "task/b-01",
        baseCommit: head, verifyCommand: "git rev-parse HEAD", evidenceDir: ev,
      });
      const ms = performance.now() - t0;
      const allIntegrated = settled.every((r) => r.status === "integrated")
        && new Set(settled.map((r) => r.sha)).size === 4;
      gates["integrationSafe"] = allIntegrated && dup.status === "deduped"
        && dup.sha === settled[0]!.sha;
      results["integrationSafety"] = {
        parallel: 4, allIntegrated, dupStatus: dup.status, ms: Number(ms.toFixed(0)),
      };
    } finally {
      db.close();
    }
  }

  const report: BenchReport = {
    generatedAt: new Date().toISOString(),
    baseline: { gitSha: gitShaBestEffort(), bun: Bun.version, platform: process.platform },
    mode: "full",
    results,
    gates,
  };
  writeFileSync(join(root, "m7-bench-report.json"), JSON.stringify(report, null, 2));
  for (const d of subdirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  console.log(JSON.stringify({ reportPath: join(root, "m7-bench-report.json"), gates }, null, 2));
}

await main();
