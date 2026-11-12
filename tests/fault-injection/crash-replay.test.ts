/**
 * M5-01 fault-injection: crash replay matrix (spec §13 rows).
 *
 * Each test commits durable state, SIMULATES A KILL (closes the DB handle
 * without delivering/acking — no real signals, no real daemons), then
 * reopens ("restart") and proves: no committed work lost, nothing
 * duplicated, leases recover safely with monotonic fencing.
 *
 * Tmp DBs/repos only. FakeHarness only (no network, no model inference,
 * no paid calls). Disposable tmp Git repos, never the canonical repo or
 * user projects.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwarmStore } from "../../packages/runtime/src/db/store.js";
import { WakeDispatcher, type DispatchHarness } from "../../packages/runtime/src/services/wake-dispatcher.js";
import { CrashRecovery } from "../../packages/runtime/src/services/recovery.js";
import { EventIngest } from "../../packages/runtime/src/services/ingest.js";
import { IntegrationService } from "../../packages/runtime/src/services/integration.js";
import type { ReconcileSnapshot } from "../../packages/runtime/src/services/inbox-reconciler.js";

// Non-literal specifier: resolved at runtime relative to this file (correct under bun).
const WM_SPEC = "../../packages/git-workspaces/src/worktree-manager.js" as string;

async function loadWorktreeManager(): Promise<{
  WorktreeManager: new (repoRoot: string) => {
    createWorktree(input: {
      readonly worktreeRoot: string;
      readonly canonicalRoot: string;
      readonly taskId: string;
      readonly baseCommit: string;
      readonly ownedPaths?: readonly string[];
    }): Promise<{ taskId: string; branch: string; worktreePath: string; baseCommit: string }>;
  };
  IntegrationLock: new (
    db: unknown,
    opts?: { readonly resourceKey?: string; readonly ttlMs?: number; readonly clock?: () => number },
  ) => {
    acquire(holder: string): { holder: string; fencingToken: number; expiresAt: string; recoveredFrom: string | null };
    release(holder: string, fencingToken?: number): boolean;
    observe(): { holder: string; fencingToken: number; expiresAt: string } | null;
    observeHighWater(): number;
    isLive(nowMs?: number): boolean;
  };
  LEASES_DDL: string;
}> {
  return await import(WM_SPEC);
}

class FakeHarness implements DispatchHarness {
  submitted: string[] = [];
  liveSessions = new Set<string>();
  submittedBySession = new Map<string, Set<string>>();
  terminalBySession = new Map<string, Map<string, "succeeded" | "failed">>();

  async submitTurn(request: {
    readonly sessionId: string;
    readonly text: string;
    readonly delivery: "queue";
    readonly externalId: string;
    readonly reason: "mention" | "assigned_task" | "verifier_request" | "monitor_intervention" | "user_direct";
  }): Promise<{ readonly externalId: string; readonly admittedAt: string; readonly transportNote: string }> {
    this.submitted.push(request.externalId);
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
    const term = this.terminalBySession.get(sessionId);
    return {
      hasLiveExecution: this.liveSessions.has(sessionId),
      knownTerminalExternalIds: term === undefined ? [] : [...term.keys()],
    };
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
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function rawHandle(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 10000;");
  return db;
}

function makeSwarm(store: SwarmStore): string {
  return store.createSwarm({
    title: "m5 fault-injection",
    coordinatorSessionId: "sess-lead",
    projectRoot: "/tmp/m5fi",
    mode: "parity",
  }).id;
}

function addMember(store: SwarmStore, swarmId: string, name: string, sessionId: string): string {
  return store.addMember(swarmId, {
    name,
    role: "coder",
    nativeAgentId: "fake-agent",
    sessionId,
    model: { providerID: "fake", id: "fake-model" },
  }).id;
}

function git(cwd: string, ...args: string[]): string {
  const out = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${out.stderr.toString().slice(0, 500)}`);
  }
  return out.stdout.toString().trim();
}

function makeRepo(): { repo: string; head: string } {
  const repo = tmpDir("m5-fi-repo-");
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "m5-fi@test.local");
  git(repo, "config", "user.name", "m5-fi");
  writeFileSync(join(repo, "README.md"), "# disposable\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "init");
  return { repo, head: git(repo, "rev-parse", "HEAD") };
}

describe("§13 FI-1 kill after message commit, before wake delivery → restart replays one undelivered wake", () => {
  test("exactly one redelivery after restart; second pass empty", async () => {
    const dir = tmpDir("m5-fi-1-");
    const dbPath = join(dir, "state.sqlite");
    // Daemon generation 1: commit post + wake + outbox atomically, then KILL.
    const store1 = new SwarmStore(dbPath);
    const swarmId = makeSwarm(store1);
    addMember(store1, swarmId, "coder-a", "sess-a");
    const posted = store1.appendPost(swarmId, {
      authorMemberId: null,
      kind: "message",
      body: "urgent @coder-a",
      idempotencyKey: "fi-1",
    });
    expect(posted.wakeIds.length).toBe(1);
    const wakeId = posted.wakeIds[0] as string;
    store1.close(); // SIGKILL here: committed, undelivered

    // Daemon generation 2 (restart): same file, fresh handles.
    const store2 = new SwarmStore(dbPath);
    const raw = rawHandle(dbPath);
    try {
      expect(store2.getWake(wakeId).state).toBe("queued"); // committed work survived
      const recovery = new CrashRecovery({ store: store2, db: raw });
      const delivered: string[] = [];
      const replay = await recovery.replayOutbox(async (entry) => {
        delivered.push(entry.id);
      });
      expect(replay.failed).toBe(0);
      expect(delivered.length).toBe(replay.checked);
      expect(new Set(delivered).size).toBe(delivered.length);
      // The undelivered wake itself redrives exactly once (queue-only, no inference).
      const harness = new FakeHarness();
      const dispatcher = new WakeDispatcher(store2, harness);
      const result = await dispatcher.dispatchNext(swarmId);
      expect(result?.status).toBe("dispatched");
      expect(harness.submitted).toEqual([wakeId]);
      // One-shot semantics hold per pass: the dispatch above appended its
      // own lifecycle rows (admitted + observed_running), so one more
      // bounded pass drains exactly those, and the pass after is empty.
      const replay2 = await recovery.replayOutbox(async () => {});
      expect(replay2.checked).toBe(2);
      expect(replay2.failed).toBe(0);
      const replay3 = await recovery.replayOutbox(async () => {
        throw new Error("no backlog expected after restart recovery");
      });
      expect(replay3.checked).toBe(0);
      expect(await dispatcher.dispatchNext(swarmId)).toBeNull();
      expect(harness.submitted).toEqual([wakeId]);
    } finally {
      store2.close();
      raw.close();
    }
  });
});

describe("§13 FI-2 kill after prompt admitted, before local ack → reconcile, no blind resubmit", () => {
  test("submitted-but-unacked admission quarantines; harness sees zero new turns", async () => {
    const dir = tmpDir("m5-fi-2-");
    const dbPath = join(dir, "state.sqlite");
    // Backend registry survives the daemon crash (the turn reached the model
    // backend); only the daemon's local ack is lost.
    const harness = new FakeHarness();
    const store1 = new SwarmStore(dbPath);
    const swarmId = makeSwarm(store1);
    addMember(store1, swarmId, "coder-a", "sess-a");
    const posted = store1.appendPost(swarmId, {
      authorMemberId: null,
      kind: "message",
      body: "run @coder-a",
      idempotencyKey: "fi-2",
    });
    const wakeId = posted.wakeIds[0] as string;
    const claim = store1.claimWakeForDispatch(wakeId);
    expect(claim.status).toBe("admitted");
    harness.submittedBySession.set("sess-a", new Set([wakeId])); // backend got it
    store1.close(); // KILL before the local ack lands

    const store2 = new SwarmStore(dbPath);
    const raw = rawHandle(dbPath);
    try {
      const recovery = new CrashRecovery({ store: store2, db: raw });
      // Admission receipt exists but no ack and no terminal outcome.
      recovery.recordAdmission({ wakeId, memberId: "m", sessionId: "sess-a", externalId: wakeId });
      expect(recovery.listAmbiguousExecutions().map((e) => e.wakeId)).toEqual([wakeId]);
      const report = await recovery.reconcileWakes(swarmId, async (sessionId) => harness.snapshotFor(sessionId, wakeId));
      expect(report.quarantined).toBe(1);
      expect(report.completed).toBe(0);
      expect(report.releasedForRetry).toBe(0);
      expect(harness.submitted.length).toBe(0); // no blind resubmit, ever
      expect(store2.isWakeQuarantined(wakeId)).toBe(true);
      // A retry attempt is refused while quarantined: still zero turns.
      // (Backoff gate frozen so the quarantine check is reached.)
      const dispatcher = new WakeDispatcher(store2, harness, undefined, {
        backoffBaseMs: 1,
        backoffCapMs: 1,
        now: () => new Date(Date.now() + 60_000).toISOString(),
      });
      const retry = await dispatcher.retryAdmittedWake(swarmId, wakeId);
      expect(retry.status).toBe("deferred-quarantined");
      expect(harness.submitted.length).toBe(0);
    } finally {
      store2.close();
      raw.close();
    }
  });
});

describe("§13 FI-3 duplicate OpenCode event → one terminal transition", () => {
  test("redelivered event dedupes; terminal edge fires exactly once", async () => {
    const dir = tmpDir("m5-fi-3-");
    const dbPath = join(dir, "state.sqlite");
    const store = new SwarmStore(dbPath);
    const ingest = new EventIngest(dbPath);
    try {
      const swarmId = makeSwarm(store);
      addMember(store, swarmId, "coder-a", "sess-a");
      expect(ingest.record(swarmId, { source: "opencode", externalEventId: "fi-3-evt" }).deduped).toBe(false);
      expect(ingest.record(swarmId, { source: "opencode", externalEventId: "fi-3-evt" }).deduped).toBe(true);
      expect(ingest.record(swarmId, { source: "opencode", externalEventId: "fi-3-evt" }).deduped).toBe(true);
      const posted = store.appendPost(swarmId, {
        authorMemberId: null,
        kind: "message",
        body: "go @coder-a",
        idempotencyKey: "fi-3",
      });
      const wakeId = posted.wakeIds[0] as string;
      store.claimWakeForDispatch(wakeId);
      store.ackWakeObservedRunning(wakeId);
      store.completeWake(wakeId, "succeeded");
      store.completeWake(wakeId, "succeeded"); // duplicate delivery of the terminal event
      expect(store.getWake(wakeId).state).toBe("succeeded");
      const terminals = store
        .listPendingOutbox(1000)
        .filter((e) => e.kind === "wake_completed" && (e.payload as { wakeId?: string }).wakeId === wakeId);
      expect(terminals.length).toBe(1); // one terminal transition, not two
    } finally {
      ingest.close();
      store.close();
    }
  });
});

describe("§13 FI-4 agent crash holding lease → fencing recovery without double-write", () => {
  test("successor fencing strictly exceeds crashed holder; merge lands exactly once", async () => {
    const { WorktreeManager, IntegrationLock, LEASES_DDL } = await loadWorktreeManager();
    const { repo, head } = makeRepo();
    const root = tmpDir("m5-fi-4-wt-");
    const dbPath = join(tmpDir("m5-fi-4-db-"), "s.db");
    const seed = new Database(dbPath);
    try {
      seed.exec(LEASES_DDL);
      const now = { ms: Date.now() };
      const seeder = new IntegrationLock(seed, { ttlMs: 1_000, clock: () => now.ms });
      const crashed = seeder.acquire("agent-crashed");
      expect(crashed.fencingToken).toBe(1);
      now.ms += 120_000; // holder dies; lease expires unreleased
      const successor = seeder.acquire("agent-successor");
      expect(successor.recoveredFrom).toBe("agent-crashed");
      expect(successor.fencingToken).toBeGreaterThan(crashed.fencingToken);
      expect(seeder.release("agent-successor", successor.fencingToken)).toBe(true);
      const third = seeder.acquire("agent-third");
      expect(third.fencingToken).toBeGreaterThan(successor.fencingToken); // high-water, not reset
      expect(seeder.release("agent-third", third.fencingToken)).toBe(true); // hand the lock back free
    } finally {
      seed.close();
    }
    // The recovered lease integrates exactly once (task_id PRIMARY KEY dedupe).
    const db = new Database(dbPath);
    try {
      const service = new IntegrationService({ repoRoot: repo, db, acquireTimeoutMs: 10_000 });
      const mgr = new WorktreeManager(repo);
      const rec = await mgr.createWorktree({
        worktreeRoot: root,
        canonicalRoot: repo,
        taskId: "t-fi4",
        baseCommit: head,
        ownedPaths: ["jobs/fi4"],
      });
      writeFileSync(join(rec.worktreePath, "work.txt"), "work\n");
      git(rec.worktreePath, "add", "work.txt");
      git(rec.worktreePath, "commit", "-m", "work");
      const ev = tmpDir("m5-fi-4-ev-");
      const first = await service.integrate({
        taskId: "t-fi4",
        worktreePath: rec.worktreePath,
        branch: "task/t-fi4",
        baseCommit: head,
        verifyCommand: "git rev-parse HEAD",
        evidenceDir: ev,
      });
      expect(first.status).toBe("integrated");
      const countAfter = Number.parseInt(git(repo, "rev-list", "--count", "main"), 10);
      // Crash after commit, before the caller sees the result: retry dedupes.
      const retry = await service.integrate({
        taskId: "t-fi4",
        worktreePath: rec.worktreePath,
        branch: "task/t-fi4",
        baseCommit: head,
        verifyCommand: "git rev-parse HEAD",
        evidenceDir: ev,
      });
      expect(retry.status).toBe("deduped");
      expect(retry.sha).toBe(first.sha);
      expect(Number.parseInt(git(repo, "rev-list", "--count", "main"), 10)).toBe(countAfter);
      expect(existsSync(rec.worktreePath)).toBe(true);
    } finally {
      db.close();
    }
  }, 60_000);
});

describe("§13 FI-5 event-stream overflow → reconnect + snapshot (no assumed replay)", () => {
  test("overflowed consumer resyncs to the durable journal exactly", async () => {
    const dir = tmpDir("m5-fi-5-");
    const dbPath = join(dir, "state.sqlite");
    const store = new SwarmStore(dbPath);
    const raw = rawHandle(dbPath);
    try {
      const swarmId = makeSwarm(store);
      for (let i = 1; i <= 8; i += 1) {
        store.appendPost(swarmId, {
          authorMemberId: null,
          kind: "message",
          body: `msg ${i}`,
          idempotencyKey: `fi-5-${i}`,
        });
      }
      const recovery = new CrashRecovery({ store, db: raw });
      // Stream buffer overflowed after sequence 3: reconnect from the
      // journal snapshot, not from assumed stream offsets.
      const snap = recovery.reconnectBoardSnapshot(swarmId, 3);
      expect(snap.posts.map((p) => p.sequence)).toEqual([4, 5, 6, 7, 8]);
      // Catch-up: only the tail remains.
      expect(recovery.reconnectBoardSnapshot(swarmId, 7).posts.map((p) => p.sequence)).toEqual([8]);
      expect(recovery.reconnectBoardSnapshot(swarmId, 8).posts.length).toBe(0);
    } finally {
      store.close();
      raw.close();
    }
  });
});

describe("M5-01-FIX-01 FI-6 kill with two swarms sharing one store → scoped replay, no cross-delivery", () => {
  test("restart replays each swarm's backlog in isolation", async () => {
    const dir = tmpDir("m5-fi-6-");
    const dbPath = join(dir, "state.sqlite");
    const store1 = new SwarmStore(dbPath);
    const swarmA = makeSwarm(store1);
    const swarmB = makeSwarm(store1);
    addMember(store1, swarmA, "coder-a", "sess-a");
    addMember(store1, swarmB, "coder-b", "sess-b");
    store1.appendPost(swarmA, {
      authorMemberId: null,
      kind: "message",
      body: "urgent @coder-a",
      idempotencyKey: "fi-6-a",
    });
    store1.appendPost(swarmB, {
      authorMemberId: null,
      kind: "message",
      body: "urgent @coder-b",
      idempotencyKey: "fi-6-b",
    });
    store1.close(); // SIGKILL: both committed, neither delivered

    const store2 = new SwarmStore(dbPath);
    const raw = rawHandle(dbPath);
    try {
      const recovery = new CrashRecovery({ store: store2, db: raw });
      const deliveredA: string[] = [];
      const reportA = await recovery.replayOutbox(
        async (entry) => {
          deliveredA.push(entry.id);
        },
        { swarmId: swarmA },
      );
      expect(reportA.failed).toBe(0);
      expect(reportA.delivered).toBeGreaterThan(0);
      // Swarm B still fully pending after A's scoped pass.
      const deliveredB: string[] = [];
      const reportB = await recovery.replayOutbox(
        async (entry) => {
          deliveredB.push(entry.id);
        },
        { swarmId: swarmB },
      );
      expect(reportB.delivered).toBeGreaterThan(0);
      expect(new Set([...deliveredA, ...deliveredB]).size).toBe(deliveredA.length + deliveredB.length);
      // Global backlog is now drained too.
      const tail = await recovery.replayOutbox(async () => {
        throw new Error("no backlog expected after both scoped passes");
      });
      expect(tail.checked).toBe(0);
    } finally {
      store2.close();
      raw.close();
    }
  });
});

describe("M5-01-FIX-01 FI-7 kill after terminal outcome → replay never flips it", () => {
  test("recorded succeeded survives restart + duplicate delivery", async () => {
    const dir = tmpDir("m5-fi-7-");
    const dbPath = join(dir, "state.sqlite");
    const store1 = new SwarmStore(dbPath);
    const swarmId = makeSwarm(store1);
    addMember(store1, swarmId, "coder-a", "sess-a");
    store1.close();
    const raw1 = rawHandle(dbPath);
    try {
      const rec1 = new CrashRecovery({ store: new SwarmStore(dbPath), db: raw1 });
      rec1.recordAdmission({ wakeId: "w-fi7", memberId: "m", sessionId: "sess-a", externalId: "ext-fi7", swarmId });
      rec1.recordOutcome("w-fi7", "succeeded");
      expect(rec1.getExecution("w-fi7")?.outcome).toBe("succeeded");
    } finally {
      raw1.close();
    }
    // Restart: fresh handles on the same file.
    const store2 = new SwarmStore(dbPath);
    const raw2 = rawHandle(dbPath);
    try {
      const rec2 = new CrashRecovery({ store: store2, db: raw2 });
      expect(rec2.getExecution("w-fi7")?.outcome).toBe("succeeded");
      rec2.recordOutcome("w-fi7", "failed"); // duplicate terminal delivery after restart
      expect(rec2.getExecution("w-fi7")?.outcome).toBe("succeeded");
    } finally {
      store2.close();
      raw2.close();
    }
  });
});

describe("M5-01-FIX-02 FI-8 kill with skewed backlog → scoped replay still reaches the own swarm", () => {
  test("restart delivers own-swarm rows buried past an other-swarm max*5 window; nothing lost", async () => {
    const dir = tmpDir("m5-fi-8-");
    const dbPath = join(dir, "state.sqlite");
    const store1 = new SwarmStore(dbPath);
    const swarmOwn = makeSwarm(store1);
    const swarmOther = makeSwarm(store1);
    for (let i = 1; i <= 30; i += 1) {
      store1.appendPost(swarmOther, {
        authorMemberId: null,
        kind: "message",
        body: `filler ${i}`,
        idempotencyKey: `fi-8-fill-${i}`,
      });
    }
    for (let i = 1; i <= 3; i += 1) {
      store1.appendPost(swarmOwn, {
        authorMemberId: null,
        kind: "message",
        body: `own ${i}`,
        idempotencyKey: `fi-8-own-${i}`,
      });
    }
    store1.close(); // SIGKILL: everything committed, nothing delivered

    const store2 = new SwarmStore(dbPath);
    const raw = rawHandle(dbPath);
    try {
      const recovery = new CrashRecovery({ store: store2, db: raw });
      const deliveredOwn: string[] = [];
      const reportOwn = await recovery.replayOutbox(
        async (entry) => {
          deliveredOwn.push(entry.id);
        },
        { swarmId: swarmOwn, maxPerRun: 5 },
      );
      expect(reportOwn.failed).toBe(0);
      expect(reportOwn.delivered).toBe(3);
      expect(new Set(deliveredOwn).size).toBe(deliveredOwn.length);
      // Other-swarm backlog survived the kill AND the own-swarm pass.
      const deliveredOther: string[] = [];
      const reportOther = await recovery.replayOutbox(
        async (entry) => {
          deliveredOther.push(entry.id);
        },
        { swarmId: swarmOther, maxPerRun: 100 },
      );
      expect(reportOther.delivered).toBe(30);
      expect(new Set([...deliveredOwn, ...deliveredOther]).size).toBe(
        deliveredOwn.length + deliveredOther.length,
      );
      const tail = await recovery.replayOutbox(async () => {
        throw new Error("no backlog expected after both scoped passes");
      });
      expect(tail.checked).toBe(0);
    } finally {
      store2.close();
      raw.close();
    }
  });
});
