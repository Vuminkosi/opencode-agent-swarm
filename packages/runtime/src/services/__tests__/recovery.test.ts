/**
 * M5-01 recovery tests — crash replay, durable leases, admission receipts
 * (spec §14 M5 + §13 failure-injection matrix rows, unit level).
 *
 * Disposable tmp-dir SQLite files (never the canonical tree), FakeHarness
 * (no network, no model inference, no billed calls), disposable tmp Git
 * repos (never the canonical repo). The M4-01 IntegrationLock is
 * import-only reuse loaded at runtime (same posture as
 * integration.test.ts: static cross-package imports cannot typecheck
 * under the orchestrator-owned rootDir containment).
 */

import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwarmStore } from "../../db/store.js";
import { WakeDispatcher, type DispatchHarness } from "../wake-dispatcher.js";
import { CrashRecovery } from "../recovery.js";
import { EventIngest } from "../ingest.js";
import { IntegrationService } from "../integration.js";
import type { ReconcileSnapshot } from "../inbox-reconciler.js";

// Non-literal specifier: resolved at runtime relative to this file (correct under bun).
// __tests__/ → services/ → src/ → runtime/ → packages/, hence four levels.
const WM_SPEC = "../../../../git-workspaces/src/worktree-manager.js";

async function loadLock(): Promise<{
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
  const m = await import(WM_SPEC);
  return { IntegrationLock: m.IntegrationLock, LEASES_DDL: m.LEASES_DDL };
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

function makeSwarm(store: SwarmStore): string {
  return store.createSwarm({
    title: "m5 recovery",
    coordinatorSessionId: "sess-lead",
    projectRoot: "/tmp/m5",
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

function rawHandle(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 10000;");
  return db;
}

function git(cwd: string, ...args: string[]): string {
  const out = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${out.stderr.toString().slice(0, 500)}`);
  }
  return out.stdout.toString().trim();
}

function makeRepo(): { repo: string; head: string } {
  const repo = tmpDir("m5-01-repo-");
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "m5-01@test.local");
  git(repo, "config", "user.name", "m5-01");
  writeFileSync(join(repo, "README.md"), "# disposable\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "init");
  return { repo, head: git(repo, "rev-parse", "HEAD") };
}

describe("M5-01 fencing high-water: monotonic across release cycles", () => {
  test("acquire → release → acquire strictly increases (never resets to 1)", async () => {
    const { IntegrationLock, LEASES_DDL } = await loadLock();
    const db = new Database(":memory:");
    try {
      db.exec(LEASES_DDL);
      const now = { ms: Date.parse("2026-01-01T00:00:00.000Z") };
      const lock = new IntegrationLock(db, { ttlMs: 60_000, clock: () => now.ms });
      const a = lock.acquire("task-a");
      expect(a.fencingToken).toBe(1);
      expect(lock.release("task-a", a.fencingToken)).toBe(true);
      expect(lock.observe()).toBeNull(); // release still frees the lock
      const b = lock.acquire("task-b");
      expect(b.fencingToken).toBeGreaterThan(a.fencingToken);
      expect(b.recoveredFrom).toBeNull(); // clean acquire after release, not a crash recovery
      expect(lock.release("task-b", b.fencingToken)).toBe(true);
      const c = lock.acquire("task-c");
      expect(c.fencingToken).toBeGreaterThan(b.fencingToken);
      expect(lock.observeHighWater()).toBe(c.fencingToken);
    } finally {
      db.close();
    }
  });

  test("expiry recovery composes with the high-water (never reused, never reset)", async () => {
    const { IntegrationLock, LEASES_DDL } = await loadLock();
    const db = new Database(":memory:");
    try {
      db.exec(LEASES_DDL);
      const now = { ms: Date.parse("2026-01-01T00:00:00.000Z") };
      const lock = new IntegrationLock(db, { ttlMs: 1_000, clock: () => now.ms });
      const a = lock.acquire("crashed-agent");
      expect(lock.release("crashed-agent", a.fencingToken)).toBe(true);
      now.ms += 60_000;
      const b = lock.acquire("successor");
      expect(b.fencingToken).toBeGreaterThan(a.fencingToken);
      now.ms += 60_000; // successor crashes without release: stale lease
      const c = lock.acquire("third");
      expect(c.recoveredFrom).toBe("successor");
      expect(c.fencingToken).toBeGreaterThan(b.fencingToken);
    } finally {
      db.close();
    }
  });
});

describe("M5-01 restart replay: exactly the undelivered set, once", () => {
  test("commit-then-kill replays pending outbox once; second pass is empty", async () => {
    const dir = tmpDir("m5-01-replay-");
    const dbPath = join(dir, "state.sqlite");
    const store1 = new SwarmStore(dbPath);
    const swarmId = makeSwarm(store1);
    addMember(store1, swarmId, "coder-a", "sess-a");
    store1.appendPost(swarmId, {
      authorMemberId: null,
      kind: "message",
      body: "hello @coder-a",
      idempotencyKey: "replay-1",
    });
    const pendingBefore = store1.listPendingOutbox(100);
    expect(pendingBefore.length).toBeGreaterThan(0);
    store1.close(); // kill before any delivery

    // Restart: brand-new handles on the same file.
    const store2 = new SwarmStore(dbPath);
    const raw = rawHandle(dbPath);
    try {
      const recovery = new CrashRecovery({ store: store2, db: raw });
      const seen: string[] = [];
      const first = await recovery.replayOutbox(async (entry) => {
        seen.push(entry.id);
      });
      expect(first.checked).toBe(pendingBefore.length);
      expect(first.delivered).toBe(pendingBefore.length);
      expect(first.failed).toBe(0);
      expect(new Set(seen).size).toBe(seen.length); // each row exactly once
      expect(store2.listPendingOutbox(100).length).toBe(0); // all acked
      const second = await recovery.replayOutbox(async () => {
        throw new Error("must not be called on an empty backlog");
      });
      expect(second.checked).toBe(0);
      expect(second.delivered).toBe(0);
    } finally {
      store2.close();
      raw.close();
    }
  });

  test("a throwing consumer leaves the row pending (marked delivered only after ack)", async () => {
    const dir = tmpDir("m5-01-replayfail-");
    const dbPath = join(dir, "state.sqlite");
    const store = new SwarmStore(dbPath);
    const raw = rawHandle(dbPath);
    try {
      const swarmId = makeSwarm(store);
      addMember(store, swarmId, "coder-a", "sess-a");
      store.appendPost(swarmId, {
        authorMemberId: null,
        kind: "message",
        body: "hello @coder-a",
        idempotencyKey: "replayfail-1",
      });
      const recovery = new CrashRecovery({ store, db: raw });
      const report = await recovery.replayOutbox(async () => {
        throw new Error("consumer down (simulated)");
      });
      expect(report.failed).toBeGreaterThan(0);
      expect(report.delivered).toBe(0);
      expect(store.listPendingOutbox(100).length).toBe(report.checked); // nothing acked
    } finally {
      store.close();
      raw.close();
    }
  });
});

describe("M5-01 ambiguous admissions quarantine (never blind replay)", () => {
  test("admitted-but-unacked with backend submission recorded → quarantined, zero resubmits", async () => {
    const dir = tmpDir("m5-01-quar-");
    const store = new SwarmStore(join(dir, "state.sqlite"));
    const raw = rawHandle(join(dir, "state.sqlite"));
    try {
      const swarmId = makeSwarm(store);
      addMember(store, swarmId, "coder-a", "sess-a");
      const posted = store.appendPost(swarmId, {
        authorMemberId: null,
        kind: "message",
        body: "ping @coder-a",
        idempotencyKey: "quar-1",
      });
      expect(posted.wakeIds.length).toBe(1);
      const wakeId = posted.wakeIds[0] as string;
      const claim = store.claimWakeForDispatch(wakeId);
      expect(claim.status).toBe("admitted");
      // Crash window: the turn reached the backend (adapter registry notes
      // the submission) but the daemon died before the local ack.
      const harness = new FakeHarness();
      harness.submittedBySession.set("sess-a", new Set([wakeId]));
      const recovery = new CrashRecovery({ store, db: raw });
      const report = await recovery.reconcileWakes(swarmId, async (sessionId) => harness.snapshotFor(sessionId, wakeId));
      expect(report.checked).toBe(1);
      expect(report.quarantined).toBe(1);
      expect(report.completed).toBe(0);
      expect(store.isWakeQuarantined(wakeId)).toBe(true);
      expect(harness.submitted.length).toBe(0); // never resubmitted
      expect(store.getWake(wakeId).state).not.toBe("succeeded");
    } finally {
      store.close();
      raw.close();
    }
  });

  test("never-submitted crash releases the lease so the SAME intent retries (no duplicate)", async () => {
    const dir = tmpDir("m5-01-retry-");
    const store = new SwarmStore(join(dir, "state.sqlite"));
    const raw = rawHandle(join(dir, "state.sqlite"));
    try {
      const swarmId = makeSwarm(store);
      const memberId = addMember(store, swarmId, "coder-a", "sess-a");
      const posted = store.appendPost(swarmId, {
        authorMemberId: null,
        kind: "message",
        body: "ping @coder-a",
        idempotencyKey: "retry-1",
      });
      const wakeId = posted.wakeIds[0] as string;
      const claim = store.claimWakeForDispatch(wakeId);
      expect(claim.status).toBe("admitted");
      const harness = new FakeHarness(); // backend never saw it
      const recovery = new CrashRecovery({ store, db: raw });
      const report = await recovery.reconcileWakes(swarmId, async (sessionId) => harness.snapshotFor(sessionId, wakeId));
      expect(report.releasedForRetry).toBe(1);
      // The SAME logical intent redrives: exactly one queue-only turn.
      // (Backoff gate frozen: the crash-released attempt must not wait out
      // a ceiling for a turn that never reached the backend.)
      const dispatcher = new WakeDispatcher(store, harness, undefined, {
        backoffBaseMs: 1,
        backoffCapMs: 1,
        now: () => new Date(Date.now() + 60_000).toISOString(),
      });
      const result = await dispatcher.retryAdmittedWake(swarmId, wakeId);
      expect(result.status).toBe("dispatched");
      expect(harness.submitted).toEqual([wakeId]);
      expect(store.getWakeLeaseInfo(memberId)?.holder).toBe(wakeId);
    } finally {
      store.close();
      raw.close();
    }
  });
});

describe("M5-01 duplicate collapse: one terminal transition", () => {
  test("duplicate OpenCode events dedupe; duplicate completion is a single transition", async () => {
    const dir = tmpDir("m5-01-dupe-");
    const dbPath = join(dir, "state.sqlite");
    const store = new SwarmStore(dbPath);
    const ingest = new EventIngest(dbPath);
    try {
      const swarmId = makeSwarm(store);
      addMember(store, swarmId, "coder-a", "sess-a");
      const first = ingest.record(swarmId, { source: "opencode", externalEventId: "evt-1" });
      expect(first.deduped).toBe(false);
      const second = ingest.record(swarmId, { source: "opencode", externalEventId: "evt-1" });
      expect(second.deduped).toBe(true);
      const posted = store.appendPost(swarmId, {
        authorMemberId: null,
        kind: "message",
        body: "ping @coder-a",
        idempotencyKey: "dupe-1",
      });
      const wakeId = posted.wakeIds[0] as string;
      store.claimWakeForDispatch(wakeId);
      const once = store.completeWake(wakeId, "succeeded");
      expect(once.state).toBe("succeeded");
      const twice = store.completeWake(wakeId, "succeeded");
      expect(twice.state).toBe("succeeded"); // idempotent: one terminal transition
      const completedRows = store
        .listPendingOutbox(1000)
        .filter((e) => e.kind === "wake_completed" && (e.payload as { wakeId?: string }).wakeId === wakeId);
      expect(completedRows.length).toBe(1);
    } finally {
      ingest.close();
      store.close();
    }
  });
});

describe("M5-01 session_executions: admission-vs-ack tracking", () => {
  test("receipt → ack → outcome correlates; ambiguous listed until acked", async () => {
    const dir = tmpDir("m5-01-exec-");
    const dbPath = join(dir, "state.sqlite");
    const store = new SwarmStore(dbPath);
    const raw = rawHandle(dbPath);
    try {
      const recovery = new CrashRecovery({ store, db: raw });
      expect(
        recovery.recordAdmission({ wakeId: "w-1", memberId: "m-1", sessionId: "s-1", externalId: "ext-1" }),
      ).toBe("recorded");
      // Redelivered receipt with the same dedupe marker collapses.
      expect(
        recovery.recordAdmission({ wakeId: "w-1b", memberId: "m-1", sessionId: "s-1", externalId: "ext-1" }),
      ).toBe("deduped");
      expect(recovery.listAmbiguousExecutions().map((e) => e.wakeId)).toEqual(["w-1"]);
      recovery.recordAck("w-1");
      expect(recovery.listAmbiguousExecutions().length).toBe(0);
      recovery.recordOutcome("w-1", "succeeded");
      expect(recovery.getExecution("w-1")?.outcome).toBe("succeeded");
      expect(recovery.getExecution("w-1")?.ackedAt).not.toBeNull();
    } finally {
      store.close();
      raw.close();
    }
  });
});

describe("M5-01 lease fencing recovery without double-write", () => {
  test("crashed holder recovers with a bump; completed work never merges twice", async () => {
    const { repo, head } = makeRepo();
    const root = tmpDir("m5-01-fence-");
    const dbPath = join(tmpDir("m5-01-fencedb-"), "s.db");
    const { IntegrationLock, LEASES_DDL } = await loadLock();
    const setupDb = new Database(dbPath);
    try {
      setupDb.exec(LEASES_DDL);
      setupDb
        .query("INSERT OR REPLACE INTO leases (resource_key, holder, fencing_token, expires_at) VALUES (?, ?, ?, ?)")
        .run("canonical-lock", "crashed-agent", 5, new Date(Date.now() - 60_000).toISOString());
    } finally {
      setupDb.close();
    }
    const db1 = new Database(dbPath);
    try {
      db1.exec(LEASES_DDL);
      // A live holder elsewhere still gates recovery (expiry-only rule).
      const liveDb = new Database(":memory:");
      try {
        liveDb.exec(LEASES_DDL);
        const liveLock = new IntegrationLock(liveDb, { ttlMs: 60_000 });
        liveLock.acquire("live-agent");
        expect(liveLock.isLive()).toBe(true);
      } finally {
        liveDb.close();
      }
      const service = new IntegrationService({ repoRoot: repo, db: db1 });
      const { WorktreeManager } = await import(WM_SPEC);
      const mgr = new WorktreeManager(repo);
      const rec = await mgr.createWorktree({
        worktreeRoot: root,
        canonicalRoot: repo,
        taskId: "t-fence",
        baseCommit: head,
        ownedPaths: ["jobs/fence"],
      });
      writeFileSync(join(rec.worktreePath, "work.txt"), "work\n");
      git(rec.worktreePath, "add", "work.txt");
      git(rec.worktreePath, "commit", "-m", "work");
      const dir2 = tmpDir("m5-01-ev-");
      const first = await service.integrate({
        taskId: "t-fence",
        worktreePath: rec.worktreePath,
        branch: "task/t-fence",
        baseCommit: head,
        verifyCommand: "git rev-parse HEAD",
        evidenceDir: dir2,
      });
      expect(first.status).toBe("integrated");
      expect(first.recoveredFrom).toBe("crashed-agent");
      expect(first.fencingToken).toBeGreaterThan(5);
      const countAfter = Number.parseInt(git(repo, "rev-list", "--count", "main"), 10);
      const again = await service.integrate({
        taskId: "t-fence",
        worktreePath: rec.worktreePath,
        branch: "task/t-fence",
        baseCommit: head,
        verifyCommand: "git rev-parse HEAD",
        evidenceDir: dir2,
      });
      expect(again.status).toBe("deduped"); // task_id PRIMARY KEY: no duplicate merge
      expect(Number.parseInt(git(repo, "rev-list", "--count", "main"), 10)).toBe(countAfter);
      expect(existsSync(rec.worktreePath)).toBe(true);
    } finally {
      db1.close();
    }
  });
});

describe("M5-01 overflow reconnect: snapshot from durable sequences", () => {
  test("reconnect replays exactly the missed range, deterministically", async () => {
    const dir = tmpDir("m5-01-overflow-");
    const store = new SwarmStore(join(dir, "state.sqlite"));
    const raw = rawHandle(join(dir, "state.sqlite"));
    try {
      const swarmId = makeSwarm(store);
      for (let i = 1; i <= 10; i += 1) {
        store.appendPost(swarmId, {
          authorMemberId: null,
          kind: "message",
          body: `msg ${i}`,
          idempotencyKey: `overflow-${i}`,
        });
      }
      const recovery = new CrashRecovery({ store, db: raw });
      // Overflow dropped everything after sequence 4: snapshot, don't assume.
      const snap = recovery.reconnectBoardSnapshot(swarmId, 4);
      expect(snap.posts.map((p) => p.sequence)).toEqual([5, 6, 7, 8, 9, 10]);
      const again = recovery.reconnectBoardSnapshot(swarmId, 4);
      expect(again.posts.map((p) => p.sequence)).toEqual([5, 6, 7, 8, 9, 10]);
      expect(recovery.reconnectBoardSnapshot(swarmId, 10).posts.length).toBe(0);
    } finally {
      store.close();
      raw.close();
    }
  });
});

describe("M5-01-FIX-01 F-01 CAS + fail-closed high-water", () => {
  test("concurrent handles: loser retries to a strictly higher token, never overwrites", async () => {
    const { IntegrationLock, LEASES_DDL } = await loadLock();
    const db = new Database(":memory:");
    try {
      db.exec(LEASES_DDL);
      const now = { ms: Date.parse("2026-01-01T00:00:00.000Z") };
      const a = new IntegrationLock(db, { ttlMs: 60_000, clock: () => now.ms });
      const b = new IntegrationLock(db, { ttlMs: 60_000, clock: () => now.ms });
      const first = a.acquire("handle-a");
      expect(first.fencingToken).toBe(1);
      // Live foreign lease: second handle must fail closed, never overwrite.
      expect(() => b.acquire("handle-b")).toThrow();
      expect(a.observe()?.holder).toBe("handle-a");
      expect(a.observe()?.fencingToken).toBe(1);
      // Same holder re-entry is a CAS bump, not an overwrite with the same token.
      const again = a.acquire("handle-a");
      expect(again.fencingToken).toBeGreaterThan(first.fencingToken);
      // After release the next handle strictly exceeds every issued token.
      expect(a.release("handle-a", again.fencingToken)).toBe(true);
      const third = b.acquire("handle-b");
      expect(third.fencingToken).toBeGreaterThan(again.fencingToken);
    } finally {
      db.close();
    }
  });

  test("expiry race: two successors cannot land the same token", async () => {
    const { IntegrationLock, LEASES_DDL } = await loadLock();
    const db = new Database(":memory:");
    try {
      db.exec(LEASES_DDL);
      const now = { ms: Date.parse("2026-01-01T00:00:00.000Z") };
      const seeder = new IntegrationLock(db, { ttlMs: 1_000, clock: () => now.ms });
      const crashed = seeder.acquire("crashed");
      now.ms += 60_000; // lease expires unreleased
      const s1 = new IntegrationLock(db, { ttlMs: 60_000, clock: () => now.ms });
      const s2 = new IntegrationLock(db, { ttlMs: 60_000, clock: () => now.ms });
      const win = s1.acquire("successor-1");
      expect(win.recoveredFrom).toBe("crashed");
      expect(win.fencingToken).toBeGreaterThan(crashed.fencingToken);
      // Loser sees the winner's live lease and fails closed.
      expect(() => s2.acquire("successor-2")).toThrow();
      expect(db.query("SELECT COUNT(*) AS n FROM leases").get() as unknown as { n: number }).toMatchObject({ n: 1 });
    } finally {
      db.close();
    }
  });

  test("failing DDL fail-closed: acquire throws and writes nothing; release keeps the row", async () => {
    const { IntegrationLock, LEASES_DDL } = await loadLock();
    const inner = new Database(":memory:");
    try {
      inner.exec(LEASES_DDL);
      const failingHw = {
        query(sql: string) {
          if (typeof sql === "string" && sql.includes("lease_fencing_high_water")) {
            throw new Error("simulated DDL failure");
          }
          return inner.query(sql);
        },
      };
      const lock = new IntegrationLock(failingHw, { ttlMs: 60_000 });
      expect(() => lock.acquire("anyone")).toThrow();
      // Fail-closed wrote no lease row.
      expect(inner.query("SELECT COUNT(*) AS n FROM leases").get() as unknown as { n: number }).toMatchObject({ n: 1 - 1 });
      // Seed a live lease behind the lock, then a failing-HW release must
      // throw WITHOUT deleting (no silent high-water loss).
      inner.exec(
        `INSERT INTO leases (resource_key, holder, fencing_token, expires_at) VALUES ('canonical-lock', 'holder-a', 7, '2099-01-01T00:00:00.000Z')`,
      );
      expect(() => lock.release("holder-a", 7)).toThrow();
      const row = inner.query("SELECT holder, fencing_token FROM leases WHERE resource_key = ?").get("canonical-lock") as unknown as {
        holder: string;
        fencing_token: number;
      };
      expect(row.holder).toBe("holder-a");
      expect(row.fencing_token).toBe(7);
    } finally {
      inner.close();
    }
  });

  test("crash between CAS and high-water record stays monotonic via the live row", async () => {
    const { IntegrationLock, LEASES_DDL } = await loadLock();
    const db = new Database(":memory:");
    try {
      db.exec(LEASES_DDL);
      const now = { ms: Date.parse("2026-01-01T00:00:00.000Z") };
      const lock = new IntegrationLock(db, { ttlMs: 1_000, clock: () => now.ms });
      const first = lock.acquire("holder-a");
      // Simulate the crash window: lease row landed at T but the high-water
      // record was lost (stale/removed before the next acquire).
      db.exec("DELETE FROM lease_fencing_high_water");
      now.ms += 60_000; // holder-a expires unreleased
      const next = lock.acquire("holder-b");
      // Live-row fallback keeps monotonicity even with the HW wiped.
      expect(next.fencingToken).toBeGreaterThan(first.fencingToken);
      expect(next.recoveredFrom).toBe("holder-a");
    } finally {
      db.close();
    }
  });
});

describe("M5-01-FIX-01 F-02 terminal-once outcome", () => {
  test("second recordOutcome never overwrites the first terminal", async () => {
    const dir = tmpDir("m5-fix02-");
    const dbPath = join(dir, "state.sqlite");
    const store = new SwarmStore(dbPath);
    const raw = rawHandle(dbPath);
    try {
      const recovery = new CrashRecovery({ store, db: raw });
      expect(recovery.recordAdmission({ wakeId: "w-t", memberId: "m", sessionId: "s", externalId: "ext-t" })).toBe("recorded");
      recovery.recordOutcome("w-t", "succeeded");
      const first = recovery.getExecution("w-t");
      expect(first?.outcome).toBe("succeeded");
      const completedAt = first?.completedAt;
      // Late duplicate delivery (retry / dual writer / crash replay).
      recovery.recordOutcome("w-t", "failed");
      const second = recovery.getExecution("w-t");
      expect(second?.outcome).toBe("succeeded");
      expect(second?.completedAt).toBe(completedAt);
      // Third write also sticks at the first terminal.
      recovery.recordOutcome("w-t", "cancelled");
      expect(recovery.getExecution("w-t")?.outcome).toBe("succeeded");
    } finally {
      store.close();
      raw.close();
    }
  });
});

describe("M5-01-FIX-01 F-D3 per-swarm replay + execution scope", () => {
  test("two swarms sharing one store: replay is scoped, no cross-delivery", async () => {
    const dir = tmpDir("m5-fixd3-");
    const dbPath = join(dir, "state.sqlite");
    const store = new SwarmStore(dbPath);
    const raw = rawHandle(dbPath);
    try {
      const swarmA = makeSwarm(store);
      const swarmB = makeSwarm(store);
      addMember(store, swarmA, "coder-a", "sess-a");
      addMember(store, swarmB, "coder-b", "sess-b");
      store.appendPost(swarmA, { authorMemberId: null, kind: "message", body: "hello @coder-a", idempotencyKey: "d3-a-1" });
      store.appendPost(swarmB, { authorMemberId: null, kind: "message", body: "hello @coder-b", idempotencyKey: "d3-b-1" });
      const recovery = new CrashRecovery({ store, db: raw });
      const seenA: string[] = [];
      const reportA = await recovery.replayOutbox(
        async (entry) => {
          seenA.push(entry.id);
        },
        { swarmId: swarmA },
      );
      expect(reportA.delivered).toBeGreaterThan(0);
      expect(reportA.failed).toBe(0);
      // Swarm B's backlog is untouched by swarm A's pass.
      const seenB: string[] = [];
      const reportB = await recovery.replayOutbox(
        async (entry) => {
          seenB.push(entry.id);
        },
        { swarmId: swarmB, maxPerRun: 100 },
      );
      expect(reportB.delivered).toBeGreaterThan(0);
      expect(new Set([...seenA, ...seenB]).size).toBe(seenA.length + seenB.length); // disjoint
      // Both scoped passes drained: a second scoped pass is empty.
      const againA = await recovery.replayOutbox(
        async () => {
          throw new Error("swarm A backlog should be drained");
        },
        { swarmId: swarmA },
      );
      expect(againA.checked).toBe(0);
    } finally {
      store.close();
      raw.close();
    }
  });

  test("ambiguous executions scope by swarm", async () => {
    const dir = tmpDir("m5-fixd3-exec-");
    const dbPath = join(dir, "state.sqlite");
    const store = new SwarmStore(dbPath);
    const raw = rawHandle(dbPath);
    try {
      const recovery = new CrashRecovery({ store, db: raw });
      expect(
        recovery.recordAdmission({ wakeId: "w-a1", memberId: "m", sessionId: "s", externalId: "ext-a1", swarmId: "swarm-a" }),
      ).toBe("recorded");
      expect(
        recovery.recordAdmission({ wakeId: "w-b1", memberId: "m", sessionId: "s", externalId: "ext-b1", swarmId: "swarm-b" }),
      ).toBe("recorded");
      expect(recovery.listAmbiguousExecutions(100, { swarmId: "swarm-a" }).map((e) => e.wakeId)).toEqual(["w-a1"]);
      expect(recovery.listAmbiguousExecutions(100, { swarmId: "swarm-b" }).map((e) => e.wakeId)).toEqual(["w-b1"]);
      expect(recovery.listAmbiguousExecutions(100).map((e) => e.wakeId).sort()).toEqual(["w-a1", "w-b1"]);
    } finally {
      store.close();
      raw.close();
    }
  });
});

describe("M5-01-FIX-02 F1 tokenless release is a fail-closed no-op", () => {
  test("acquire t1 → re-acquire t2 → stale release(holder) keeps the live lease + fencing intact", async () => {
    const { IntegrationLock, LEASES_DDL } = await loadLock();
    const db = new Database(":memory:");
    try {
      db.exec(LEASES_DDL);
      const now = { ms: Date.parse("2026-01-01T00:00:00.000Z") };
      const lock = new IntegrationLock(db, { ttlMs: 60_000, clock: () => now.ms });
      const t1 = lock.acquire("holder-a");
      expect(t1.fencingToken).toBe(1);
      const t2 = lock.acquire("holder-a"); // same-holder live re-acquire bumps
      expect(t2.fencingToken).toBeGreaterThan(t1.fencingToken);
      // Stale tokenless release: fail-closed no-op, live lease untouched.
      expect(lock.release("holder-a")).toBe(false);
      const live = lock.observe();
      expect(live?.holder).toBe("holder-a");
      expect(live?.fencingToken).toBe(t2.fencingToken);
      expect(lock.isLive(now.ms)).toBe(true);
      expect(lock.observeHighWater()).toBeGreaterThanOrEqual(t2.fencingToken);
      // The live generation still releases cleanly WITH its token.
      expect(lock.release("holder-a", t2.fencingToken)).toBe(true);
      expect(lock.observe()).toBeNull();
      // Stale token (t1) against the retired row is also a no-op.
      expect(lock.release("holder-a", t1.fencingToken)).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe("M5-01-FIX-02 F2 skewed-backlog filtered replay", () => {
  test("other-swarm backlog ≥ max*5 ahead never starves the own-swarm pass; pending not lost", async () => {
    const dir = tmpDir("m5-fix02-skew-");
    const dbPath = join(dir, "state.sqlite");
    const store = new SwarmStore(dbPath);
    const raw = rawHandle(dbPath);
    try {
      const swarmOwn = makeSwarm(store);
      const swarmOther = makeSwarm(store);
      // Skew: 30 other-swarm rows land FIRST (older created_at), own-swarm
      // rows after — every one of them past the old max*5 window (max=5).
      for (let i = 1; i <= 30; i += 1) {
        store.appendPost(swarmOther, {
          authorMemberId: null,
          kind: "message",
          body: `filler ${i}`,
          idempotencyKey: `skew-fill-${i}`,
        });
      }
      for (let i = 1; i <= 3; i += 1) {
        store.appendPost(swarmOwn, {
          authorMemberId: null,
          kind: "message",
          body: `own ${i}`,
          idempotencyKey: `skew-own-${i}`,
        });
      }
      const recovery = new CrashRecovery({ store, db: raw });
      const seen: string[] = [];
      const report = await recovery.replayOutbox(
        async (entry) => {
          seen.push(entry.id);
        },
        { swarmId: swarmOwn, maxPerRun: 5 },
      );
      expect(report.delivered).toBe(3); // all own-swarm rows, despite the skew
      expect(report.failed).toBe(0);
      expect(new Set(seen).size).toBe(seen.length);
      // Other-swarm backlog untouched by the own-swarm pass (pending, not lost).
      const otherPending = store
        .listPendingOutbox(1000)
        .filter((e) => (e.payload as { swarmId?: string }).swarmId === swarmOther);
      expect(otherPending.length).toBe(30);
      // And the other swarm still replays fully on its own pass.
      const seenOther: string[] = [];
      const reportOther = await recovery.replayOutbox(
        async (entry) => {
          seenOther.push(entry.id);
        },
        { swarmId: swarmOther, maxPerRun: 100 },
      );
      expect(reportOther.delivered).toBe(30);
      expect(new Set([...seen, ...seenOther]).size).toBe(seen.length + seenOther.length);
    } finally {
      store.close();
      raw.close();
    }
  });
});

describe("M8-01 scan cap: bounded read per pass, documented value", () => {
  test("REPLAY_SCAN_CAP is exported at its documented value and every pass reports a bounded scan", async () => {
    const { REPLAY_SCAN_CAP } = await import("../recovery.js");
    expect(REPLAY_SCAN_CAP).toBe(2000);
    const dir = tmpDir("m8-01-scancap-");
    const dbPath = join(dir, "state.sqlite");
    const store = new SwarmStore(dbPath);
    const raw = rawHandle(dbPath);
    try {
      const swarmOwn = makeSwarm(store);
      const swarmOther = makeSwarm(store);
      for (let i = 1; i <= 60; i += 1) {
        store.appendPost(swarmOther, {
          authorMemberId: null,
          kind: "message",
          body: `filler ${i}`,
          idempotencyKey: `m8fill-${i}`,
        });
      }
      for (let i = 1; i <= 3; i += 1) {
        store.appendPost(swarmOwn, {
          authorMemberId: null,
          kind: "message",
          body: `own ${i}`,
          idempotencyKey: `m8own-${i}`,
        });
      }
      const recovery = new CrashRecovery({ store, db: raw });
      const report = await recovery.replayOutbox(
        async () => {},
        { swarmId: swarmOwn, maxPerRun: 5 },
      );
      expect(report.delivered).toBe(3);
      expect(report.scanned).toBeLessThanOrEqual(REPLAY_SCAN_CAP);
      // Unfiltered passes are single-fetch: scanned == checked <= maxPerRun.
      const full = await recovery.replayOutbox(async () => {}, { maxPerRun: 1000 });
      expect(full.scanned).toBeLessThanOrEqual(REPLAY_SCAN_CAP);
      expect(full.scanned).toBe(full.checked);
    } finally {
      store.close();
      raw.close();
    }
  });
});

describe("M8-01-FIX-01 F2: NULL-swarm rows quarantine from filtered replays, never lost", () => {
  test("unknown-kind outbox row: filtered pass excludes it, unfiltered pass redelivers it", async () => {
    const dir = tmpDir("m8-fix01-f2-");
    const dbPath = join(dir, "state.sqlite");
    const store = new SwarmStore(dbPath);
    const raw = rawHandle(dbPath);
    try {
      const swarmId = makeSwarm(store);
      addMember(store, swarmId, "coder-a", "sess-a");
      // Unknown kind + vanished aggregate: resolves to NULL swarm (store.ts
      // is another lane — inserted directly, never via store writers).
      raw
        .query("INSERT INTO outbox (id, kind, aggregate_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
        .run("m8f2-mystery-1", "mystery_kind", "no-such-aggregate", JSON.stringify({}), new Date().toISOString());
      const recovery = new CrashRecovery({ store, db: raw });
      // Filtered replay quarantines the NULL-swarm row: excluded, preserved.
      const filtered = await recovery.replayOutbox(
        async () => {
          throw new Error("NULL-swarm row must never reach a filtered consumer");
        },
        { swarmId },
      );
      expect(filtered.checked).toBe(0);
      expect(filtered.delivered).toBe(0);
      expect(filtered.scanned).toBeLessThanOrEqual(2000);
      expect(store.listPendingOutbox(100).length).toBe(1);
      // Unfiltered legacy replay still redelivers it: nothing is lost.
      const seen: string[] = [];
      const full = await recovery.replayOutbox(async (entry) => {
        seen.push(entry.id);
      });
      expect(full.delivered).toBe(1);
      expect(seen).toEqual(["m8f2-mystery-1"]);
      expect(store.listPendingOutbox(100).length).toBe(0);
    } finally {
      store.close();
      raw.close();
    }
  });
});
