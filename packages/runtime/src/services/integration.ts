/**
 * M4-03 integration gate — serialized, policy-controlled canonical integration
 * (spec §10 steps 7-10 + §6 integration_runs + §8 locks).
 *
 * Import-only reuse (never modified here, never copied here):
 * - M4-01 `WorktreeManager` + `IntegrationLock` (canonical-lock, fencing++,
 *   expiry, stale recovery).
 * - M4-02 `runVerification` / `isVerificationPassing` (the gate predicate).
 * - M3 convention (no M3 edits): verification failure means "blocked — route
 *   to the defect loop (defect post + ready requeue)"; this service records
 *   the failure as evidence and never merges.
 *
 * Loading note: `package.json` manifests + `tsconfig` files (including the
 * runtime `rootDir: src` containment) are orchestrator-owned and outside this
 * task's owned paths, so no workspace dependency entries can be added and no
 * static cross-package import can typecheck. The M4-01/M4-02 modules are
 * therefore loaded at runtime via dynamic `import()` with non-literal
 * specifiers (relative to THIS file, correct under bun) and consumed through
 * the precise structural interfaces below. This is still import-only reuse:
 * every behavior (worktree lifecycle, fencing lock, verification runner)
 * executes from the actual M4-01/M4-02 modules — no logic is duplicated, only
 * type shapes are mirrored.
 *
 * Why there is NO `003_integration_runs.sql` migration file: `store.ts`
 * (and its MIGRATIONS registry) is owned by another lane — this task
 * contract prohibits editing it, and an unwired `.sql` file would be dead
 * schema. `integration_runs` is therefore service-owned and ensured
 * idempotently by `ensureIntegrationSchema()` (`CREATE TABLE IF NOT EXISTS`)
 * on the shared DB handle: same durability, same idempotency
 * (`task_id PRIMARY KEY` ⇒ duplicate completion is a deduped no-op).
 *
 * Safety policy (all Git via `Bun.spawn` argv-only, never a shell):
 * - One integration at a time under the shared `canonical-lock` lease.
 *   Waiters poll with a bounded `acquireTimeoutMs`; holders are named
 *   `integrate:<taskId>` so a same-task retry re-acquires safely.
 * - The canonical/target checkout's own HEAD and working tree are NEVER
 *   touched: the task branch merges into a disposable `integrate/<taskId>`
 *   branch inside a disposable tmp worktree. No `checkout`, no blind
 *   `force`/`reset` anywhere — the temp namespace is the only ref ever
 *   deleted, and only `integrate/*` names.
 * - Target advance is an atomic compare-and-swap
 *   (`update-ref refs/heads/<target> <new> <old>`): if the target moved
 *   under the lock the advance fails closed instead of overwriting.
 * - The task worktree is NEVER deleted or cleaned by this service: every
 *   failure path preserves it for diagnosis (no cleanup, no merge).
 * - Tmp repos only in tests; never the real canonical repo or user repos.
 * - No model inference, no paid services.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

// --- Runtime module loading (import-only; see header note) ---

const WORKTREE_MANAGER_SPEC: string = "../../../git-workspaces/src/worktree-manager.js";
const TEST_RUNNER_SPEC: string = "../../../verification/src/test-runner.js";

/** Structural mirror of the M4-01 worktree record (runtime type only). */
export interface M401WorktreeRecord {
  readonly taskId: string;
  readonly branch: string;
  readonly worktreePath: string;
  readonly baseCommit: string;
}

export interface M401RefreshReport {
  readonly taskId: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly branchMatches: true;
  readonly clean: boolean;
  readonly headSha: string;
  readonly baseCommit: string;
}

export interface M401RecoverReport {
  readonly status: string;
  readonly taskId: string;
  readonly worktreePath: string | null;
  readonly detail: string;
  readonly fencingGeneration: number;
}

export interface M401WorktreeManager {
  createWorktree(input: {
    readonly worktreeRoot: string;
    readonly canonicalRoot: string;
    readonly taskId: string;
    readonly baseCommit: string;
    readonly branch?: string;
    readonly ownedPaths?: readonly string[];
    readonly forbiddenPaths?: readonly string[];
    readonly liveAssignments?: readonly {
      readonly taskId: string;
      readonly worktreePath: string | null;
      readonly ownedPaths: readonly string[];
    }[];
    readonly timeoutMs?: number;
  }): Promise<M401WorktreeRecord>;
  refresh(taskId: string, record: M401WorktreeRecord, timeoutMs?: number): Promise<M401RefreshReport>;
  recover(
    taskId: string,
    record: M401WorktreeRecord | null,
    opts?: { readonly candidatePath?: string; readonly onFencingBump?: () => number | Promise<number> },
  ): Promise<M401RecoverReport>;
}

export interface M401AcquireResult {
  readonly holder: string;
  readonly fencingToken: number;
  readonly expiresAt: string;
  readonly recoveredFrom: string | null;
}

export interface M401LeaseState {
  readonly holder: string;
  readonly fencingToken: number;
  readonly expiresAt: string;
}

export interface M401IntegrationLock {
  acquire(holder: string): M401AcquireResult;
  release(holder: string, fencingToken?: number): boolean;
  observe(): M401LeaseState | null;
}

export interface M402VerificationEvidenceInput {
  readonly exitCode: number;
  readonly commitSha?: string;
}

export interface M402VerificationResult {
  readonly evidenceInput: M402VerificationEvidenceInput;
  readonly timedOut: boolean;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

export interface M402RunInput {
  readonly taskId: string;
  readonly worktreePath: string;
  readonly command: string;
  readonly executorMemberId: string;
  readonly evidenceDir?: string;
  readonly timeoutMs?: number;
  readonly canonicalRoot?: string;
}

export interface M4Surfaces {
  readonly WorktreeManager: new (repoRoot: string) => M401WorktreeManager;
  readonly IntegrationLock: new (
    db: unknown,
    opts?: { readonly resourceKey?: string; readonly ttlMs?: number; readonly clock?: () => number },
  ) => M401IntegrationLock;
  readonly LEASES_DDL: string;
  readonly runVerification: (input: M402RunInput) => Promise<M402VerificationResult>;
  readonly isVerificationPassing: (result: M402VerificationResult) => boolean;
}

let cachedSurfaces: Promise<M4Surfaces> | null = null;

/**
 * Load the real M4-01/M4-02 modules (import-only). Memoized: module
 * evaluation happens once per process; every caller shares it.
 */
export function loadM4Surfaces(): Promise<M4Surfaces> {
  if (cachedSurfaces === null) {
    cachedSurfaces = (async (): Promise<M4Surfaces> => {
      // Non-literal specifiers: resolved at runtime relative to this file.
      const [m401, m402] = await Promise.all([import(WORKTREE_MANAGER_SPEC), import(TEST_RUNNER_SPEC)]);
      const surfaces: M4Surfaces = {
        WorktreeManager: m401.WorktreeManager as M4Surfaces["WorktreeManager"],
        IntegrationLock: m401.IntegrationLock as M4Surfaces["IntegrationLock"],
        LEASES_DDL: m401.LEASES_DDL as string,
        runVerification: m402.runVerification as M4Surfaces["runVerification"],
        isVerificationPassing: m402.isVerificationPassing as M4Surfaces["isVerificationPassing"],
      };
      if (
        typeof surfaces.WorktreeManager !== "function" ||
        typeof surfaces.IntegrationLock !== "function" ||
        typeof surfaces.runVerification !== "function" ||
        typeof surfaces.isVerificationPassing !== "function" ||
        typeof surfaces.LEASES_DDL !== "string"
      ) {
        throw new IntegrationError("GIT_FAILED", "M4-01/M4-02 runtime surfaces unavailable", {});
      }
      return surfaces;
    })();
  }
  return cachedSurfaces;
}

/** Error `code` when the thrown value carries one (M4-01 WorktreeError shape). */
function errorCode(err: unknown): string | null {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code: unknown = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

// --- Error contract (safe messages only) ---

export type IntegrationErrorCode =
  | "INVALID_INPUT"
  | "LEASE_HELD"
  | "WORKTREE_UNUSABLE"
  | "GIT_FAILED"
  | "GIT_TIMEOUT";

export class IntegrationError extends Error {
  readonly code: IntegrationErrorCode;
  readonly details: Readonly<Record<string, string>>;
  constructor(code: IntegrationErrorCode, message: string, details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "IntegrationError";
    this.code = code;
    this.details = details;
  }
}

// --- Agent-text allowlists (same shape as M4-01; never trust agent text as a ref) ---

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COMMIT_RE = /^[0-9a-fA-F]{4,64}$/;

function assertTaskId(taskId: string): void {
  if (!TASK_ID_RE.test(taskId)) {
    throw new IntegrationError("INVALID_INPUT", `Unsafe task id rejected: ${taskId}`, { taskId });
  }
}

function assertBranch(branch: string, what: string): void {
  const bad =
    branch.length === 0 ||
    branch.length > 128 ||
    branch.startsWith("-") ||
    branch.startsWith(".") ||
    branch.startsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("/.") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.endsWith("/") ||
    branch.endsWith(".lock") ||
    branch.includes("@{") ||
    branch.includes("~") ||
    branch.includes("^") ||
    branch.includes(":") ||
    branch.includes("?") ||
    branch.includes("*") ||
    branch.includes("[") ||
    branch.includes("\\") ||
    /\s/.test(branch) ||
    // biome-ignore lint: control chars must never reach git argv as a ref
    /[\x00-\x1f\x7f]/.test(branch);
  if (bad) {
    throw new IntegrationError("INVALID_INPUT", `Unsafe ${what} branch name rejected: ${branch}`, {
      [what]: branch,
    });
  }
}

function assertCommit(commit: string, what: string): void {
  if (!COMMIT_RE.test(commit)) {
    throw new IntegrationError("INVALID_INPUT", `Unsafe ${what} commit rejected: ${commit}`, {
      [what]: commit,
    });
  }
}

// --- Service-owned durable schema (see header note re: no 003 file) ---

export const INTEGRATION_RUNS_DDL = `CREATE TABLE IF NOT EXISTS integration_runs (
  task_id TEXT PRIMARY KEY,
  outcome TEXT NOT NULL CHECK (outcome IN ('integrated','blocked-verification','blocked-post-integration','blocked-dirty','rejected-conflict')),
  sha TEXT,
  detail TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;

/** Idempotent schema ensure for the service-owned table (safe on every open). */
export function ensureIntegrationSchema(db: Database): void {
  db.exec(INTEGRATION_RUNS_DDL);
}

/**
 * S2-1: the canonical lock lives in the M4-01 `leases` table on the shared
 * DB handle (M4-01-owned DDL; this service never migrates it, only ensures
 * presence idempotently). A failure here throws loudly with the required
 * action instead of surfacing later as a misleading LEASE_HELD.
 */
function ensureLeasesSchema(db: Database, ddl: string): void {
  try {
    db.exec(ddl);
  } catch (err) {
    throw new IntegrationError(
      "GIT_FAILED",
      `leases schema unavailable: ${err instanceof Error ? err.message : String(err)} — ensure the shared DB handle applies M4-01 LEASES_DDL`,
      {},
    );
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

// --- Git CLI (argv only, never a shell) ---

const GIT_TIMEOUT_MS = 60_000;

interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runGit(repoCwd: string, args: readonly string[], timeoutMs: number): Promise<GitResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["git", ...args], { cwd: repoCwd, stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    throw new IntegrationError("GIT_FAILED", `Cannot spawn git: ${err instanceof Error ? err.message : String(err)}`, {});
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill(9);
    } catch {
      /* already exited */
    }
  }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      proc.stdout === null || typeof proc.stdout === "number"
        ? Promise.resolve("")
        : new Response(proc.stdout as ReadableStream).text(),
      proc.stderr === null || typeof proc.stderr === "number"
        ? Promise.resolve("")
        : new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    if (timedOut) {
      throw new IntegrationError("GIT_TIMEOUT", `git ${args[0] ?? ""} timed out after ${timeoutMs}ms`, {
        argv0: args[0] ?? "",
      });
    }
    return { code, stdout, stderr };
  } catch (err) {
    if (err instanceof IntegrationError) throw err;
    throw new IntegrationError(
      "GIT_FAILED",
      `git ${args[0] ?? ""} failed: ${err instanceof Error ? err.message : String(err)}`,
      { argv0: args[0] ?? "" },
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Non-blocking wait: never starve same-process lock holders (no Atomics.wait here). */
function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Public shapes ---

export type IntegrateStatus =
  | "integrated"
  | "deduped"
  | "blocked-verification"
  | "blocked-post-integration"
  | "blocked-dirty"
  | "rejected-conflict";

export interface VerificationSummary {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly commitSha: string | undefined;
}

export interface IntegrateInput {
  readonly taskId: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly verifyCommand: string;
  readonly executorMemberId?: string;
  readonly targetBranch?: string;
  /** Post-integration tests; defaults to `verifyCommand`. */
  readonly postVerifyCommand?: string;
  readonly evidenceDir?: string;
  readonly verifyTimeoutMs?: number;
}

export interface IntegrateResult {
  readonly taskId: string;
  readonly status: IntegrateStatus;
  /** New target head (integrated) or the already-integrated head (deduped). */
  readonly sha: string | null;
  readonly targetBranch: string;
  readonly headSha: string;
  readonly fencingToken: number;
  readonly recoveredFrom: string | null;
  readonly detail: string;
  readonly verification: VerificationSummary | undefined;
  readonly postVerification: VerificationSummary | undefined;
}

export type ReconcileStatus =
  | "integrated-already"
  | "recoverable"
  | "lease-held-ambiguous"
  | "no-record";

export interface ReconcileReport {
  readonly taskId: string;
  readonly status: ReconcileStatus;
  readonly sha: string | null;
  readonly fencingToken: number | null;
  readonly recoveredFrom: string | null;
  readonly leaseHolder: string | null;
  readonly worktreeStatus: string | null;
  readonly detail: string;
}

export interface IntegrationServiceOptions {
  /** Shared repo whose `targetBranch` advances (tmp repo in tests). */
  readonly repoRoot: string;
  /** Shared DB handle (leases table + service-owned integration_runs). */
  readonly db: Database;
  readonly lockTtlMs?: number;
  /** Bounded wait for the canonical lock (serializes parallel integrates). */
  readonly acquireTimeoutMs?: number;
  readonly acquirePollMs?: number;
  readonly gitTimeoutMs?: number;
  readonly clock?: () => number;
}

interface RunRow {
  outcome: string;
  sha: string | null;
  detail: string;
  fencing_token: number;
}

export class IntegrationService {
  private readonly repoRoot: string;
  private readonly db: Database;
  private readonly lockTtlMs: number;
  private readonly acquireTimeoutMs: number;
  private readonly acquirePollMs: number;
  private readonly gitTimeoutMs: number;
  private readonly clock: () => number;
  private readonly surfaces: Promise<M4Surfaces>;

  constructor(opts: IntegrationServiceOptions) {
    if (opts.repoRoot.trim() === "") {
      throw new IntegrationError("INVALID_INPUT", "repoRoot must be non-empty", {});
    }
    this.repoRoot = opts.repoRoot;
    this.db = opts.db;
    this.lockTtlMs = opts.lockTtlMs ?? 60_000;
    this.acquireTimeoutMs = opts.acquireTimeoutMs ?? 120_000;
    this.acquirePollMs = opts.acquirePollMs ?? 25;
    this.gitTimeoutMs = opts.gitTimeoutMs ?? GIT_TIMEOUT_MS;
    this.clock = opts.clock ?? Date.now;
    this.surfaces = loadM4Surfaces();
    ensureIntegrationSchema(this.db);
  }

  private newLock(s: M4Surfaces): M401IntegrationLock {
    return new s.IntegrationLock(this.db, {
      resourceKey: "canonical-lock",
      ttlMs: this.lockTtlMs,
      clock: this.clock,
    });
  }

  private readRun(taskId: string): RunRow | null {
    const row = this.db
      .query("SELECT outcome, sha, detail, fencing_token FROM integration_runs WHERE task_id = ?")
      .get(taskId) as RunRow | null;
    return row;
  }

  private recordRun(taskId: string, outcome: string, sha: string | null, detail: string, fencingToken: number): void {
    const now = nowIso();
    this.db
      .query(
        "INSERT OR REPLACE INTO integration_runs (task_id, outcome, sha, detail, fencing_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM integration_runs WHERE task_id = ?), ?), ?)",
      )
      .run(taskId, outcome, sha, detail.slice(0, 2000), fencingToken, taskId, now, now);
  }

  /**
   * Spec §10 steps 7-10: verify → temp-branch merge → post-integration
   * tests → atomic target advance, all under the single canonical lock.
   * Failure paths preserve the task worktree and never advance the target.
   */
  async integrate(input: IntegrateInput): Promise<IntegrateResult> {
    const taskId = input.taskId.trim();
    assertTaskId(taskId);
    assertBranch(input.branch, "branch");
    assertCommit(input.baseCommit, "base");
    const targetBranch = (input.targetBranch ?? "main").trim();
    assertBranch(targetBranch, "target");
    const verifyCommand = input.verifyCommand.trim();
    if (verifyCommand === "" || verifyCommand.length > 4096) {
      throw new IntegrationError("INVALID_INPUT", "verifyCommand must be 1..4096 chars", {});
    }
    if (input.worktreePath.trim() === "") {
      throw new IntegrationError("INVALID_INPUT", "worktreePath must be non-empty", {});
    }

    const s = await this.surfaces;
    // S2-1: ensure the M4-01 leases table exists (idempotent). Genuine DB
    // failures throw loudly with action (see ensureLeasesSchema) — they
    // never reach the acquire loop to be misreported as contention.
    ensureLeasesSchema(this.db, s.LEASES_DDL);
    // Serialized admission: bounded poll for the single canonical lock.
    // Stale (expired) leases recover with fencing++ inside acquire().
    const lock = this.newLock(s);
    const holder = `integrate:${taskId}`;
    const deadline = this.clock() + this.acquireTimeoutMs;
    let acquired: { fencingToken: number; recoveredFrom: string | null };
    for (;;) {
      try {
        const a = lock.acquire(holder);
        acquired = { fencingToken: a.fencingToken, recoveredFrom: a.recoveredFrom };
        break;
      } catch (err) {
        // S2-1: only a live foreign lease waits/retries. Any other DB/infra
        // failure propagates untouched — a broken store must never
        // masquerade as contention (no false LEASE_HELD).
        if (errorCode(err) !== "LEASE_HELD") throw err;
        if (this.clock() >= deadline) {
          throw new IntegrationError("LEASE_HELD", `Integration lock unavailable for ${taskId}`, { taskId });
        }
        await delayMs(this.acquirePollMs);
      }
    }

    try {
      return await this.integrateInner(s, input, targetBranch, acquired.fencingToken, acquired.recoveredFrom);
    } finally {
      // Release only when we still hold our own fencing token (never
      // steal a successor's lease after expiry).
      try {
        lock.release(holder, acquired.fencingToken);
      } catch {
        /* best-effort unlock; the TTL bounds any leftover */
      }
    }
  }

  private async integrateInner(
    s: M4Surfaces,
    input: IntegrateInput,
    targetBranch: string,
    fencingToken: number,
    recoveredFrom: string | null,
  ): Promise<IntegrateResult> {
    const taskId = input.taskId.trim();

    // Idempotency: duplicate completion is a deduped no-op (no re-merge,
    // no re-verify, canonical untouched beyond what already landed).
    const existing = this.readRun(taskId);
    if (existing !== null && existing.outcome === "integrated") {
      return {
        taskId,
        status: "deduped",
        sha: existing.sha,
        targetBranch,
        headSha: existing.sha ?? "",
        fencingToken,
        recoveredFrom,
        detail: `Duplicate completion for ${taskId}: already integrated; no-op.`,
        verification: undefined,
        postVerification: undefined,
      };
    }

    // Admission: the worktree must exist, be listed, and be on the task
    // branch (M4-01 refresh: branch match + clean/dirty baseline + HEAD).
    const manager = new s.WorktreeManager(this.repoRoot);
    let headSha: string;
    try {
      const refresh = await manager.refresh(taskId, {
        taskId,
        branch: input.branch,
        worktreePath: input.worktreePath,
        baseCommit: input.baseCommit,
      });
      headSha = refresh.headSha;
      if (!refresh.clean) {
        const detail = `Dirty worktree for ${taskId}: uncommitted changes preserved, no merge attempted.`;
        this.recordRun(taskId, "blocked-dirty", null, detail, fencingToken);
        return {
          taskId, status: "blocked-dirty", sha: null, targetBranch, headSha,
          fencingToken, recoveredFrom, detail, verification: undefined, postVerification: undefined,
        };
      }
    } catch (err) {
      const code = errorCode(err);
      if (code === "BRANCH_MISMATCH" || code === "WORKTREE_MISSING") {
        const detail = `Worktree unusable for ${taskId} (${code}): preserved, no merge attempted.`;
        this.recordRun(taskId, "rejected-conflict", null, detail, fencingToken);
        return {
          taskId, status: "rejected-conflict", sha: null, targetBranch, headSha: "",
          fencingToken, recoveredFrom, detail, verification: undefined, postVerification: undefined,
        };
      }
      throw err instanceof IntegrationError
        ? err
        : new IntegrationError("WORKTREE_UNUSABLE", `Worktree check failed for ${taskId}`, { taskId });
    }

    // Base-descendant check: HEAD must descend from the recorded base, and
    // the base must resolve in this repo (else the worktree is not the
    // admitted state — reject, preserve, no merge).
    const baseResolve = await runGit(this.repoRoot, ["rev-parse", `${input.baseCommit}^{commit}`], this.gitTimeoutMs);
    if (baseResolve.code !== 0) {
      throw new IntegrationError("INVALID_INPUT", `Base commit not found in repo for ${taskId}`, { taskId });
    }
    const ancestor = await runGit(input.worktreePath, ["merge-base", "--is-ancestor", input.baseCommit, "HEAD"], this.gitTimeoutMs);
    if (ancestor.code !== 0) {
      const detail = `HEAD of ${taskId} does not descend from its base commit: rejected, worktree preserved, no merge attempted.`;
      this.recordRun(taskId, "rejected-conflict", null, detail, fencingToken);
      return {
        taskId, status: "rejected-conflict", sha: null, targetBranch, headSha,
        fencingToken, recoveredFrom, detail, verification: undefined, postVerification: undefined,
      };
    }

    // Step 7: pre-integration verification IN the task worktree. Failure
    // (non-zero exit or timeout) blocks integration; the worktree is
    // preserved for the M3 defect loop (defect post + ready requeue by the
    // orchestrator — no M3 edits here).
    const executorMemberId = (input.executorMemberId ?? `integrate:${taskId}`).trim() || `integrate:${taskId}`;
    const pre = await s.runVerification({
      taskId,
      worktreePath: input.worktreePath,
      command: input.verifyCommand,
      executorMemberId,
      canonicalRoot: this.repoRoot,
      ...(input.evidenceDir === undefined ? {} : { evidenceDir: input.evidenceDir }),
      ...(input.verifyTimeoutMs === undefined ? {} : { timeoutMs: input.verifyTimeoutMs }),
    });
    const verification: VerificationSummary = {
      exitCode: pre.evidenceInput.exitCode,
      timedOut: pre.timedOut,
      stdoutPath: pre.stdoutPath,
      stderrPath: pre.stderrPath,
      commitSha: pre.evidenceInput.commitSha,
    };
    if (!s.isVerificationPassing(pre)) {
      const detail = `Verification failed for ${taskId} (exit ${verification.exitCode}, timedOut=${verification.timedOut ? "yes" : "no"}): blocked, worktree preserved for remediation, no merge attempted.`;
      this.recordRun(taskId, "blocked-verification", null, detail, fencingToken);
      return {
        taskId, status: "blocked-verification", sha: null, targetBranch, headSha,
        fencingToken, recoveredFrom, detail, verification, postVerification: undefined,
      };
    }

    // Steps 8-10: merge on a disposable temp branch inside a disposable
    // tmp worktree — the shared repo's own HEAD/working tree never moves
    // until the atomic update-ref advance.
    const targetOldOut = await runGit(this.repoRoot, ["rev-parse", `${targetBranch}^{commit}`], this.gitTimeoutMs);
    if (targetOldOut.code !== 0) {
      throw new IntegrationError("GIT_FAILED", `Target branch not found: ${targetBranch}`, { target: targetBranch });
    }
    const targetOld = targetOldOut.stdout.trim();
    const taskHeadOut = await runGit(this.repoRoot, ["rev-parse", `${input.branch}^{commit}`], this.gitTimeoutMs);
    if (taskHeadOut.code !== 0) {
      throw new IntegrationError("GIT_FAILED", `Task branch not found: ${input.branch}`, { task: taskId });
    }
    const taskHead = taskHeadOut.stdout.trim();

    // Already reachable: nothing to merge (git-level idempotency).
    const alreadyThere = await runGit(this.repoRoot, ["merge-base", "--is-ancestor", taskHead, targetOld], this.gitTimeoutMs);
    if (alreadyThere.code === 0) {
      this.recordRun(taskId, "integrated", targetOld, `Task ${taskId} already reachable from ${targetBranch}; no-op.`, fencingToken);
      return {
        taskId, status: "integrated", sha: targetOld, targetBranch, headSha,
        fencingToken, recoveredFrom, detail: `Already integrated at ${targetOld}.`, verification, postVerification: undefined,
      };
    }

    const tmpBranch = `integrate/${taskId}`;
    const scratchBase = mkdtempSync(join(tmpdir(), `m4-03-integrate-${taskId}-`));
    const tmpWorktree = join(scratchBase, `wt-${taskId}`);
    let tmpReady = false;
    try {
      // Leftover disposable temp branch from a crashed run: only the
      // `integrate/*` namespace is ever deleted, then recreated from target
      // (never force/reset of the target itself).
      const tmpExists = await runGit(this.repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${tmpBranch}`], this.gitTimeoutMs);
      if (tmpExists.code === 0) {
        await runGit(this.repoRoot, ["branch", "-D", tmpBranch], this.gitTimeoutMs);
      }
      const mkBranch = await runGit(this.repoRoot, ["branch", tmpBranch, targetOld], this.gitTimeoutMs);
      if (mkBranch.code !== 0) {
        throw new IntegrationError("GIT_FAILED", `Cannot create temp branch for ${taskId}`, { task: taskId });
      }
      const add = await runGit(this.repoRoot, ["worktree", "add", tmpWorktree, tmpBranch], this.gitTimeoutMs);
      if (add.code !== 0) {
        throw new IntegrationError("GIT_FAILED", `Cannot create temp worktree for ${taskId}`, { task: taskId });
      }
      tmpReady = true;

      // --no-ff merge of the task branch (conflict ⇒ reject, abort, retain all).
      const merge = await runGit(tmpWorktree, ["merge", "--no-ff", "--no-edit", input.branch], this.gitTimeoutMs);
      if (merge.code !== 0) {
        await runGit(tmpWorktree, ["merge", "--abort"], this.gitTimeoutMs).catch(() => undefined);
        const detail = `Merge conflict integrating ${taskId} into ${targetBranch}: rejected, all work retained, canonical unchanged.`;
        this.recordRun(taskId, "rejected-conflict", null, detail, fencingToken);
        return {
          taskId, status: "rejected-conflict", sha: null, targetBranch, headSha,
          fencingToken, recoveredFrom, detail, verification, postVerification: undefined,
        };
      }

      // Post-integration tests in the merged tree. Failure aborts the temp
      // merge only — the canonical branch never advances.
      const postCommand = (input.postVerifyCommand ?? input.verifyCommand).trim() === ""
        ? input.verifyCommand
        : (input.postVerifyCommand ?? input.verifyCommand);
      const post = await s.runVerification({
        taskId,
        worktreePath: tmpWorktree,
        command: postCommand,
        executorMemberId,
        canonicalRoot: this.repoRoot,
        ...(input.evidenceDir === undefined ? {} : { evidenceDir: input.evidenceDir }),
        ...(input.verifyTimeoutMs === undefined ? {} : { timeoutMs: input.verifyTimeoutMs }),
      });
      const postVerification: VerificationSummary = {
        exitCode: post.evidenceInput.exitCode,
        timedOut: post.timedOut,
        stdoutPath: post.stdoutPath,
        stderrPath: post.stderrPath,
        commitSha: post.evidenceInput.commitSha,
      };
      if (!s.isVerificationPassing(post)) {
        const detail = `Post-integration tests failed for ${taskId} (exit ${postVerification.exitCode}, timedOut=${postVerification.timedOut ? "yes" : "no"}): temp merge aborted, all work retained, canonical unchanged.`;
        this.recordRun(taskId, "blocked-post-integration", null, detail, fencingToken);
        return {
          taskId, status: "blocked-post-integration", sha: null, targetBranch, headSha,
          fencingToken, recoveredFrom, detail, verification, postVerification,
        };
      }

      const tmpHeadOut = await runGit(tmpWorktree, ["rev-parse", "HEAD"], this.gitTimeoutMs);
      const tmpHead = tmpHeadOut.stdout.trim();
      if (tmpHeadOut.code !== 0 || tmpHead === "") {
        throw new IntegrationError("GIT_FAILED", `Cannot read merged HEAD for ${taskId}`, { task: taskId });
      }
      // Atomic policy-controlled advance: compare-and-swap on the target ref.
      const advance = await runGit(
        this.repoRoot,
        ["update-ref", `refs/heads/${targetBranch}`, tmpHead, targetOld],
        this.gitTimeoutMs,
      );
      if (advance.code !== 0) {
        const detail = `Target ${targetBranch} moved during integration of ${taskId}: advance refused (no blind overwrite), all work retained.`;
        this.recordRun(taskId, "rejected-conflict", null, detail, fencingToken);
        return {
          taskId, status: "rejected-conflict", sha: null, targetBranch, headSha,
          fencingToken, recoveredFrom, detail, verification, postVerification,
        };
      }
      const confirm = await runGit(this.repoRoot, ["rev-parse", `${targetBranch}^{commit}`], this.gitTimeoutMs);
      if (confirm.code !== 0 || confirm.stdout.trim() !== tmpHead) {
        throw new IntegrationError("GIT_FAILED", `Target advance unverified for ${taskId}`, { task: taskId });
      }

      this.recordRun(taskId, "integrated", tmpHead, `Integrated ${taskId} into ${targetBranch} at ${tmpHead}.`, fencingToken);
      return {
        taskId, status: "integrated", sha: tmpHead, targetBranch, headSha,
        fencingToken, recoveredFrom, detail: `Integrated into ${targetBranch} at ${tmpHead}.`, verification, postVerification,
      };
    } finally {
      // Temp-only cleanup (never the task worktree): remove the disposable
      // worktree + disposable temp branch. Best-effort — failures here must
      // not mask the integration result.
      if (tmpReady) {
        await runGit(this.repoRoot, ["worktree", "remove", "--force", tmpWorktree], this.gitTimeoutMs).catch(() => undefined);
        await runGit(this.repoRoot, ["worktree", "prune"], this.gitTimeoutMs).catch(() => undefined);
      }
      try {
        rmSync(scratchBase, { recursive: true, force: true });
      } catch {
        /* disposable tmp dir */
      }
      await runGit(this.repoRoot, ["branch", "-D", tmpBranch], this.gitTimeoutMs).catch(() => undefined);
    }
  }

  /**
   * Restart-safe reconciliation: open `integration_runs` + leases + worktree
   * existence. Never merges, never deletes. An expired lease + fencing bump
   * resumes safely; a live foreign lease with no durable outcome quarantines
   * the admission as ambiguous instead of acting on it.
   */
  async reconcile(
    taskId: string,
    opts?: { readonly worktreeRecord?: { readonly worktreePath: string; readonly branch: string; readonly baseCommit: string } },
  ): Promise<ReconcileReport> {
    const id = taskId.trim();
    assertTaskId(id);
    const s = await this.surfaces;
    ensureLeasesSchema(this.db, s.LEASES_DDL);
    const run = this.readRun(id);
    if (run !== null && run.outcome === "integrated") {
      return {
        taskId: id, status: "integrated-already", sha: run.sha, fencingToken: run.fencing_token,
        recoveredFrom: null, leaseHolder: null, worktreeStatus: null,
        detail: `Task ${id} already integrated at ${run.sha ?? "unknown"}; no further action (deduped).`,
      };
    }

    const lock = this.newLock(s);
    const observed = lock.observe();
    const live = observed !== null && observed.expiresAt > new Date(this.clock()).toISOString();

    let worktreeStatus: string | null = null;
    if (opts?.worktreeRecord !== undefined) {
      try {
        const manager = new s.WorktreeManager(this.repoRoot);
        const report = await manager.recover(id, {
          taskId: id,
          branch: opts.worktreeRecord.branch,
          worktreePath: opts.worktreeRecord.worktreePath,
          baseCommit: opts.worktreeRecord.baseCommit,
        });
        worktreeStatus = report.status;
      } catch {
        worktreeStatus = "unreadable";
      }
    }

    if (live && observed !== null) {
      // Ambiguous admission: someone else holds the lock and there is no
      // durable integrated outcome — quarantine (report only), never act.
      return {
        taskId: id, status: "lease-held-ambiguous", sha: run?.sha ?? null, fencingToken: observed.fencingToken,
        recoveredFrom: null, leaseHolder: observed.holder, worktreeStatus,
        detail: `Live lease held by ${observed.holder} with no durable outcome for ${id}: quarantined for operator review; no action taken.`,
      };
    }

    // Free or stale lease: prove recovery with a fencing bump, then release
    // immediately (reconcile never integrates — it only re-arms the lock).
    // S2-3: the observe→acquire window is racy — a rival may grab the lock
    // in between. A LEASE_HELD here means "uncertain", so quarantine as
    // ambiguous (preserve the worktree, advance nothing) instead of
    // throwing; any other failure propagates untouched. Never remerge,
    // cleanup, or advance while uncertain.
    const holder = `reconcile:${id}`;
    try {
      const acquired = lock.acquire(holder);
      lock.release(holder, acquired.fencingToken);
      return {
        taskId: id, status: run === null ? "no-record" : "recoverable", sha: run?.sha ?? null,
        fencingToken: acquired.fencingToken, recoveredFrom: acquired.recoveredFrom,
        leaseHolder: observed?.holder ?? null, worktreeStatus,
        detail: run === null
          ? `No integration record for ${id}; stale lease recovered (fencing ${acquired.fencingToken}). Safe to integrate.`
          : `Prior outcome ${run.outcome} for ${id}; stale lease recovered (fencing ${acquired.fencingToken}). Safe to retry integration.`,
      };
    } catch (err) {
      if (errorCode(err) !== "LEASE_HELD") throw err;
      let current: M401LeaseState | null = null;
      try {
        current = lock.observe();
      } catch {
        current = null;
      }
      return {
        taskId: id, status: "lease-held-ambiguous", sha: run?.sha ?? null, fencingToken: current?.fencingToken ?? null,
        recoveredFrom: null, leaseHolder: current?.holder ?? null, worktreeStatus,
        detail: `Lease changed under reconcile for ${id} (race between observe and acquire): quarantined for operator review; no action taken.`,
      };
    }
  }
}
