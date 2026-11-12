/**
 * M4-01 worktree manager — task-scoped Git worktrees with exclusive
 * ownership, canonical protection, and Windows-safe lifecycle
 * (spec §14 worktree manager + §9 safe-coding + §10 steps 1-4).
 *
 * Transport: git CLI via Bun.spawn ONLY (the OpenCode worktree SDK projectID
 * is unresolved — Q-03 — so the undocumented plugin worktree API is NOT
 * used). argv-based spawning (no shell) + strict allowlist validation of
 * every agent-supplied string (taskId, branch, baseCommit): NEVER trust agent
 * text as a path or ref.
 *
 * Boundaries (owned by this package):
 * - create(): `git worktree add -b <branch> <path> <base>` under a
 *   runtime-managed root; records { worktree_path, base_commit }. Refuses
 *   when the path escapes the root (resolved, case-normalized,
 *   symlink/junction-aware best-effort) or overlaps another live task's
 *   ownedPaths (conflict at admission).
 * - validateWorktreeWrite(): worker confinement — denies the canonical
 *   checkout, paths outside ownedPaths, and forbiddenPaths (see
 *   ./path-policy.js; re-exported here for a single import surface).
 * - refresh(): verify worktree exists + branch + clean/dirty baseline.
 * - remove(): refuses unintegrated work (dirty tree OR commits ahead of
 *   base) unless preserveFailed=true, which KEEPS the worktree for
 *   diagnosis instead of deleting it. Never deletes unknown paths.
 * - recover(): post-restart reconciliation of store record vs worktree
 *   existence; never deletes; bumps fencing generation.
 * - IntegrationLock: stale-lease integration lock on the SHARED `leases`
 *   table contract (resource_key `canonical-lock`, monotonic
 *   fencing_token++, ISO expires_at) with expiry + recovery. The table DDL
 *   mirrors runtime migration 001; point it at the same SQLite file to
 *   share the lock with the daemon, or at a test DB in isolation.
 *
 * NOT owned here (no protocol change): persisting worktree_path/base_commit
 * onto Task rows belongs to the runtime store caller — this manager RETURNS
 * the record; the orchestrator writes it through the approved API.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  bestEffortRealpathNoThrow,
  findOwnedPathConflict,
  isWithinRoot,
  normalizeForCompare,
  normalizeGrant,
  physicalFormForNewPath,
  realpathFsNoThrow,
  resolveWithinRoot,
  rootKey,
  validateWorktreeWrite as validateWritePure,
  type WriteValidationContext,
  type WriteVerdict,
} from "./path-policy.js";
import { PathPolicyError } from "./path-policy.js";

export type { WriteValidationContext, WriteVerdict };
export { PathPolicyError };
export { validateWorktreeWrite } from "./path-policy.js";

export type WorktreeErrorCode =
  | "INVALID_TASK_ID"
  | "INVALID_BRANCH"
  | "INVALID_COMMIT"
  | "INVALID_GRANT"
  | "PATH_ESCAPES_ROOT"
  | "OWNERSHIP_CONFLICT"
  | "WORKTREE_EXISTS"
  | "WORKTREE_MISSING"
  | "BRANCH_MISMATCH"
  | "DIRTY_WORKTREE"
  | "UNINTEGRATED_COMMITS"
  | "GIT_FAILED"
  | "GIT_TIMEOUT"
  | "LEASE_HELD"
  | "UNKNOWN_WORKTREE";

export class WorktreeError extends Error {
  readonly code: WorktreeErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(code: WorktreeErrorCode, message: string, details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "WorktreeError";
    this.code = code;
    this.details = details;
  }
}

function toWorktreeError(err: unknown, fallback: WorktreeErrorCode, message: string): WorktreeError {
  if (err instanceof WorktreeError) return err;
  if (err instanceof PathPolicyError) {
    // INVALID_PATH (unparseable/empty input) carries no confinement signal —
    // keep the caller's fallback (e.g. INVALID_GRANT) instead of mislabeling
    // it as an escape. Only escape-shaped denials map to PATH_ESCAPES_ROOT.
    if (err.code === "INVALID_PATH") {
      return new WorktreeError(fallback, `${message}: ${err.message}`, { ...err.details });
    }
    return new WorktreeError("PATH_ESCAPES_ROOT", err.message, { ...err.details });
  }
  return new WorktreeError(fallback, `${message}: ${err instanceof Error ? err.message : String(err)}`, {});
}

// --- Agent-text allowlists (never trust agent text as path/ref) ---

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COMMIT_RE = /^[0-9a-fA-F]{4,64}$/;

function assertTaskId(taskId: string): void {
  if (!TASK_ID_RE.test(taskId)) {
    throw new WorktreeError("INVALID_TASK_ID", `Unsafe task id rejected: ${taskId}`, { taskId });
  }
}

function assertBranch(branch: string): void {
  if (
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
    // biome-ignore lint: control chars must never reach argv as a ref
    /[\x00-\x1f\x7f]/.test(branch)
  ) {
    throw new WorktreeError("INVALID_BRANCH", `Unsafe branch name rejected: ${branch}`, { branch });
  }
}

function assertCommit(commit: string): void {
  if (!COMMIT_RE.test(commit)) {
    throw new WorktreeError("INVALID_COMMIT", `Unsafe base commit rejected: ${commit}`, { commit });
  }
}

function assertGrants(grants: readonly string[], what: string): void {
  for (const g of grants) {
    try {
      normalizeGrant(g);
    } catch (err) {
      throw toWorktreeError(err, "INVALID_GRANT", `Invalid ${what} grant: ${g}`);
    }
  }
}

// --- git CLI (argv only, never a shell) ---

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

async function runGit(repoRoot: string, args: readonly string[], timeoutMs: number): Promise<GitResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["git", ...args], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    throw new WorktreeError("GIT_FAILED", `Cannot spawn git: ${err instanceof Error ? err.message : String(err)}`, {});
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
    const out = proc.stdout;
    const errOut = proc.stderr;
    const [stdout, stderr, code] = await Promise.all([
      out === null || typeof out === "number" ? Promise.resolve("") : new Response(out as ReadableStream).text(),
      errOut === null || typeof errOut === "number" ? Promise.resolve("") : new Response(errOut as ReadableStream).text(),
      proc.exited,
    ]);
    if (timedOut) {
      throw new WorktreeError("GIT_TIMEOUT", `git ${args[0] ?? ""} timed out after ${timeoutMs}ms`, {
        argv0: args[0] ?? "",
      });
    }
    return { code, stdout, stderr, timedOut: false };
  } catch (err) {
    if (err instanceof WorktreeError) throw err;
    if (timedOut) {
      throw new WorktreeError("GIT_TIMEOUT", `git ${args[0] ?? ""} timed out after ${timeoutMs}ms`, {
        argv0: args[0] ?? "",
      });
    }
    throw new WorktreeError("GIT_FAILED", `git ${args[0] ?? ""} failed: ${err instanceof Error ? err.message : String(err)}`, {
      argv0: args[0] ?? "",
    });
  } finally {
    clearTimeout(timer);
  }
}

async function gitOk(repoRoot: string, args: readonly string[], timeoutMs: number): Promise<boolean> {
  const r = await runGit(repoRoot, args, timeoutMs);
  return r.code === 0;
}

export interface ListedWorktree {
  readonly path: string;
  readonly head: string;
  /** Short branch name; null when detached/bare. */
  readonly branch: string | null;
}

export function parseWorktreeList(porcelain: string): ListedWorktree[] {
  const out: ListedWorktree[] = [];
  let path = "";
  let head = "";
  let branch: string | null = null;
  const flush = (): void => {
    if (path !== "") out.push({ path, head, branch });
    path = "";
    head = "";
    branch = null;
  };
  for (const line of porcelain.split("\n")) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
    else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length).trim();
    else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
    }
  }
  flush();
  return out;
}

/** Case-insensitive by design (Windows NTFS semantics — this package's platform). */
function samePath(a: string, b: string): boolean {
  try {
    return normalizeForCompare(a) === normalizeForCompare(b);
  } catch {
    return false;
  }
}

/**
 * Worktree identity across spellings: git may report the long (`Vuminkosi`)
 * form while the caller holds the short (`VUMINK~1`) form, or vice versa.
 * Compare lexically first, then with best-effort physical resolution on
 * either side (never throws for missing paths).
 */
function pathMatches(a: string, b: string): boolean {
  if (samePath(a, b)) return true;
  const ra = bestEffortRealpathNoThrow(a);
  if (ra !== a && samePath(ra, b)) return true;
  const rb = bestEffortRealpathNoThrow(b);
  if (rb !== b && (samePath(a, rb) || samePath(ra, rb))) return true;
  return false;
}

// --- Records ---

export interface WorktreeRecord {
  readonly taskId: string;
  readonly branch: string;
  readonly worktreePath: string;
  readonly baseCommit: string;
}

export interface LiveAssignment {
  readonly taskId: string;
  readonly worktreePath: string | null;
  readonly ownedPaths: readonly string[];
}

export interface CreateWorktreeInput {
  readonly worktreeRoot: string;
  readonly canonicalRoot: string;
  readonly taskId: string;
  readonly baseCommit: string;
  readonly branch?: string;
  readonly ownedPaths?: readonly string[];
  readonly forbiddenPaths?: readonly string[];
  readonly liveAssignments?: readonly LiveAssignment[];
  readonly timeoutMs?: number;
}

export interface RefreshReport {
  readonly taskId: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly branchMatches: true;
  readonly clean: boolean;
  readonly headSha: string;
  readonly baseCommit: string;
}

export interface RemoveReport {
  readonly removed: boolean;
  /** True when preserveFailed kept a dirty/unintegrated worktree for diagnosis. */
  readonly preserved?: boolean;
  readonly reason?: string;
}

export interface RemoveOptions {
  readonly baseCommit?: string;
  readonly branch?: string;
  /** Keep (do not delete) dirty/unintegrated worktrees for diagnosis. */
  readonly preserveFailed?: boolean;
  readonly timeoutMs?: number;
}

export type RecoverStatus = "healthy" | "orphaned-record" | "unknown-path" | "no-record";

export interface RecoverReport {
  readonly status: RecoverStatus;
  readonly taskId: string;
  readonly worktreePath: string | null;
  readonly detail: string;
  /** Bumped on every recover call (instance epoch, or leases-table fencing token via onFencingBump). */
  readonly fencingGeneration: number;
  readonly refresh?: RefreshReport;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class WorktreeManager {
  private recoveryEpoch = 0;

  constructor(
    private readonly repoRoot: string,
    private readonly opts?: { readonly gitBinIgnored?: never; readonly timeoutMs?: number },
  ) {}

  private timeoutMs(explicit?: number): number {
    return explicit ?? this.opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async requireRepo(timeoutMs: number): Promise<void> {
    const r = await runGit(this.repoRoot, ["rev-parse", "--git-dir"], timeoutMs);
    if (r.code !== 0) {
      throw new WorktreeError("GIT_FAILED", `Not a git repository: ${this.repoRoot}`, { stderr: r.stderr.slice(0, 500) });
    }
  }

  private async listWorktrees(timeoutMs: number): Promise<ListedWorktree[]> {
    const r = await runGit(this.repoRoot, ["worktree", "list", "--porcelain"], timeoutMs);
    if (r.code !== 0) {
      throw new WorktreeError("GIT_FAILED", `git worktree list failed: ${r.stderr.slice(0, 500)}`, {});
    }
    return parseWorktreeList(r.stdout);
  }

  private async findListed(worktreePath: string, timeoutMs: number): Promise<ListedWorktree | null> {
    const all = await this.listWorktrees(timeoutMs);
    return all.find((w) => pathMatches(w.path, worktreePath)) ?? null;
  }

  /**
   * Admission: create one worktree + one branch for a task. Records
   * { worktree_path, base_commit } in the returned record (the caller
   * persists it onto the Task row through the approved store API).
   */
  async createWorktree(input: CreateWorktreeInput): Promise<WorktreeRecord> {
    const timeoutMs = this.timeoutMs(input.timeoutMs);
    assertTaskId(input.taskId);
    assertCommit(input.baseCommit);
    const branch = input.branch ?? `task/${input.taskId}`;
    assertBranch(branch);
    const ownedPaths = input.ownedPaths ?? [];
    const forbiddenPaths = input.forbiddenPaths ?? [];
    assertGrants(ownedPaths, "ownedPaths");
    assertGrants(forbiddenPaths, "forbiddenPaths");

    // Root confinement: the runtime-managed root must be real, and must
    // NOT be the canonical checkout (worktrees inside canonical would
    // mutate the canonical repo's own metadata).
    let rootNorm: string;
    let canonicalNorm: string;
    try {
      rootNorm = normalizeForCompare(input.worktreeRoot);
      canonicalNorm = normalizeForCompare(input.canonicalRoot);
    } catch (err) {
      throw toWorktreeError(err, "PATH_ESCAPES_ROOT", "Unparseable roots");
    }
    if (rootKey(input.worktreeRoot) === rootKey(input.canonicalRoot)) {
      throw new WorktreeError("PATH_ESCAPES_ROOT", "Worktree root must not be the canonical checkout", {});
    }
    // Ancestor-aware admission (S1 F-02): the root usually does NOT exist
    // yet, so bestEffortRealpathNoThrow would return it lexically and miss a
    // symlinked ancestor. physicalFormForNewPath resolves the deepest
    // existing ancestor instead — a nonexistent root smuggled inside the
    // canonical checkout through a link is denied here, not after mkdir.
    // Both canonical spellings count (8.3 short vs long).
    const physicalRootAdmit = physicalFormForNewPath(rootNorm);
    const physicalCanonAdmit = physicalFormForNewPath(canonicalNorm);
    if (
      isWithinRoot(canonicalNorm, physicalRootAdmit) ||
      isWithinRoot(physicalCanonAdmit, physicalRootAdmit)
    ) {
      throw new WorktreeError(
        "PATH_ESCAPES_ROOT",
        "Worktree root must not live inside the canonical checkout",
        {},
      );
    }
    // FS operations MUST use case-preserving physical paths, never the
    // lowercased comparison forms (S2 F-03: lowercased mkdir/exists/git argv
    // breaks case-sensitive filesystems and diverges from the record).
    const rootFs = input.worktreeRoot;
    mkdirSync(rootFs, { recursive: true });

    const worktreePath = resolveWithinRoot(rootNorm, `task-${input.taskId}`);
    const worktreeFsPath = join(rootFs, `task-${input.taskId}`);
    // Ancestor-aware physical comparison: the target does not exist yet,
    // so its deepest existing ancestor is resolved (8.3/junction aware)
    // and the remainder re-appended — never compare a physical root
    // against a lexical child.
    const physicalRoot = physicalFormForNewPath(rootNorm);
    const physicalTarget = physicalFormForNewPath(worktreePath);
    if (!isWithinRoot(physicalRoot, physicalTarget)) {
      throw new WorktreeError("PATH_ESCAPES_ROOT", `Worktree path resolves outside its root via link: ${worktreePath}`, {
        worktreePath,
      });
    }

    // Exclusivity at admission: ownedPaths must not overlap any live task.
    const liveMap = new Map<string, readonly string[]>();
    for (const a of input.liveAssignments ?? []) liveMap.set(a.taskId, a.ownedPaths);
    const conflict = findOwnedPathConflict(liveMap, input.taskId, ownedPaths);
    if (conflict !== null) {
      throw new WorktreeError(
        "OWNERSHIP_CONFLICT",
        `ownedPaths overlap live task ${conflict.conflictingTaskId}: ${conflict.requestedGrant} vs ${conflict.existingGrant}`,
        { conflictingTaskId: conflict.conflictingTaskId },
      );
    }
    for (const a of input.liveAssignments ?? []) {
      if (a.taskId !== input.taskId && a.worktreePath !== null && pathMatches(a.worktreePath, worktreePath)) {
        throw new WorktreeError("OWNERSHIP_CONFLICT", `Worktree path already owned by live task ${a.taskId}`, {
          conflictingTaskId: a.taskId,
        });
      }
    }

    if (existsSync(worktreeFsPath) || existsSync(worktreePath)) {
      throw new WorktreeError("WORKTREE_EXISTS", `Worktree path already exists: ${worktreeFsPath}`, {
        worktreePath: worktreeFsPath,
      });
    }

    await this.requireRepo(timeoutMs);

    // Base must be a real commit in this repo (resolves short SHAs to full).
    const baseOut = await runGit(this.repoRoot, ["rev-parse", `${input.baseCommit}^{commit}`], timeoutMs);
    if (baseOut.code !== 0) {
      throw new WorktreeError("INVALID_COMMIT", `Base commit not found in repo: ${input.baseCommit}`, {
        stderr: baseOut.stderr.slice(0, 500),
      });
    }
    const fullBase = baseOut.stdout.trim();

    // Branch must be fresh — never reuse (or clobber) another task's ref.
    if (await gitOk(this.repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], timeoutMs)) {
      throw new WorktreeError("WORKTREE_EXISTS", `Branch already exists: ${branch}`, { branch });
    }

    const add = await runGit(this.repoRoot, ["worktree", "add", "-b", branch, worktreeFsPath, fullBase], timeoutMs);
    if (add.code !== 0) {
      throw new WorktreeError("WORKTREE_EXISTS", `git worktree add failed: ${add.stderr.slice(0, 500)}`, {
        branch,
        worktreePath: worktreeFsPath,
      });
    }

    // Post-condition verification (never trust the happy path): the new
    // worktree must be listed, on the expected branch, at the base commit.
    const listedAfterAdd = await this.findListed(worktreeFsPath, timeoutMs);
    if (listedAfterAdd === null) {
      throw new WorktreeError("GIT_FAILED", "Worktree missing from git worktree list after add", {
        branch,
        worktreePath: worktreeFsPath,
      });
    }
    const head = await runGit(worktreeFsPath, ["rev-parse", "HEAD"], timeoutMs);
    const headBranch = await runGit(worktreeFsPath, ["rev-parse", "--abbrev-ref", "HEAD"], timeoutMs);
    if (head.code !== 0 || head.stdout.trim() !== fullBase || headBranch.stdout.trim() !== branch) {
      throw new WorktreeError("GIT_FAILED", "Worktree verification failed after add", {
        branch,
        worktreePath: worktreeFsPath,
      });
    }

    // Canonicalize the record path: git (and the OS) may report the long
    // spelling while the caller holds the short (`VUMINK~1`) spelling. The
    // record carries the case-preserving physical form (never the lowercased
    // comparison form) so later refresh/remove/recover FS operations hit the
    // real directory on case-sensitive filesystems too.
    const canonPath = realpathFsNoThrow(worktreeFsPath);
    return { taskId: input.taskId, branch, worktreePath: canonPath, baseCommit: fullBase };
  }

  /** Verify a worktree still exists, is listed, is on its branch, + dirtiness. */
  async refresh(taskId: string, record: WorktreeRecord, timeoutMs?: number): Promise<RefreshReport> {
    const tmo = this.timeoutMs(timeoutMs);
    assertTaskId(taskId);
    let recNorm: string;
    try {
      recNorm = normalizeForCompare(record.worktreePath);
    } catch {
      throw new WorktreeError("INVALID_TASK_ID", "Unparseable record path", { taskId });
    }
    // Canonical denial (S2 F-06): a record pointing inside the canonical
    // checkout must never verify — fail closed BEFORE any git FS access, so
    // a forged or drifted record cannot launder canonical writes through
    // refresh/recover. Both spellings count (8.3 short vs long).
    let canonNormR: string;
    try {
      canonNormR = normalizeForCompare(this.repoRoot);
    } catch {
      throw new WorktreeError("GIT_FAILED", `Not a git repository: ${this.repoRoot}`, {});
    }
    const canonPhysicalR = physicalFormForNewPath(canonNormR);
    const recPhysical = physicalFormForNewPath(recNorm);
    if (
      isWithinRoot(canonNormR, recNorm) ||
      isWithinRoot(canonNormR, recPhysical) ||
      isWithinRoot(canonPhysicalR, recNorm) ||
      isWithinRoot(canonPhysicalR, recPhysical)
    ) {
      throw new WorktreeError("PATH_ESCAPES_ROOT", `Worktree record inside canonical checkout denied: ${record.worktreePath}`, {
        taskId,
        worktreePath: record.worktreePath,
      });
    }
    const listed = await this.findListed(record.worktreePath, tmo);
    // FS operations use git's own listed spelling (authoritative case), not
    // the lowercased comparison form.
    const fsPath = listed?.path ?? record.worktreePath;
    if (listed === null || !existsSync(fsPath)) {
      throw new WorktreeError("WORKTREE_MISSING", `Worktree missing for task ${taskId}: ${record.worktreePath}`, {
        taskId,
        worktreePath: record.worktreePath,
      });
    }
    const headBranch = await runGit(fsPath, ["rev-parse", "--abbrev-ref", "HEAD"], tmo);
    if (headBranch.code !== 0 || headBranch.stdout.trim() !== record.branch) {
      throw new WorktreeError(
        "BRANCH_MISMATCH",
        `Worktree for task ${taskId} is on ${headBranch.stdout.trim() || "unknown"}, expected ${record.branch}`,
        { taskId, expected: record.branch },
      );
    }
    const status = await runGit(fsPath, ["status", "--porcelain"], tmo);
    if (status.code !== 0) {
      throw new WorktreeError("GIT_FAILED", `git status failed: ${status.stderr.slice(0, 500)}`, { taskId });
    }
    const head = await runGit(fsPath, ["rev-parse", "HEAD"], tmo);
    if (head.code !== 0) {
      throw new WorktreeError("GIT_FAILED", `git rev-parse HEAD failed: ${head.stderr.slice(0, 500)}`, { taskId });
    }
    return {
      taskId,
      worktreePath: record.worktreePath,
      branch: record.branch,
      branchMatches: true,
      clean: status.stdout.trim() === "",
      headSha: head.stdout.trim(),
      baseCommit: record.baseCommit,
    };
  }

  /**
   * Safe removal. Refuses dirty trees and unintegrated commits (HEAD ahead
   * of base) unless preserveFailed=true — which KEEPS the worktree for
   * diagnosis and reports preserved instead of deleting. Paths not listed
   * by `git worktree list` are never touched. baseCommit is REQUIRED
   * (fail-closed): without it ahead-detection is impossible and an
   * unintegrated worktree could be deleted silently.
   */
  async remove(worktreePath: string, opts?: RemoveOptions): Promise<RemoveReport> {
    const tmo = this.timeoutMs(opts?.timeoutMs);
    // Canonical denial (CODE-F-01): mirror refresh()'s 4-combination
    // fail-closed deny. A forged/drifted caller path inside the canonical
    // checkout must never reach git FS access — deny BEFORE any lookup, on
    // both the lexical and the ancestor-resolved physical form (8.3 short
    // vs long spellings both count). Unparseable input denies closed.
    let canonNorm: string;
    try {
      canonNorm = normalizeForCompare(this.repoRoot);
    } catch {
      throw new WorktreeError("GIT_FAILED", `Not a git repository: ${this.repoRoot}`, {});
    }
    const canonPhysical = physicalFormForNewPath(canonNorm);
    const deniesCanonical = (normAbs: string): boolean => {
      const physical = physicalFormForNewPath(normAbs);
      return (
        isWithinRoot(canonNorm, normAbs) ||
        isWithinRoot(canonNorm, physical) ||
        isWithinRoot(canonPhysical, normAbs) ||
        isWithinRoot(canonPhysical, physical)
      );
    };
    let callerNorm: string;
    try {
      callerNorm = normalizeForCompare(worktreePath);
    } catch (err) {
      throw toWorktreeError(err, "PATH_ESCAPES_ROOT", `Refusing to remove unparseable path: ${worktreePath}`);
    }
    if (deniesCanonical(callerNorm)) {
      throw new WorktreeError(
        "PATH_ESCAPES_ROOT",
        `Refusing to remove path inside the canonical checkout: ${worktreePath}`,
        { worktreePath },
      );
    }
    const listed = await this.findListed(worktreePath, tmo);
    if (listed === null) {
      throw new WorktreeError("WORKTREE_MISSING", `Refusing to delete: not a registered worktree: ${worktreePath}`, {
        worktreePath,
      });
    }
    // Listed-path canonical denial (CODE-F-01, second half): the
    // git-reported spelling may differ from the caller path (8.3/long) or
    // the record may have drifted — deny when EITHER listed form lands
    // inside the canonical checkout, before any destructive git FS access.
    let listedNorm: string;
    try {
      listedNorm = normalizeForCompare(listed.path);
    } catch {
      throw new WorktreeError("PATH_ESCAPES_ROOT", `Refusing to remove unparseable listed path: ${listed.path}`, {
        worktreePath: listed.path,
      });
    }
    if (deniesCanonical(listedNorm)) {
      throw new WorktreeError(
        "PATH_ESCAPES_ROOT",
        `Refusing to remove worktree inside the canonical checkout: ${listed.path}`,
        { worktreePath: listed.path },
      );
    }
    // Strict branch validation (S2 F-05): a caller-supplied branch reaches
    // git argv — validate it exactly like admission does.
    if (opts?.branch !== undefined) assertBranch(opts.branch);
    // Fail closed without a base commit (S2 F-04): guessing "no ahead
    // commits" would silently delete unintegrated work.
    if (opts?.baseCommit === undefined) {
      throw new WorktreeError("INVALID_COMMIT", "remove() requires baseCommit for ahead-detection (fail-closed)", {
        worktreePath: listed.path,
      });
    }
    assertCommit(opts.baseCommit);
    const status = await runGit(listed.path, ["status", "--porcelain"], tmo);
    if (status.code !== 0) {
      throw new WorktreeError("GIT_FAILED", `git status failed: ${status.stderr.slice(0, 500)}`, { worktreePath });
    }
    const dirty = status.stdout.trim() !== "";
    const count = await runGit(listed.path, ["rev-list", "--count", `${opts.baseCommit}..HEAD`], tmo);
    if (count.code !== 0) {
      throw new WorktreeError("GIT_FAILED", `rev-list failed: ${count.stderr.slice(0, 500)}`, { worktreePath });
    }
    let ahead = Number.parseInt(count.stdout.trim(), 10);
    if (!Number.isFinite(ahead) || ahead < 0) ahead = 1; // fail closed

    if (dirty || ahead > 0) {
      const reason = dirty ? `dirty working tree${ahead > 0 ? ` + ${ahead} unintegrated commit(s)` : ""}` : `${ahead} unintegrated commit(s)`;
      if (opts?.preserveFailed === true) {
        return { removed: false, preserved: true, reason: `kept for diagnosis: ${reason}` };
      }
      throw new WorktreeError(
        dirty ? "DIRTY_WORKTREE" : "UNINTEGRATED_COMMITS",
        `Refusing to remove worktree with ${reason}: ${listed.path}`,
        { worktreePath: listed.path },
      );
    }

    const rm = await runGit(this.repoRoot, ["worktree", "remove", listed.path], tmo);
    if (rm.code !== 0) {
      throw new WorktreeError("GIT_FAILED", `git worktree remove failed: ${rm.stderr.slice(0, 500)}`, {
        worktreePath: listed.path,
      });
    }
    await runGit(this.repoRoot, ["worktree", "prune"], tmo).catch(() => undefined);

    // Best-effort branch cleanup: only when the branch still points exactly
    // at the recorded base (no integrated-but-unseen commits to lose).
    // baseCommit is always defined here (required above); the validated
    // caller branch wins over the listed one.
    const branch = opts?.branch ?? listed.branch;
    if (branch !== null) {
      const ref = await runGit(this.repoRoot, ["rev-parse", `${branch}^{commit}`], tmo);
      if (ref.code === 0 && ref.stdout.trim() === opts.baseCommit) {
        await runGit(this.repoRoot, ["branch", "-d", branch], tmo).catch(() => undefined);
      }
    }
    return { removed: true };
  }

  /**
   * Post-restart reconciliation: compare the store record against worktree
   * reality. NEVER deletes anything. Bumps the fencing generation so a
   * restarted daemon cannot act with a stale epoch; wire onFencingBump to
   * the leases-table IntegrationLock for cross-restart fencing.
   */
  async recover(
    taskId: string,
    record: WorktreeRecord | null,
    opts?: { readonly candidatePath?: string; readonly onFencingBump?: () => number | Promise<number> },
  ): Promise<RecoverReport> {
    assertTaskId(taskId);
    this.recoveryEpoch += 1;
    const fencingGeneration =
      opts?.onFencingBump !== undefined ? await opts.onFencingBump() : this.recoveryEpoch;

    if (record === null) {
      if (opts?.candidatePath !== undefined) {
        const listed = await this.findListed(opts.candidatePath, this.timeoutMs()).catch(() => null);
        if (listed !== null || existsSync(opts.candidatePath)) {
          return {
            status: "unknown-path",
            taskId,
            worktreePath: opts.candidatePath,
            detail: "Path exists but has no store record — left untouched for operator review",
            fencingGeneration,
          };
        }
      }
      return { status: "no-record", taskId, worktreePath: null, detail: "No record and no path — nothing to reconcile", fencingGeneration };
    }

    try {
      const refresh = await this.refresh(taskId, record);
      return {
        status: "healthy",
        taskId,
        worktreePath: record.worktreePath,
        detail: refresh.clean ? "Worktree verified on branch, clean" : "Worktree verified on branch, dirty baseline preserved",
        fencingGeneration,
        refresh,
      };
    } catch (err) {
      if (err instanceof WorktreeError && (err.code === "WORKTREE_MISSING" || err.code === "BRANCH_MISMATCH")) {
        return {
          status: "orphaned-record",
          taskId,
          worktreePath: record.worktreePath,
          detail: `Record exists but worktree is unusable (${err.code}) — needs operator attention, nothing deleted`,
          fencingGeneration,
        };
      }
      throw err;
    }
  }

  /**
   * Worker write confinement for a task workspace. The canonical root
   * defaults to this manager's repo (the canonical checkout) — pass an
   * explicit root when the manager fronts a different repo.
   */
  validateWrite(
    worktreePath: string,
    ownedPaths: readonly string[],
    forbiddenPaths: readonly string[],
    candidate: string,
    canonicalRoot: string = this.repoRoot,
  ): WriteVerdict {
    return validateWritePure({ canonicalRoot, worktreePath, ownedPaths, forbiddenPaths }, candidate);
  }
}

// --- Integration lock (shared `leases` table contract, migration 001) ---

/** Minimal structural surface of the leases table — satisfied by bun:sqlite Database. */
export interface LeaseDb {
  query(sql: string): {
    // biome-ignore lint: adapter boundary — bindings mirror bun:sqlite
    get(...params: any[]): unknown;
    // biome-ignore lint: adapter boundary — bindings mirror bun:sqlite
    run(...params: any[]): unknown;
  };
}

interface LeaseRow {
  holder: string;
  fencing_token: number;
  expires_at: string;
}

export const LEASES_DDL = `CREATE TABLE IF NOT EXISTS leases (
  resource_key TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);`;

/**
 * M5-01 fencing high-water (service-owned, same precedent as the runtime
 * `integration_runs` ensure): `release()` DELETES the `leases` row so
 * `observe()` stays null-after-release, but a bare DELETE resets the next
 * `acquire()` token to 1. This table retains the monotonic high-water per
 * `resource_key` so `acquire()` always exceeds every previously issued
 * token — including across release cycles. The `leases` row contract is
 * untouched; git compare-and-swap stays the backstop.
 */
export const LEASE_FENCING_HIGH_WATER_DDL = `CREATE TABLE IF NOT EXISTS lease_fencing_high_water (
  resource_key TEXT PRIMARY KEY,
  fencing_token INTEGER NOT NULL
);`;

export interface LeaseState {
  readonly holder: string;
  readonly fencingToken: number;
  readonly expiresAt: string;
}

export interface AcquireResult extends LeaseState {
  /** Previous holder when this acquire recovered an expired lease. */
  readonly recoveredFrom: string | null;
}

/**
 * Stale-lease integration lock for canonical-repo integration
 * (resource_key `canonical-lock`): monotonic fencing_token++, ISO
 * expires_at TTL, expiry-gated recovery. Only one holder integrates at a
 * time; a crashed holder's lease expires and the next acquirer recovers it
 * with a bumped fencing token (never reused).
 */
export class IntegrationLock {
  private readonly resourceKey: string;
  private readonly ttlMs: number;
  private readonly clock: () => number;
  /**
   * F-01 in-process high-water floor (carry-forward): the highest token
   * this instance has reserved/observed. `Math.max(dbHighWater,
   * liveToken, memHighWater)` seeds every `acquire()` so a transient
   * high-water write gap inside this process can never go backwards.
   * Cross-restart safety still rests on the durable
   * `lease_fencing_high_water` table — a DDL/read/write failure there is
   * fail-closed (throws), never a silent `0` fallback.
   */
  private memHighWater = 0;
  /** Bounded CAS retries: contention loses the race and retries, never spins. */
  private static readonly MAX_CAS_ATTEMPTS = 10;

  constructor(
    private readonly db: LeaseDb,
    opts?: { readonly resourceKey?: string; readonly ttlMs?: number; readonly clock?: () => number },
  ) {
    this.resourceKey = opts?.resourceKey ?? "canonical-lock";
    this.ttlMs = opts?.ttlMs ?? 60_000;
    this.clock = opts?.clock ?? Date.now;
  }

  private read(): LeaseState | null {
    const row = this.db
      .query("SELECT holder, fencing_token, expires_at FROM leases WHERE resource_key = ?")
      .get(this.resourceKey) as LeaseRow | null;
    if (row === null || typeof row.holder !== "string") return null;
    // S3 NaN clamp: a corrupt/non-finite token must never seed arithmetic —
    // floor it to 0 so the next acquire strictly exceeds the high-water.
    const token = typeof row.fencing_token === "number" && Number.isFinite(row.fencing_token) && row.fencing_token >= 0
      ? Math.floor(row.fencing_token)
      : 0;
    return { holder: row.holder, fencingToken: token, expiresAt: row.expires_at };
  }

  /**
   * Monotonic high-water (M5-01, F-01 fail-closed): retained across
   * `release()` DELETEs so the next `acquire()` can never reuse a token.
   * Idempotent ensure on every use — safe on legacy DBs that predate this
   * table. FAIL-CLOSED: any DDL/read failure throws (never a silent `0`
   * fallback that would let the next token reuse a retired value).
   */
  private ensureHighWater(): void {
    this.db.query(LEASE_FENCING_HIGH_WATER_DDL).run();
  }

  private readHighWater(): number {
    try {
      this.ensureHighWater();
    } catch (err) {
      throw new WorktreeError(
        "GIT_FAILED",
        `Fencing high-water unavailable (DDL failed, fail-closed): ${err instanceof Error ? err.message : String(err)}`,
        { resourceKey: this.resourceKey },
      );
    }
    let row: { fencing_token: number } | null;
    try {
      row = this.db
        .query("SELECT fencing_token FROM lease_fencing_high_water WHERE resource_key = ?")
        .get(this.resourceKey) as { fencing_token: number } | null;
    } catch (err) {
      throw new WorktreeError(
        "GIT_FAILED",
        `Fencing high-water unavailable (read failed, fail-closed): ${err instanceof Error ? err.message : String(err)}`,
        { resourceKey: this.resourceKey },
      );
    }
    const dbValue =
      typeof row?.fencing_token === "number" && Number.isFinite(row.fencing_token) && row.fencing_token >= 0
        ? Math.floor(row.fencing_token)
        : 0;
    // In-memory carry-forward: never go below what this process reserved.
    if (dbValue > this.memHighWater) this.memHighWater = dbValue;
    return this.memHighWater;
  }

  private recordHighWater(token: number): void {
    const safe = Number.isFinite(token) && token >= 0 ? Math.floor(token) : 0;
    try {
      this.ensureHighWater();
      this.db
        .query(
          "INSERT INTO lease_fencing_high_water (resource_key, fencing_token) VALUES (?, ?) " +
            "ON CONFLICT(resource_key) DO UPDATE SET fencing_token = excluded.fencing_token " +
            "WHERE excluded.fencing_token > lease_fencing_high_water.fencing_token",
        )
        .run(this.resourceKey, safe);
    } catch (err) {
      // S3 downgrade log + F-01 fail-closed: a lost high-water must never
      // proceed silently to a lease write that could reuse a token.
      console.warn(
        `[worktree-manager] fencing high-water write failed for ${this.resourceKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new WorktreeError(
        "GIT_FAILED",
        `Fencing high-water write failed (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
        { resourceKey: this.resourceKey },
      );
    }
    if (safe > this.memHighWater) this.memHighWater = safe;
  }

  private live(state: LeaseState | null, nowMs: number): boolean {
    return state !== null && state.expiresAt > new Date(nowMs).toISOString();
  }

  observe(): LeaseState | null {
    return this.read();
  }

  isLive(nowMs?: number): boolean {
    return this.live(this.read(), nowMs ?? this.clock());
  }

  acquire(holder: string): AcquireResult {
    if (holder.trim() === "") {
      throw new WorktreeError("INVALID_TASK_ID", "Lock holder must not be empty", {});
    }
    // F-01 CAS loop: read → reserve high-water → conditional write. The
    // lease write is guarded by WHERE fencing_token=<read> (UPDATE) or
    // WHERE NOT EXISTS (INSERT) so two concurrent acquirers can never both
    // land the same token: the loser sees changes=0 and retries with a
    // strictly higher token. The high-water is reserved BEFORE the lease
    // write so a crash between the two leaves a gap (safe), never a reuse.
    for (let attempt = 0; attempt < IntegrationLock.MAX_CAS_ATTEMPTS; attempt += 1) {
      const nowMs = this.clock();
      const current = this.read();
      if (this.live(current, nowMs) && current !== null && current.holder !== holder) {
        throw new WorktreeError("LEASE_HELD", `Integration lock held by ${current.holder} until ${current.expiresAt}`, {
          holder: current.holder,
        });
      }
      // Fail-closed: throws when the high-water table is unavailable.
      const highWater = this.readHighWater();
      const base = current?.fencingToken ?? 0;
      const fencingToken = Math.max(base, highWater, this.memHighWater) + 1;
      if (!Number.isFinite(fencingToken) || fencingToken <= 0) {
        throw new WorktreeError("GIT_FAILED", "Fencing token overflow (fail-closed)", {
          resourceKey: this.resourceKey,
        });
      }
      // Reserve first (fail-closed on write failure — no lease written yet).
      this.recordHighWater(fencingToken);
      const expiresAt = new Date(nowMs + this.ttlMs).toISOString();
      if (current === null) {
        const outcome = this.db
          .query(
            "INSERT INTO leases (resource_key, holder, fencing_token, expires_at) " +
              "SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM leases WHERE resource_key = ?)",
          )
          .run(this.resourceKey, holder, fencingToken, expiresAt, this.resourceKey) as unknown as {
          changes?: unknown;
        };
        if ((typeof outcome?.changes === "number" ? outcome.changes : 0) === 0) continue; // lost insert race: retry higher
      } else {
        const outcome = this.db
          .query(
            "UPDATE leases SET holder = ?, fencing_token = ?, expires_at = ? WHERE resource_key = ? AND fencing_token = ?",
          )
          .run(holder, fencingToken, expiresAt, this.resourceKey, current.fencingToken) as unknown as {
          changes?: unknown;
        };
        if ((typeof outcome?.changes === "number" ? outcome.changes : 0) === 0) continue; // lost CAS race: retry higher
      }
      if (fencingToken > this.memHighWater) this.memHighWater = fencingToken;
      return {
        holder,
        fencingToken,
        expiresAt,
        recoveredFrom: current !== null && !this.live(current, nowMs) ? current.holder : null,
      };
    }
    throw new WorktreeError("LEASE_HELD", "Integration lock contention: concurrent acquirer won the race", {
      holder,
    });
  }

  /**
   * Release only when held by `holder` WITH the matching fencing token
   * (M5-01-FIX-02 F1 fail-closed): an omitted token is a no-op returning
   * false — a stale `release(holder)` after a same-holder re-acquire must
   * never delete the live lease. The high-water is retained BEFORE the
   * DELETE and a high-water failure aborts WITHOUT deleting, so a retired
   * token can never be lost. Returns false when the row moved under us
   * (CAS guard) or when the token is omitted/mismatched.
   */
  release(holder: string, fencingToken?: number): boolean {
    // F1 fail-closed: tokenless release is a no-op (audit + false), never
    // a delete — the caller must prove ownership of the live generation.
    if (fencingToken === undefined) {
      console.warn(
        `[worktree-manager] release without fencing token denied (fail-closed) for ${this.resourceKey} holder=${holder}`,
      );
      return false;
    }
    const current = this.read();
    if (current === null || current.holder !== holder) return false;
    if (current.fencingToken !== fencingToken) return false;
    // Retain the monotonic high-water BEFORE the DELETE so the next
    // acquire (after release, or after a crash) strictly exceeds it.
    // Fail-closed: throws without deleting when the high-water is unavailable.
    this.recordHighWater(current.fencingToken);
    if (current.fencingToken > this.memHighWater) this.memHighWater = current.fencingToken;
    const outcome = this.db
      .query("DELETE FROM leases WHERE resource_key = ? AND holder = ? AND fencing_token = ?")
      .run(this.resourceKey, holder, current.fencingToken) as unknown as { changes?: unknown };
    // S3 release changes check: 0 changes means the row moved under us.
    return (typeof outcome?.changes === "number" ? outcome.changes : 0) > 0;
  }

  /** Highest fencing token ever issued for this resource (0 when unknown). */
  observeHighWater(): number {
    return this.readHighWater();
  }
}
