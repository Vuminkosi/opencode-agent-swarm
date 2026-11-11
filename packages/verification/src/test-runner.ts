/**
 * M4-02 actual test runner (spec §14 M4 + §10 steps 5-6, §5 VerificationEvidence).
 *
 * `runVerification` spawns a task acceptance command with `cwd = worktreePath`
 * (a TMP worktree created by tests via `git init`, or by the M4-01 manager —
 * never the canonical checkout), captures exit code + stdout/stderr artifacts
 * + timing + commitSha + executor, and returns a `RecordEvidenceInput` DTO the
 * caller persists via `store.recordVerificationEvidence(...)` (C-DB-01) and
 * then drives through the M3 verifier gate (`submitVerification`: exit 0 ->
 * `verifying -> accepted`, non-zero -> defect post + `verifying -> ready`).
 *
 * INTEGRATION GATE (runner itself never merges): a non-zero `exitCode` (or
 * `timedOut`) MUST block canonical integration. The caller asserts
 * `isVerificationPassing(result)` before any merge/stage step and routes
 * failures into the M3 defect/remediation loop. Never present
 * model-written "tests passed" prose as artifact evidence.
 *
 * Safety: tmp repos only (symlinks denied, canonical checkout denied via
 * realpath); no canonical mutation; no paid inference; timeout + byte-counted
 * per-stream streaming caps with bounded drain; secret patterns are redacted
 * from the written artifacts, the persisted DTO command, and never logged.
 * The disposable run script is removed after spawn; artifacts land in a
 * disposable evidence dir under `os.tmpdir()` (`evidenceDir/<uuid>/...`),
 * never canonical.
 *
 * Evidence: [DESIGN] (spec §§5, 10, 14 M4).
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { RecordEvidenceInputSchema, type RecordEvidenceInput } from "@opencode-swarm/protocol";

export const DEFAULT_VERIFICATION_TIMEOUT_MS = 120_000 as const;
/** Default per-stream capture cap: streams past this are truncated with a marker (never OOM). */
export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576 as const;
/** Exit code reported when the command is killed after the timeout. */
export const VERIFICATION_TIMEOUT_EXIT_CODE = 124 as const;
const COMMIT_SHA_TIMEOUT_MS = 10_000 as const;

export interface RunVerificationInput {
  readonly taskId: string;
  readonly worktreePath: string;
  /** Shell command string, executed via a disposable script file (`run.cmd` on
   * win32, `run.sh` on POSIX) with `cwd = worktreePath`. */
  readonly command: string;
  readonly executorMemberId: string;
  /** Disposable root for `stdout.log`/`stderr.log`. Defaults to `os.tmpdir()`.
   * Must resolve inside `os.tmpdir()` (SEC F4). */
  readonly evidenceDir?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Canonical checkout root the worktree must NOT live under. Defaults to
   * `OPENCODE_SWARM_CANONICAL_ROOT` or the git toplevel of `process.cwd()`
   * (best-effort; skipped when undiscoverable). */
  readonly canonicalRoot?: string;
}

export interface RunVerificationResult {
  /** DTO for `store.recordVerificationEvidence(...)` — the caller persists it. */
  readonly evidenceInput: RecordEvidenceInput;
  /** True when the process was killed after `timeoutMs`. */
  readonly timedOut: boolean;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

/**
 * Gate predicate for callers: only a clean exit without timeout passes.
 * Non-passing results MUST block integration and enter M3 remediation.
 */
export function isVerificationPassing(result: RunVerificationResult): boolean {
  return !result.timedOut && result.evidenceInput.exitCode === 0;
}

/**
 * Write the shell command to a disposable script file and return the argv
 * that executes it. A script file (not `cmd.exe /c "<command>"` / argument
 * interpolation) keeps quoting predictable on Windows, where `cmd` quote
 * stripping otherwise mangles inner quotes, parens and `%` expansions in
 * acceptance commands.
 */
function writeRunScript(dir: string, command: string): { argv: [string, ...string[]]; scriptPath: string } {
  if (process.platform === "win32") {
    // win32 has no POSIX mode bits: the script inherits the best-effort 0700
    // evidence dir and is unlinked immediately after spawn (F2).
    const scriptPath = join(dir, "run.cmd");
    writeFileSync(scriptPath, `@echo off\r\n${command}\r\n`, "utf8");
    return { argv: ["cmd.exe", "/d", "/c", scriptPath], scriptPath };
  }
  const scriptPath = join(dir, "run.sh");
  writeFileSync(scriptPath, `#!/bin/sh\n${command}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(scriptPath, 0o600);
  } catch {
    /* best-effort ACL tightening */
  }
  return { argv: ["/bin/sh", scriptPath], scriptPath };
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-(?:live|test)-[A-Za-z0-9]{8,}/g,
  /sk-[A-Za-z0-9_-]{8,}/g,
  /ghp_[A-Za-z0-9]{10,}/g,
  /gho_[A-Za-z0-9]{10,}/g,
  /ghs_[A-Za-z0-9]{10,}/g,
  /ghu_[A-Za-z0-9]{10,}/g,
  /ghr_[A-Za-z0-9]{10,}/g,
  /github_pat_[A-Za-z0-9_]{10,}/g,
  /glpat-[A-Za-z0-9_\-]{10,}/g,
  /npm_[A-Za-z0-9]{8,}/g,
  /AIza[0-9A-Za-z\-_]{35}/g,
  /xox[a-z]-[A-Za-z0-9-]{8,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /ASIA[0-9A-Z]{16}/g,
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/gi,
  /Bearer\s+[A-Za-z0-9\-._~+/=]{8,}/gi,
  /(api[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret|aws[_-]?secret(?:[_-]?access[_-]?key)?|private[_-]?key|secret|password|passwd|pwd|bearer|token)\s*[:=]\s*("[^"]+"|'[^']+'|[^\s"'`,;]+)/gi,
];

/** Redact secret-bearing values from captured output before persisting. */
export function redactSecrets(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    // NOTE: String.replace passes (match, p1, offset, string) — with no
    // capture group `p1` is the numeric offset, so a bare `group !== undefined`
    // check would emit e.g. `123=[REDACTED]`. Guard on typeof string (F-01).
    out = out.replace(pattern, (_match: string, group: unknown) =>
      typeof group === "string" ? `${group}=[REDACTED]` : "[REDACTED]",
    );
  }
  return out;
}

function failInput(message: string): never {
  throw new Error(`[verification] invalid input: ${message}`);
}

function sha256hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function truncateBytes(input: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(input, "utf8");
  if (bytes <= maxBytes) return { text: input, truncated: false };
  // Slice on UTF-8 byte boundary: encode, cut, decode with replacement-safe trim.
  const buf = Buffer.from(input, "utf8").subarray(0, maxBytes);
  let text = buf.toString("utf8");
  // A cut mid-character decodes to U+FFFD at the tail — strip those so we
  // never persist a spurious replacement character (F-05).
  text = text.replace(/\uFFFD+$/u, "");
  text += `\n[truncated: output exceeded ${maxBytes} bytes]`;
  return { text, truncated: true };
}

/**
 * Byte-counted stream drain (F-02): never buffers more than `capBytes` (+one
 * head chunk for the truncation signal). Cancels the reader once the cap is
 * hit so a runaway process cannot OOM the runner via an unbounded pipe.
 */
async function readStream(
  stream: ReadableStream<Uint8Array> | null,
  capBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (stream === null) return { text: "", truncated: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;
      const room = capBytes - total;
      if (room <= 0) {
        truncated = true;
        continue;
      }
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room));
        total += room;
        truncated = true;
        continue;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    try {
      if (truncated) await reader.cancel();
    } catch {
      /* reader already closed */
    }
    reader.releaseLock();
  }
  // Buffer.concat first so only the tail can hold a split multi-byte char;
  // strip a trailing U+FFFD artifact just like truncateBytes (F-05).
  return { text: Buffer.concat(chunks).toString("utf8").replace(/\uFFFD+$/u, ""), truncated };
}

type SpawnedProc = ReturnType<typeof Bun.spawn>;

/** Bounded drain: never wait longer than this for pipes after kill (F-03). */
const DRAIN_TIMEOUT_MS = 5_000 as const;

/**
 * Kill the spawned shell AND its children. `proc.kill()` alone only stops
 * `cmd.exe` on Windows while the grandchild (e.g. `bun.exe`) keeps the
 * pipes open, which would hang stream drain indefinitely — so use
 * `taskkill /T` there and check its exit code before falling back to
 * `proc.kill()` (F-03). On POSIX the child is spawned with `detached: true`
 * (see `runVerification`), i.e. `setsid()` makes it a process-group leader,
 * so `process.kill(-pid, "SIGKILL")` honestly signals exactly this tree
 * (R01-01) — never an inherited group. Falls back to a direct kill when the
 * group is already gone.
 */
function killTree(proc: SpawnedProc): void {
  if (process.platform === "win32") {
    try {
      const res = Bun.spawnSync(["taskkill", "/PID", String(proc.pid), "/T", "/F"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      if (res.exitCode === 0) return;
    } catch {
      /* fall through to proc.kill() */
    }
  } else {
    try {
      process.kill(-proc.pid, "SIGKILL");
      return;
    } catch {
      /* no group leader (or already exited) — fall through to proc.kill() */
    }
  }
  try {
    proc.kill(9);
  } catch {
    /* already exited */
  }
}

/** Best-effort canonical-root discovery for the worktree deny check (F1). */
function discoverCanonicalRoot(explicit?: string): string | undefined {
  const candidate = explicit ?? process.env["OPENCODE_SWARM_CANONICAL_ROOT"];
  if (candidate !== undefined && candidate.trim() !== "") {
    try {
      return realpathSync(resolve(candidate.trim()));
    } catch {
      return resolve(candidate.trim());
    }
  }
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "ignore",
    } as unknown as Record<string, unknown>);
    const raw = typeof proc.stdout === "string" ? proc.stdout : proc.stdout?.toString() ?? "";
    const top = raw.trim();
    if (proc.exitCode === 0 && top !== "") return realpathSync(top);
  } catch {
    /* undiscoverable — caller skips the canonical check */
  }
  return undefined;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rootNorm = root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const candNorm = candidate.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return candNorm === rootNorm || candNorm.startsWith(`${rootNorm}/`);
}

/**
 * True when the final path component is a symlink (POSIX) or a directory
 * junction (Windows, where `lstatSync().isSymbolicLink()` is false for
 * junctions). Parent-chain links are fine — they are normalized away by
 * realpath — but a link AS the worktree itself is denied (F1).
 */
function finalComponentIsLink(p: string): boolean {
  try {
    if (lstatSync(p).isSymbolicLink()) return true;
  } catch {
    return false;
  }
  if (process.platform === "win32") {
    try {
      const lexical = join(realpathSync(dirname(p)), basename(p));
      return lexical.toLowerCase() !== realpathSync(p).toLowerCase();
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Resolve + validate the worktree dir (F1): deny symlinks, resolve the
 * canonical path via realpath, and deny anything inside the canonical
 * checkout root so a malicious/typoed path can never mutate canonical.
 */
function resolveWorktreeDir(worktreePath: string, canonicalRoot: string | undefined): string {
  try {
    lstatSync(worktreePath);
  } catch {
    failInput(`worktreePath is not accessible: ${worktreePath}`);
  }
  if (finalComponentIsLink(worktreePath)) {
    failInput(`worktreePath must not be a symlink or junction: ${worktreePath}`);
  }
  let real: string;
  try {
    real = realpathSync(worktreePath);
  } catch {
    failInput(`worktreePath is not accessible: ${worktreePath}`);
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(real);
  } catch {
    failInput(`worktreePath is not accessible: ${worktreePath}`);
  }
  if (!st.isDirectory()) failInput(`worktreePath is not a directory: ${worktreePath}`);
  if (canonicalRoot !== undefined && isWithinRoot(canonicalRoot, real)) {
    failInput(`worktreePath must not be inside the canonical checkout: ${worktreePath}`);
  }
  return real;
}

/** Constrain the disposable evidence root to os.tmpdir() (SEC F4). */
function physicalFormForNewPath(resolved: string): string {
  // SEC-02: a not-yet-created leaf has no realpath of its own, and a purely
  // lexical gate would bless `tmpdir/<symlink-to-elsewhere>/leaf`. Anchor the
  // deepest existing ancestor via realpath (collapsing a symlinked parent),
  // then re-append the missing tail so the gate below checks the physical
  // location. Purely local; does not touch git-workspaces.
  let cursor = resolved;
  const tail: string[] = [];
  for (;;) {
    try {
      let real = realpathSync(cursor);
      for (let i = tail.length - 1; i >= 0; i--) real = join(real, tail[i] as string);
      return real;
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return resolved;
      tail.push(basename(cursor));
      cursor = parent;
    }
  }
}

function resolveEvidenceRoot(evidenceDir: string | undefined): string {
  const tmpRoot = realpathSync(tmpdir());
  if (evidenceDir === undefined) return tmpRoot;
  const resolved = resolve(evidenceDir);
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    // Not-yet-created: gate the physical form, not the lexical string.
    real = physicalFormForNewPath(resolved);
  }
  if (!isWithinRoot(tmpRoot, real) && real.toLowerCase() !== tmpRoot.toLowerCase()) {
    failInput(`evidenceDir must be inside the system temp dir: ${evidenceDir}`);
  }
  try {
    mkdirSync(real, { recursive: true });
  } catch {
    failInput(`evidenceDir is not writable: ${evidenceDir}`);
  }
  return real;
}

/** Best-effort HEAD SHA of the tmp worktree; undefined when unavailable.
 * Fail-open by design: a non-git worktree still records evidence with the
 * sha omitted (pinned by the non-git test below), it never throws here. */
function readCommitSha(worktreePath: string): string | undefined {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: worktreePath,
      stdout: "pipe",
      stderr: "ignore",
      timeout: COMMIT_SHA_TIMEOUT_MS,
    } as unknown as Record<string, unknown>);
    const raw = typeof proc.stdout === "string" ? proc.stdout : proc.stdout?.toString() ?? "";
    const sha = raw.trim();
    if (proc.exitCode === 0 && /^[0-9a-f]{4,40}$/i.test(sha)) return sha;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run the task acceptance command in the tmp worktree and build the
 * persistence DTO. Throws only on invalid input / unreadable worktree /
 * artifact-write failure — command failure is DATA (`exitCode != 0`), not
 * an exception, so the caller can record evidence and block integration.
 */
export async function runVerification(input: RunVerificationInput): Promise<RunVerificationResult> {
  const taskId = input.taskId.trim();
  const executorMemberId = input.executorMemberId.trim();
  const command = input.command.trim();
  if (taskId === "") failInput("taskId must be non-empty");
  if (executorMemberId === "") failInput("executorMemberId must be non-empty");
  if (command === "") failInput("command must be non-empty");
  // Pre-validate §5 wire lengths BEFORE spawning (F-04): late Zod-only
  // enforcement would run the command first and fail after side effects.
  if (taskId.length > 128) failInput("taskId must be at most 128 characters");
  if (executorMemberId.length > 128) failInput("executorMemberId must be at most 128 characters");
  if (command.length > 4096) failInput("command must be at most 4096 characters");
  if (input.worktreePath.length > 4096) failInput("worktreePath must be at most 4096 characters");

  const timeoutMs = input.timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) failInput("timeoutMs must be a positive integer");
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    failInput("maxOutputBytes must be a positive integer");
  }

  const canonicalRoot = discoverCanonicalRoot(input.canonicalRoot);
  const worktreeDir = resolveWorktreeDir(input.worktreePath, canonicalRoot);

  const startedAt = new Date().toISOString();

  const root = resolveEvidenceRoot(input.evidenceDir);
  const dir = mkdtempSync(join(root, "verification-"));
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best-effort ACL tightening */
  }
  const stdoutPath = join(dir, "stdout.log");
  const stderrPath = join(dir, "stderr.log");

  const { argv, scriptPath } = writeRunScript(dir, input.command);
  const proc = Bun.spawn(argv, {
    cwd: worktreeDir,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    // R01-01: POSIX `setsid()` ⇒ group leader, so killTree's `kill(-pid)`
    // targets exactly this tree. No-op for the win32 `taskkill /T` path.
    detached: process.platform !== "win32",
  });

  let timedOut = false;
  let exitCode: number;
  // Byte-counted streaming caps (F-02): pipes can never buffer past the cap.
  const stdoutPromise = readStream(proc.stdout, maxOutputBytes);
  const stderrPromise = readStream(proc.stderr, maxOutputBytes);
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    killTree(proc);
  }, timeoutMs);
  // Do not keep the event loop alive on the timeout alone.
  (timeoutHandle as unknown as { unref?: () => void }).unref?.();
  try {
    exitCode = await proc.exited;
  } finally {
    clearTimeout(timeoutHandle);
  }
  // Bounded drain even after kill (F-03): a killed tree holding pipes open
  // must not hang the runner forever.
  const drainTimeout = new Promise<readonly [{ text: string; truncated: boolean }, { text: string; truncated: boolean }]>(
    (resolveDrain) => {
      const t = setTimeout(() => {
        try {
          proc.stdout?.cancel?.();
        } catch {
          /* best-effort */
        }
        try {
          (proc.stderr as unknown as { cancel?: () => void })?.cancel?.();
        } catch {
          /* best-effort */
        }
        resolveDrain([
          { text: "", truncated: true },
          { text: "", truncated: true },
        ] as const);
      }, DRAIN_TIMEOUT_MS);
      // Do not keep the event loop alive on the drain guard alone.
      (t as unknown as { unref?: () => void }).unref?.();
      void Promise.all([stdoutPromise, stderrPromise]).then((both) => {
        clearTimeout(t);
        resolveDrain(both);
      });
    },
  );
  const [streamStdout, streamStderr] = await drainTimeout;
  if (timedOut) {
    // Ensure the killed process actually reaped before returning.
    try {
      await proc.exited;
    } catch {
      /* kill already delivered */
    }
    exitCode = VERIFICATION_TIMEOUT_EXIT_CODE;
  }

  const stdoutCapped = streamStdout.truncated
    ? { text: `${streamStdout.text}\n[truncated: output exceeded ${maxOutputBytes} bytes]`, truncated: true }
    : truncateBytes(streamStdout.text, maxOutputBytes);
  const stderrCapped = streamStderr.truncated
    ? { text: `${streamStderr.text}\n[truncated: output exceeded ${maxOutputBytes} bytes]`, truncated: true }
    : truncateBytes(streamStderr.text, maxOutputBytes);
  const stdoutTruncated = stdoutCapped.truncated || streamStdout.truncated;
  const stderrTruncated = stderrCapped.truncated || streamStderr.truncated;
  const stdoutText = redactSecrets(stdoutCapped.text);
  const stderrText = redactSecrets(stderrCapped.text);
  const finishedAt = new Date().toISOString();

  writeFileSync(stdoutPath, stdoutText, "utf8");
  writeFileSync(stderrPath, stderrText, "utf8");
  // Remove the secret-bearing script (F2): logs are redacted, the raw command
  // must not linger on disk.
  try {
    unlinkSync(scriptPath);
  } catch {
    /* best-effort cleanup */
  }

  const commitSha = readCommitSha(worktreeDir);
  const evidenceInput: RecordEvidenceInput = {
    taskId,
    executorMemberId,
    // Never persist the raw command: it may carry secrets (F2).
    command: redactSecrets(input.command),
    cwd: worktreeDir,
    exitCode,
    ...(commitSha === undefined ? {} : { commitSha }),
    startedAt,
    finishedAt,
    stdout: { sha256: sha256hex(stdoutText), filePath: stdoutPath },
    stderr: { sha256: sha256hex(stderrText), filePath: stderrPath },
  };
  // Enforce the §5 wire shape before handing the DTO to the caller.
  RecordEvidenceInputSchema.parse(evidenceInput);

  return {
    evidenceInput,
    timedOut,
    stdoutPath,
    stderrPath,
    stdoutTruncated,
    stderrTruncated,
  };
}
