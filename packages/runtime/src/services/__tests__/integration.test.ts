/**
 * M4-03 integration-gate tests (spec §10 steps 7-10 + §6 + §8).
 *
 * Disposable tmp Git repos ONLY (git init) — never the canonical checkout
 * or user projects. No model inference. Covers: 8-worktree parallel
 * integrate with disjoint ownedPaths (serialized, no contamination),
 * conflict rejection, failed verification/post-integration blocking with
 * canonical unchanged + worktree preserved, duplicate-completion dedupe,
 * crash/restart safety (file-backed DB, no duplicate merge), stale-lease
 * recovery with fencing increment, live-lease bounded wait, reconcile
 * quarantine, dirty-worktree block, and space-bearing Windows paths.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntegrationError, IntegrationService, loadM4Surfaces } from "../integration.js";
// NOTE (M4-03): M4-01 classes + LEASES_DDL are import-only reuse loaded at
// runtime (see integration.ts header — static cross-package imports cannot
// typecheck under the orchestrator-owned rootDir containment).
// biome-ignore lint: runtime-loaded surface typed via integration.ts mirrors
let M4: Awaited<ReturnType<typeof loadM4Surfaces>>;
beforeAll(async () => {
  M4 = await loadM4Surfaces();
});

const TMP_ROOTS: string[] = [];
function track(p: string): string {
  TMP_ROOTS.push(p);
  return p;
}
function realTmp(): string {
  return realpathSync(tmpdir());
}
afterAll(() => {
  for (const p of TMP_ROOTS.reverse()) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup of disposable tmp dirs */
    }
  }
});

function git(cwd: string, ...args: string[]): string {
  const out = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${out.stderr.toString().slice(0, 500)}`);
  }
  return out.stdout.toString().trim();
}

/** Disposable shared repo (stands in for the canonical repo) with one commit on main. */
function makeRepo(): { repo: string; head: string } {
  const repo = track(mkdtempSync(join(realTmp(), "m4-03-repo-")));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "m4-03@test.local");
  git(repo, "config", "user.name", "m4-03");
  writeFileSync(join(repo, "README.md"), "# disposable\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "init");
  return { repo, head: git(repo, "rev-parse", "HEAD") };
}

function makeDb(path?: string): Database {
  const db = path === undefined ? new Database(":memory:") : new Database(path);
  db.exec(M4.LEASES_DDL);
  return db;
}

function evidenceDir(): string {
  return track(mkdtempSync(join(realTmp(), "m4-03-ev-")));
}

function svc(repo: string, db: Database, extra?: { acquireTimeoutMs?: number }): IntegrationService {
  return new IntegrationService({ repoRoot: repo, db, ...(extra ?? {}) });
}

async function createTaskWorktree(
  repo: string,
  root: string,
  taskId: string,
  base: string,
  ownedPaths: readonly string[],
  live: { taskId: string; worktreePath: string | null; ownedPaths: readonly string[] }[] = [],
): Promise<string> {
  const mgr = new M4.WorktreeManager(repo);
  const rec = await mgr.createWorktree({
    worktreeRoot: root,
    canonicalRoot: repo,
    taskId,
    baseCommit: base,
    ownedPaths: [...ownedPaths],
    liveAssignments: live,
  });
  live.push({ taskId, worktreePath: rec.worktreePath, ownedPaths: [...ownedPaths] });
  return rec.worktreePath;
}

function commitFile(cwd: string, name: string, content: string, msg: string): string {
  writeFileSync(join(cwd, name), content);
  git(cwd, "add", name);
  git(cwd, "commit", "-m", msg);
  return git(cwd, "rev-parse", "HEAD");
}

function targetHead(repo: string): string {
  return git(repo, "rev-parse", "main^{commit}");
}

/** Read a file as committed on a ref (the checkout working tree is NOT updated by update-ref advances). */
function showFile(repo: string, ref: string, name: string): string {
  const out = Bun.spawnSync(["git", "show", `${ref}:${name}`], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0) {
    throw new Error(`git show ${ref}:${name} failed: ${out.stderr.toString().slice(0, 300)}`);
  }
  return out.stdout.toString();
}

function targetCount(repo: string): number {
  return Number.parseInt(git(repo, "rev-list", "--count", "main"), 10);
}

describe("parallel serialize — 8 worktrees, disjoint ownedPaths", () => {
  test(
    "all integrate without contamination",
    async () => {
      const { repo, head } = makeRepo();
      const root = track(mkdtempSync(join(realTmp(), "m4-03-wt8-")));
      const db = makeDb();
      const service = svc(repo, db);
      const live: { taskId: string; worktreePath: string | null; ownedPaths: readonly string[] }[] = [];
      const ids = Array.from({ length: 8 }, (_, i) => `t-${String(i + 1).padStart(2, "0")}`);
      const ev = evidenceDir();
      for (const id of ids) {
        const n = id.slice(2);
        const wt = await createTaskWorktree(repo, root, id, head, [`jobs/j${n}`], live);
        commitFile(wt, `${id}.txt`, `result-of-${id}\n`, `work ${id}`);
      }
      const results = await Promise.all(
        ids.map((id) =>
          service.integrate({
            taskId: id,
            worktreePath: live.find((l) => l.taskId === id)?.worktreePath ?? "",
            branch: `task/${id}`,
            baseCommit: head,
            verifyCommand: "git rev-parse HEAD",
            postVerifyCommand: "git rev-parse HEAD",
            evidenceDir: ev,
          }),
        ),
      );
      for (const r of results) expect(r.status).toBe("integrated");
      const shas = new Set(results.map((r) => r.sha));
      expect(shas.size).toBe(8);
      expect(targetCount(repo)).toBe(17); // init + 8 task commits + 8 --no-ff merge commits
      expect(Number.parseInt(git(repo, "rev-list", "--count", "--merges", "main"), 10)).toBe(8);
      // No contamination: every per-task file is on main with exact content.
      for (const id of ids) {
        expect(showFile(repo, "main", `${id}.txt`)).toBe(`result-of-${id}\n`);
      }
      const log = git(repo, "log", "--format=%s", "main");
      for (const id of ids) expect(log).toContain(`Merge branch 'task/${id}'`);
    },
    180_000,
  );

  test(
    "disjoint files land exactly (no cross-task contamination)",
    async () => {
      const { repo, head } = makeRepo();
      const root = track(mkdtempSync(join(realTmp(), "m4-03-wt8b-")));
      const db = makeDb();
      const service = svc(repo, db);
      const live: { taskId: string; worktreePath: string | null; ownedPaths: readonly string[] }[] = [];
      const ev = evidenceDir();
      const ids = ["a-01", "a-02", "a-03", "a-04", "a-05", "a-06", "a-07", "a-08"];
      for (const id of ids) {
        const wt = await createTaskWorktree(repo, root, id, head, [`jobs/${id}`], live);
        commitFile(wt, `${id}.txt`, `payload-${id}\n`, `work ${id}`);
      }
      const results = await Promise.all(
        ids.map((id) =>
          service.integrate({
            taskId: id,
            worktreePath: live.find((l) => l.taskId === id)?.worktreePath ?? "",
            branch: `task/${id}`,
            baseCommit: head,
            verifyCommand: "git rev-parse HEAD",
            evidenceDir: ev,
          }),
        ),
      );
      for (const r of results) expect(r.status).toBe("integrated");
      for (const id of ids) {
        expect(showFile(repo, "main", `${id}.txt`)).toBe(`payload-${id}\n`);
      }
    },
    180_000,
  );
});

describe("conflict + failure gates", () => {
  test(
    "merge conflict rejected; canonical unchanged; worktree preserved",
    async () => {
      const { repo, head } = makeRepo();
      const root = track(mkdtempSync(join(realTmp(), "m4-03-conf-")));
      const db = makeDb();
      const service = svc(repo, db);
      const wt = await createTaskWorktree(repo, root, "t-conf", head, ["jobs/conf"]);
      writeFileSync(join(repo, "base.txt"), "base\n");
      git(repo, "add", "base.txt");
      git(repo, "commit", "-m", "base file");
      const base2 = targetHead(repo);
      // Task branches from base2, edits base.txt one way...
      const wt2 = await createTaskWorktree(repo, root, "t-conf2", base2, ["jobs/conf2"]);
      commitFile(wt2, "base.txt", "task side\n", "task edit");
      // ...main moves the same file the other way.
      commitFile(repo, "base.txt", "main side\n", "main edit");
      const mainBefore = targetHead(repo);
      const r = await service.integrate({
        taskId: "t-conf2",
        worktreePath: wt2,
        branch: "task/t-conf2",
        baseCommit: base2,
        verifyCommand: "git rev-parse HEAD",
        evidenceDir: evidenceDir(),
      });
      expect(r.status).toBe("rejected-conflict");
      expect(targetHead(repo)).toBe(mainBefore);
      expect(existsSync(wt2)).toBe(true); // preserved for diagnosis
      expect(wt).not.toBe("");
      const row = db.query("SELECT outcome FROM integration_runs WHERE task_id = ?").get("t-conf2") as {
        outcome: string;
      } | null;
      expect(row?.outcome).toBe("rejected-conflict");
    },
    60_000,
  );

  test(
    "failed verification blocks; canonical unchanged; worktree preserved; retry allowed",
    async () => {
      const { repo, head } = makeRepo();
      const root = track(mkdtempSync(join(realTmp(), "m4-03-failv-")));
      const db = makeDb();
      const service = svc(repo, db);
      const wt = await createTaskWorktree(repo, root, "t-fv", head, ["jobs/fv"]);
      commitFile(wt, "work.txt", "work\n", "work");
      const mainBefore = targetHead(repo);
      const blocked = await service.integrate({
        taskId: "t-fv",
        worktreePath: wt,
        branch: "task/t-fv",
        baseCommit: head,
        verifyCommand: "exit 1",
        evidenceDir: evidenceDir(),
      });
      expect(blocked.status).toBe("blocked-verification");
      expect(blocked.verification?.exitCode).toBe(1);
      expect(targetHead(repo)).toBe(mainBefore);
      expect(existsSync(wt)).toBe(true);
      // Retry after the fix is allowed (blocked rows do not dedupe).
      const retry = await service.integrate({
        taskId: "t-fv",
        worktreePath: wt,
        branch: "task/t-fv",
        baseCommit: head,
        verifyCommand: "git rev-parse HEAD",
        evidenceDir: evidenceDir(),
      });
      expect(retry.status).toBe("integrated");
      expect(retry.sha).not.toBeNull();
      expect(targetHead(repo)).toBe(retry.sha as string);
    },
    60_000,
  );

  test(
    "failed post-integration tests abort the temp merge; canonical unchanged",
    async () => {
      const { repo, head } = makeRepo();
      const root = track(mkdtempSync(join(realTmp(), "m4-03-failp-")));
      const db = makeDb();
      const service = svc(repo, db);
      const wt = await createTaskWorktree(repo, root, "t-fp", head, ["jobs/fp"]);
      commitFile(wt, "work.txt", "work\n", "work");
      const mainBefore = targetHead(repo);
      const r = await service.integrate({
        taskId: "t-fp",
        worktreePath: wt,
        branch: "task/t-fp",
        baseCommit: head,
        verifyCommand: "git rev-parse HEAD",
        postVerifyCommand: "exit 1",
        evidenceDir: evidenceDir(),
      });
      expect(r.status).toBe("blocked-post-integration");
      expect(r.postVerification?.exitCode).toBe(1);
      expect(targetHead(repo)).toBe(mainBefore);
      expect(existsSync(wt)).toBe(true);
      // No temp refs leak; task branch retained for the fix.
      expect(git(repo, "rev-parse", "task/t-fp^{commit}")).not.toBe("");
    },
    60_000,
  );

  test(
    "dirty worktree blocked; canonical unchanged",
    async () => {
      const { repo, head } = makeRepo();
      const root = track(mkdtempSync(join(realTmp(), "m4-03-dirty-")));
      const db = makeDb();
      const service = svc(repo, db);
      const wt = await createTaskWorktree(repo, root, "t-dirty", head, ["jobs/dirty"]);
      commitFile(wt, "work.txt", "work\n", "work");
      writeFileSync(join(wt, "uncommitted.txt"), "draft\n");
      const mainBefore = targetHead(repo);
      const r = await service.integrate({
        taskId: "t-dirty",
        worktreePath: wt,
        branch: "task/t-dirty",
        baseCommit: head,
        verifyCommand: "git rev-parse HEAD",
        evidenceDir: evidenceDir(),
      });
      expect(r.status).toBe("blocked-dirty");
      expect(targetHead(repo)).toBe(mainBefore);
    },
    60_000,
  );
});

describe("idempotency + restart safety", () => {
  test(
    "duplicate completion deduped; no duplicate merge",
    async () => {
      const { repo, head } = makeRepo();
      const root = track(mkdtempSync(join(realTmp(), "m4-03-dup-")));
      const db = makeDb();
      const service = svc(repo, db);
      const wt = await createTaskWorktree(repo, root, "t-dup", head, ["jobs/dup"]);
      commitFile(wt, "work.txt", "work\n", "work");
      const first = await service.integrate({
        taskId: "t-dup",
        worktreePath: wt,
        branch: "task/t-dup",
        baseCommit: head,
        verifyCommand: "git rev-parse HEAD",
        evidenceDir: evidenceDir(),
      });
      expect(first.status).toBe("integrated");
      const countAfter = targetCount(repo);
      const second = await service.integrate({
        taskId: "t-dup",
        worktreePath: wt,
        branch: "task/t-dup",
        baseCommit: head,
        verifyCommand: "git rev-parse HEAD",
        evidenceDir: evidenceDir(),
      });
      expect(second.status).toBe("deduped");
      expect(second.sha).toBe(first.sha);
      expect(first.sha).not.toBeNull();
      expect(targetHead(repo)).toBe(first.sha as string);
      expect(targetCount(repo)).toBe(countAfter);
    },
    60_000,
  );

  test(
    "crash/restart on a file DB: new instance dedupes, no duplicate merge",
    async () => {
      const { repo, head } = makeRepo();
      const root = track(mkdtempSync(join(realTmp(), "m4-03-crash-")));
      const dbPath = join(track(mkdtempSync(join(realTmp(), "m4-03-crashdb-"))), "s.db");
      const db1 = makeDb(dbPath);
      const s1 = svc(repo, db1);
      const wt = await createTaskWorktree(repo, root, "t-crash", head, ["jobs/crash"]);
      commitFile(wt, "work.txt", "work\n", "work");
      const first = await s1.integrate({
        taskId: "t-crash",
        worktreePath: wt,
        branch: "task/t-crash",
        baseCommit: head,
        verifyCommand: "git rev-parse HEAD",
        evidenceDir: evidenceDir(),
      });
      expect(first.status).toBe("integrated");
      db1.close();
      // "Restart": brand-new handle on the same DB file + same repo.
      const db2 = makeDb(dbPath);
      const s2 = svc(repo, db2);
      const countBefore = targetCount(repo);
      const again = await s2.integrate({
        taskId: "t-crash",
        worktreePath: wt,
        branch: "task/t-crash",
        baseCommit: head,
        verifyCommand: "git rev-parse HEAD",
        evidenceDir: evidenceDir(),
      });
      expect(again.status).toBe("deduped");
      expect(again.sha).toBe(first.sha);
      expect(targetCount(repo)).toBe(countBefore);
      const rec = await s2.reconcile("t-crash");
      expect(rec.status).toBe("integrated-already");
      expect(rec.sha).toBe(first.sha);
      db2.close();
    },
    60_000,
  );

  test(
    "stale lease recovers with fencing increment",
    async () => {
      const { repo, head } = makeRepo();
      const root = track(mkdtempSync(join(realTmp(), "m4-03-stale-")));
      const db = makeDb();
      db.query("INSERT OR REPLACE INTO leases (resource_key, holder, fencing_token, expires_at) VALUES (?, ?, ?, ?)")
        .run("canonical-lock", "crashed-worker", 5, new Date(Date.now() - 60_000).toISOString());
      const service = svc(repo, db);
      const wt = await createTaskWorktree(repo, root, "t-stale", head, ["jobs/stale"]);
      commitFile(wt, "work.txt", "work\n", "work");
      const r = await service.integrate({
        taskId: "t-stale",
        worktreePath: wt,
        branch: "task/t-stale",
        baseCommit: head,
        verifyCommand: "git rev-parse HEAD",
        evidenceDir: evidenceDir(),
      });
      expect(r.status).toBe("integrated");
      expect(r.recoveredFrom).toBe("crashed-worker");
      expect(r.fencingToken).toBeGreaterThan(5);
    },
    60_000,
  );

  test(
    "reconcile quarantines ambiguous admission under a live foreign lease",
    async () => {
      const { repo, head } = makeRepo();
      const root = track(mkdtempSync(join(realTmp(), "m4-03-amb-")));
      const db = makeDb();
      const foreign = new M4.IntegrationLock(db, { ttlMs: 60_000 });
      foreign.acquire("integrate:t-other");
      const service = svc(repo, db);
      const wt = await createTaskWorktree(repo, root, "t-amb", head, ["jobs/amb"]);
      const mainBefore = targetHead(repo);
      const rec = await service.reconcile("t-amb", {
        worktreeRecord: { worktreePath: wt, branch: "task/t-amb", baseCommit: head },
      });
      expect(rec.status).toBe("lease-held-ambiguous");
      expect(rec.leaseHolder).toBe("integrate:t-other");
      expect(targetHead(repo)).toBe(mainBefore);
    },
    60_000,
  );

  test(
    "reconcile recovers a stale lease with fencing bump and takes no action",
    async () => {
      const { repo } = makeRepo();
      const db = makeDb();
      db.query("INSERT OR REPLACE INTO leases (resource_key, holder, fencing_token, expires_at) VALUES (?, ?, ?, ?)")
        .run("canonical-lock", "dead-worker", 3, new Date(Date.now() - 5_000).toISOString());
      const service = svc(repo, db);
      const mainBefore = targetHead(repo);
      const rec = await service.reconcile("t-ghost");
      expect(rec.status).toBe("no-record");
      expect(rec.recoveredFrom).toBe("dead-worker");
      expect((rec.fencingToken ?? 0)).toBeGreaterThan(3);
      expect(targetHead(repo)).toBe(mainBefore);
    },
    60_000,
  );

  test(
    "live lock held elsewhere → bounded LEASE_HELD, canonical unchanged, no run row",
    async () => {
      const { repo, head } = makeRepo();
      const root = track(mkdtempSync(join(realTmp(), "m4-03-held-")));
      const db = makeDb();
      const foreign = new M4.IntegrationLock(db, { ttlMs: 60_000 });
      foreign.acquire("integrate:t-busy");
      const service = svc(repo, db, { acquireTimeoutMs: 400 });
      const wt = await createTaskWorktree(repo, root, "t-wait", head, ["jobs/wait"]);
      commitFile(wt, "work.txt", "work\n", "work");
      const mainBefore = targetHead(repo);
      let err: unknown = null;
      try {
        await service.integrate({
          taskId: "t-wait",
          worktreePath: wt,
          branch: "task/t-wait",
          baseCommit: head,
          verifyCommand: "git rev-parse HEAD",
          evidenceDir: evidenceDir(),
        });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(IntegrationError);
      expect((err as IntegrationError).code).toBe("LEASE_HELD");
      expect(targetHead(repo)).toBe(mainBefore);
      const row = db.query("SELECT outcome FROM integration_runs WHERE task_id = ?").get("t-wait");
      expect(row).toBeNull();
    },
    60_000,
  );
});

describe("windows paths", () => {
  test(
    "worktree root containing spaces integrates cleanly (argv-only, no shell)",
    async () => {
      const { repo, head } = makeRepo();
      const root = track(mkdtempSync(join(realTmp(), "m4-03 with space-")));
      const db = makeDb();
      const service = svc(repo, db);
      const wt = await createTaskWorktree(repo, root, "t-space", head, ["jobs/space"]);
      commitFile(wt, "work.txt", "work\n", "work");
      const r = await service.integrate({
        taskId: "t-space",
        worktreePath: wt,
        branch: "task/t-space",
        baseCommit: head,
        verifyCommand: "git rev-parse HEAD",
        evidenceDir: evidenceDir(),
      });
      expect(r.status).toBe("integrated");
      expect(existsSync(r.verification?.stdoutPath ?? "")).toBe(true);
      expect(showFile(repo, "main", "work.txt")).toBe("work\n");
    },
    60_000,
  );
});

describe("S2 fail-closed gates + reconcile race (M4-03-REVIEW-01)", () => {
  test(
    "branch-mismatched worktree rejected; target unchanged; worktree preserved; row recorded",
    async () => {
      const { repo, head } = makeRepo();
      const root = track(mkdtempSync(join(realTmp(), "m4-03-bm-")));
      const db = makeDb();
      const service = svc(repo, db);
      const wt = await createTaskWorktree(repo, root, "t-bm", head, ["jobs/bm"]);
      commitFile(wt, "work.txt", "work\n", "work");
      const mainBefore = targetHead(repo);
      const r = await service.integrate({
        taskId: "t-bm",
        worktreePath: wt,
        branch: "task/t-bm-wrong",
        baseCommit: head,
        verifyCommand: "git rev-parse HEAD",
        evidenceDir: evidenceDir(),
      });
      expect(r.status).toBe("rejected-conflict");
      expect(targetHead(repo)).toBe(mainBefore);
      expect(existsSync(wt)).toBe(true);
      expect(existsSync(join(wt, "work.txt"))).toBe(true);
      const row = db.query("SELECT outcome FROM integration_runs WHERE task_id = ?").get("t-bm") as {
        outcome: string;
      } | null;
      expect(row?.outcome).toBe("rejected-conflict");
    },
    60_000,
  );

  test(
    "non-descendant HEAD rejected; target unchanged; worktree preserved; row recorded",
    async () => {
      const { repo, head } = makeRepo();
      const root = track(mkdtempSync(join(realTmp(), "m4-03-nd-")));
      const db = makeDb();
      const service = svc(repo, db);
      const wt = await createTaskWorktree(repo, root, "t-nd", head, ["jobs/nd"]);
      commitFile(wt, "work.txt", "work\n", "work");
      // Move main elsewhere so the recorded base is NOT an ancestor of the task HEAD.
      commitFile(repo, "main-only.txt", "main\n", "main moves on");
      const mainBefore = targetHead(repo);
      const r = await service.integrate({
        taskId: "t-nd",
        worktreePath: wt,
        branch: "task/t-nd",
        baseCommit: mainBefore,
        verifyCommand: "git rev-parse HEAD",
        evidenceDir: evidenceDir(),
      });
      expect(r.status).toBe("rejected-conflict");
      expect(targetHead(repo)).toBe(mainBefore);
      expect(existsSync(wt)).toBe(true);
      expect(existsSync(join(wt, "work.txt"))).toBe(true);
      const row = db.query("SELECT outcome FROM integration_runs WHERE task_id = ?").get("t-nd") as {
        outcome: string;
      } | null;
      expect(row?.outcome).toBe("rejected-conflict");
    },
    60_000,
  );

  test(
    "non-lease lock failure propagates original (no false LEASE_HELD); target unchanged",
    async () => {
      const { repo, head } = makeRepo();
      const root = track(mkdtempSync(join(realTmp(), "m4-03-nolease-")));
      const db = makeDb();
      const service = svc(repo, db);
      const wt = await createTaskWorktree(repo, root, "t-nl", head, ["jobs/nl"]);
      commitFile(wt, "work.txt", "work\n", "work");
      const mainBefore = targetHead(repo);
      const lockProto = (M4.IntegrationLock as unknown as {
        prototype: { acquire(holder: string): unknown };
      }).prototype;
      const origAcquire = lockProto.acquire;
      lockProto.acquire = (): unknown => {
        throw Object.assign(new Error("injected infra boom"), { code: "SQLITE_IOERR" });
      };
      let err: unknown = null;
      try {
        await service.integrate({
          taskId: "t-nl",
          worktreePath: wt,
          branch: "task/t-nl",
          baseCommit: head,
          verifyCommand: "git rev-parse HEAD",
          evidenceDir: evidenceDir(),
        });
      } catch (e) {
        err = e;
      } finally {
        lockProto.acquire = origAcquire;
      }
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("injected infra boom");
      expect((err as { code?: string }).code).not.toBe("LEASE_HELD");
      expect(targetHead(repo)).toBe(mainBefore);
      expect(existsSync(wt)).toBe(true);
    },
    60_000,
  );

  test(
    "reconcile race (lock grabbed after observe) quarantines ambiguous; no ref advance; worktree preserved",
    async () => {
      const { repo, head } = makeRepo();
      const root = track(mkdtempSync(join(realTmp(), "m4-03-race-")));
      const db = makeDb();
      const service = svc(repo, db);
      const wt = await createTaskWorktree(repo, root, "t-race", head, ["jobs/race"]);
      commitFile(wt, "work.txt", "work\n", "work");
      const mainBefore = targetHead(repo);
      // Inject the race: observe() sees a free lock, then acquire() loses it.
      const lockProto = (M4.IntegrationLock as unknown as {
        prototype: { acquire(holder: string): unknown };
      }).prototype;
      const origAcquire = lockProto.acquire;
      lockProto.acquire = (): unknown => {
        lockProto.acquire = origAcquire;
        throw Object.assign(new Error("Integration lock held by integrate:t-rival (injected race)"), {
          code: "LEASE_HELD",
        });
      };
      let rec: Awaited<ReturnType<IntegrationService["reconcile"]>>;
      try {
        rec = await service.reconcile("t-race", {
          worktreeRecord: { worktreePath: wt, branch: "task/t-race", baseCommit: head },
        });
      } finally {
        lockProto.acquire = origAcquire;
      }
      expect(rec.status).toBe("lease-held-ambiguous");
      expect(targetHead(repo)).toBe(mainBefore);
      expect(existsSync(wt)).toBe(true);
      expect(existsSync(join(wt, "work.txt"))).toBe(true);
    },
    60_000,
  );
});
