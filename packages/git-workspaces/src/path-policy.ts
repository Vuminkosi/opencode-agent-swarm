/**
 * M4-01 path policy — Windows-safe normalization, root confinement, grant
 * overlap detection, and worker write validation (spec §§9, 10, 14).
 *
 * Pure functions only: no git, no I/O except a best-effort realpath for
 * symlink/junction awareness. NEVER trust agent-supplied text paths — every
 * entry point validates before comparing.
 *
 * Windows rules (best-effort, lexical + realpath where the path exists):
 * - Drive letters are casefolded (`c:\x` == `C:\X`); the whole comparison
 *   form is lowercased because NTFS is case-preserving but case-insensitive.
 * - Both separators are accepted; comparison uses `\`.
 * - UNC roots (`\\server\share`) are preserved and casefolded; a candidate
 *   that resolves to a different server/share never matches.
 * - Trailing separators are stripped except on filesystem roots (`C:\`,
 *   `\\server\share`).
 * - `..` segments are collapsed lexically and can never escape their root;
 *   an absolute candidate outside the root is rejected, never normalized
 *   into it.
 *
 * KNOWN LIMITS (junction enforcement, report verbatim to orchestrator):
 * - Symlink/junction resolution is ancestor-aware but best-effort: only
 *   existing ancestors can be resolved via realpath; a hostile symlink
 *   swapped in after validation (TOCTOU) is NOT detected by this module —
 *   creation and validation must be re-checked at use time by the caller
 *   (worktree-manager refreshes before destructive ops).
 * - Remote UNC targets are compared lexically; the local host cannot
 *   canonicalize a remote server's reparse points.
 */

import { existsSync, realpathSync } from "node:fs";

export type PathDenyCode =
  | "INVALID_PATH"
  | "PATH_ESCAPES_ROOT"
  | "ABSOLUTE_OUTSIDE_ROOT";

export class PathPolicyError extends Error {
  readonly code: PathDenyCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(code: PathDenyCode, message: string, details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "PathPolicyError";
    this.code = code;
    this.details = details;
  }
}

const DRIVE_RE = /^[A-Za-z]:([\\/]|$)/;
const UNC_RE = /^\\\\[^\\/]+\\[^\\/]+([\\/]|$)/;

/**
 * M8 COMPAT F-02: Windows reserved device names. The basename (sans
 * extension), with trailing dots/spaces stripped, case-insensitive:
 * `CON`, `con.txt`, `COM1 `, `lpt9.log`, `aux.` all collide with devices
 * on Windows and must never validate as ordinary path components.
 */
const WINDOWS_DEVICE_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

export function isWindowsDeviceSegment(seg: string): boolean {
  const stem = (seg.split(".")[0] ?? "").replace(/[. ]+$/, "");
  return stem !== "" && WINDOWS_DEVICE_RE.test(stem);
}

function isAbsoluteLike(p: string): boolean {
  return (
    p.startsWith("/") ||
    p.startsWith("\\") ||
    DRIVE_RE.test(p) ||
    UNC_RE.test(p) ||
    /^[A-Za-z]:$/.test(p)
  );
}

/**
 * Lexical comparison form for an absolute path. Handles BOTH win32 and
 * posix inputs on any host so Windows paths are testable everywhere.
 * Output: lowercased, `\`-separated, no trailing separator (except roots),
 * `.` removed, `..` collapsed without ever popping the root.
 */
export function normalizeForCompare(absPath: string): string {
  const trimmed = absPath.trim();
  if (trimmed.length === 0) {
    throw new PathPolicyError("INVALID_PATH", "Path must not be empty", {});
  }
  // M8 COMPAT F-02: embedded NUL bytes are never valid in a path —
  // fail closed before any comparison or filesystem use.
  if (trimmed.includes("\0")) {
    throw new PathPolicyError("INVALID_PATH", "Path must not contain NUL bytes", { path: trimmed });
  }
  // Forward slashes are valid Windows separators — unify first.
  let p = trimmed.replace(/\//g, "\\");

  // M8 COMPAT F-01: long-prefix (`\\?\`) and device (`\\.\`) spellings
  // must compare in the SAME namespace as plain paths. Without this a
  // prefixed spelling parses as UNC server `?`/`.`, so it can never
  // match (or be denied against) its canonical root. Strip to the
  // drive/UNC form; namespaces with no lexical drive mapping fail closed.
  const longPrefix = p.match(/^\\\\([?.])\\(.*)$/s);
  if (longPrefix !== null) {
    const kind = longPrefix[1];
    const body = longPrefix[2] ?? "";
    if (kind === "?") {
      const uncBody = body.match(/^UNC\\(.*)$/i);
      if (uncBody !== null) {
        p = `\\\\${uncBody[1] ?? ""}`;
      } else if (/^[A-Za-z]:($|\\)/.test(body)) {
        p = body;
      } else {
        throw new PathPolicyError("INVALID_PATH", `Unmappable extended-length path: ${trimmed}`, { path: trimmed });
      }
    } else if (/^[A-Za-z]:($|\\)/.test(body)) {
      // `\\.\C:\...` — the only device-namespace spelling with a
      // lexical drive mapping (`\\.\COM1`, `\\.\PhysicalDrive0`, … deny).
      p = body;
    } else {
      throw new PathPolicyError("INVALID_PATH", `Unmappable device-namespace path: ${trimmed}`, { path: trimmed });
    }
  }
  // NT object-manager namespaces (`\Device\…`, `\??\…`) have no lexical
  // drive mapping — treating them as drive-relative rooted paths would
  // mis-confine them, so they fail closed here.
  if (/^\\(\?\?|device)(\\|$)/i.test(p)) {
    throw new PathPolicyError("INVALID_PATH", `Unmappable NT-namespace path: ${trimmed}`, { path: trimmed });
  }

  let root: string;
  let rest: string;
  const unc = p.match(/^\\\\([^\\]+)\\([^\\]+)(\\|$)(.*)$/);
  const drive = p.match(/^([A-Za-z]:)(\\|$)(.*)$/);
  if (unc !== null) {
    const server = unc[1];
    const share = unc[2];
    if (server === undefined || share === undefined || server === "" || share === "") {
      throw new PathPolicyError("INVALID_PATH", `Unparseable UNC path: ${trimmed}`, { path: trimmed });
    }
    root = `\\\\${server}\\${share}`;
    rest = unc[4] ?? "";
  } else if (drive !== null) {
    const letter = drive[1];
    if (letter === undefined || letter === "") {
      throw new PathPolicyError("INVALID_PATH", `Unparseable drive path: ${trimmed}`, { path: trimmed });
    }
    // NB: `letter` already includes the colon (`C:`) — do not add another.
    root = `${letter.toUpperCase()}\\`;
    rest = drive[3] ?? "";
  } else if (p.startsWith("\\")) {
    // Rooted but drive-relative (`\foo`) or single-backslash: treat the
    // leading separator as the root; callers join it with a real root first.
    root = "\\";
    rest = p.replace(/^\\+/, "");
  } else {
    // Not absolute — the caller must resolve against a root first.
    throw new PathPolicyError("INVALID_PATH", `Not an absolute path: ${trimmed}`, { path: trimmed });
  }

  const out: string[] = [];
  for (const seg of rest.split("\\")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0) out.pop();
      // else: clamped at root — `..` above root is absorbed, and the
      // within-root check downstream still rejects escapes because the
      // RELATIVE candidate was joined under the root first.
      continue;
    }
    // M8 COMPAT F-02: reserved device names are never ordinary
    // components — fail closed (covers every component, any case,
    // with or without extension).
    if (isWindowsDeviceSegment(seg)) {
      throw new PathPolicyError("INVALID_PATH", `Reserved Windows device name: ${seg}`, { path: trimmed });
    }
    out.push(seg);
  }
  const joined = out.join("\\");
  // Comparison form is fully lowercased: NTFS is case-preserving but
  // case-insensitive. This form is for COMPARISON ONLY — never use it for
  // filesystem operations (the record keeps the physical spelling).
  if (root === "\\") return `\\${joined}`.toLowerCase();
  if (joined === "") return root.toLowerCase();
  const full = root.endsWith("\\") ? `${root}${joined}` : `${root}\\${joined}`;
  return full.toLowerCase();
}

/** Casefolded key for root-equality checks (worktreeRoot vs canonicalRoot). */
export function rootKey(absPath: string): string {
  return normalizeForCompare(absPath).toLowerCase();
}

/**
 * Join a (possibly relative, possibly absolute, agent-supplied) candidate
 * under `rootAbs` and return its comparison form. Absolute candidates are
 * used as-is — they must still land inside the root. Throws PathPolicyError
 * when the result escapes the root.
 */
export function resolveWithinRoot(rootAbs: string, candidate: string): string {
  if (candidate.trim() === "") {
    throw new PathPolicyError("INVALID_PATH", "Candidate path must not be empty", {});
  }
  const root = normalizeForCompare(rootAbs);
  const candAbs = isAbsoluteLike(candidate.trim())
    ? normalizeForCompare(candidate.trim())
    : normalizeForCompare(`${root}\\${candidate.trim().replace(/\//g, "\\")}`);
  if (!isWithinRoot(root, candAbs)) {
    throw new PathPolicyError("PATH_ESCAPES_ROOT", `Path escapes its root: ${candidate}`, {
      candidate,
    });
  }
  return candAbs;
}

/** True when both forms are identical or `cand` is strictly beneath `root`. */
export function isWithinRoot(rootNorm: string, candNorm: string): boolean {
  if (candNorm === rootNorm) return true;
  return candNorm.startsWith(rootNorm.endsWith("\\") ? rootNorm : `${rootNorm}\\`);
}

/**
 * Best-effort physical resolution: realpath when the path exists (catches
 * symlinks/junctions AND Windows 8.3 short-name spellings — git reports the
 * long form while tmpdir/mkdtemp may hand out the short form). `.native`
 * is required for the 8.3 expansion; plain realpath does not expand it.
 * Never throws for missing paths — returns the lexical comparison form.
 */
export function bestEffortRealpathNoThrow(normAbs: string): string {
  try {
    const native = (realpathSync as unknown as { native?: (p: string) => string }).native;
    const physical = typeof native === "function" ? native(normAbs) : realpathSync(normAbs);
    return normalizeForCompare(physical);
  } catch {
    return normAbs;
  }
}

/**
 * Best-effort physical resolution that PRESERVES case for filesystem use.
 * Comparison forms from this module are lowercased (NTFS semantics) and must
 * NEVER drive FS operations on case-sensitive filesystems — use this (or a
 * raw caller path) for mkdir/existsSync/git argv instead.
 * Never throws for missing paths — returns the input unchanged.
 */
export function realpathFsNoThrow(fsPath: string): string {
  try {
    const native = (realpathSync as unknown as { native?: (p: string) => string }).native;
    return typeof native === "function" ? native(fsPath) : realpathSync(fsPath);
  } catch {
    return fsPath;
  }
}

/**
 * Physical form for possibly-not-yet-existing paths: realpath the deepest
 * existing ancestor (8.3 expansion, symlink/junction resolution included)
 * and re-append the missing remainder lexically. Fixes the asymmetry where
 * an existing root resolves physical while its not-yet-created child stays
 * lexical, which would false-reject confinement (and false-accept a
 * swapped-in link — callers must re-check after creation).
 */
export function physicalFormForNewPath(normAbs: string): string {
  if (existsSync(normAbs)) return bestEffortRealpathNoThrow(normAbs);
  const segs = normAbs.split("\\");
  for (let drop = 1; drop < segs.length; drop++) {
    const prefix = segs.slice(0, segs.length - drop).join("\\");
    if (prefix === "" || prefix.endsWith(":")) continue; // never probe bare `C:`
    if (existsSync(prefix)) {
      const remainder = segs.slice(segs.length - drop).join("\\");
      return normalizeForCompare(`${bestEffortRealpathNoThrow(prefix)}\\${remainder}`);
    }
  }
  return normAbs;
}

/**
 * Resolve + confine + symlink-check in one step: lexical resolution must
 * land inside the root, and the physical form (deepest-existing-ancestor
 * resolution, so not-yet-created targets are covered) must ALSO land inside
 * the root. Returns the lexical comparison form (stable for not-yet-created
 * targets).
 */
export function resolveConfined(rootAbs: string, candidate: string): string {
  const lexical = resolveWithinRoot(rootAbs, candidate);
  const physical = physicalFormForNewPath(lexical);
  if (physical !== lexical && !isWithinRoot(normalizeForCompare(rootAbs), physical)) {
    throw new PathPolicyError("PATH_ESCAPES_ROOT", `Path resolves outside its root via link: ${candidate}`, {
      candidate,
    });
  }
  return lexical;
}

// --- Grant overlap (ownedPaths conflict at admission) ---

/**
 * Comparison form for repo-relative grants (Task ownedPaths/forbiddenPaths
 * are canonical-relative, e.g. `packages/foo`). Forward-slash, lowercased,
 * `.`/`..` collapsed; `..` that escapes the repo anchor is REJECTED (grants
 * must stay inside the repo — use an absolute grant otherwise).
 */
export function normalizeGrant(grant: string): string {
  const t = grant.trim().replace(/\\/g, "/");
  if (t === "") throw new PathPolicyError("INVALID_PATH", "Grant must not be empty", {});
  if (t.startsWith("/") || DRIVE_RE.test(grant.trim()) || UNC_RE.test(grant.trim().replace(/\//g, "\\"))) {
    // Absolute grant — compare as an absolute path.
    return normalizeForCompare(grant.trim());
  }
  const out: string[] = [];
  for (const seg of t.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) {
        throw new PathPolicyError("PATH_ESCAPES_ROOT", `Grant escapes the repo: ${grant}`, { grant });
      }
      out.pop();
      continue;
    }
    out.push(seg);
  }
  if (out.length === 0) throw new PathPolicyError("INVALID_PATH", `Grant is empty after normalization: ${grant}`, { grant });
  return out.join("/").toLowerCase();
}

function grantContains(grantNorm: string, otherNorm: string): boolean {
  return otherNorm === grantNorm || otherNorm.startsWith(`${grantNorm}/`);
}

/** True when two grants overlap (equal, or either contains the other). */
export function grantsOverlap(a: string, b: string): boolean {
  const na = normalizeGrant(a);
  const nb = normalizeGrant(b);
  // Absolute-vs-relative grants live in different namespaces; an absolute
  // grant can only overlap another absolute grant on the same root.
  const aAbs = na.includes("\\") || na.includes(":");
  const bAbs = nb.includes("\\") || nb.includes(":");
  if (aAbs !== bAbs) return false;
  return grantContains(na, nb) || grantContains(nb, na);
}

/**
 * Cross-namespace admission check (SEC-F-01): a relative grant and an
 * absolute grant never share grantsOverlap's namespace, so normalize the
 * absolute grant to repo-relative before comparing — match the relative
 * grant's segments (or one of its leading prefixes, for an absolute grant
 * that names an ancestor of the live grant) against the absolute grant's
 * trailing segments. Fail closed: a trailing-segment match conflicts (the
 * absolute path may simply be a worktree-anchored spelling of the same
 * repo dir). Same-namespace pairs return false here — grantsOverlap owns
 * them. Never throws for ungrammatical grants.
 */
function crossNamespaceOverlap(a: string, b: string): boolean {
  let na: string;
  let nb: string;
  try {
    na = normalizeGrant(a);
  } catch {
    return false;
  }
  try {
    nb = normalizeGrant(b);
  } catch {
    return false;
  }
  const aAbs = na.includes("\\") || na.includes(":");
  const bAbs = nb.includes("\\") || nb.includes(":");
  if (aAbs === bAbs) return false;
  const absSegs = (aAbs ? na : nb).split("\\").filter((s) => s !== "");
  const relSegs = (aAbs ? nb : na).split("/");
  if (relSegs.length === 0 || absSegs.length === 0) return false;
  // Requested-inside (or equal to) live: the relative grant appears
  // contiguously inside the absolute path (machine prefix + repo suffix).
  for (let i = 0; i + relSegs.length <= absSegs.length; i++) {
    if (relSegs.every((s, j) => absSegs[i + j] === s)) return true;
  }
  // Requested-contains-live: the absolute path's tail is a leading prefix
  // of the relative grant (it names an ancestor of the live grant).
  for (let k = 1; k < relSegs.length; k++) {
    const pre = relSegs.slice(0, k);
    if (pre.length > absSegs.length) break;
    const tail = absSegs.slice(absSegs.length - pre.length);
    if (pre.every((s, j) => tail[j] === s)) return true;
  }
  return false;
}

export interface OwnedPathConflict {
  readonly conflictingTaskId: string;
  readonly existingGrant: string;
  readonly requestedGrant: string;
}

/**
 * Admission-time exclusivity: a new task's ownedPaths must not overlap any
 * live task's ownedPaths. Returns the first conflict, or null.
 */
export function findOwnedPathConflict(
  live: ReadonlyMap<string, readonly string[]> | Record<string, readonly string[]>,
  taskId: string,
  ownedPaths: readonly string[],
): OwnedPathConflict | null {
  const entries: Array<[string, readonly string[]]> =
    live instanceof Map ? [...live.entries()] : Object.entries(live);
  for (const [otherId, otherPaths] of entries) {
    if (otherId === taskId) continue;
    for (const existing of otherPaths) {
      for (const requested of ownedPaths) {
        let overlap = false;
        try {
          overlap = grantsOverlap(existing, requested);
        } catch {
          // Ungrammatical existing grants cannot overlap; the requester's
          // own validation rejects bad grants at creation.
          overlap = false;
        }
        // Cross-namespace fallback (SEC-F-01): grantsOverlap never
        // conflicts relative-vs-absolute, so normalize the absolute side
        // to repo-relative trailing segments before comparing.
        if (!overlap) {
          try {
            overlap = crossNamespaceOverlap(existing, requested);
          } catch {
            overlap = false;
          }
        }
        if (overlap) return { conflictingTaskId: otherId, existingGrant: existing, requestedGrant: requested };
      }
    }
  }
  return null;
}

// --- Worker write validation ---

export type WriteDenyCode =
  | "CANONICAL_CHECKOUT"
  | "OUTSIDE_WORKTREE"
  | "OUTSIDE_OWNED_PATHS"
  | "FORBIDDEN_PATH"
  | "INVALID_PATH";

export interface WriteValidationContext {
  /** Canonical checkout root — worker writes here are ALWAYS denied. */
  readonly canonicalRoot: string;
  /** This task's worktree root — the candidate must live inside it. */
  readonly worktreePath: string;
  /** Task ownedPaths: repo-relative (resolved under the worktree) or absolute. */
  readonly ownedPaths: readonly string[];
  /** Task forbiddenPaths: same namespaces as ownedPaths; deny wins. */
  readonly forbiddenPaths: readonly string[];
}

export type WriteVerdict =
  | { readonly allowed: true; readonly resolvedPath: string }
  | { readonly allowed: false; readonly code: WriteDenyCode; readonly reason: string };

/**
 * Confine a worker write. Order is load-bearing:
 * 1. canonical checkout → deny (even if otherwise granted);
 * 2. outside the worktree → deny (BOTH the lexical and the
 *    ancestor-resolved physical form must stay inside — deny-if-either-outside);
 * 3. inside a forbidden grant → deny (deny wins over owned);
 * 4. outside every owned grant → deny (default-deny; empty grants deny all;
 *    BOTH forms must sit inside the granting path).
 * Allowed writes resolve to the ancestor-resolved physical comparison form.
 */
export function validateWorktreeWrite(ctx: WriteValidationContext, candidate: string): WriteVerdict {
  if (candidate.trim() === "") {
    return { allowed: false, code: "INVALID_PATH", reason: "Write path must not be empty" };
  }
  let candNorm: string;
  try {
    const t = candidate.trim();
    candNorm = isAbsoluteLike(t)
      ? normalizeForCompare(t)
      : normalizeForCompare(`${normalizeForCompare(ctx.worktreePath)}\\${t.replace(/\//g, "\\")}`);
  } catch {
    return { allowed: false, code: "INVALID_PATH", reason: `Unparseable write path: ${candidate}` };
  }
  // Ancestor-aware physical form: the target often does not exist yet, so
  // the deepest existing ancestor is resolved (symlink/junction + 8.3
  // aware) and the remainder re-appended. A hostile link swapped in under an
  // allowlisted directory must NOT pass on its lexical shape alone, and a
  // not-yet-created target under a symlinked ancestor must resolve against
  // the same physical root as its parent (S1 F-01).
  const candPhysical = physicalFormForNewPath(candNorm);

  let canonicalNorm: string;
  let worktreeNorm: string;
  try {
    canonicalNorm = normalizeForCompare(ctx.canonicalRoot);
    worktreeNorm = normalizeForCompare(ctx.worktreePath);
  } catch {
    return { allowed: false, code: "INVALID_PATH", reason: "Unparseable context roots" };
  }
  const canonicalPhysical = physicalFormForNewPath(canonicalNorm);
  const worktreePhysical = physicalFormForNewPath(worktreeNorm);
  // Either comparison spelling counts (8.3 short vs long): confinement
  // denies when EITHER candidate form escapes, canonical denies when EITHER
  // form lands inside.
  const withinEither = (a: string, b: string, cand: string): boolean =>
    isWithinRoot(a, cand) || isWithinRoot(b, cand);

  if (
    withinEither(canonicalNorm, canonicalPhysical, candNorm) ||
    withinEither(canonicalNorm, canonicalPhysical, candPhysical)
  ) {
    return { allowed: false, code: "CANONICAL_CHECKOUT", reason: `Writes to the canonical checkout are denied: ${candidate}` };
  }
  if (
    !withinEither(worktreeNorm, worktreePhysical, candNorm) ||
    !withinEither(worktreeNorm, worktreePhysical, candPhysical)
  ) {
    return { allowed: false, code: "OUTSIDE_WORKTREE", reason: `Write is outside the task worktree: ${candidate}` };
  }
  // Forbidden check uses the lexical path (a forbidden dir that does not
  // exist yet must still deny), plus the ancestor-resolved physical path.
  for (const raw of ctx.forbiddenPaths) {
    let forbidNorm: string;
    try {
      forbidNorm = isAbsoluteLike(raw.trim())
        ? normalizeForCompare(raw.trim())
        : normalizeForCompare(`${worktreeNorm}\\${raw.trim().replace(/\//g, "\\")}`);
    } catch {
      continue;
    }
    const forbidPhysical = physicalFormForNewPath(forbidNorm);
    if (
      withinEither(forbidNorm, forbidPhysical, candNorm) ||
      withinEither(forbidNorm, forbidPhysical, candPhysical)
    ) {
      return { allowed: false, code: "FORBIDDEN_PATH", reason: `Write is inside forbidden path ${raw}: ${candidate}` };
    }
  }
  if (ctx.ownedPaths.length === 0) {
    return { allowed: false, code: "OUTSIDE_OWNED_PATHS", reason: `Task grants no owned paths: ${candidate}` };
  }
  for (const raw of ctx.ownedPaths) {
    let ownedNorm: string;
    try {
      ownedNorm = isAbsoluteLike(raw.trim())
        ? normalizeForCompare(raw.trim())
        : normalizeForCompare(`${worktreeNorm}\\${raw.trim().replace(/\//g, "\\")}`);
    } catch {
      continue;
    }
    // Namespace unification (SEC-F-01): absolute owned grants NEVER
    // authorize — authorization lives in the repo-relative namespace only.
    // A relative-vs-absolute pair never conflicts at admission, so an
    // absolute grant that authorized inside-worktree writes would bypass
    // exclusivity. Fail closed: express in-worktree grants repo-relative.
    // (Absolute FORBIDDEN grants below still deny — the deny side stays
    // expressive; only the allow side is unified.)
    if (isAbsoluteLike(raw.trim())) continue;
    const ownedPhysical = physicalFormForNewPath(ownedNorm);
    // BOTH forms must sit inside the grant: a symlink that is lexically
    // nested under an owned dir but physically escapes it is denied here
    // (and already denied by the worktree gate when it leaves the worktree).
    if (
      withinEither(ownedNorm, ownedPhysical, candNorm) &&
      withinEither(ownedNorm, ownedPhysical, candPhysical)
    ) {
      return { allowed: true, resolvedPath: candPhysical };
    }
  }
  return { allowed: false, code: "OUTSIDE_OWNED_PATHS", reason: `Write is outside the task ownedPaths: ${candidate}` };
}
