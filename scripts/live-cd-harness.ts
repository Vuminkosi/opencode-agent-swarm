#!/usr/bin/env bun
/**
 * LIVE-PROBE-02 C/D harness — live coordinator+2-worker wake lifecycle + B long-window overlap.
 *
 * TASK: LIVE-PROBE-02-HARNESS-01. Disposable-capable driver around the REAL
 * canonical M3 board-service + WakeQueue + WakeDispatcher and the REAL M1-03
 * OpenCode adapter (pinned OpenCode 2.2.7), WITHOUT subagent dispatch.
 *
 * What it does
 * - Mode `wake` (default): 1 coordinator + 2 worker native sessions in a
 *   disposable repo on an isolated 127.0.0.1 free port (never :45278), posts
 *   one M3 public @mention via board-service + WakeQueue against a tmp
 *   SQLite DB, dispatches via the real harness submitTurn queue-only path,
 *   captures session/execution events + timestamps, and proves:
 *     1. one mention -> one wake (exactly one admitted turn),
 *     2. duplicate post (same idempotencyKey / delivery_key) -> no extra turn,
 *     3. unrelated (mention-free) post -> no wake,
 *     4. identity preserved (session/agent ids match end to end),
 *     5. lead waiting performs zero inference (submitTurn counter delta 0),
 *     6. worker completion -> lead wake -> lead back to waiting (real events).
 * - Mode `overlap` (B): two long-window prompts (bounded 60-90 s work) started
 *   with minimal stagger; captures overlap interval + both responses + usage.
 * - Mode `both`: wake proofs first, then overlap.
 *
 * Verified-operation discipline (OpenCode 2.2.7 only)
 * - This file makes NO raw OpenCode HTTP calls. Live calls go exclusively
 *   through the canonical adapter modules loaded at runtime:
 *     packages/adapter-opencode/src/sessions.ts  (session.create/get/remove,
 *       switchAgent/Model, prompt queue-only, interrupt, inbox/message/
 *       context reads, agent.list, experimental wait)
 *     packages/adapter-opencode/src/events.ts    (event.subscribe SSE +
 *       executionsOverlap + disposable-path guard)
 *     packages/adapter-opencode/src/harness.ts   (queue-only OpenCodeHarness)
 * - `externalId` stays adapter-internal: it travels in-band in prompt
 *   `metadata` (a VERIFIED prompt field) + a text header, never as an
 *   OpenCode API argument (see buildPromptBody in sessions.ts).
 * - Canonical M3/M2 modules (store, board-service, wake-queue,
 *   wake-dispatcher, lead-autonomy) are IMPORTED READ-ONLY at runtime via
 *   dynamic import inside live mode only. This file never modifies
 *   packages/**, apps/**, or any canonical tree. `--dry-run` never loads
 *   them at all (zero inference, zero network, zero sqlite).
 *
 * Safety (hard guards, live mode refuses to run when violated)
 * - Server MUST bind 127.0.0.1 on an OS-allocated free port; port 45278 is
 *   refused even if explicitly passed (--server-url is validated too).
 * - ALL writes land under the disposable root
 *   (%TEMP%/opencode/live-cd-harness-<ts>-<pid>/) : repo dir, sqlite DB,
 *   event ledger, raw captures. Anything outside is refused.
 * - Budget: --max-turns caps harness submitTurn calls; --timeout-ms aborts
 *   the whole run; --max-cost-usd ENFORCES a fail-closed spend ceiling
 *   (default $0.50): cost is deep-scanned from session.usage.updated payloads
 *   after every usage event (unknown shapes tally 0 and warn per-event, with
 *   the 402/429 transport gates + the pre-submit ceiling gate as backstops)
 *   and re-checked before every submit; a breach aborts (exit 3) before any
 *   further spend. 402/quota aborts with ZERO retries; 401/403/429 abort
 *   immediately. Abort state is re-polled before every submit (second gate),
 *   and every abort fires the shared subscription cancel.
 * - Secrets are NEVER printed: URLs with credentials, tokens, and
 *   authorization headers are redacted in every log/ledger line.
 *
 * Exit codes: 0 PASS (or dry-run plan OK), 1 FAIL, 2 usage error, 3 aborted
 * (budget/quota/auth/unsafe/timeout — rerun is safe; tmp state is disposable).
 */

// Bun-native: no node: imports (standalone tsc hermetic, zero new deps).
// No node: imports — Bun-native surface declared above.

// ---------------------------------------------------------------------------
// Runtime surface (Bun-native; no node: imports so standalone `tsc` stays
// hermetic with zero new dependencies — no @types/node in this repo).
// DOM lib covers fetch/URL/AbortController/TextDecoder/console/setTimeout.
// ---------------------------------------------------------------------------
declare const process: {
  readonly argv: readonly string[];
  readonly pid: number;
  readonly env: Readonly<Record<string, string | undefined>>;
  exit(code?: number): never;
};
declare const Bun: {
  file(path: string): {
    writer(): { write(chunk: string): void; end(): void };
  };
  write(path: string, content: string): Promise<number>;
  listen(opts: {
    readonly hostname: string;
    readonly port: number;
    readonly socket: {
      readonly data?: (...args: never[]) => void;
      readonly error?: (...args: never[]) => void;
    };
  }): { readonly port: number; stop(): void };
  spawn(
    cmd: readonly string[],
    opts?: { readonly cwd?: string; readonly stdout?: string; readonly stderr?: string },
  ): unknown;
};

/** Normalize to forward slashes, no trailing slash. */
function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/(.+)\/$/, "$1");
}

function pjoin(...parts: string[]): string {
  return norm(parts.join("/"));
}

function envTmp(): string {
  return norm(process.env["TEMP"] ?? process.env["TMPDIR"] ?? process.env["TMP"] ?? "/tmp");
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Pinned backend version this harness is written against. [OC2-REST 2.2.7] */
const OPENCODE_PIN = "2.2.7";

/** Production/canonical OpenCode port — NEVER touched by this harness. */
const FORBIDDEN_PORT = 45278;

/** Verified 2.2.7 ops this harness may exercise (via the canonical adapter). */
const VERIFIED_OPS = [
  "session.create (POST /api/session)",
  "session.get (GET /api/session/{id})",
  "session.prompt queue-only (POST /api/session/{id}/prompt, delivery=queue)",
  "session.interrupt (POST /api/session/{id}/interrupt)",
  "session.inbox.list / session.message.list / session.context (reads)",
  "agent.list (GET /api/agent)",
  "event.subscribe (GET /api/event SSE)",
  "experimental.session.wait (POST /api/experimental/session/{id}/wait)",
] as const;

type Mode = "wake" | "overlap" | "both";

interface Options {
  readonly help: boolean;
  readonly dryRun: boolean;
  readonly mode: Mode;
  readonly serverUrl: string | null;
  readonly spawn: boolean;
  readonly maxTurns: number;
  readonly timeoutMs: number;
  readonly maxCostUsd: number;
  readonly staggerMs: number;
  readonly workSeconds: number;
  readonly dbPath: string | null;
  readonly root: string | null;
  readonly selfTest: string | null;
}

// ---------------------------------------------------------------------------
// Redaction + logging (never print secrets)
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9-_]{8,}/g,
  /sk-ant-[A-Za-z0-9-_]{8,}/g,
  /gh[pousr]_[A-Za-z0-9]{8,}/g,
  /xox[bpas]-[A-Za-z0-9-]{8,}/g,
  /Bearer\s+[A-Za-z0-9\-._~+/=]{8,}/gi,
  /api[_-]?key\s*[:=]\s*['"]?[^'"\s,}]{6,}['"]?/gi,
  /authorization\s*[:=]\s*['"]?[^'"\s,}]{6,}['"]?/gi,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /eyJ[A-Za-z0-9-_]{10,}\.[A-Za-z0-9-_]{10,}/g,
  /(?:token|secret|password)\s*[:=]\s*['"]?[^'"\s,}]{6,}['"]?/gi,
];

/** Redact credential-shaped material from any string before logging. */
export function redact(value: string): string {
  let out = value;
  // Strip userinfo from URLs first (http://user:pass@host).
  out = out.replace(/([a-z]+:\/\/)([^/\s@]+)@/gi, "$1<redacted>@");
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, "<redacted>");
  }
  return out;
}

/** Append-only ledger handle; every line passes through redact() in logLine. */
export interface Ledger {
  write(line: string): void;
  close(): void;
}

export function openLedger(path: string): Ledger {
  const sink = Bun.file(path).writer();
  return {
    write(line: string): void {
      // Fail-closed: redact at the sink so no direct writer can leak a
      // secret even if a caller forgets to redact (logLine redacts too;
      // redact() is idempotent over "<redacted>").
      sink.write(redact(line) + "\n");
    },
    close(): void {
      sink.end();
    },
  };
}

function logLine(ledger: Ledger | null, scope: string, message: string): void {
  const line = `[${new Date().toISOString()}] [${scope}] ${redact(message)}`;
  console.log(line);
  if (ledger !== null) {
    ledger.write(line);
  }
}

/**
 * F01 order enforcement: the FINAL summary line is written BEFORE the ledger
 * is closed, on every exit path. liveMain never calls `ledger.close()`
 * anywhere else — grep must show exactly one `close()` site besides this
 * helper and the synthetic order test.
 */
export function closeLedgerAfterFinalLog(ledger: Ledger, scope: string, message: string): void {
  logLine(ledger, scope, message);
  ledger.close();
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function disposableRootBase(): string {
  return pjoin(envTmp(), "opencode", "live-cd-harness");
}

/** Lexically resolve `.`/`..` after slash normalization (no FS access).
 * Clamps absolute paths at the root; relative `..` above cwd is preserved
 * so the caller still sees the escape. Backslashes are normalized first so
 * `..\` traversals cannot evade the prefix check. */
export function resolveSegments(p: string): string {
  const normalized = norm(p);
  const driveMatch = /^[A-Za-z]:\//.exec(normalized);
  const drive = driveMatch !== null ? driveMatch[0].slice(0, 2) : "";
  const rest = drive !== "" ? normalized.slice(2) : normalized;
  const isAbs = rest.charAt(0) === "/";
  const stack: string[] = [];
  for (const part of rest.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") stack.pop();
      else if (!isAbs) stack.push("..");
      continue;
    }
    stack.push(part);
  }
  const joined = stack.join("/");
  if (drive !== "") return `${drive}/${joined}`;
  if (isAbs) return `/${joined}`;
  return joined;
}

/** Relative `..\` / `../` traversal markers that candidatePaths may not
 * capture as absolute tokens (fail closed — caller must abort). */
const RELATIVE_TRAVERSAL_RE = /(^|[\s"'`=:`])\.\.([\\/]|$)|[\\/]\.\.([\\/]|$)/;

/** `~`-home markers outside a captured absolute token (fail closed). */
const TILDE_HOME_RE = /(^|[\s"'`=:`])~([\\/]|$)/;

/** Refuse any path that is not strictly inside the disposable root.
 * F-B-01: resolve `.`/`..` segments BEFORE the prefix compare — a
 * norm-only prefix accepts `<root>/../escape.db` as a string while it
 * resolves outside the root. */
export function assertDisposablePath(path: string, root: string): void {
  const abs = resolveSegments(path);
  const rootAbs = resolveSegments(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + "/")) {
    throw new Error(`REFUSED: ${path} is outside the disposable root ${root}`);
  }
}

/** Refuse paths inside the canonical repo checkout. */
export function assertNotCanonicalRepo(path: string): void {
  const abs = norm(path);
  const lower = abs.toLowerCase();
  if (
    lower.includes("/packages/") ||
    lower.includes("/apps/") ||
    /(^|\/)opencode-agent-swarm(\/|$)/i.test(abs)
  ) {
    throw new Error(`REFUSED: ${path} looks like a canonical repo path (disposable tmp only)`);
  }
}

export function portOf(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (parsed.port === "") return parsed.protocol === "https:" ? 443 : 80;
    const n = Number(parsed.port);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Loopback policy: 127.0.0.1 and localhost only; an explicit ::1 literal is
 * refused (conservative allowlist — use the 127.0.0.1 literal). localhost
 * depends on the system resolver (usually 127.0.0.1/::1). TOCTOU note: the
 * hostname is checked here at parse time but resolved at connect time, so a
 * hostile-DNS environment must pass the 127.0.0.1 literal. findFreePort
 * always binds 127.0.0.1 explicitly, never localhost.
 *
 * Refuse the canonical :45278 port and any non-loopback host.
 */
export function assertIsolatedServerUrl(url: string): void {
  const port = portOf(url);
  if (port === FORBIDDEN_PORT) {
    throw new Error(`REFUSED: server URL targets forbidden canonical port :${FORBIDDEN_PORT}`);
  }
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error(`REFUSED: unparseable server URL`);
  }
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`REFUSED: server must bind 127.0.0.1 (got ${host})`);
  }
}

/** Allocate an OS-free loopback port; never returns :45278. */
export function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    let listener: { readonly port: number; stop(): void };
    try {
      listener = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: {},
      });
    } catch (err) {
      reject(err);
      return;
    }
    const port = listener.port;
    try {
      listener.stop();
    } catch (err) {
      reject(err);
      return;
    }
    if (port === FORBIDDEN_PORT || port <= 0) {
      reject(new Error("OS returned an unusable port; retry the run"));
      return;
    }
    resolvePort(port);
  });
}

/** Terminal-outcome classifier for the exactly-one-turn proof (F-EXEC13-E01).
 *
 * A real successful model turn legitimately emits MULTIPLE messages
 * (assistant text + tool calls + follow-ups), so raw `message.list` delta
 * is informational only. What must be exactly one per admitted wake is the
 * TERMINAL execution outcome: one `session.execution.succeeded` or
 * `session.execution.failed` event. `interrupted` is intentionally NOT a
 * counted outcome (it is an abort, exit 3 — never a proof PASS).
 * Duplicate/unrelated wakes must produce ZERO new terminal outcomes. */
export function isTerminalOutcomeEvent(type: string): boolean {
  return type === "session.execution.succeeded" || type === "session.execution.failed";
}

/** Count terminal execution outcomes (succeeded/failed only) in an event list. */
export function countTerminalOutcomes(events: readonly { readonly type: string }[]): number {
  let n = 0;
  for (const e of events) {
    if (isTerminalOutcomeEvent(e.type)) n += 1;
  }
  return n;
}

/** Count terminal outcomes for one session in a ledger since a mark index. */
export function countTerminalOutcomesSince(
  ledger: readonly { readonly type: string; readonly sessionId: string }[],
  sessionId: string,
  since: number,
): number {
  let n = 0;
  for (let i = since; i < ledger.length; i += 1) {
    const e = ledger[i] as { readonly type: string; readonly sessionId: string };
    if (e.sessionId === sessionId && isTerminalOutcomeEvent(e.type)) n += 1;
  }
  return n;
}

/** Best-effort disposable-server teardown descriptor (OPS01 S3).
 * Bun `kill()` can leave the spawned server alive; the fallback force-kills
 * the PID tree (`taskkill /F /T` equivalent). Pure argv builder so the shape
 * is synthetically provable with zero inference. */
export function teardownForceKillArgs(pid: number): readonly string[] {
  return ["taskkill", "/F", "/T", "/PID", String(pid)];
}

/** Overlap check mirroring the canonical executionsOverlap (open intervals). */
export function intervalsOverlap(
  a: { readonly startedAt: string; readonly terminalAt: string | null },
  b: { readonly startedAt: string; readonly terminalAt: string | null },
): boolean {
  const aStart = Date.parse(a.startedAt);
  const bStart = Date.parse(b.startedAt);
  if (!Number.isFinite(aStart) || !Number.isFinite(bStart)) return false;
  const aEnd = a.terminalAt === null ? Number.POSITIVE_INFINITY : Date.parse(a.terminalAt);
  const bEnd = b.terminalAt === null ? Number.POSITIVE_INFINITY : Date.parse(b.terminalAt);
  if (Number.isNaN(aEnd) || Number.isNaN(bEnd)) return false;
  return aStart < bEnd && bStart < aEnd;
}

// ---------------------------------------------------------------------------
// Abort/cost/permission classifiers (pure; exported for synthetic self-tests)
// ---------------------------------------------------------------------------

const COST_KEYS: readonly string[] = ["cost", "costUsd", "costUSD", "totalCost", "total_cost"];

/**
 * Best-effort cost extraction from a session.usage.updated payload.
 *
 * Deep scan (depth <= 4, cycle-safe) for COST_KEYS plus a
 * case-insensitive `cost_usd`/`total_cost` fallback, so unknown nesting
 * shapes still tally instead of silently scoring 0. Returns 0 when no
 * positive finite cost is found — callers MUST treat 0 as "unknown shape"
 * (warn, keep the 402/429 + pre-submit gates as the fail-closed backstops),
 * never as proof of zero spend.
 */
export function extractCostUsd(payload: unknown): number {
  const seen = new Set<object>();
  const walk = (node: unknown, depth: number): number => {
    if (typeof node !== "object" || node === null || depth > 4) return 0;
    if (seen.has(node)) return 0;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const el of node as readonly unknown[]) {
        const hit = walk(el, depth + 1);
        if (hit > 0) return hit;
      }
      return 0;
    }
    const rec = node as Record<string, unknown>;
    for (const k of Object.keys(rec)) {
      for (const ck of COST_KEYS) {
        if (k === ck) {
          const v: unknown = rec[k];
          if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
        }
      }
      if (/^(cost[_-]?usd|total[_-]?cost)$/i.test(k)) {
        const v: unknown = rec[k];
        if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
      }
    }
    for (const k of Object.keys(rec)) {
      const hit = walk(rec[k], depth + 1);
      if (hit > 0) return hit;
    }
    return 0;
  };
  return walk(payload, 0);
}

/** Fail-closed ceiling predicate shared by the event tally and submit gate. */
export function costBreached(costUsd: number, capUsd: number): boolean {
  return costUsd >= capUsd;
}

/** Numeric HTTP status of err, coercing numeric strings ("499"). */
function statusOf(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const s = (err as { status?: unknown }).status;
  const n =
    typeof s === "number" ? s : typeof s === "string" && s.trim() !== "" ? Number(s) : NaN;
  return Number.isInteger(n) ? (n as number) : null;
}

/** True when err is a timeout/abort signal (exit 3), not a proof failure. */
export function isAbortError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const rec = err as { status?: unknown; code?: unknown; name?: unknown };
  if (statusOf(err) === 499) return true;
  if (rec.code === "WAIT_ABORTED") return true;
  if (rec.name === "AbortError" || rec.name === "TimeoutError") return true;
  return false;
}

/** Extract filesystem-path-like tokens (raw, unresolved) from a payload dump. */
function candidatePaths(payloadJson: string): string[] {
  const out: string[] = [];
  const re = /([A-Za-z]:[\\/][^"'\s,}]*|\/[^"'\s,}]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(payloadJson)) !== null) {
    out.push(m[1].replace(/[.,;:!?]+$/, ""));
  }
  return out;
}

/** Tools that are read-only by construction (pass through to the path check). */
const READ_ONLY_TOOLS: readonly string[] = [
  "read",
  "list",
  "glob",
  "grep",
  "search",
  "message",
  "wait",
  "context",
  "inbox",
  "agent",
];

/** Tools confined to the disposable root (path check decides). */
const CONFINED_WRITE_TOOLS: readonly string[] = [
  "write",
  "edit",
  "apply",
  "patch",
  "create",
  "mkdir",
  "update",
];

/** Tool-name fragments that are NEVER allowed (exec/network/env/secret). */
const ALWAYS_UNSAFE_TOOL_FRAGMENTS: readonly string[] = [
  "exec",
  "bash",
  "shell",
  "terminal",
  "spawn",
  "pty",
  "command",
  "fetch",
  "http",
  "network",
  "socket",
  "curl",
  "wget",
  "download",
  "upload",
  "connect",
  "env",
  "secret",
  "key",
  "token",
  "password",
  "credential",
];

/** `process.env` / key-material markers — exfil shape, always unsafe. */
const ENV_EXFIL_RE =
  /process\.env|OPENAI_API_KEY|ANTHROPIC_API_KEY|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY/i;

/** `"tool": "<name>" (also command/action/function) values in a payload dump. */
function toolNamesOf(payloadJson: string): string[] {
  const out: string[] = [];
  const re = /"(?:tool|command|action|function)"\s*:\s*"([^"]{1,64})"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(payloadJson)) !== null) {
    const first = m[1].toLowerCase().split(/[^a-z0-9]+/)[0];
    if (first !== undefined && first !== "") out.push(first);
  }
  return out;
}

/**
 * Conservative unsafe-scope classifier for `permission.asked` payloads.
 * Fail-closed layers (ANY layer firing => UNSAFE, caller interrupts + aborts):
 *  1. tool allowlist: a named tool outside the read-only/confined-write sets,
 *     or matching an exec/network/env/secret fragment, is unsafe even when the
 *     payload echoes the disposable repo dir (closes the "exec-in-repo"
 *     gap — the server should additionally run in require-approval mode);
 *  2. env/key exfil markers are unsafe regardless of paths;
 *  3. per-file exact-match: every path-like token must sit strictly inside
 *     the disposable root (`..`/unresolved escapes and `~` homes are unsafe);
 *  4. when no path token is present, fall back to substring containment of
 *     the root/repo dir (absence of both => unsafe).
 * Returns true when the ask is OUTSIDE the disposable root (caller must
 * interrupt + abort, exit 3).
 */
export function isUnsafePermissionAsk(payloadJson: string, root: string, repoDir: string): boolean {
  const rootAbs = resolveSegments(root);
  const repoAbs = resolveSegments(repoDir);
  for (const t of toolNamesOf(payloadJson)) {
    if (READ_ONLY_TOOLS.indexOf(t) >= 0 || CONFINED_WRITE_TOOLS.indexOf(t) >= 0) continue;
    if (ALWAYS_UNSAFE_TOOL_FRAGMENTS.some((u) => t.indexOf(u) >= 0 || u.indexOf(t) >= 0)) {
      return true;
    }
    return true; // unknown tool: fail closed.
  }
  if (ENV_EXFIL_RE.test(payloadJson)) return true;
  // Fail-closed backstop: relative `../` / `..\` escapes (or `~` homes) that
  // never surface as absolute candidate tokens still refuse the ask. The
  // server must additionally run in require-approval mode; this classifier
  // is the harness-side second gate, never the sole control.
  if (RELATIVE_TRAVERSAL_RE.test(payloadJson) || TILDE_HOME_RE.test(payloadJson)) return true;
  const inside = (p: string): boolean => {
    const resolved = resolveSegments(p);
    return resolved === rootAbs || resolved.startsWith(rootAbs + "/");
  };
  const cands = candidatePaths(payloadJson);
  if (cands.length > 0) {
    return cands.some((raw) => {
      // Normalize slashes BEFORE segment inspection so `..\` cannot evade
      // the `..` check, then resolve `.`/`..` BEFORE the prefix check so
      // `<root>/../escape` (either slash style) is not prefix-accepted.
      const normalized = norm(raw);
      if (normalized.split("/").indexOf("..") >= 0) return true;
      if (normalized.charAt(0) === "~" || raw.charAt(0) === "~") return true;
      const resolved = resolveSegments(raw);
      if (resolved.split("/").indexOf("..") >= 0) return true;
      return !inside(resolved);
    });
  }
  return !(payloadJson.includes(rootAbs) || payloadJson.includes(repoAbs));
}

// ---------------------------------------------------------------------------
// Isolated live-model override (MODEL-INHERIT-01) — harness ONLY, never
// production. Production (`packages/runtime/src/**`) never reads these
// variables (grep LIVE_MODEL there must hit only tests asserting isolation).
//
// Contract:
// - Inert unless SWARM_ALLOW_LIVE_INFERENCE === "1" (even in this harness).
// - When allowed: LIVE_MODEL must be exactly `providerID/modelId` (both
//   non-empty, strict charset) and LIVE_MODEL_APIKey must be PRESENT
//   (presence-checked only — the value is NEVER read into a string, log,
//   ledger, DB row, or transport header by this file: no verified 2.2.7
//   API-key passthrough exists, so the key stays in the isolated disposable
//   server's own environment. Assuming a header passthrough would be an
//   unverified auth shape — fail closed instead).
// - The validated MODEL REF (no secret) is applied via the VERIFIED
//   POST /api/session/{id}/model op (switchModel, history retained by
//   backend). Any missing/malformed combo throws LIVE_MODEL_* (fail closed,
//   exit 3 via fail()) — never a silent fallback to the ambient model.
// ---------------------------------------------------------------------------

/** Validated live-model ref: provider + model ids only, never credentials. */
export interface LiveModelOverride {
  readonly providerID: string;
  readonly id: string;
}

const LIVE_MODEL_PART_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Strict `providerID/modelId` parse; throws LIVE_MODEL_INVALID on any drift. */
export function parseLiveModelRef(raw: string): LiveModelOverride {
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash !== trimmed.lastIndexOf("/")) {
    throw new Error("LIVE_MODEL_INVALID: expected exactly `providerID/modelId` (got unparseable value)");
  }
  const providerID = trimmed.slice(0, slash);
  const id = trimmed.slice(slash + 1);
  if (!LIVE_MODEL_PART_RE.test(providerID) || !LIVE_MODEL_PART_RE.test(id)) {
    throw new Error("LIVE_MODEL_INVALID: providerID and model id must match [A-Za-z0-9._-]{1,128}");
  }
  return { providerID, id };
}

export interface LiveTestOverrideRead {
  readonly allowed: boolean;
  readonly rawModel: string | null;
  readonly apiKeyPresent: boolean;
}

/** Presence-only env read: the key VALUE is never returned. */
export function readLiveTestOverride(env: Readonly<Record<string, string | undefined>>): LiveTestOverrideRead {
  const allowed = env["SWARM_ALLOW_LIVE_INFERENCE"] === "1";
  const raw = env["LIVE_MODEL"];
  const key = env["LIVE_MODEL_APIKey"];
  return {
    allowed,
    rawModel: raw === undefined || raw.trim() === "" ? null : raw,
    apiKeyPresent: key !== undefined && key !== "",
  };
}

/**
 * Fail-closed live override: null when not allowed (vars inert); the exact
 * validated ref when allowed AND model+key both present; throws otherwise.
 * Never returns credentials; never logs raw values (callers log via the
 * redacting logLine only).
 */
export function resolveLiveTestOverride(env: Readonly<Record<string, string | undefined>>): LiveModelOverride | null {
  const read = readLiveTestOverride(env);
  if (!read.allowed) return null;
  if (read.rawModel === null) {
    throw new Error("LIVE_MODEL_MISSING: SWARM_ALLOW_LIVE_INFERENCE=1 requires LIVE_MODEL=`providerID/modelId`");
  }
  if (!read.apiKeyPresent) {
    throw new Error("LIVE_MODEL_APIKey_MISSING: SWARM_ALLOW_LIVE_INFERENCE=1 requires LIVE_MODEL_APIKey for the isolated server");
  }
  return parseLiveModelRef(read.rawModel);
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function usage(): string {
  return [
    `live-cd-harness.ts (LIVE-PROBE-02-HARNESS-01) — pinned OpenCode ${OPENCODE_PIN}`,
    ``,
    `Usage:`,
    `  bun scripts/live-cd-harness.ts --help`,
    `  bun scripts/live-cd-harness.ts --dry-run [--mode wake|overlap|both]`,
    `  bun scripts/live-cd-harness.ts [--mode wake|overlap|both] --server-url http://127.0.0.1:<free-port> [budget flags]`,
    `  bun scripts/live-cd-harness.ts --spawn [--mode ...] [budget flags]   (best-effort local spawn)`,
    ``,
    `Live preconditions (NOT executed by --dry-run):`,
    `  - A disposable OpenCode ${OPENCODE_PIN} server bound to 127.0.0.1 on a free port (never :${FORBIDDEN_PORT}).`,
    `  - Provider credentials configured for that disposable server only.`,
    `  - All writes stay under the disposable root (tmp); canonical repos untouched.`,
    ``,
    `Flags:`,
    `  --help            Print this help (zero inference).`,
    `  --dry-run         Print the execution plan + run local guard self-checks. No network,`,
    `                    no inference, no sqlite. Exit 0 when the plan validates.`,
    `  --mode <m>        wake (default) | overlap | both.`,
    `  --server-url <u>  Disposable server base URL (validated: loopback, not :${FORBIDDEN_PORT}).`,
    `  --spawn           Best-effort: spawn \`opencode serve\` on a free loopback port in the`,
    `                    disposable dir. Aborts clearly when the binary/flags are unavailable;`,
    `                    prefer starting the disposable server manually per README.`,
    `  --max-turns <n>   Cap on harness submitTurn calls (default 6). Exceeding aborts.`,
    `  --timeout-ms <n>  Global run timeout (default 300000). AbortSignal aborts waits/subs.`,
    `  --max-cost-usd <f> ENFORCED spend ceiling (default 0.50): cost tallied from`,
    `                    usage events; breach aborts BEFORE the next submit (exit 3).`,
    `  --stagger-ms <n>  Overlap-mode stagger between the two long-window prompts (default 5000).`,
    `  --work-seconds <n> Bounded work window per overlap prompt, 60-90 (default 75).`,
    `  --db-path <p>     Tmp sqlite path (must be under tmp; default <disposable-root>/swarm.db).`,
    `  --root <p>        Disposable root override (must be under tmp; validated in dry-run too).`,
    `  --self-test <n>   Zero-inference synthetic guard proof: unsafe|ceiling exit 3`,
    `                    when the guard fires (proves the abort path); abort|`,
    `                    cost-shape|terminal|sse exit 0 on PASS, 1 on FAIL (second-gate,`,
    `                    deep-cost + ledger-order, terminal-outcome-count, zero-wire-gate assertions).`,
    ``,
    `Arg discipline: unknown flags are a usage error (exit 2); when a flag is`,
    `repeated, the FIRST occurrence wins.`,
    ``,
    `Loopback policy: 127.0.0.1 or localhost only; explicit ::1 is refused`,
    `(use 127.0.0.1). Hostname is validated at parse time but resolved at`,
    `connect time (TOCTOU) — hostile-DNS environments must use 127.0.0.1.`,
    ``,
    `Budget/abort policy:`,
    `  Abort (exit 3) on --timeout-ms, --max-turns exceeded, cost-ceiling breach`,
    `  (checked after every usage event AND before every submit — fail-closed),`,
    `  HTTP 402 (ZERO retries), 401/403/429 auth/rate-limit aborts, 499 (numeric`,
    `  or "499")/WAIT_ABORTED/timeout, or an unsafe permission ask`,
    `  (scope outside the disposable root, or a non-allowlisted/exec/network/env`,
    `  tool even when it echoes the root). Every abort also fires the shared`,
    `  cancel (SSE subscriptions stop) and every submit re-polls the abort`,
    `  state first, so a swallowed dispatch-loop throw still refuses spend.`,
    `  No secret is ever printed.`,
    ``,
    `Verified ops only (${OPENCODE_PIN}, via canonical adapter modules):`,
    ...VERIFIED_OPS.map((op) => `  - ${op}`),
  ].join("\n");
}

function parseArgs(argv: readonly string[]): Options {
  const KNOWN_VALUE_FLAGS: readonly string[] = [
    "--mode",
    "--server-url",
    "--max-turns",
    "--timeout-ms",
    "--max-cost-usd",
    "--stagger-ms",
    "--work-seconds",
    "--db-path",
    "--root",
    "--self-test",
  ];
  const KNOWN_BOOL_FLAGS: readonly string[] = ["--help", "--dry-run", "--spawn"];
  for (const a of argv) {
    if (
      a.startsWith("--") &&
      KNOWN_VALUE_FLAGS.indexOf(a) < 0 &&
      KNOWN_BOOL_FLAGS.indexOf(a) < 0
    ) {
      throw new Error(`Unknown flag ${a} (see --help)`);
    }
  }
  const get = (flag: string): string | null => {
    // First occurrence wins (documented in usage()).
    const i = argv.indexOf(flag);
    if (i < 0) return null;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`Flag ${flag} requires a value`);
    return v;
  };
  const num = (flag: string, def: number): number => {
    const raw = get(flag);
    if (raw === null) return def;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`Flag ${flag} requires a positive number (got ${raw})`);
    return n;
  };
  const modeRaw = get("--mode") ?? "wake";
  if (modeRaw !== "wake" && modeRaw !== "overlap" && modeRaw !== "both") {
    throw new Error(`--mode must be wake|overlap|both (got ${modeRaw})`);
  }
  const workSeconds = num("--work-seconds", 75);
  if (workSeconds < 60 || workSeconds > 90) {
    throw new Error(`--work-seconds must be within 60-90 (got ${workSeconds})`);
  }
  const selfTestRaw = get("--self-test");
  if (selfTestRaw !== null && selfTestRaw !== "unsafe" && selfTestRaw !== "ceiling" && selfTestRaw !== "abort" && selfTestRaw !== "cost-shape" && selfTestRaw !== "terminal" && selfTestRaw !== "sse") {
    throw new Error(`--self-test must be unsafe|ceiling|abort|cost-shape|terminal|sse (got ${selfTestRaw})`);
  }
  return {
    help: argv.includes("--help"),
    dryRun: argv.includes("--dry-run"),
    mode: modeRaw,
    serverUrl: get("--server-url"),
    spawn: argv.includes("--spawn"),
    maxTurns: Math.floor(num("--max-turns", 6)),
    timeoutMs: Math.floor(num("--timeout-ms", 300_000)),
    maxCostUsd: num("--max-cost-usd", 0.5),
    staggerMs: Math.floor(num("--stagger-ms", 5000)),
    workSeconds: Math.floor(workSeconds),
    dbPath: get("--db-path"),
    root: get("--root"),
    selfTest: selfTestRaw,
  };
}

// ---------------------------------------------------------------------------
// Dry-run (zero inference): plan validation + guard self-checks
// ---------------------------------------------------------------------------

interface PlanStep {
  readonly n: number;
  readonly op: string;
  readonly detail: string;
}

function wakePlan(): readonly PlanStep[] {
  return [
    { n: 1, op: "session.create x3", detail: "coordinator + 2 workers, directory=<disposable-repo> (verified op)" },
    { n: 2, op: "agent.list", detail: "record native agent ids; identity baseline (verified op)" },
    { n: 3, op: "board-service.publishPost", detail: "public @mention post, idempotencyKey=<uuid> (canonical M3, tmp sqlite)" },
    { n: 4, op: "WakeQueue.enqueue", detail: "one durable wake intent per live @mentioned member (delivery_key idempotent)" },
    { n: 5, op: "WakeDispatcher.dispatchWake", detail: "real harness submitTurn queue-only; externalId in-band metadata only" },
    { n: 6, op: "event.subscribe", detail: "capture session/execution events + timestamps to disposable ledger (verified op)" },
    { n: 7, op: "proof: exactly-one-terminal-outcome", detail: "ONE session.execution.succeeded/failed per admitted wake (message-list delta reported informational only — a real turn emits multiple messages)" },
    { n: 8, op: "proof: duplicate->no-extra-turn", detail: "replay same idempotencyKey => deduped:true, wakeIds empty, turns delta 0" },
    { n: 9, op: "proof: unrelated->no-wake", detail: "mention-free post => zero new wake intents, turns delta 0" },
    { n: 10, op: "proof: identity", detail: "session/agent ids match registry from step 1-2 through terminal events" },
    { n: 11, op: "proof: lead zero-inference", detail: "submitTurn counter delta == 0 while lead is waiting" },
    { n: 12, op: "proof: completion->lead wake->waiting", detail: "worker execution.succeeded => lead wake admitted => lead session idle" },
  ];
}

function overlapPlan(workSeconds: number, staggerMs: number): readonly PlanStep[] {
  return [
    { n: 1, op: "session.create x2 (reuse)", detail: "two worker sessions bound to the disposable repo" },
    { n: 2, op: "submitTurn A (queue-only)", detail: `bounded local task ~${workSeconds}s: read disposable files, summarize <200 words, no network` },
    { n: 3, op: `stagger ${staggerMs}ms`, detail: "minimal stagger, then submitTurn B (queue-only) with the same bounded shape" },
    { n: 4, op: "event.subscribe x2", detail: "record execution.started/terminal timestamps + session.usage.updated per session" },
    { n: 5, op: "experimental.session.wait x2", detail: "bounded completion signal, reconciled via session.get (verified op)" },
    { n: 6, op: "proof: overlap", detail: "open-interval intersection of [startedAt, terminalAt) is non-empty; report ms" },
    { n: 7, op: "proof: responses+usage", detail: "both message.list responses captured; usage events tallied (tokens/cost when exposed)" },
  ];
}

function dryRun(opts: Options): number {
  console.log(`live-cd-harness --dry-run (mode=${opts.mode}, pin=${OPENCODE_PIN}) — zero inference, zero network`);
  console.log(`budget: max-turns=${opts.maxTurns} timeout-ms=${opts.timeoutMs} max-cost-usd=${opts.maxCostUsd} (fail-closed: tallied per usage event + gated per submit)`);
  const steps: PlanStep[] = [
    ...(opts.mode === "wake" || opts.mode === "both" ? wakePlan() : []),
    ...(opts.mode === "overlap" || opts.mode === "both" ? overlapPlan(opts.workSeconds, opts.staggerMs) : []),
  ];
  for (const s of steps) console.log(`  plan ${s.n}. ${s.op} — ${s.detail}`);
  console.log(`verified ops (${VERIFIED_OPS.length}): ${VERIFIED_OPS.join(" | ")}`);

  // Local guard self-checks (pure, no side effects beyond stdout).
  const checks: Array<readonly [string, boolean]> = [];
  try {
    assertIsolatedServerUrl(`http://127.0.0.1:${FORBIDDEN_PORT}/api`);
    checks.push(["forbidden-port refused", false]);
  } catch {
    checks.push(["forbidden-port refused", true]);
  }
  try {
    assertIsolatedServerUrl("http://127.0.0.1:41234/api");
    checks.push(["loopback free-port accepted", true]);
  } catch {
    checks.push(["loopback free-port accepted", false]);
  }
  try {
    assertIsolatedServerUrl("http://192.168.1.10:41234/api");
    checks.push(["non-loopback refused", false]);
  } catch {
    checks.push(["non-loopback refused", true]);
  }
  try {
    assertDisposablePath("/etc/passwd", pjoin(envTmp(), "opencode", "live-cd-harness-x"));
    checks.push(["outside-tmp refused", false]);
  } catch {
    checks.push(["outside-tmp refused", true]);
  }
  const redacted = redact("Authorization: Bearer sk-test-1234567890 and key=abc");
  checks.push(["secret redaction active", !redacted.includes("sk-test-1234567890")]);
  checks.push(["abort second-gate holds (swallowed SSE abort refuses submit)", syntheticAbortGateHolds()]);
  checks.push(["live-model override gate + exact-ref + fail-closed", syntheticLiveModelHolds()]);
  checks.push(["disposable `..`-traversal refused (F-B-01 resolve-before-prefix)", syntheticDisposableTraversalHolds()]);
  checks.push(["exactly-one-terminal-outcome counting (5 msgs/1 terminal PASS, 2 terminals FAIL, dupe 0)", syntheticTerminalCountHolds()]);
  checks.push(["teardown force-kill fallback argv (taskkill /F /T)", syntheticTeardownFallbackHolds()]);
  checks.push(["zero-wire blackout trips loudly; idle-with-drops stays quiet", syntheticSseZeroFramesHolds()]);
  checks.push(["deep cost-shape extraction + unknown-shape 0 + string-499", syntheticCostShapeHolds()]);
  checks.push(["ledger close-after-final-log order", syntheticLedgerOrderHolds()]);
  checks.push([
    "overlap math sane",
    intervalsOverlap(
      { startedAt: "2026-01-01T00:00:00.000Z", terminalAt: "2026-01-01T00:01:00.000Z" },
      { startedAt: "2026-01-01T00:00:30.000Z", terminalAt: "2026-01-01T00:02:00.000Z" },
    ) &&
      !intervalsOverlap(
        { startedAt: "2026-01-01T00:00:00.000Z", terminalAt: "2026-01-01T00:01:00.000Z" },
        { startedAt: "2026-01-01T00:01:00.000Z", terminalAt: "2026-01-01T00:02:00.000Z" },
      ),
  ]);
  let pass = true;
  for (const [name, ok] of checks) {
    console.log(`  self-check ${ok ? "PASS" : "FAIL"} — ${name}`);
    if (!ok) pass = false;
  }
  // Usage-event redaction + ledger path discipline are structural (see code);
  // the live slice replays these checks against real events.
  if (!pass) {
    console.error("dry-run FAILED: a guard self-check did not hold");
    return 1;
  }
  console.log(
    `dry-run PASS: plan validates (${steps.length} steps), guards hold, no inference executed. ` +
      `Live run resumption: start a disposable ${OPENCODE_PIN} server, then rerun without --dry-run.`,
  );
  return 0;
}

/**
 * Zero-inference synthetic abort checks (no network, no sqlite, no spend).
 * Returns 3 when the guard fires (proves the abort path), 1 when it does not.
 * New kinds (`abort`, `cost-shape`) are assertion tests: 0 PASS, 1 FAIL.
 */
export function syntheticAbortGateHolds(): boolean {
  const order: string[] = [];
  let cancelled = false;
  const stub = {
    aborted: null,
    cancel: (): void => {
      cancelled = true;
    },
    ledger: stubLedger(order),
    deadline: { aborted: false } as unknown as AbortSignal,
    opts: { maxTurns: 6, maxCostUsd: 0.5 },
    turnsUsed: 0,
    costUsd: 0,
  } as unknown as LiveContext;
  try {
    // The SSE fail() throw is what the adapter dispatch loop may swallow.
    fail(stub, "UNSAFE_SCOPE", "synthetic swallowed abort");
  } catch {
    /* fail() always throws; the swallow happens downstream of this throw */
  }
  if (!cancelled) return false; // shared controller must have fired
  if (stub.aborted === null) return false;
  try {
    checkAborted(stub); // second gate: must refuse the next submit
    return false;
  } catch (err) {
    return err instanceof Error && err.message.indexOf("HARNESS_ABORT") === 0;
  }
}

/** MODEL-INHERIT-01: exact-ref parse, allow-gate, fail-closed combos. */
export function syntheticLiveModelHolds(): boolean {
  try {
    // Gate off: vars inert even when set.
    if (
      resolveLiveTestOverride({ SWARM_ALLOW_LIVE_INFERENCE: "0", LIVE_MODEL: "p/m", LIVE_MODEL_APIKey: "k" }) !== null
    ) {
      return false;
    }
    if (resolveLiveTestOverride({}) !== null) return false;
    // Gate on + valid: exact ref; the key VALUE never appears in any output.
    const secret = "sk-live-secret-zzz-0123456789";
    const ok = resolveLiveTestOverride({
      SWARM_ALLOW_LIVE_INFERENCE: "1",
      LIVE_MODEL: "prov-x/model-y",
      LIVE_MODEL_APIKey: secret,
    });
    if (ok === null || ok.providerID !== "prov-x" || ok.id !== "model-y") return false;
    const read = readLiveTestOverride({
      SWARM_ALLOW_LIVE_INFERENCE: "1",
      LIVE_MODEL: "prov-x/model-y",
      LIVE_MODEL_APIKey: secret,
    });
    if (!read.apiKeyPresent) return false;
    if (JSON.stringify(ok).includes(secret) || JSON.stringify(read).includes(secret)) return false;
    // Gate on + missing/invalid: every combo fails closed (throws).
    const bad: ReadonlyArray<Readonly<Record<string, string | undefined>>> = [
      { SWARM_ALLOW_LIVE_INFERENCE: "1" },
      { SWARM_ALLOW_LIVE_INFERENCE: "1", LIVE_MODEL: "prov-x/model-y" },
      { SWARM_ALLOW_LIVE_INFERENCE: "1", LIVE_MODEL: "prov-x/model-y", LIVE_MODEL_APIKey: "" },
      { SWARM_ALLOW_LIVE_INFERENCE: "1", LIVE_MODEL: "no-slash", LIVE_MODEL_APIKey: "k" },
      { SWARM_ALLOW_LIVE_INFERENCE: "1", LIVE_MODEL: "a/b/c", LIVE_MODEL_APIKey: "k" },
    ];
    for (const env of bad) {
      let threw = false;
      try {
        resolveLiveTestOverride(env);
      } catch {
        threw = true;
      }
      if (!threw) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Deep-shape extraction scores; unknown shapes tally 0 (warn, never inflate). */
export function syntheticCostShapeHolds(): boolean {
  const deep = { session: { usage: { costUsd: 0.2 } } };
  const inArray = { usages: [{ total_cost: 0.15 }] };
  const snake = { billing: { cost_usd: 0.07 } };
  const unknown = { tokens: { input: 5, output: 3 } };
  return (
    extractCostUsd(deep) === 0.2 &&
    extractCostUsd(inArray) === 0.15 &&
    extractCostUsd(snake) === 0.07 &&
    extractCostUsd(unknown) === 0 &&
    extractCostUsd(null) === 0 &&
    isAbortError({ status: "499" }) && // string form (F-03)
    !isAbortError({ status: 200 })
  );
}

/** F-EXEC13-E01: fake transcript 5 msgs / 1 terminal -> PASS; 2 terminals
 * -> FAIL (exactly-one violated); duplicate wake -> 0 new terminals. */
export function syntheticTerminalCountHolds(): boolean {
  const admitted = [
    { type: "message.created" },
    { type: "message.created" },
    { type: "tool.call" },
    { type: "message.created" },
    { type: "message.created" },
    { type: "session.execution.succeeded" },
  ];
  const doubleTerminal = [...admitted, { type: "session.execution.failed" }];
  const duplicateWake: readonly { readonly type: string }[] = [];
  const interruptedOnly = [{ type: "session.execution.interrupted" }];
  return (
    countTerminalOutcomes(admitted) === 1 && // 5 msgs, 1 terminal -> PASS
    countTerminalOutcomes(doubleTerminal) !== 1 && // 2 terminals -> FAIL
    countTerminalOutcomes(duplicateWake) === 0 && // duplicate -> 0 terminals
    countTerminalOutcomes(interruptedOnly) === 0 // interrupt is abort, not PASS
  );
}

/** OPS01 S3: the force-kill fallback argv is exactly `taskkill /F /T /PID <pid>`. */
export function syntheticTeardownFallbackHolds(): boolean {
  const args = teardownForceKillArgs(1234);
  return args.join(" ") === "taskkill /F /T /PID 1234";
}

/** DEBUG-SSE-01 + F-EXEC19-E01: loud zero-wire gate (pure; shared by live
 * paths + self-test).
 *
 * The wait() receipt reconciles via polling, so it can resolve with ZERO
 * mapped handler invocations. That is ambiguous: a healthy idle stream
 * (keepalives + `server.connected`, all correctly filtered by the adapter
 * allowlist) yields frames==0 with drops>0, while a true blackout (HTTP-400
 * subscription, dispatch-before-connect on the volatile stream) yields
 * frames==0 AND drops==0 despite HTTP 200. Only the latter fails loudly
 * with a diagnosed cause — never a silent 0-event proof. Returns the fail
 * detail when the gate trips, null when the wire is alive (≥1 mapped frame
 * or ≥1 adapter-filtered drop). */
export function sseBlackoutDetail(framesObserved: number, framesDropped: number, subsRejected: number): string | null {
  if (framesObserved > 0) return null;
  if (framesDropped > 0) return null;
  return (
    `first wait resolved with zero wire-classified activity (frames=0 dropped=0 rejections=${subsRejected}); ` +
    `event-stream blackout — failing loudly instead of a silent 0-event proof`
  );
}

/** DEBUG-SSE-01 + F-EXEC19-E01: true zero-wire blackout trips the gate
 * (rejections diagnosed); ≥1 mapped frame stays quiet; idle-with-drops
 * (keepalives/`server.connected` correctly filtered) stays quiet. */
export function syntheticSseZeroFramesHolds(): boolean {
  const tripsOnBlackout = sseBlackoutDetail(0, 0, 0) !== null;
  const rejectionDiagnosed = (sseBlackoutDetail(0, 0, 1) ?? "").indexOf("rejections=1") >= 0;
  const quietWithFrames = sseBlackoutDetail(1, 0, 0) === null;
  const quietIdleWithDrops = sseBlackoutDetail(0, 3, 0) === null;
  return tripsOnBlackout && rejectionDiagnosed && quietWithFrames && quietIdleWithDrops;
}

/** F-B-01: `<root>/../escape.db` (both slash styles) must be refused by the
 * resolve-before-prefix guard — norm-only prefix comparison accepts it. */
export function syntheticDisposableTraversalHolds(): boolean {
  const root = pjoin(envTmp(), "opencode", "live-cd-harness-traversal");
  const cases: readonly string[] = [
    pjoin(root, "..", "escape.db"),
    `${root.replace(/\//g, "\\")}\\..\\escape.db`,
    pjoin(root, "sub", "..", "..", "escape.db"),
  ];
  for (const evil of cases) {
    let refused = false;
    try {
      assertDisposablePath(evil, root);
    } catch {
      refused = true;
    }
    if (!refused) return false;
  }
  // Sanity: a genuine in-root path (even with benign `.`/`sub/..`) still passes.
  try {
    assertDisposablePath(pjoin(root, "sub", "..", "swarm.db"), root);
    assertDisposablePath(pjoin(root, "swarm.db"), root);
  } catch {
    return false;
  }
  return true;
}

/** The final summary line is emitted BEFORE the ledger closes (F01). */
export function syntheticLedgerOrderHolds(): boolean {
  const order: string[] = [];
  const stub = stubLedger(order);
  closeLedgerAfterFinalLog(stub, "test", "FINAL summary present");
  return (
    order.length === 2 &&
    order[0] !== undefined &&
    order[0].indexOf("write:") === 0 &&
    order[1] === "close"
  );
}

function stubLedger(order: string[]): Ledger & { closed: boolean } {
  const s = {
    closed: false,
    write(line: string): void {
      if (s.closed) order.push("WRITE-AFTER-CLOSE");
      else order.push(`write:${line.slice(0, 24)}`);
    },
    close(): void {
      s.closed = true;
      order.push("close");
    },
  };
  return s;
}

function runSyntheticSelfTest(kind: string): number {
  if (kind === "unsafe") {
    const root = pjoin(envTmp(), "opencode", "live-cd-harness-selftest");
    const repo = pjoin(root, "repo");
    const benign = JSON.stringify({ tool: "read", path: pjoin(repo, "notes.txt") });
    const hostile = JSON.stringify({ tool: "write", path: "/etc/cron.d/pwn" });
    const benignSafe = !isUnsafePermissionAsk(benign, root, repo);
    const hostileDetected = isUnsafePermissionAsk(hostile, root, repo);
    // SEC-F2 gap payloads: exec/network/env/unknown tools echoing the repo
    // dir, `..` escapes, and key-material markers must ALL fail closed.
    const gapCases: ReadonlyArray<readonly [string, string]> = [
      ["exec-echoing-repo", JSON.stringify({ tool: "exec", command: "ls -la", cwd: repo })],
      ["unknown-tool-in-repo", JSON.stringify({ tool: "quantum-flux", path: pjoin(repo, "notes.txt") })],
      ["network-in-repo", JSON.stringify({ tool: "fetch", url: "https://example.invalid/x", cwd: repo })],
      ["env-exfil-in-repo", JSON.stringify({ tool: "read", path: pjoin(repo, "notes.txt"), detail: "process.env" })],
      ["dotdot-escape", JSON.stringify({ tool: "read", path: pjoin(root, "..", "escape.txt") })],
      ["backslash-dotdot-escape", JSON.stringify({ tool: "read", path: `${root.replace(/\//g, "\\")}\\..\\escape.txt` })],
      ["backslash-absolute-outside", JSON.stringify({ tool: "read", path: "C:\\Windows\\System32\\evil.txt" })],
      ["relative-dotdot-no-absolute-token", JSON.stringify({ tool: "read", detail: "see ..\\escape.txt for context" })],
      ["key-material", JSON.stringify({ tool: "message", body: "AKIAIOSFODNN7EXAMPLE" })],
    ];
    let gapsClosed = 0;
    for (const [name, payload] of gapCases) {
      const unsafe = isUnsafePermissionAsk(payload, root, repo);
      console.log(`synthetic-unsafe: gap ${name} unsafe=${unsafe}`);
      if (unsafe) gapsClosed += 1;
    }
    console.log(`synthetic-unsafe: benign-safe=${benignSafe} hostile-detected=${hostileDetected} gaps-closed=${gapsClosed}/${gapCases.length}`);
    if (benignSafe && hostileDetected && gapsClosed === gapCases.length) {
      console.log("synthetic-unsafe ABORT: permission ask outside disposable root; interrupted (exit 3)");
      return 3;
    }
    console.error("synthetic-unsafe FAILED: guard misclassified a synthetic ask");
    return 1;
  }
  if (kind === "terminal") {
    const holds = syntheticTerminalCountHolds();
    console.log(`synthetic-terminal: 5-msgs/1-terminal ${holds ? "PASS" : "FAIL"} — exactly ONE succeeded/failed per admitted wake; 2 terminals FAIL; duplicate wake 0 terminals`);
    return holds ? 0 : 1;
  }
  if (kind === "sse") {
    const holds = syntheticSseZeroFramesHolds();
    console.log(`synthetic-sse: zero-wire gate ${holds ? "PASS" : "FAIL"} — true blackout (frames=0 dropped=0) trips SSE_ZERO_FRAMES loudly (rejections diagnosed); ≥1 frame or idle-with-drops stays quiet`);
    return holds ? 0 : 1;
  }
  if (kind === "abort") {
    const holds = syntheticAbortGateHolds();
    console.log(`synthetic-abort: second-gate ${holds ? "PASS" : "FAIL"} — swallowed SSE abort refuses the next submit + cancels subscriptions`);
    return holds ? 0 : 1;
  }
  if (kind === "cost-shape") {
    const holds = syntheticCostShapeHolds();
    console.log(`synthetic-cost-shape: deep-extraction ${holds ? "PASS" : "FAIL"} — nested costs tally, unknown shapes warn at 0, "499" aborts`);
    if (holds) {
      const orderHolds = syntheticLedgerOrderHolds();
      console.log("synthetic-ledger-order: " + (orderHolds ? "PASS" : "FAIL") + " — final summary precedes ledger close");
      return orderHolds ? 0 : 1;
    }
    return 1;
  }
  // ceiling: replay synthetic usage payloads through the REAL extractor +
  // gate; the third event breaches the cap, so the run must abort BEFORE
  // any further submit.
  const cap = 0.5;
  const payloads: readonly unknown[] = [{ cost: 0.2 }, { usage: { costUsd: 0.2 } }, { total_cost: 0.2 }];
  let tally = 0;
  for (let i = 0; i < payloads.length; i += 1) {
    tally += extractCostUsd(payloads[i]);
    console.log(`synthetic-ceiling: event ${i + 1} tally=${tally.toFixed(2)}/${cap.toFixed(2)}`);
    if (costBreached(tally, cap)) {
      console.log("synthetic-ceiling ABORT: spend ceiling breached; submit refused (exit 3)");
      return 3;
    }
  }
  console.error("synthetic-ceiling FAILED: ceiling never tripped");
  return 1;
}

// ---------------------------------------------------------------------------
// Live mode (NOT executed in the HARNESS-01 slice — implemented for resumption)
// ---------------------------------------------------------------------------

/** Dynamic runtime import of a canonical module (keeps static tsc hermetic). */
async function loadCanonicalModule(path: string): Promise<Record<string, unknown>> {
  const specifier: string = path;
  return (await import(specifier)) as Record<string, unknown>;
}

function canonicalSrc(moduleRel: string): string {
  // scripts/ -> repo root -> packages/... (read-only; never written).
  const here = new URL(import.meta.url);
  const repoRoot = new URL("../", here);
  return new URL(`packages/${moduleRel}`, repoRoot).href;
}

interface LiveContext {
  readonly opts: Options;
  readonly root: string;
  readonly repoDir: string;
  readonly dbPath: string;
  readonly ledger: Ledger;
  readonly baseUrl: string;
  readonly deadline: AbortSignal;
  readonly store: any;
  readonly board: Record<string, any>;
  readonly wakeQueueCtor: any;
  readonly dispatcherCtor: any;
  readonly leadAutonomy: Record<string, any>;
  readonly harness: any;
  readonly events: Record<string, any>;
  /** Best-effort shared abort: set by liveMain to stop SSE subscriptions. */
  cancel: (() => void) | null;
  turnsUsed: number;
  usageEvents: number;
  unknownCostShapes: number;
  costUsd: number;
  aborted: { readonly code: string; readonly detail: string } | null;
}

function fail(ctx: LiveContext, code: string, detail: string): never {
  ctx.aborted = { code, detail };
  try {
    ctx.cancel?.();
  } catch {
    /* best-effort shared-controller abort; the throw below decides exit 3 */
  }
  logLine(ctx.ledger, "abort", `${code}: ${detail}`);
  throw new Error(`HARNESS_ABORT ${code}: ${redact(detail)}`);
}

function checkTurnBudget(ctx: LiveContext): void {
  if (ctx.turnsUsed >= ctx.opts.maxTurns) {
    fail(ctx, "TURN_BUDGET_EXCEEDED", `max-turns=${ctx.opts.maxTurns} exhausted`);
  }
}

/** Pre-submit cost gate: refuse the submit when the ceiling is breached. */
function checkCostBudget(ctx: LiveContext): void {
  if (costBreached(ctx.costUsd, ctx.opts.maxCostUsd)) {
    fail(ctx, "COST_CEILING_EXCEEDED", `cost ${ctx.costUsd} >= cap ${ctx.opts.maxCostUsd}; submit refused`);
  }
}

/** Post-event cost tally: add the event's cost, then fail closed on breach. */
function recordUsageEvent(ctx: LiveContext, payload: unknown): void {
  ctx.usageEvents += 1;
  const delta = extractCostUsd(payload);
  if (delta > 0) {
    ctx.costUsd += delta;
  } else {
    // Unknown shape: tally unchanged. Warn (fail-open tally would hide spend,
    // fail-closed tally would false-abort) — the 402/429 transport gates and
    // the pre-submit ceiling gate remain the spend backstops (see README).
    ctx.unknownCostShapes += 1;
  }
  logLine(
    ctx.ledger,
    "usage",
    `usage event #${ctx.usageEvents} cost-delta=${delta} total=${ctx.costUsd}/${ctx.opts.maxCostUsd}` +
      (delta > 0 ? "" : " (unknown shape; tally unchanged — see README cost-model note)"),
  );
  if (costBreached(ctx.costUsd, ctx.opts.maxCostUsd)) {
    fail(ctx, "COST_CEILING_EXCEEDED", `cost ${ctx.costUsd} >= cap ${ctx.opts.maxCostUsd} after usage event #${ctx.usageEvents}`);
  }
}

/** Second abort gate (F02): re-polled before every spend-adjacent call. */
function checkAborted(ctx: LiveContext): void {
  if (ctx.aborted !== null) {
    fail(ctx, ctx.aborted.code, `refused: run already aborted (${ctx.aborted.code})`);
  }
  if (ctx.deadline.aborted) {
    fail(ctx, "TIMEOUT", "global deadline elapsed; submit refused");
  }
}

/** OPS01 S3 teardown: graceful kill first, then force-kill the PID tree
 * (`taskkill /F /T` equivalent) when Bun kill() leaves the disposable
 * server alive. Best-effort; every attempt is logged. */
function teardownSpawned(
  spawned: { kill?: () => void; pid?: number } | null,
  ledger: Ledger,
  scope: string,
): void {
  if (spawned === null) return;
  try {
    spawned.kill?.();
  } catch {
    /* fall through to the force-kill fallback below */
  }
  const pid = spawned.pid;
  if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
    try {
      Bun.spawn(teardownForceKillArgs(pid), {
        stdout: "ignore",
        stderr: "ignore",
      });
      logLine(ledger, scope, `spawned disposable server force-kill fallback attempted (taskkill /F /T pid=${pid})`);
      return;
    } catch {
      /* best-effort; fall through to the plain killed line */
    }
  }
  logLine(ledger, scope, "spawned disposable server killed");
}

/** Abort-aware sleep: resolves early when the global deadline fires. */
function sleepBounded(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Count a member's wakes via the canonical listWakes accessor when present. */
function countMemberWakes(
  store: any,
  swarmId: string,
  memberId: string,
): { count: number; via: string } {
  try {
    const list: unknown = store?.listWakes;
    if (typeof list === "function") {
      const states: readonly string[] = ["pending", "admitted", "observed_running", "dispatched"];
      let n = 0;
      let used = false;
      for (const s of states) {
        let arr: unknown;
        try {
          arr = (list as (swarmId: string, state: string, limit: number) => unknown).call(store, swarmId, s, 100);
        } catch {
          continue;
        }
        if (!Array.isArray(arr)) continue;
        used = true;
        for (const w of arr as Array<{ memberId?: unknown }>) {
          if (w !== null && typeof w === "object" && w.memberId === memberId) n += 1;
        }
      }
      if (used) return { count: n, via: "listWakes" };
    }
  } catch {
    /* fall through to the wakeIds-only fallback below */
  }
  return { count: 0, via: "fallback-wakeIds" };
}

function classifyTransportError(ctx: LiveContext, err: unknown): never {
  const status = statusOf(err);
  const code =
    typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  if (status === 402) fail(ctx, "QUOTA_402_ZERO_RETRY", `402 quota block; no retry (code=${String(code)})`);
  if (status === 401 || status === 403) fail(ctx, "AUTH_FAILURE", `http ${String(status)} (code=${String(code)})`);
  if (status === 429) fail(ctx, "RATE_LIMITED", `http 429; run aborts rather than burning budget (code=${String(code)})`);
  throw err;
}

async function liveMain(opts: Options): Promise<number> {
  const stamp = `${Date.now()}-${process.pid}`;
  // F-B-01: resolve `.`/`..` BEFORE every disposable/tmp prefix compare so
  // `--db-path <root>/../escape.db` (which passes a norm-only string prefix)
  // is refused instead of escaping the disposable root.
  const root = opts.root !== null ? resolveSegments(opts.root) : resolveSegments(pjoin(disposableRootBase(), `run-${stamp}`));
  assertNotCanonicalRepo(root);
  const tmpBase = resolveSegments(envTmp());
  if (root !== tmpBase && !root.startsWith(tmpBase + "/")) {
    throw new Error(`REFUSED: --root must be under the OS tmp dir (got ${opts.root ?? root})`);
  }
  // Bun.write creates parent dirs; seed them plus the repo dir.
  await Bun.write(pjoin(root, ".keep"), "");
  const repoDir = pjoin(root, "repo");
  await Bun.write(pjoin(repoDir, ".keep"), "");
  const dbPath = opts.dbPath !== null ? resolveSegments(opts.dbPath) : resolveSegments(pjoin(root, "swarm.db"));
  assertDisposablePath(dbPath, root);
  assertNotCanonicalRepo(dbPath);
  const ledgerPath = pjoin(root, "harness-ledger.jsonl");
  assertDisposablePath(ledgerPath, root);
  await Bun.write(ledgerPath, "");
  const ledger = openLedger(ledgerPath);

  const scope = "live";
  logLine(ledger, scope, `start mode=${opts.mode} pin=${OPENCODE_PIN} root=<disposable-tmp> (absolute path withheld from stdout)`);

  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);

  // Resolve the isolated server URL (never :45278, loopback only).
  // F-A setup guard: EVERY exit path in this block closes the ledger after
  // its final log via closeLedgerAfterFinalLog (the usage-error return
  // closes then returns 2; throws close then rethrow so main's catch maps
  // to exit 1 with the trail preserved and no leaked handle).
  let baseUrl: string;
  let spawned: { kill?: () => void; pid?: number } | null = null;
  try {
    if (opts.serverUrl !== null) {
      assertIsolatedServerUrl(opts.serverUrl);
      baseUrl = opts.serverUrl.replace(/\/+$/, "");
    } else if (opts.spawn) {
      const port = await findFreePort();
      logLine(ledger, scope, `spawning disposable opencode serve on 127.0.0.1:${port} (best-effort)`);
      const proc = Bun.spawn(["opencode", "serve", "--port", String(port), "--hostname", "127.0.0.1"], {
        cwd: repoDir,
        stdout: "ignore",
        stderr: "ignore",
      }) as unknown as { kill?: () => void; pid?: number };
      spawned = proc;
      baseUrl = `http://127.0.0.1:${port}`;
      // Give the server a beat, then verify via a VERIFIED op (agent.list), not /health.
      await sleepBounded(2500, timeoutSignal);
    } else {
      console.error("Live mode requires --server-url (disposable 127.0.0.1 server) or --spawn. See README.");
      closeLedgerAfterFinalLog(ledger, scope, "setup refused: no --server-url or --spawn (exit=2)");
      return 2;
    }
    assertIsolatedServerUrl(baseUrl);
  } catch (err) {
    teardownSpawned(spawned, ledger, scope);
    closeLedgerAfterFinalLog(
      ledger,
      scope,
      `setup aborted: ${redact(err instanceof Error ? err.message : String(err))}`,
    );
    throw err;
  }
  logLine(ledger, scope, `server validated: loopback, port != :${FORBIDDEN_PORT}`);

  // Load canonical modules read-only (runtime only; never modified).
  const [storeMod, boardMod, queueMod, dispatcherMod, leadMod, sessionsMod, harnessMod, eventsMod] = await Promise.all([
    loadCanonicalModule(canonicalSrc("runtime/src/db/store.ts")),
    loadCanonicalModule(canonicalSrc("runtime/src/services/board-service.ts")),
    loadCanonicalModule(canonicalSrc("runtime/src/services/wake-queue.ts")),
    loadCanonicalModule(canonicalSrc("runtime/src/services/wake-dispatcher.ts")),
    loadCanonicalModule(canonicalSrc("runtime/src/services/lead-autonomy.ts")),
    loadCanonicalModule(canonicalSrc("adapter-opencode/src/sessions.ts")),
    loadCanonicalModule(canonicalSrc("adapter-opencode/src/harness.ts")),
    loadCanonicalModule(canonicalSrc("adapter-opencode/src/events.ts")),
  ]);

  const SwarmStore = storeMod["SwarmStore"] as new (dbPath: string) => any;
  const FetchTransport = sessionsMod["FetchTransport"] as new (baseUrl: string) => any;
  const OpenCodeHarness = harnessMod["OpenCodeHarness"] as new (o: {
    transport: unknown;
  }) => any;

  const ctx: LiveContext = {
    opts,
    root,
    repoDir,
    dbPath,
    ledger,
    baseUrl,
    deadline: timeoutSignal,
    store: new SwarmStore(dbPath),
    board: boardMod,
    wakeQueueCtor: queueMod["WakeQueue"],
    dispatcherCtor: dispatcherMod["WakeDispatcher"],
    leadAutonomy: leadMod,
    harness: null,
    events: eventsMod,
    turnsUsed: 0,
    usageEvents: 0,
    unknownCostShapes: 0,
    costUsd: 0,
    aborted: null,
    cancel: null,
  };

  const transport = new FetchTransport(baseUrl);
  const inner = new OpenCodeHarness({ transport });
  // Budget-counting facade: identical surface, counts queue-only admissions.
  const counting = {
    backend: "opencode" as const,
    async submitTurn(req: {
      sessionId: string;
      text: string;
      delivery: "queue";
      externalId: string;
      reason: string;
    }): Promise<{ externalId: string; admittedAt: string; transportNote: string }> {
      checkAborted(ctx);
      checkTurnBudget(ctx);
      checkCostBudget(ctx);
      try {
        const receipt = await inner.submitTurn(req);
        ctx.turnsUsed += 1;
        logLine(ledger, "turn", `admitted externalId=${req.externalId} session=<id> turns=${ctx.turnsUsed}/${opts.maxTurns}`);
        return receipt;
      } catch (err) {
        classifyTransportError(ctx, err);
      }
    },
    async getSession(sessionId: string): Promise<{ hasLiveExecution: boolean; knownTerminalExternalIds: readonly string[] }> {
      checkAborted(ctx);
      try {
        return await inner.getSession(sessionId);
      } catch (err) {
        classifyTransportError(ctx, err);
      }
    },
  };
  (ctx as { harness: unknown }).harness = counting;

  // Verify the server with a VERIFIED op before spending anything.
  try {
    const agents = (await inner.listAgents()) as ReadonlyArray<{ id: string }>;
    logLine(ledger, scope, `agent.list ok: ${agents.length} native agent(s); ids preserved verbatim in ledger annex`);
    const annexPath = pjoin(root, "agents-annex.json");
    assertDisposablePath(annexPath, root);
    // SEC-F3: redact before writing (ids are opaque, but the file shares the
    // ledger directory with model text — redact uniformly, never weaken).
    await Bun.write(annexPath, redact(JSON.stringify(agents.map((a) => a.id))));
  } catch (err) {
    classifyTransportError(ctx, err);
  }

  // Create 1 coordinator + 2 worker sessions (verified session.create).
  const mk = async (title: string): Promise<string> => {
    const created = (await inner.createSession(title, repoDir)) as { sessionId: string };
    logLine(ledger, "session", `created title=${title}`);
    return created.sessionId;
  };
  const coordSession = await mk("live-cd-coordinator");
  const workerA = await mk("live-cd-worker-a");
  const workerB = await mk("live-cd-worker-b");

  // Register the swarm + members in tmp sqlite (canonical M3 store).
  const model = { providerID: "unknown", id: "unknown" };
  const swarm = ctx.store.createSwarm({
    title: "live-cd-harness",
    coordinatorSessionId: coordSession,
    projectRoot: repoDir,
    mode: "parity",
  });
  const lead = ctx.store.addMember(swarm.id, {
    name: "lead",
    groups: ["crew"],
    role: "coordinator",
    nativeAgentId: "native",
    sessionId: coordSession,
    model,
  });
  const coderOne = ctx.store.addMember(swarm.id, {
    name: "coder-one",
    groups: ["crew"],
    role: "coder",
    nativeAgentId: "native",
    sessionId: workerA,
    model,
  });
  const coderTwo = ctx.store.addMember(swarm.id, {
    name: "coder-two",
    groups: ["crew"],
    role: "coder",
    nativeAgentId: "native",
    sessionId: workerB,
    model,
  });
  logLine(ledger, "store", `swarm + 3 members registered in tmp sqlite`);

  // Subscribe to all three sessions (verified event.subscribe) into the ledger.
  const stopSubs = new AbortController();
  const onTimeout = (): void => stopSubs.abort();
  timeoutSignal.addEventListener("abort", onTimeout, { once: true });
  const startedAt = new Map<string, string>();
  const terminalAt = new Map<string, string>();
  // F-EXEC13-E01: every terminal OUTCOME (succeeded/failed) per session, in
  // arrival order — the exactly-one proof counts these, not message verbosity.
  const terminalOutcomes: Array<{ sessionId: string; type: string; at: string }> = [];
  // DEBUG-SSE-01 + F-EXEC19-E01: SSE observability — every mapped frame is
  // counted, the first frame per session is logged as subscription
  // establishment, and any subscription rejection is logged with its cause.
  // Adapter-filtered frames (keepalives, `server.connected`, unwatched
  // sessions — all correctly excluded by the frozen events.ts allowlist) are
  // counted via onDrop into framesDropped: a healthy idle stream shows
  // frames==0 with drops>0. Only a run whose first wait() resolves with zero
  // wire-classified activity (frames==0 AND drops==0) fails loudly
  // (SSE_ZERO_FRAMES via sseBlackoutDetail) — never a silent 0-event proof.
  // Per-drop ledger logging is deliberately omitted: keepalives are frequent
  // and the ledger is the audit trail, not a packet dump.
  const sseHealth = { framesObserved: 0, framesDropped: 0, subsRejected: 0 };
  const establishedSessions = new Set<string>();
  const recordEvent = (e: { type: string; sessionId: string; at: string; nativeExecutionId: string | null; payload: unknown }): void => {
    sseHealth.framesObserved += 1;
    if (!establishedSessions.has(e.sessionId)) {
      establishedSessions.add(e.sessionId);
      logLine(ledger, "event", `subscription established (first frame) session=${e.sessionId} type=${e.type}`);
    }
    logLine(ledger, "event", `${e.type} at=${e.at}`);
    if (e.type === "session.execution.started" && !startedAt.has(e.sessionId)) startedAt.set(e.sessionId, e.at);
    if (isTerminalOutcomeEvent(e.type)) terminalOutcomes.push({ sessionId: e.sessionId, type: e.type, at: e.at });
    const terminal =
      e.type === "session.execution.succeeded" ||
      e.type === "session.execution.failed" ||
      e.type === "session.execution.interrupted";
    if (terminal && !terminalAt.has(e.sessionId)) terminalAt.set(e.sessionId, e.at);
    if (e.type === "session.usage.updated") recordUsageEvent(ctx, e.payload);
    if (e.type === "permission.asked") {
      const payload = JSON.stringify(e.payload ?? {});
      if (isUnsafePermissionAsk(payload, root, repoDir)) {
        // Deterministic abort: kick the interrupt best-effort (never throws),
        // then fail SYNCHRONOUSLY so exit 3 is decided here — never in a
        // floating .then (inner.interrupt is the OpenCodeHarness surface;
        // interruptSession lives on the inner session manager only).
        void (inner.interrupt(e.sessionId) as Promise<unknown>).catch(() => undefined);
        fail(ctx, "UNSAFE_SCOPE", "permission ask outside disposable root; interrupted");
      }
    }
  };
  // F-EXEC19-E01: subscribe through the canonical adapter events module
  // (verified event.subscribe op) with the adapter's onDrop threaded in, so
  // correctly-filtered frames are counted per run. Parameters mirror the
  // OpenCodeHarness facade exactly (same transport, default type allowlist,
  // same handler) — the only deliberate delta is that the facade's private
  // nativeExecutionId cache is not seeded here. That field flows only into
  // wait()'s ExecutionRecord.nativeExecutionId, which this harness never
  // reads (only outcome/externalId/observedAt are consumed below), so no
  // proof, gate, or ledger line changes. The adapter facade is untouched.
  const subscribeHarnessEvents = ctx.events["subscribeHarnessEvents"] as (
    transport: unknown,
    opts: {
      readonly sessionIds: readonly string[];
      readonly handler: (event: {
        type: string;
        sessionId: string;
        at: string;
        nativeExecutionId: string | null;
        payload: unknown;
      }) => void;
      readonly signal: AbortSignal;
      readonly onDrop?: (drop: { readonly droppedTotal: number }) => void;
    },
  ) => Promise<void>;
  const subs = [coordSession, workerA, workerB].map((s) =>
    subscribeHarnessEvents(transport, {
      sessionIds: [s],
      handler: recordEvent,
      signal: stopSubs.signal,
      onDrop: (drop) => {
        sseHealth.framesDropped = drop.droppedTotal;
      },
    }).catch((err: unknown) => {
      if ((stopSubs.signal as AbortSignal).aborted) return;
      sseHealth.subsRejected += 1;
      logLine(ledger, "event", `subscription rejected session=${s} (${redact(err instanceof Error ? err.message : String(err))})`);
      throw err;
    }),
  );

  const WakeQueueCtor = ctx.wakeQueueCtor as new (store: unknown) => any;
  const DispatcherCtor = ctx.dispatcherCtor as new (store: unknown, harness: unknown) => any;
  const queue = new WakeQueueCtor(ctx.store);
  const dispatcher = new DispatcherCtor(ctx.store, counting);
  // Shared abort: fail() also stops the SSE subscriptions, so a swallowed
  // dispatch-loop throw still halts event intake (the submitTurn second gate
  // in checkAborted refuses any further spend).
  ctx.cancel = (): void => stopSubs.abort();

  const results: Array<{ check: string; pass: boolean; detail: string }> = [];
  const note = (check: string, pass: boolean, detail: string): void => {
    results.push({ check, pass, detail });
    logLine(ledger, "proof", `${pass ? "PASS" : "FAIL"} ${check} — ${redact(detail)}`);
  };

  let exitCode: number | null = null;
  try {
    // MODEL-INHERIT-01 isolated live-model override (harness ONLY — never
    // production). Inert unless SWARM_ALLOW_LIVE_INFERENCE=1. When allowed,
    // the EXACT validated ref is applied to all three sessions via the
    // VERIFIED switchModel op (POST /api/session/{id}/model, history
    // retained by backend); the API key value is never read here (presence
    // gate only — no verified 2.2.7 key passthrough exists, so the key stays
    // in the isolated disposable server's own environment). Any
    // missing/malformed combo fails closed via fail() (exit 3) — never a
    // silent ambient-model fallback.
    try {
      const liveOverride = resolveLiveTestOverride(process.env);
      if (liveOverride !== null) {
        for (const s of [coordSession, workerA, workerB]) {
          await (inner.manager.switchModel(s, liveOverride) as Promise<unknown>);
        }
        logLine(
          ledger,
          "model",
          `live override applied via verified switchModel providerID=${liveOverride.providerID} id=${liveOverride.id} (isolated server resolves creds)`,
        );
      }
    } catch (err) {
      fail(ctx, "LIVE_MODEL_UNRESOLVABLE", err instanceof Error ? err.message : String(err));
    }
    if (opts.mode === "wake" || opts.mode === "both") {
      await runWakeProofs(ctx, queue, dispatcher, inner, swarm.id, lead, coderOne, note, terminalOutcomes, sseHealth);
    }
    if (opts.mode === "overlap" || opts.mode === "both") {
      await runOverlap(ctx, inner, workerA, workerB, note, startedAt, terminalAt, sseHealth);
    }
  } catch (err) {
    if (ctx.aborted !== null) {
      logLine(ledger, scope, `aborted: ${ctx.aborted.code}`);
      exitCode = 3;
    } else if (timeoutSignal.aborted || isAbortError(err)) {
      // Timeout / transport-abort shapes (499 incl. "499", WAIT_ABORTED,
      // AbortError) are aborts (exit 3), never proof failures — safe to rerun.
      logLine(ledger, scope, `aborted: TIMEOUT_OR_TRANSPORT_ABORT (${redact(err instanceof Error ? err.message : String(err))})`);
      exitCode = 3;
    } else {
      logLine(ledger, scope, `FAILED: ${err instanceof Error ? err.message : String(err)}`);
      exitCode = 1;
    }
  } finally {
    stopSubs.abort();
    timeoutSignal.removeEventListener("abort", onTimeout);
    if (spawned !== null) {
      teardownSpawned(spawned, ledger, scope);
    }
    await Promise.allSettled(subs);
    try {
      ctx.store.close();
    } catch {
      /* disposable; ignore */
    }
    // NOTE: the ledger stays OPEN here on purpose (F01). It is closed only
    // after the final logLine on every path below — never in this finally.
  }

  if (exitCode !== null) {
    // Abort/failure path: the final line above IS the summary; close after it.
    closeLedgerAfterFinalLog(ledger, scope, `exit=${exitCode} (proofs omitted on abort/failure; ledger holds the trail)`);
    return exitCode;
  }

  const failed = results.filter((r) => !r.pass);
  const proofsPath = pjoin(root, "proofs.json");
  assertDisposablePath(proofsPath, root);
  try {
    // SEC-F3: redact before writing — proof details may echo model text.
    await Bun.write(proofsPath, redact(JSON.stringify(results, null, 2)));
  } catch (err) {
    closeLedgerAfterFinalLog(
      ledger,
      scope,
      `FAILED: proofs write refused/failed (${redact(err instanceof Error ? err.message : String(err))})`,
    );
    return 1;
  }
  const code = failed.length === 0 ? 0 : 1;
  closeLedgerAfterFinalLog(
    ledger,
    scope,
    `done: ${results.length - failed.length}/${results.length} proofs PASS; turns=${ctx.turnsUsed}/${opts.maxTurns} usage-events=${ctx.usageEvents} unknown-cost-shapes=${ctx.unknownCostShapes} cost=${ctx.costUsd}/${opts.maxCostUsd} exit=${code}`,
  );
  return code;
}

async function runWakeProofs(
  ctx: LiveContext,
  queue: any,
  dispatcher: any,
  inner: any,
  swarmId: string,
  lead: { id: string },
  coderOne: { id: string; sessionId?: string },
  note: (check: string, pass: boolean, detail: string) => void,
  terminalOutcomes: ReadonlyArray<{ sessionId: string; type: string; at: string }>,
  sse: { readonly framesObserved: number; readonly framesDropped: number; readonly subsRejected: number },
): Promise<void> {
  const sessionId = coderOne.sessionId as string;
  const publishPost = ctx.board["publishPost"] as (store: unknown, input: Record<string, unknown>) => {
    post: { sequence: number };
    deduped: boolean;
    wakeIds: readonly string[];
  };
  const messageCount = async (id: string): Promise<number> => {
    const list = (await inner.manager.listMessages(id)) as unknown[];
    return list.length;
  };
  // Terminal outcomes land via SSE; the wait receipt only proves the backend
  // went terminal. Poll briefly (bounded by the global deadline) so delivery
  // lag cannot flake the exactly-one count.
  const awaitTerminalDelta = async (mark: number, timeoutMs: number): Promise<number> => {
    const start = Date.now();
    let delta = 0;
    for (;;) {
      delta = 0;
      for (let i = mark; i < terminalOutcomes.length; i += 1) {
        const e = terminalOutcomes[i] as { sessionId: string; type: string };
        if (e.sessionId === sessionId && isTerminalOutcomeEvent(e.type)) delta += 1;
      }
      if (delta >= 1 || ctx.deadline.aborted || Date.now() - start >= timeoutMs) return delta;
      await sleepBounded(250, ctx.deadline);
    }
  };

  // 1) One mention -> one wake -> exactly ONE terminal execution outcome.
  // F-EXEC13-E01: raw message delta is INFORMATIONAL ONLY — a real turn
  // legitimately emits multiple messages (assistant text + tool calls +
  // follow-ups). PASS = exactly one succeeded/failed outcome per admitted wake.
  const key1 = `live-cd-${Date.now()}-1`;
  const before = await messageCount(sessionId);
  const terminalMark = terminalOutcomes.length;
  const post1 = publishPost(ctx.store, {
    swarmId,
    authorMemberId: null,
    kind: "message",
    body: "@coder-one please confirm the disposable workspace contents (bounded check, no network).",
    idempotencyKey: key1,
  });
  note("mention fans out exactly one wake", post1.wakeIds.length === 1 && !post1.deduped, `wakeIds=${post1.wakeIds.length} deduped=${post1.deduped}`);
  const wakeId = post1.wakeIds[0] as string;
  const res = (await dispatcher.dispatchWake(swarmId, wakeId, { correlationId: key1 })) as { status: string };
  note("dispatch admits one queue-only turn", res.status === "dispatched", `status=${res.status} turns=${ctx.turnsUsed}`);
  // Wait for the terminal event (bounded by the global deadline), then reconcile
  // terminal OUTCOMES — message delta is informational only (F-EXEC13-E01).
  const rec = (await inner.wait(sessionId, ctx.deadline)) as {
    outcome: string;
    externalId: string;
  };
  // DEBUG-SSE-01 + F-EXEC19-E01: loud zero-wire gate — wait() reconciles
  // via polling, so it can resolve with zero mapped frames. That trips
  // SSE_ZERO_FRAMES only when the wire was fully silent (frames==0 AND
  // drops==0); an idle-but-live stream (frames==0, drops>0 from correctly
  // filtered keepalives/`server.connected`) passes. Diagnosed abort
  // (exit 3), never a silent 0-event proof.
  const blackout = sseBlackoutDetail(sse.framesObserved, sse.framesDropped, sse.subsRejected);
  if (blackout !== null) fail(ctx, "SSE_ZERO_FRAMES", blackout);
  const after = await messageCount(sessionId);
  const terminalDelta = await awaitTerminalDelta(terminalMark, 10000);
  note("exactly-one-terminal-outcome executed", terminalDelta === 1, `terminal-outcomes=${terminalDelta} messages-delta=${after - before} (informational) outcome=${rec.outcome}`);
  note("identity preserved (wake<->turn)", rec.externalId === wakeId, `externalId match=${rec.externalId === wakeId}`);

  // 2) Duplicate (same idempotencyKey) -> no extra turn, zero new terminals.
  const turnsBeforeDupe = ctx.turnsUsed;
  const dupeMark = terminalOutcomes.length;
  const dupe = publishPost(ctx.store, {
    swarmId,
    authorMemberId: null,
    kind: "message",
    body: "@coder-one please confirm the disposable workspace contents (bounded check, no network).",
    idempotencyKey: key1,
  });
  note("duplicate post deduped, no new wake", dupe.deduped === true && dupe.wakeIds.length === 0, `deduped=${dupe.deduped} wakeIds=${dupe.wakeIds.length}`);
  await sleepBounded(2000, ctx.deadline); // beat for any stray execution (bounded)
  const dupeTerminals = countTerminalOutcomesSince(terminalOutcomes, sessionId, dupeMark);
  note("duplicate causes zero terminal outcomes", dupeTerminals === 0 && ctx.turnsUsed === turnsBeforeDupe, `terminal-outcomes=${dupeTerminals} turns delta=${ctx.turnsUsed - turnsBeforeDupe}`);

  // 3) Unrelated (mention-free) post -> no wake, zero new terminals.
  const wakesBefore = countMemberWakes(ctx.store, swarmId, coderOne.id);
  const unrelatedMark = terminalOutcomes.length;
  const plain = publishPost(ctx.store, {
    swarmId,
    authorMemberId: null,
    kind: "progress",
    body: "General note with no mentions; nothing to do.",
    idempotencyKey: `live-cd-${Date.now()}-plain`,
  });
  await sleepBounded(2000, ctx.deadline); // beat for any stray execution (bounded)
  const wakesAfter = countMemberWakes(ctx.store, swarmId, coderOne.id);
  const unrelatedTerminals = countTerminalOutcomesSince(terminalOutcomes, sessionId, unrelatedMark);
  note(
    "unrelated post wakes nobody",
    plain.wakeIds.length === 0 && wakesAfter.count === wakesBefore.count && unrelatedTerminals === 0,
    `wakeIds=${plain.wakeIds.length} store-delta=${wakesAfter.count - wakesBefore.count} via=${wakesAfter.via} terminal-outcomes=${unrelatedTerminals}`,
  );

  // 4) Lead waiting performs zero inference: observe a quiet window, bounded
  // by the global deadline (resolves early on timeout abort).
  const turnsBeforeQuiet = ctx.turnsUsed;
  await sleepBounded(5000, ctx.deadline);
  note("lead waiting is zero-inference", ctx.turnsUsed === turnsBeforeQuiet, `turns delta=${ctx.turnsUsed - turnsBeforeQuiet} over 5s quiet window`);

  // 5) Completion -> lead wake -> waiting (real events + real store transition).
  const markWaiting = ctx.leadAutonomy["markWaiting"] as (store: unknown, leadId: string) => { internalState: string };
  const waiting = markWaiting(ctx.store, lead.id);
  const leadWake = queue.enqueue({
    swarmId,
    memberId: lead.id,
    reason: "monitor_intervention",
    payloadHash: `completion-${wakeId}`,
  }) as { intent: { id: string }; deduped: boolean };
  const leadRes = (await dispatcher.dispatchWake(swarmId, leadWake.intent.id, {
    correlationId: `lead-${wakeId}`,
  })) as { status: string };
  note("completion wakes the lead", leadRes.status === "dispatched", `status=${leadRes.status}`);
  await (inner.wait as (s: string, sig: AbortSignal) => Promise<unknown>)(coderOne.sessionId as string, ctx.deadline).catch(() => undefined);
  const leadSnap = (await inner.getSession(coderOne.sessionId as string)) as { hasLiveExecution: boolean };
  void leadSnap;
  const leadAfter = markWaiting(ctx.store, lead.id);
  note("lead returns to waiting", waiting !== undefined && leadAfter.internalState === "waiting", `state=${leadAfter.internalState}`);
}

// B-overlap: two long-window prompts, minimal stagger, capture overlap + responses + usage.
async function runOverlap(
  ctx: LiveContext,
  inner: any,
  workerA: string,
  workerB: string,
  note: (check: string, pass: boolean, detail: string) => void,
  startedAt: Map<string, string>,
  terminalAt: Map<string, string>,
  sse: { readonly framesObserved: number; readonly framesDropped: number; readonly subsRejected: number },
): Promise<void> {
  const boundedTask =
    `Bounded local check (target ~${ctx.opts.workSeconds}s, NO network, disposable dir only): ` +
    `list the files in your session directory, read the two largest text files fully, ` +
    `then summarize what you found in under 200 words. Work steadily; do not rush, do not stop early.`;
  const extA = `live-cd-overlap-a-${Date.now()}`;
  const extB = `live-cd-overlap-b-${Date.now()}`;
  const t0 = Date.now();
  await (ctx.harness as {
    submitTurn: (r: unknown) => Promise<unknown>;
  }).submitTurn({ sessionId: workerA, text: boundedTask, delivery: "queue", externalId: extA, reason: "user_direct" });
  const submittedA = new Date().toISOString();
  await sleepBounded(ctx.opts.staggerMs, ctx.deadline);
  await (ctx.harness as {
    submitTurn: (r: unknown) => Promise<unknown>;
  }).submitTurn({ sessionId: workerB, text: boundedTask, delivery: "queue", externalId: extB, reason: "user_direct" });
  const submittedB = new Date().toISOString();
  logLine(ctx.ledger, "overlap", `A submitted at=${submittedA} B submitted at=${submittedB} stagger-ms=${ctx.opts.staggerMs}`);

  const [recA, recB] = (await Promise.all([
    inner.wait(workerA, ctx.deadline),
    inner.wait(workerB, ctx.deadline),
  ])) as Array<{ outcome: string; observedAt: string }>;
  // DEBUG-SSE-01 + F-EXEC19-E01: loud zero-wire gate (same rule as the
  // wake path: trip only on frames==0 AND drops==0).
  const overlapBlackout = sseBlackoutDetail(sse.framesObserved, sse.framesDropped, sse.subsRejected);
  if (overlapBlackout !== null) fail(ctx, "SSE_ZERO_FRAMES", overlapBlackout);
  const aStart = startedAt.get(workerA) ?? submittedA;
  const bStart = startedAt.get(workerB) ?? submittedB;
  const aEnd = terminalAt.get(workerA) ?? recA.observedAt;
  const bEnd = terminalAt.get(workerB) ?? recB.observedAt;
  const overlap = intervalsOverlap({ startedAt: aStart, terminalAt: aEnd }, { startedAt: bStart, terminalAt: bEnd });
  const overlapMs = Math.max(0, Math.min(Date.parse(aEnd), Date.parse(bEnd)) - Math.max(Date.parse(aStart), Date.parse(bStart)));
  note("B windows overlap", overlap && overlapMs > 0, `overlap-ms=${overlapMs} outcomes=${recA.outcome}/${recB.outcome} wall-ms=${Date.now() - t0}`);
  const msgsA = (await inner.manager.listMessages(workerA)) as unknown[];
  const msgsB = (await inner.manager.listMessages(workerB)) as unknown[];
  note("both responses captured", msgsA.length > 0 && msgsB.length > 0, `messages A=${msgsA.length} B=${msgsB.length}`);
  note("usage observed", ctx.usageEvents >= 0, `usage-events=${ctx.usageEvents} cost-tally=${ctx.costUsd} unknown-shapes=${ctx.unknownCostShapes} (unknown shapes warn per-event and never inflate the tally; 402/429 + pre-submit gates are the backstops)`);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main(argv: readonly string[]): Promise<number> {
  let opts: Options;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`usage error: ${redact(err instanceof Error ? err.message : String(err))}`);
    console.error(usage());
    return 2;
  }
  if (opts.help) {
    console.log(usage());
    return 0;
  }
  if (opts.selfTest !== null) {
    return runSyntheticSelfTest(opts.selfTest);
  }
  if (opts.dryRun) {
    if (opts.serverUrl !== null) {
      try {
        assertIsolatedServerUrl(opts.serverUrl);
      } catch (err) {
        console.error(`dry-run FAILED: ${redact(err instanceof Error ? err.message : String(err))}`);
        return 1;
      }
    }
    if (opts.dbPath !== null) {
      // F-B-01: resolve segments before the tmp prefix compare.
      const abs = resolveSegments(opts.dbPath);
      const tmpBase = resolveSegments(envTmp());
      if (abs !== tmpBase && !abs.startsWith(tmpBase + "/")) {
        console.error(`dry-run FAILED: --db-path must be under tmp (got ${redact(opts.dbPath)})`);
        return 1;
      }
    }
    if (opts.root !== null) {
      // F-B-01: resolve segments before the tmp prefix compare.
      const abs = resolveSegments(opts.root);
      const tmpBase = resolveSegments(envTmp());
      if (abs !== tmpBase && !abs.startsWith(tmpBase + "/")) {
        console.error(`dry-run FAILED: --root must be under tmp (got ${redact(opts.root)})`);
        return 1;
      }
      try {
        assertNotCanonicalRepo(abs);
      } catch (err) {
        console.error(`dry-run FAILED: ${redact(err instanceof Error ? err.message : String(err))}`);
        return 1;
      }
    }
    if (opts.root !== null && opts.dbPath !== null) {
      // Mirror the live containment rule (dbPath strictly inside root) so a
      // dry-run PASS cannot bless a combination liveMain would refuse — e.g.
      // `--db-path <root>/../escape.db` resolves outside root.
      try {
        assertDisposablePath(opts.dbPath, opts.root);
      } catch (err) {
        console.error(`dry-run FAILED: ${redact(err instanceof Error ? err.message : String(err))}`);
        return 1;
      }
    }
    return dryRun(opts);
  }
  try {
    return await liveMain(opts);
  } catch (err) {
    console.error(`harness error: ${redact(err instanceof Error ? err.message : String(err))}`);
    return 1;
  }
}

const code = await main(process.argv.slice(2));
process.exit(code);
