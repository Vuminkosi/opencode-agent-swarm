/**
 * M4-01 worktree-manager tests: disposable tmp Git repos ONLY (git init).
 * Never touches the canonical repo or user projects. Covers: create (unique
 * branch + base record), 8 simultaneous worktrees without contamination,
 * admission conflicts, write confinement, refresh/remove lifecycle,
 * crash/restart recovery, stale-lease integration lock, unsafe-cleanup
 * refusal, and agent-text rejection.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IntegrationLock,
  LEASES_DDL,
  WorktreeError,
  WorktreeManager,
  parseWorktreeList,
  type LiveAssignment,
  type WorktreeErrorCode,
  type WorktreeRecord,
} from "../worktree-manager.js";
import { normalizeForCompare, physicalFormForNewPath } from "../path-policy.js";

const TMP_ROOTS: string[] = [];

function track(p: string): string {
  TMP_ROOTS.push(p);
  return p;
}

function git(cwd: string, ...args: string[]): string {
  const out = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${out.stderr.toString().slice(0, 500)}`);
  }
  return out.stdout.toString().trim();
}

function expectWorktreeError(p: Promise<unknown>, code: WorktreeErrorCode): Promise<WorktreeError> {
  return p.then(
    () => {
      throw new Error(`expected WorktreeError ${code}, but the call succeeded`);
    },
    (err: unknown) => {
      expect(err).toBeInstanceOf(WorktreeError);
      expect((err as WorktreeError).code).toBe(code);
      return err as WorktreeError;
    },
  );
}

/** Disposable canonical repo (tmp only) with one commit. */
function makeRepo(): { repo: string; head: string } {
  const repo = track(mkdtempSync(join(tmpdir(), "gw-canon-")));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "m4-01@test.local");
  git(repo, "config", "user.name", "m4-01");
  writeFileSync(join(repo, "README.md"), "# disposable\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "init");
  return { repo, head: git(repo, "rev-parse", "HEAD") };
}

function makeRoot(): string {
  return track(mkdtempSync(join(tmpdir(), "gw-wt-")));
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

describe("create — admission", () => {
  test("records worktree_path + base_commit on a unique branch", async () => {
    const { repo, head } = makeRepo();
    const root = makeRoot();
    const mgr = new WorktreeManager(repo);
    const rec = await mgr.createWorktree({
      worktreeRoot: root,
      canonicalRoot: repo,
      taskId: "t-01",
      baseCommit: head,
      ownedPaths: ["jobs/j1"],
    });
    expect(rec.branch).toBe("task/t-01");
    expect(rec.baseCommit).toBe(head);
    expect(normalizeForCompare(rec.worktreePath).startsWith(normalizeForCompare(physicalFormForNewPath(root)))).toBe(
      true,
    );
    expect(existsSync(rec.worktreePath)).toBe(true);
    expect(git(rec.worktreePath, "rev-parse", "HEAD")).toBe(head);
    expect(git(rec.worktreePath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("task/t-01");
  });

  test("8 independently assigned worktrees on one repo", async () => {
    const { repo, head } = makeRepo();
    const root = makeRoot();
    const mgr = new WorktreeManager(repo);
    const live: LiveAssignment[] = [];
    const recs: WorktreeRecord[] = [];
    for (let i = 1; i <= 8; i++) {
      const rec = await mgr.createWorktree({
        worktreeRoot: root,
        canonicalRoot: repo,
        taskId: `t-${String(i).padStart(2, "0")}`,
        baseCommit: head,
        ownedPaths: [`jobs/j${i}`],
        liveAssignments: live,
      });
      recs.push(rec);
      live.push({ taskId: rec.taskId, worktreePath: rec.worktreePath, ownedPaths: [`jobs/j${i}`] });
    }
    const listed = parseWorktreeList(git(repo, "worktree", "list", "--porcelain"));
    for (const rec of recs) {
      expect(
        listed.some((w) => normalizeForCompare(w.path) === normalizeForCompare(rec.worktreePath)),
      ).toBe(true);
    }
    expect(new Set(recs.map((r) => r.branch)).size).toBe(8);
  });

  test("8 simultaneous writes do not contaminate each other or canonical", async () => {
    const { repo, head } = makeRepo();
    const root = makeRoot();
    const mgr = new WorktreeManager(repo);
    const live: LiveAssignment[] = [];
    const recs: WorktreeRecord[] = [];
    for (let i = 1; i <= 8; i++) {
      const rec = await mgr.createWorktree({
        worktreeRoot: root,
        canonicalRoot: repo,
        taskId: `w-${String(i).padStart(2, "0")}`,
        baseCommit: head,
        ownedPaths: [`jobs/j${i}`],
        liveAssignments: live,
      });
      recs.push(rec);
      live.push({ taskId: rec.taskId, worktreePath: rec.worktreePath, ownedPaths: [`jobs/j${i}`] });
    }
    await Promise.all(
      recs.map((rec, i) => Bun.write(join(rec.worktreePath, "jobs", `j${i + 1}`, "out.txt"), `worker-${i + 1}`)),
    );
    recs.forEach((rec, i) => {
      const marker = `worker-${i + 1}`;
      expect(readFileSync(join(rec.worktreePath, "jobs", `j${i + 1}`, "out.txt"), "utf8")).toBe(marker);
      // No other worker's file leaked into this worktree.
      for (let j = 1; j <= 8; j++) {
        if (j === i + 1) continue;
        expect(existsSync(join(rec.worktreePath, "jobs", `j${j}`, "out.txt"))).toBe(false);
      }
    });
    // Canonical checkout untouched.
    expect(existsSync(join(repo, "jobs"))).toBe(false);
  });

  test("ownedPaths overlap rejected at admission", async () => {
    const { repo, head } = makeRepo();
    const mgr = new WorktreeManager(repo);
    const live: LiveAssignment[] = [{ taskId: "t-01", worktreePath: null, ownedPaths: ["packages/foo"] }];
    await expectWorktreeError(
      mgr.createWorktree({
        worktreeRoot: makeRoot(),
        canonicalRoot: repo,
        taskId: "t-02",
        baseCommit: head,
        ownedPaths: ["packages/foo/deep"],
        liveAssignments: live,
      }),
      "OWNERSHIP_CONFLICT",
    );
  });

  test("path escape and agent text rejected", async () => {
    const { repo, head } = makeRepo();
    const mgr = new WorktreeManager(repo);
    const root = makeRoot();
    await expectWorktreeError(
      mgr.createWorktree({ worktreeRoot: root, canonicalRoot: repo, taskId: "../evil", baseCommit: head }),
      "INVALID_TASK_ID",
    );
    await expectWorktreeError(
      mgr.createWorktree({ worktreeRoot: root, canonicalRoot: repo, taskId: "a/b", baseCommit: head }),
      "INVALID_TASK_ID",
    );
    await expectWorktreeError(
      mgr.createWorktree({ worktreeRoot: root, canonicalRoot: repo, taskId: "t-x", baseCommit: "not-a-sha!!" }),
      "INVALID_COMMIT",
    );
    // Worktree root inside the canonical checkout would mutate canonical metadata.
    await expectWorktreeError(
      mgr.createWorktree({
        worktreeRoot: join(repo, ".wt"),
        canonicalRoot: repo,
        taskId: "t-x",
        baseCommit: head,
      }),
      "PATH_ESCAPES_ROOT",
    );
    // Worktree root that IS the canonical checkout.
    await expectWorktreeError(
      mgr.createWorktree({ worktreeRoot: repo, canonicalRoot: repo, taskId: "t-x", baseCommit: head }),
      "PATH_ESCAPES_ROOT",
    );
  });

  test("nonexistent root smuggled inside canonical via a symlinked ancestor is denied before mkdir (S1 F-02)", async () => {
    const { repo, head } = makeRepo();
    const mgr = new WorktreeManager(repo);
    const outside = track(mkdtempSync(join(tmpdir(), "gw-out-")));
    const link = join(outside, "into-repo");
    symlinkSync(repo, link, "junction");
    // Lexically outside the canonical checkout, but the deepest existing
    // ancestor (the junction) resolves inside it. The old
    // bestEffortRealpathNoThrow-on-nonexistent-root check passed this.
    const smuggled = join(link, "wt-new");
    await expectWorktreeError(
      mgr.createWorktree({ worktreeRoot: smuggled, canonicalRoot: repo, taskId: "t-s1", baseCommit: head }),
      "PATH_ESCAPES_ROOT",
    );
    expect(existsSync(smuggled)).toBe(false);
    expect(existsSync(join(repo, "wt-new"))).toBe(false);
  });

  test("FS operations preserve case — no lowercased directories (S2 F-03)", async () => {
    const { repo, head } = makeRepo();
    const root = track(join(tmpdir(), `GW-UPPER-${process.pid}-${Date.now()}`));
    const mgr = new WorktreeManager(repo);
    const rec = await mgr.createWorktree({
      worktreeRoot: root,
      canonicalRoot: repo,
      taskId: "t-up",
      baseCommit: head,
    });
    expect(existsSync(rec.worktreePath)).toBe(true);
    expect(rec.worktreePath).toContain("GW-UPPER");
    expect(git(rec.worktreePath, "rev-parse", "HEAD")).toBe(head);
  });

  test("branch names with a leading dash/dot and empty grants rejected with precise codes (S3)", async () => {
    const { repo, head } = makeRepo();
    const mgr = new WorktreeManager(repo);
    const root = makeRoot();
    await expectWorktreeError(
      mgr.createWorktree({ worktreeRoot: root, canonicalRoot: repo, taskId: "t-b1", baseCommit: head, branch: "-evil" }),
      "INVALID_BRANCH",
    );
    await expectWorktreeError(
      mgr.createWorktree({ worktreeRoot: root, canonicalRoot: repo, taskId: "t-b2", baseCommit: head, branch: ".hidden" }),
      "INVALID_BRANCH",
    );
    await expectWorktreeError(
      mgr.createWorktree({
        worktreeRoot: root,
        canonicalRoot: repo,
        taskId: "t-g1",
        baseCommit: head,
        ownedPaths: [""],
      }),
      "INVALID_GRANT",
    );
  });

  test("duplicate task re-admission and branch reuse refused", async () => {
    const { repo, head } = makeRepo();
    const mgr = new WorktreeManager(repo);
    const root = makeRoot();
    await mgr.createWorktree({ worktreeRoot: root, canonicalRoot: repo, taskId: "t-dup", baseCommit: head });
    await expectWorktreeError(
      mgr.createWorktree({ worktreeRoot: root, canonicalRoot: repo, taskId: "t-dup", baseCommit: head }),
      "WORKTREE_EXISTS",
    );
  });

  test("unknown base commit refused", async () => {
    const { repo } = makeRepo();
    const mgr = new WorktreeManager(repo);
    await expectWorktreeError(
      mgr.createWorktree({
        worktreeRoot: makeRoot(),
        canonicalRoot: repo,
        taskId: "t-x",
        baseCommit: "deadbeef",
      }),
      "INVALID_COMMIT",
    );
  });
});

describe("worker write confinement (manager surface)", () => {
  test("denies canonical, outside-owned, forbidden", () => {
    const { repo } = makeRepo();
    const mgr = new WorktreeManager(repo);
    const wt = join(makeRoot(), "task-t1");
    mkdirSync(wt, { recursive: true });
    expect(mgr.validateWrite(wt, ["pkgs/a"], [], join(repo, "pkgs", "a", "x.ts")).allowed).toBe(false);
    const denied = mgr.validateWrite(wt, ["pkgs/a"], [], join(wt, "pkgs", "b", "x.ts"));
    expect(denied.allowed).toBe(false);
    const forbidden = mgr.validateWrite(wt, ["pkgs/a"], ["pkgs/a/keys"], join(wt, "pkgs", "a", "keys", "k"));
    expect(forbidden.allowed).toBe(false);
    expect(mgr.validateWrite(wt, ["pkgs/a"], [], join(wt, "pkgs", "a", "x.ts")).allowed).toBe(true);
  });
});

describe("refresh — verify existence + branch + baseline", () => {
  test("healthy clean worktree", async () => {
    const { repo, head } = makeRepo();
    const mgr = new WorktreeManager(repo);
    const rec = await mgr.createWorktree({
      worktreeRoot: makeRoot(),
      canonicalRoot: repo,
      taskId: "t-r1",
      baseCommit: head,
    });
    const r = await mgr.refresh("t-r1", rec);
    expect(r.branchMatches).toBe(true);
    expect(r.clean).toBe(true);
    expect(r.headSha).toBe(head);
  });

  test("dirty baseline preserved (not auto-cleaned)", async () => {
    const { repo, head } = makeRepo();
    const mgr = new WorktreeManager(repo);
    const rec = await mgr.createWorktree({
      worktreeRoot: makeRoot(),
      canonicalRoot: repo,
      taskId: "t-r2",
      baseCommit: head,
    });
    writeFileSync(join(rec.worktreePath, "scratch.txt"), "dirty");
    const r = await mgr.refresh("t-r2", rec);
    expect(r.clean).toBe(false);
    expect(r.headSha).toBe(head);
    expect(existsSync(join(rec.worktreePath, "scratch.txt"))).toBe(true);
  });

  test("refresh denies records inside the canonical checkout (S2 F-06)", async () => {
    const { repo, head } = makeRepo();
    const mgr = new WorktreeManager(repo);
    await expectWorktreeError(
      mgr.refresh("t-evil", {
        taskId: "t-evil",
        branch: "task/t-evil",
        worktreePath: join(repo, ".wt", "evil"),
        baseCommit: head,
      }),
      "PATH_ESCAPES_ROOT",
    );
  });

  test("deleted worktree dir reports missing", async () => {
    const { repo, head } = makeRepo();
    const mgr = new WorktreeManager(repo);
    const rec = await mgr.createWorktree({
      worktreeRoot: makeRoot(),
      canonicalRoot: repo,
      taskId: "t-r3",
      baseCommit: head,
    });
    rmSync(rec.worktreePath, { recursive: true, force: true });
    await expectWorktreeError(mgr.refresh("t-r3", rec), "WORKTREE_MISSING");
  });
});

describe("remove — safe lifecycle", () => {
  test("remove without baseCommit fails closed and keeps the worktree (S2 F-04)", async () => {
    const { repo, head } = makeRepo();
    const mgr = new WorktreeManager(repo);
    const rec = await mgr.createWorktree({
      worktreeRoot: makeRoot(),
      canonicalRoot: repo,
      taskId: "t-nb",
      baseCommit: head,
    });
    await expectWorktreeError(mgr.remove(rec.worktreePath), "INVALID_COMMIT");
    await expectWorktreeError(mgr.remove(rec.worktreePath, { branch: rec.branch }), "INVALID_COMMIT");
    expect(existsSync(rec.worktreePath)).toBe(true);
    const done = await mgr.remove(rec.worktreePath, { baseCommit: head, branch: rec.branch });
    expect(done.removed).toBe(true);
  });

  test("remove with an unsafe branch is rejected (S2 F-05)", async () => {
    const { repo, head } = makeRepo();
    const mgr = new WorktreeManager(repo);
    const rec = await mgr.createWorktree({
      worktreeRoot: makeRoot(),
      canonicalRoot: repo,
      taskId: "t-eb",
      baseCommit: head,
    });
    await expectWorktreeError(
      mgr.remove(rec.worktreePath, { baseCommit: head, branch: "-evil" }),
      "INVALID_BRANCH",
    );
    await expectWorktreeError(
      mgr.remove(rec.worktreePath, { baseCommit: head, branch: "a..b" }),
      "INVALID_BRANCH",
    );
    expect(existsSync(rec.worktreePath)).toBe(true);
    const done = await mgr.remove(rec.worktreePath, { baseCommit: head, branch: rec.branch });
    expect(done.removed).toBe(true);
  });

  test("refuses dirty tree; preserveFailed keeps it for diagnosis", async () => {
    const { repo, head } = makeRepo();
    const mgr = new WorktreeManager(repo);
    const rec = await mgr.createWorktree({
      worktreeRoot: makeRoot(),
      canonicalRoot: repo,
      taskId: "t-del1",
      baseCommit: head,
    });
    writeFileSync(join(rec.worktreePath, "dirty.txt"), "x");
    await expectWorktreeError(mgr.remove(rec.worktreePath, { baseCommit: head, branch: rec.branch }), "DIRTY_WORKTREE");
    const kept = await mgr.remove(rec.worktreePath, { baseCommit: head, branch: rec.branch, preserveFailed: true });
    expect(kept).toMatchObject({ removed: false, preserved: true });
    expect(existsSync(rec.worktreePath)).toBe(true);
  });

  test("refuses unintegrated commits; clean removal deletes branch at base", async () => {
    const { repo, head } = makeRepo();
    const mgr = new WorktreeManager(repo);
    const rec = await mgr.createWorktree({
      worktreeRoot: makeRoot(),
      canonicalRoot: repo,
      taskId: "t-del2",
      baseCommit: head,
    });
    writeFileSync(join(rec.worktreePath, "feat.txt"), "v1");
    git(rec.worktreePath, "add", "feat.txt");
    git(rec.worktreePath, "commit", "-m", "unintegrated work");
    await expectWorktreeError(mgr.remove(rec.worktreePath, { baseCommit: head, branch: rec.branch }), "UNINTEGRATED_COMMITS");
    // Integrate-then-rebase simulation: reset onto base → clean + at base.
    git(rec.worktreePath, "reset", "--hard", head);
    const done = await mgr.remove(rec.worktreePath, { baseCommit: head, branch: rec.branch });
    expect(done.removed).toBe(true);
    expect(existsSync(rec.worktreePath)).toBe(false);
    const listed = parseWorktreeList(git(repo, "worktree", "list", "--porcelain"));
    expect(
      listed.some((w) => normalizeForCompare(w.path) === normalizeForCompare(rec.worktreePath)),
    ).toBe(false);
    // Branch pointed exactly at base → cleaned up.
    const refGone = Bun.spawnSync(["git", "show-ref", "--verify", "--quiet", `refs/heads/${rec.branch}`], {
      cwd: repo,
    });
    expect(refGone.exitCode).not.toBe(0);
  });

  test("never touches unregistered paths", async () => {
    const { repo } = makeRepo();
    const mgr = new WorktreeManager(repo);
    const stranger = track(mkdtempSync(join(tmpdir(), "gw-stranger-")));
    writeFileSync(join(stranger, "keep.txt"), "do not delete");
    await expectWorktreeError(mgr.remove(stranger), "WORKTREE_MISSING");
    expect(existsSync(join(stranger, "keep.txt"))).toBe(true);
  });
});

describe("recover — restart reconciliation", () => {
  test("healthy report + fencing generation bumps every call", async () => {
    const { repo, head } = makeRepo();
    const mgr = new WorktreeManager(repo);
    const rec = await mgr.createWorktree({
      worktreeRoot: makeRoot(),
      canonicalRoot: repo,
      taskId: "t-c1",
      baseCommit: head,
    });
    let fencing = 0;
    const bump = (): number => {
      fencing += 1;
      return fencing;
    };
    const r1 = await mgr.recover("t-c1", rec, { onFencingBump: bump });
    expect(r1.status).toBe("healthy");
    expect(r1.fencingGeneration).toBe(1);
    const r2 = await mgr.recover("t-c1", rec, { onFencingBump: bump });
    expect(r2.status).toBe("healthy");
    expect(r2.fencingGeneration).toBe(2);
  });

  test("daemon-restart equivalent: fresh manager instance reconciles", async () => {
    const { repo, head } = makeRepo();
    const root = makeRoot();
    const rec = await new WorktreeManager(repo).createWorktree({
      worktreeRoot: root,
      canonicalRoot: repo,
      taskId: "t-c2",
      baseCommit: head,
    });
    // Simulate restart: drop the manager, create a new one.
    const restarted = new WorktreeManager(repo);
    const r = await restarted.recover("t-c2", rec);
    expect(r.status).toBe("healthy");
    expect(r.fencingGeneration).toBe(1);
    expect(r.refresh?.headSha).toBe(head);
  });

  test("orphaned record needs attention, deletes nothing", async () => {
    const { repo, head } = makeRepo();
    const mgr = new WorktreeManager(repo);
    const rec = await mgr.createWorktree({
      worktreeRoot: makeRoot(),
      canonicalRoot: repo,
      taskId: "t-c3",
      baseCommit: head,
    });
    rmSync(rec.worktreePath, { recursive: true, force: true });
    git(repo, "worktree", "prune");
    const r = await mgr.recover("t-c3", rec);
    expect(r.status).toBe("orphaned-record");
    expect(r.worktreePath).toBe(rec.worktreePath);
  });

  test("unknown path left untouched; no-record is explicit", async () => {
    const { repo } = makeRepo();
    const mgr = new WorktreeManager(repo);
    const root = makeRoot();
    const mystery = join(root, "mystery-dir");
    mkdirSync(mystery, { recursive: true });
    writeFileSync(join(mystery, "notes.txt"), "someone else's work");
    const r = await mgr.recover("t-zzz", null, { candidatePath: mystery });
    expect(r.status).toBe("unknown-path");
    expect(existsSync(join(mystery, "notes.txt"))).toBe(true);
    const n = await mgr.recover("t-zzz", null);
    expect(n.status).toBe("no-record");
  });
});

describe("IntegrationLock — stale lease via leases table", () => {
  function openLock(ttlMs: number, now: { ms: number }): { db: Database; lock: IntegrationLock } {
    const db = new Database(":memory:");
    db.exec(LEASES_DDL);
    const lock = new IntegrationLock(db, { ttlMs, clock: () => now.ms });
    return { db, lock };
  }

  test("single holder; second holder denied while live", () => {
    const now = { ms: Date.parse("2026-01-01T00:00:00.000Z") };
    const { lock } = openLock(60_000, now);
    const a = lock.acquire("task-a");
    expect(a.fencingToken).toBe(1);
    expect(a.recoveredFrom).toBeNull();
    expect(() => lock.acquire("task-b")).toThrow(WorktreeError);
    try {
      lock.acquire("task-b");
    } catch (err) {
      expect((err as WorktreeError).code).toBe("LEASE_HELD");
    }
  });

  test("expiry allows recovery with a bumped fencing token (never reused)", () => {
    const now = { ms: Date.parse("2026-01-01T00:00:00.000Z") };
    const { db, lock } = openLock(1_000, now);
    const a = lock.acquire("task-a");
    now.ms += 5_000; // lease stale
    expect(lock.isLive()).toBe(false);
    const b = lock.acquire("task-b");
    expect(b.fencingToken).toBe(a.fencingToken + 1);
    expect(b.recoveredFrom).toBe("task-a");
    // Same holder re-acquire also bumps (monotonic, never reused).
    const c = lock.acquire("task-b");
    expect(c.fencingToken).toBe(b.fencingToken + 1);
    expect(c.recoveredFrom).toBeNull(); // live lease re-acquire is not a recovery
    db.close();
  });

  test("release is holder- and token-gated", () => {
    const now = { ms: Date.parse("2026-01-01T00:00:00.000Z") };
    const { db, lock } = openLock(60_000, now);
    const a = lock.acquire("task-a");
    expect(lock.release("task-b")).toBe(false);
    expect(lock.release("task-a", a.fencingToken + 99)).toBe(false);
    expect(lock.release("task-a", a.fencingToken)).toBe(true);
    expect(lock.observe()).toBeNull();
    db.close();
  });

  test("default resource key is canonical-lock (shared contract)", () => {
    const now = { ms: Date.now() };
    const { db, lock } = openLock(60_000, now);
    lock.acquire("task-a");
    const row = db.query<{ resource_key: string }, []>("SELECT resource_key FROM leases").get() as {
      resource_key: string;
    } | null;
    expect(row?.resource_key).toBe("canonical-lock");
    db.close();
  });
});

describe("remove — canonical-checkout deny (CODE-F-01)", () => {
  test("caller path inside canonical denied before lookup (fail-closed, no opts needed)", async () => {
    const { repo } = makeRepo();
    const mgr = new WorktreeManager(repo);
    // Not a registered worktree AND inside canonical: the canonical gate
    // must fire (PATH_ESCAPES_ROOT), not the unregistered-path gate.
    await expectWorktreeError(mgr.remove(join(repo, ".wt", "nope")), "PATH_ESCAPES_ROOT");
    expect(existsSync(join(repo, ".wt", "nope"))).toBe(false);
  });

  test("listed worktree inside canonical denied via forged/drifted path; nothing deleted", async () => {
    const { repo, head } = makeRepo();
    const mgr = new WorktreeManager(repo);
    // Bypass admission (which refuses canonical-inside roots) with raw git
    // to simulate a forged record or a path that drifted under canonical.
    const evilFs = join(repo, ".wt-evil");
    git(repo, "worktree", "add", "-b", "task/evil", evilFs, head);
    try {
      // Clean and exactly at base — without the canonical gate this call
      // would succeed and delete, so denial proves the gate fired first.
      await expectWorktreeError(
        mgr.remove(evilFs, { baseCommit: head, branch: "task/evil" }),
        "PATH_ESCAPES_ROOT",
      );
      expect(existsSync(evilFs)).toBe(true);
    } finally {
      git(repo, "worktree", "remove", "--force", evilFs);
    }
  });
});
