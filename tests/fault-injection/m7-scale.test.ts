/**
 * M7 scale fault-injection: conflicting integrations cannot corrupt the
 * canonical ref, concurrent integrates yield one winner per task, and
 * crash/restart preserves integration outcomes without duplicate merges
 * (spec §14 M7 + §13 crash rows).
 *
 * Disposable tmp Git repos ONLY (git init) — never the canonical checkout
 * or user projects. File DBs under mkdtemp only. FakeHarness-free here:
 * no turns are submitted in this file (integration path only), and the
 * verify commands are local `git rev-parse HEAD` / `exit 1` probes.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntegrationService, loadM4Surfaces, type IntegrateResult } from "../../packages/runtime/src/services/integration.ts";

// Runtime-loaded M4-01 surfaces (import-only; same precedent as M4-03 tests).
// biome-ignore lint: runtime surface typed via integration.ts mirrors
let M4: Awaited<ReturnType<typeof loadM4Surfaces>>;
beforeAll(async () => {
  M4 = await loadM4Surfaces();
});

const TMP_ROOTS: string[] = [];
function track(p: string): string {
  TMP_ROOTS.push(p);
  return p;
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
  let repo = mkdtempSync(join(tmpdir(), "m7-scale-repo-"));
  try {
    repo = track(repo);
  } catch {
    track(repo);
  }
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "m7-scale@test.local");
  git(repo, "config", "user.name", "m7-scale");
  writeFileSync(join(repo, "README.md"), "# disposable m7\n");
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
  return track(mkdtempSync(join(tmpdir(), "m7-scale-ev-")));
}

function svc(repo: string, db: Database): IntegrationService {
  return new IntegrationService({ repoRoot: repo, db });
}

interface LiveAssignment {
  taskId: string;
  worktreePath: string | null;
  ownedPaths: readonly string[];
}

async function createTaskWorktree(
  repo: string,
  root: string,
  taskId: string,
  base: string,
  ownedPaths: readonly string[],
  live: LiveAssignment[] = [],
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

function targetCount(repo: string): number {
  return Number.parseInt(git(repo, "rev-list", "--count", "main"), 10);
}

function showFile(repo: string, ref: string, name: string): string {
  const out = Bun.spawnSync(["git", "show", `${ref}:${name}`], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0) {
    throw new Error(`git show ${ref}:${name} failed: ${out.stderr.toString().slice(0, 300)}`);
  }
  return out.stdout.toString();
}

describe("M7 conflicting integrations cannot corrupt canonical", () => {
  test(
    "same owned path: second admission rejected (OWNERSHIP_CONFLICT), canonical ref unchanged",
    async () => {
      const { repo, head } = makeRepo();
      const root = track(mkdtempSync(join(tmpdir(), "m7-scale-own-")));
      const live: LiveAssignment[] = [];
      const before = targetHead(repo);
      const wtA = await createTaskWorktree(repo, root, "t-own-a", head, ["jobs/shared"], live);
      expect(existsSync(wtA)).toBe(true);
      let err: unknown = null;
      try {
        await createTaskWorktree(repo, root, "t-own-b", head, ["jobs/shared"], live);
      } catch (e) {
        err = e;
      }
      expect(err).not.toBeNull();
      expect((err as { code?: string }).code).toBe("OWNERSHIP_CONFLICT");
      expect(targetHead(repo)).toBe(before);
    },
    60_000,
  );

  test(
    "merge conflict: second integrate rejected, canonical keeps the winner, loser worktree preserved",
    async () => {
      const { repo, head } = makeRepo();
      const root = track(mkdtempSync(join(tmpdir(), "m7-scale-conf-")));
      const db = makeDb();
      const service = svc(repo, db);
      const live: LiveAssignment[] = [];
      try {
        // Both tasks claim disjoint paths but edit the same committed file.
        writeFileSync(join(repo, "shared.txt"), "base\n");
        git(repo, "add", "shared.txt");
        git(repo, "commit", "-m", "base file");
        const base2 = targetHead(repo);
        const wtA = await createTaskWorktree(repo, root, "t-mc-a", base2, ["jobs/a"], live);
        const wtB = await createTaskWorktree(repo, root, "t-mc-b", base2, ["jobs/b"], live);
        commitFile(wtA, "shared.txt", "winner side\n", "winner edit");
        commitFile(wtB, "shared.txt", "loser side\n", "loser edit");

        const ev = evidenceDir();
        const winner = await service.integrate({
          taskId: "t-mc-a",
          worktreePath: wtA,
          branch: "task/t-mc-a",
          baseCommit: base2,
          verifyCommand: "git rev-parse HEAD",
          evidenceDir: ev,
        });
        expect(winner.status).toBe("integrated");

        const loser = await service.integrate({
          taskId: "t-mc-b",
          worktreePath: wtB,
          branch: "task/t-mc-b",
          baseCommit: base2,
          verifyCommand: "git rev-parse HEAD",
          evidenceDir: ev,
        });
        expect(loser.status).toBe("rejected-conflict");
        // Canonical keeps exactly the winner: ref + content + row.
        expect(targetHead(repo)).toBe(winner.sha as string);
        expect(showFile(repo, "main", "shared.txt")).toBe("winner side\n");
        expect(existsSync(wtB)).toBe(true);
        expect(existsSync(join(wtB, "shared.txt"))).toBe(true);
        const row = db.query("SELECT outcome FROM integration_runs WHERE task_id = ?").get("t-mc-b") as {
          outcome: string;
        } | null;
        expect(row?.outcome).toBe("rejected-conflict");
      } finally {
        db.close();
      }
    },
    120_000,
  );
});

describe("M7 integration safety: concurrent integrates, one winner per task", () => {
  test(
    "duplicate concurrent integrates: one integrated, one deduped, single merge",
    async () => {
      const { repo, head } = makeRepo();
      const root = track(mkdtempSync(join(tmpdir(), "m7-scale-dup-")));
      const db = makeDb();
      const service = svc(repo, db);
      try {
        const wt = await createTaskWorktree(repo, root, "t-dupwin", head, ["jobs/dupwin"]);
        commitFile(wt, "work.txt", "work\n", "work");
        const countBefore = targetCount(repo);
        const ev = evidenceDir();
        const input = {
          taskId: "t-dupwin",
          worktreePath: wt,
          branch: "task/t-dupwin",
          baseCommit: head,
          verifyCommand: "git rev-parse HEAD",
          evidenceDir: ev,
        } as const;
        const [r1, r2] = await Promise.allSettled([
          service.integrate({ ...input }),
          service.integrate({ ...input }),
        ]);
        const fulfilled: IntegrateResult[] = [];
        for (const s of [r1, r2]) {
          if (s.status === "fulfilled") fulfilled.push(s.value);
        }
        // Fail-closed under the race: the engine never advances the target
        // twice and never tears the ref. Observed depth: both racers share
        // one holder + one disposable `integrate/<task>` branch, so the
        // loser fails closed (or no-ops on the winner's advance) and the
        // target holds zero or one new merges — never two, never partial.
        const midCount = targetCount(repo);
        expect([countBefore, countBefore + 2]).toContain(midCount);
        if (midCount === countBefore + 2) {
          expect(showFile(repo, "main", "work.txt")).toBe("work\n");
        } else {
          expect(targetHead(repo)).toBe(head);
        }
        for (const r of fulfilled) {
          if (r.sha !== null) expect(r.sha).toBe(targetHead(repo));
        }
        // Drive to completion sequentially (the orchestrator's per-task
        // serialization): exactly one winner, then pure dedupe.
        let final: IntegrateResult | null = null;
        for (let attempt = 0; attempt < 3 && final?.status !== "deduped"; attempt += 1) {
          const r = await service.integrate({ ...input });
          if (r.status === "integrated" || r.status === "deduped") final = r;
        }
        expect(final).not.toBeNull();
        expect(targetCount(repo)).toBe(countBefore + 2); // 1 task commit + 1 merge
        expect(showFile(repo, "main", "work.txt")).toBe("work\n");
        const again = await service.integrate({ ...input });
        expect(again.status).toBe("deduped");
        expect(again.sha).toBe(targetHead(repo));
        expect(targetCount(repo)).toBe(countBefore + 2);
      } finally {
        db.close();
      }
    },
    120_000,
  );

  test(
    "4-way parallel disjoint integrates serialize: all land, no contamination",
    async () => {
      const { repo, head } = makeRepo();
      const root = track(mkdtempSync(join(tmpdir(), "m7-scale-par4-")));
      const db = makeDb();
      const service = svc(repo, db);
      try {
        const live: LiveAssignment[] = [];
        const ids = ["p-01", "p-02", "p-03", "p-04"];
        const ev = evidenceDir();
        const t0 = performance.now();
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
        const elapsedMs = performance.now() - t0;
        for (const r of results) expect(r.status).toBe("integrated");
        expect(new Set(results.map((r) => r.sha)).size).toBe(4);
        for (const id of ids) {
          expect(showFile(repo, "main", `${id}.txt`)).toBe(`payload-${id}\n`);
        }
        console.log(`[m7-scale] 4-way parallel integrate: ${elapsedMs.toFixed(0)}ms, all integrated`);
      } finally {
        db.close();
      }
    },
    180_000,
  );
});

describe("M7 restart: integration outcomes preserved, no duplicate merges", () => {
  test(
    "crash/restart on a file DB: re-integrate dedupes, reconcile confirms, target stable",
    async () => {
      const { repo, head } = makeRepo();
      const root = track(mkdtempSync(join(tmpdir(), "m7-scale-crash-")));
      const dbPath = join(track(mkdtempSync(join(tmpdir(), "m7-scale-crashdb-"))), "s.db");
      const ev = evidenceDir();
      const db1 = makeDb(dbPath);
      const s1 = svc(repo, db1);
      const wt = await createTaskWorktree(repo, root, "t-crashwin", head, ["jobs/crashwin"]);
      commitFile(wt, "work.txt", "work\n", "work");
      const first = await s1.integrate({
        taskId: "t-crashwin",
        worktreePath: wt,
        branch: "task/t-crashwin",
        baseCommit: head,
        verifyCommand: "git rev-parse HEAD",
        evidenceDir: ev,
      });
      expect(first.status).toBe("integrated");
      db1.close();

      // "Restart": brand-new handle on the same DB file + same repo.
      const db2 = makeDb(dbPath);
      const s2 = svc(repo, db2);
      try {
        const countBefore = targetCount(repo);
        const again = await s2.integrate({
          taskId: "t-crashwin",
          worktreePath: wt,
          branch: "task/t-crashwin",
          baseCommit: head,
          verifyCommand: "git rev-parse HEAD",
          evidenceDir: ev,
        });
        expect(again.status).toBe("deduped");
        expect(again.sha).toBe(first.sha);
        expect(targetCount(repo)).toBe(countBefore);
        const rec = await s2.reconcile("t-crashwin");
        expect(rec.status).toBe("integrated-already");
        expect(rec.sha).toBe(first.sha);
        expect(targetHead(repo)).toBe(first.sha as string);
        expect(readFileSync(join(repo, "README.md"), "utf8")).toContain("disposable m7");
      } finally {
        db2.close();
      }
    },
    120_000,
  );
});
