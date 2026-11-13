/**
 * M5-02 provider rate limiter + quota/auth blocking gate (spec §14 M5 + §8.4 + §13).
 *
 * Provider pressure must never spend inference speculatively:
 * - Per-model/provider concurrency semaphore + bounded FIFO pending queues
 *   (backpressure: overflow rejects the newcomer, never drops committed work).
 * - 429 (rate limited) → bounded exponential backoff with full jitter +
 *   retry budget, then terminal exhaustion (no unbounded storm).
 *   Digit-guarded status matching (M8-01): bare-substring checks would
 *   confuse `14029`/`4021` with real 429/402 codes — every numeric-code
 *   match is anchored on non-digit boundaries.
 * - Timeout handling (M8-01): a configured per-attempt deadline
 *   (`timeoutMs`) turns a hung transport into a bounded transient failure
 *   (same retry budget, never unbounded); unset means no deadline.
 * - 402 (quota exhausted) → quota-paused, zero retries. Attempts frozen,
 *   eligible-list exclusion is the store's `quota_paused` member state, and
 *   resume happens only on documented triggers (new post / model switch /
 *   user input) — never on elapsed time.
 * - 401/403 (auth) → blocked (permission/approval surface, never
 *   auto-approved), zero retries.
 * - Throttle queues admit work WITHOUT calling the transport: queued items
 *   spend zero inference (proven by FakeHarness submit counters).
 *
 * Trust boundaries (credentials): this module carries `{ providerID, id }`
 * refs only (rate-limit keys). It never holds, copies, logs, or persists
 * provider API keys. Logs record counts/ids/statuses only — never prompts,
 * bodies, or secrets.
 *
 * Reuse (import-only, never modified here): M2 store backoff shape
 * (`base * 2^attempts` + full jitter) and MODEL-INHERIT-01 classifiers
 * (`isQuotaStatus` / `isAuthBlockedStatus` / `resolutionRetryPolicy`).
 * This file owns no DB schema; the usage ledger lives in
 * `usage-ledger.ts`. `store.ts` / `wake-dispatcher.ts` are never edited here.
 */

import { isAuthBlockedStatus, isQuotaStatus } from "./model-resolver.js";

/** Canonical per-model/provider concurrency key: refs only, never secrets. */
export function rateLimitKeyFor(providerID: string, modelId: string): string {
  return `${providerID}/${modelId}`;
}

/** Transport outcome classes. 402 is quota (never transient); 401/403 is
 *  auth-blocked (never auto-approved, never retried); 429 is rate-limited
 *  (bounded retries only). */
export type ProviderOutcomeClass =
  | "quota"
  | "auth-blocked"
  | "rate-limited"
  | "transient"
  | "permanent";

/** Classify a transport status/code into its M5 outcome class. Unknown and
 *  5xx/timeout shapes are transient (M2 bounded-backoff domain); any other
 *  4xx is permanent (fail closed). String statuses match on digit-guarded
 *  tokens (M8-01): `14029` or `error 4021` must NOT classify as 429/402.
 *  Numeric/string agreement (M8-01-FIX-01 F-M8-04): `408`/`502`/`503`/`504`
 *  are transient whether they arrive as numbers or as digit-guarded string
 *  tokens (`"503"`, `"HTTP 503 Service Unavailable"`); any other 4xx string
 *  is permanent, 5xx strings are transient. */
export function classifyProviderStatus(status: unknown): ProviderOutcomeClass {
  if (isQuotaStatus(status)) return "quota";
  if (isAuthBlockedStatus(status)) return "auth-blocked";
  if (status === 429 || status === "429") return "rate-limited";
  if (typeof status === "number") {
    if (status === 408 || status === 502 || status === 503 || status === 504) return "transient";
    if (status >= 400 && status < 500) return "permanent";
    if (status >= 500) return "transient";
    return "permanent";
  }
  if (typeof status === "string") {
    if (QUOTA_STATUS_TOKEN.test(status)) return "quota";
    if (AUTH_STATUS_TOKEN.test(status)) return "auth-blocked";
    if (RATE_STATUS_TOKEN.test(status)) return "rate-limited";
    if (TRANSIENT_STATUS_TOKEN.test(status)) return "transient";
    if (/ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|FETCH_TIMEOUT|TIMEOUT|ABORT/i.test(status)) {
      return "transient";
    }
    return "permanent";
  }
  return "transient";
}

/** Extract a classifiable status from a thrown transport error (same shape
 *  the M2 dispatcher inspects: `.status` / `.code` / message).
 *
 *  Status-less auth shapes MUST NOT fall through to transient: a missing
 *  `.status` with an auth-bearing `.code` (`UNAUTHENTICATED`,
 *  `PERMISSION_DENIED`, …) or an auth-bearing message (`401 Unauthorized`,
 *  `403 Forbidden`, …) is `auth-blocked` (exactly one attempt, zero
 *  retries). The auth regex runs on code+message BEFORE the transient
 *  fallback, so status-less auth can never be retried ×3 as transient. */
const AUTH_CODE_PATTERN =
  /UNAUTHENTICATED|PERMISSION_DENIED|UNAUTHORIZED|FORBIDDEN|ACCESS[_-\s]?DENIED|INVALID[_-\s]?API[_-\s]?KEY|TOKEN[_-\s]?EXPIRED|AUTH[_-\s]?FAILED|INVALID[_-\s]?TOKEN/i;
/**
 * M8-01 digit-guarded numeric tokens: the code/message must carry the code
 * as a standalone number, never as a digit-run substring. `14029` is not
 * 429, `error 4021` is not 402, `x401b` IS 401 (letter boundaries count).
 */
const AUTH_STATUS_TOKEN = /(^|[^0-9])(401|403)([^0-9]|$)/;
const QUOTA_STATUS_TOKEN = /(^|[^0-9])402([^0-9]|$)/;
const RATE_STATUS_TOKEN = /(^|[^0-9])429([^0-9]|$)/;
/**
 * M8-01-FIX-01 (F-M8-04) digit-guarded transient tokens: `408`/`502`/`503`/
 * `504` arrive as strings from some transports (`"503"`, `"HTTP 503 …"`).
 * They are transient exactly like their numeric twins — but only as
 * standalone numbers, never as digit-run substrings (`"error 5021"` is
 * permanent, not transient).
 */
const TRANSIENT_STATUS_TOKEN = /(^|[^0-9])(408|502|503|504)([^0-9]|$)/;

export function classifyTransportError(err: unknown): ProviderOutcomeClass {
  if (typeof err === "object" && err !== null) {
    const rec = err as { status?: unknown; code?: unknown; message?: unknown };
    // M8-01-FIX-01 (F-M8-02): only a REAL status (number|string) routes by
    // status. A null (or otherwise non-status) `.status` with an auth-bearing
    // `.code`/message (e.g. `{status: null, code: "UNAUTHENTICATED"}`) must
    // fall through to the code+message auth checks below — never land on
    // `transient` with a full retry budget.
    if (typeof rec.status === "number" || typeof rec.status === "string") {
      return classifyProviderStatus(rec.status);
    }
    const code = typeof rec.code === "string" ? rec.code : "";
    if (/quota/i.test(code) || QUOTA_STATUS_TOKEN.test(code)) return "quota";
    if (code === "401" || code === "403") return "auth-blocked";
    if (AUTH_CODE_PATTERN.test(code) || AUTH_STATUS_TOKEN.test(code)) return "auth-blocked";
    if (code === "429" || RATE_STATUS_TOKEN.test(code) || /rate.?limit|too.?many.?requests/i.test(code)) {
      return "rate-limited";
    }
    const message = typeof rec.message === "string" ? rec.message : "";
    if (/quota/i.test(message) || QUOTA_STATUS_TOKEN.test(message)) return "quota";
    if (AUTH_CODE_PATTERN.test(message) || AUTH_STATUS_TOKEN.test(message)) return "auth-blocked";
    if (RATE_STATUS_TOKEN.test(message) || /rate.?limit|too.?many.?requests/i.test(message)) {
      return "rate-limited";
    }
  }
  return "transient";
}

/**
 * Bounded exponential backoff with full jitter for 429/transient retries
 * only: delay = rand * min(cap, base * 2^attempt). Same shape as the M2
 * store helper (import-only reuse of the policy, local pure arithmetic so
 * this module stays dependency-light). Quota/auth paths never call this.
 */
export function computeRateLimitBackoffMs(
  attempt: number,
  baseMs: number,
  capMs: number,
  rand: () => number,
): number {
  const n = Math.max(0, Math.floor(attempt));
  // S3 hardening: NaN / negative / non-finite inputs fail closed to zero
  // delay (bounded, never NaN) instead of poisoning the retry loop.
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 0;
  const cap = Number.isFinite(capMs) && capMs > 0 ? capMs : 0;
  const exp = Math.min(cap, base * 2 ** Math.min(n, 20));
  const r = rand();
  const jitter = r >= 0 && r <= 1 ? r : 0.5;
  return Math.floor(jitter * exp);
}

export interface RateLimiterPolicy {
  readonly maxConcurrentPerKey?: number;
  readonly maxQueuedPerKey?: number;
  readonly backoffBaseMs?: number;
  readonly backoffCapMs?: number;
  /** Retry budget for 429/transient ONLY (quota/auth never retry). */
  readonly maxAttempts?: number;
  /**
   * M8-01 per-attempt transport deadline in ms. When set (> 0, finite), a
   * hung transport is failed as a bounded transient timeout (same retry
   * budget, never unbounded); when unset, attempts have no deadline.
   */
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

export type AdmissionVerdict = "admitted" | "queued" | "rejected-overflow";

/** Thrown (never returned) when `execute` arrives under full backpressure:
 *  every slot is held AND the unified pending line
 *  (`execute` waiters + queued admit ids) already holds `maxQueuedPerKey`
 *  entries. The newcomer is refused; admitted/queued work is never dropped. */
export class RateLimitOverflowError extends Error {
  readonly code = "RATE_LIMIT_OVERFLOW" as const;
  constructor(readonly key: string) {
    super(`Rate limiter queue overflow for key ${key}: newcomer rejected under backpressure`);
  }
}

export interface ThrottledResult<T> {
  readonly status: "ok" | "rate-limited-terminal" | "transient-terminal" | "quota-paused" | "auth-blocked" | "permanent";
  readonly value?: T;
  /** Transport attempts actually performed (quota/auth always exactly 1). */
  readonly attempts: number;
  /** Backoff delays waited between 429/transient retries (spacing evidence). */
  readonly delaysMs: readonly number[];
}

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_QUEUED = 64;
const DEFAULT_BACKOFF_BASE_MS = 100;
const DEFAULT_BACKOFF_CAP_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Per-key concurrency semaphore + bounded FIFO pending queue.
 *
 * `execute` admits work only when a slot is free; otherwise the caller waits
 * in a local FIFO WITHOUT invoking the transport (zero inference spend
 * while queued). Overflow beyond `maxQueuedPerKey` rejects the newcomer —
 * admitted/queued work is never dropped.
 *
 * Unified admission: `execute` waiters and `admit` ids share ONE semaphore
 * and ONE bound — `waiters + queued ids <= maxQueuedPerKey`. Neither line
 * can starve the other's backpressure accounting: `enqueue` counts live
 * `execute` waiters, and `waitForSlot` counts queued admit ids, before
 * accepting a newcomer.
 *
 * Mixed-path fairness: `release` wakes the longest-waiting `execute`
 * waiter; queued admit ids advance only via `admitNext`. When both paths
 * feed one key, drain queued ids with `admitNext` after each release so
 * neither line starves the other.
 */
export class RateLimiter {
  private readonly maxConcurrentPerKey: number;
  private readonly maxQueuedPerKey: number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  private readonly inflightByKey = new Map<string, number>();
  private readonly queuesByKey = new Map<string, string[]>();
  private readonly queuedIdsByKey = new Map<string, Set<string>>();
  private readonly waitersByKey = new Map<string, Array<() => void>>();
  private readonly maxObservedByKey = new Map<string, number>();
  private admissions = 0;

  constructor(policy?: RateLimiterPolicy) {
    this.maxConcurrentPerKey = Math.max(1, Math.floor(policy?.maxConcurrentPerKey ?? DEFAULT_MAX_CONCURRENT));
    this.maxQueuedPerKey = Math.max(0, Math.floor(policy?.maxQueuedPerKey ?? DEFAULT_MAX_QUEUED));
    this.backoffBaseMs = policy?.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffCapMs = policy?.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
    this.maxAttempts = Math.max(1, Math.floor(policy?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
    const timeoutRaw = policy?.timeoutMs;
    this.timeoutMs =
      timeoutRaw !== undefined && Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : undefined;
    this.sleep = policy?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = policy?.random ?? Math.random;
  }

  /** Current live transports for a key (never exceeds the cap). */
  inflight(key: string): number {
    return this.inflightByKey.get(key) ?? 0;
  }

  /** Pending FIFO depth for a key (bounded). */
  queued(key: string): number {
    return this.queuesByKey.get(key)?.length ?? 0;
  }

  /** Peak concurrency observed for a key (test/evidence hook). */
  maxObserved(key: string): number {
    return this.maxObservedByKey.get(key) ?? 0;
  }

  /** Total admitted transports across all keys. */
  getAdmissions(): number {
    return this.admissions;
  }

  /** Retry budget (429/transient only; quota/auth never consume it). */
  getMaxAttempts(): number {
    return this.maxAttempts;
  }

  tryAcquire(key: string): boolean {
    const current = this.inflightByKey.get(key) ?? 0;
    if (current >= this.maxConcurrentPerKey) return false;
    this.inflightByKey.set(key, current + 1);
    this.admissions += 1;
    const peak = this.maxObservedByKey.get(key) ?? 0;
    if (current + 1 > peak) this.maxObservedByKey.set(key, current + 1);
    return true;
  }

  release(key: string): void {
    const current = this.inflightByKey.get(key) ?? 0;
    if (current > 0) this.inflightByKey.set(key, current - 1);
    this.pump(key);
  }

  /** Wake the longest-waiting local waiter when a slot frees (FIFO). */
  private pump(key: string): void {
    const waiters = this.waitersByKey.get(key);
    if (waiters === undefined || waiters.length === 0) return;
    const current = this.inflightByKey.get(key) ?? 0;
    if (current >= this.maxConcurrentPerKey) return;
    const next = waiters.shift();
    if (next !== undefined) next();
  }

  /**
   * Admission gate: admit immediately when a slot is free, else join the
   * bounded FIFO. `rejected-overflow` refuses the newcomer under
   * backpressure — committed (admitted/queued) work is never dropped.
   * Re-admitting an already-queued id is idempotent (`queued`, never
   * `rejected-overflow`): a duplicate is not backpressure.
   */
  admit(key: string, id: string): AdmissionVerdict {
    // Idempotent re-admit BEFORE slot acquisition: a duplicate must return
    // `queued` even when a slot is free, otherwise the queued entry becomes
    // a ghost (admitted + still queued) and drains twice via admitNext.
    if (this.queuedIdsByKey.get(key)?.has(id)) return "queued";
    if (this.tryAcquire(key)) return "admitted";
    return this.enqueue(key, id) === "rejected-overflow" ? "rejected-overflow" : "queued";
  }

  enqueue(key: string, id: string): "queued" | "duplicate" | "rejected-overflow" {
    let set = this.queuedIdsByKey.get(key);
    if (set?.has(id)) return "duplicate";
    const queue = this.queuesByKey.get(key) ?? [];
    // Unified bound: queued ids + live execute waiters share maxQueuedPerKey.
    const waiters = this.waitersByKey.get(key)?.length ?? 0;
    if (queue.length + waiters >= this.maxQueuedPerKey) return "rejected-overflow";
    queue.push(id);
    this.queuesByKey.set(key, queue);
    if (set === undefined) {
      set = new Set();
      this.queuedIdsByKey.set(key, set);
    }
    set.add(id);
    return "queued";
  }

  /** Pop the longest-waiting queued id (FIFO) without spending inference.
   *
   *  Prefer `admitNext`: this pop does NOT hold a slot, so a manual
   *  `dequeueNext` + `tryAcquire` pair is TOCTOU — another claimant may take
   *  the freed slot between the two calls, stranding the id while an
   *  `execute` waiter advances (or vice versa). Retained for queue
   *  inspection/drain; admission must go through `admitNext`. */
  dequeueNext(key: string): string | null {
    const queue = this.queuesByKey.get(key);
    if (queue === undefined || queue.length === 0) return null;
    const next = queue.shift() as string;
    this.queuedIdsByKey.get(key)?.delete(next);
    return next;
  }

  /**
   * Atomically dequeue the longest-waiting queued id AND acquire its slot.
   * Returns the id with the slot held, or null when the queue is empty or
   * no slot is free (queue untouched — no dequeue without admission, no
   * stranded ids, no starvation side-effect). Synchronous, so the
   * dequeue+acquire pair cannot interleave with a competing claimant.
   */
  admitNext(key: string): string | null {
    const queue = this.queuesByKey.get(key);
    if (queue === undefined || queue.length === 0) return null;
    if (!this.tryAcquire(key)) return null;
    const next = queue.shift() as string;
    this.queuedIdsByKey.get(key)?.delete(next);
    return next;
  }

  /**
   * Wait for a free slot in the bounded waiter FIFO. When every slot is
   * held AND the unified pending line (waiters + queued admit ids) is full,
   * rejects with `RateLimitOverflowError` instead of queueing unboundedly.
   * The check+enqueue runs synchronously (no await between), so two
   * racing newcomers cannot both slip past the bound.
   */
  private waitForSlot(key: string): Promise<void> {
    if (this.tryAcquire(key)) return Promise.resolve();
    const waiters = this.waitersByKey.get(key);
    const waiterCount = waiters?.length ?? 0;
    const queuedCount = this.queuesByKey.get(key)?.length ?? 0;
    if (waiterCount + queuedCount >= this.maxQueuedPerKey) {
      return Promise.reject(new RateLimitOverflowError(key));
    }
    return new Promise<void>((resolve) => {
      const line: Array<() => void> = this.waitersByKey.get(key) ?? [];
      this.waitersByKey.set(key, line);
      const wake = (): void => {
        if (this.tryAcquire(key)) {
          resolve();
        } else {
          // Lost a race (defensive: pump gates on capacity, so this is
          // near-unreachable): requeue at the FRONT, preserving FIFO
          // place without growing the line, then keep pumping.
          line.unshift(wake);
          this.pump(key);
        }
      };
      line.push(wake);
      this.pump(key);
    });
  }

  /**
   * Run one transport attempt under the configured deadline (when any).
   * A deadline breach rejects with a NATIVELY transient shape
   * (`code: "ETIMEDOUT"`, timeout-bearing message, no status/auth/quota
   * markers) so classification can only ever yield bounded transient
   * retries — a hung transport can never masquerade as quota/auth, and a
   * NaN/negative/omitted timeout disables the deadline (fail open to the
   * legacy no-deadline behavior, retries still bounded by maxAttempts).
   *
   * M8-01-FIX-01 (F-M8-05) reject-not-cancel: the deadline REJECTS the
   * race — it does NOT cancel the underlying transport (no AbortController
   * is wired, the hung promise is left to settle on its own and its late
   * settlement is ignored after `finally` clears the timer). The slot stays
   * held across backoff, so an uncooperative transport can never widen into
   * extra concurrency while its replacement retries.
   */
  private runAttempt<T>(fn: () => Promise<T>): Promise<T> {
    if (this.timeoutMs === undefined) return fn();
    const deadlineMs = this.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          Object.assign(new Error(`transport deadline exceeded after ${deadlineMs}ms (TIMEOUT, no inference)`), {
            code: "ETIMEDOUT",
          }),
        );
      }, deadlineMs);
    });
    return Promise.race([fn(), deadline]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  /**
   * Run `fn` under the per-key semaphore with M5 failure discipline:
   * - 429/transient → bounded exp-backoff retries (budget `maxAttempts`
   *   total attempts), then terminal — no unbounded storm. Transport
   *   timeouts (deadline breach or timeout-shaped errors) are transient
   *   members of this budget.
   * - 402 quota → `quota-paused`, exactly one transport attempt, zero retry.
   * - 401/403 auth → `auth-blocked`, exactly one attempt, zero retry
   *   (never auto-approved). Status-less auth shapes (auth-bearing code or
   *   message, no `.status`) are caught by the code+message auth regex
   *   before the transient fallback, so they also cost exactly one attempt.
   * - Unified backpressure: when slots are held AND the pending line is
   *   full, the newcomer is refused with `RateLimitOverflowError` (never
   *   queued unboundedly, never silently dropped after admission).
   * The transport is invoked only while holding a slot: queued waiters
   * spend zero inference.
   *
   * Slot-held-across-backoff: the slot acquired in `waitForSlot` is held
   * for the WHOLE attempt loop, including 429/transient backoff sleeps.
   * A backing-off transport still counts against the concurrency cap — it
   * cannot churn the slot to admit extra work, so retries can never widen
   * into a storm. Release happens exactly once, in `finally`.
   */
  async execute<T>(key: string, fn: () => Promise<T>): Promise<ThrottledResult<T>> {
    await this.waitForSlot(key);
    const delaysMs: number[] = [];
    let attempts = 0;
    try {
      for (;;) {
        attempts += 1;
        try {
          const value = await this.runAttempt(fn);
          return { status: "ok", value, attempts, delaysMs };
        } catch (err) {
          const outcome = classifyTransportError(err);
          if (outcome === "quota") return { status: "quota-paused", attempts, delaysMs };
          if (outcome === "auth-blocked") return { status: "auth-blocked", attempts, delaysMs };
          if (outcome === "permanent") return { status: "permanent", attempts, delaysMs };
          if (attempts >= this.maxAttempts) {
            return {
              status: outcome === "rate-limited" ? "rate-limited-terminal" : "transient-terminal",
              attempts,
              delaysMs,
            };
          }
          const delay = computeRateLimitBackoffMs(attempts, this.backoffBaseMs, this.backoffCapMs, this.random);
          delaysMs.push(delay);
          await this.sleep(delay);
        }
      }
    } finally {
      this.release(key);
    }
  }
}

/**
 * Documented resume triggers that may lift a quota pause. Elapsed time is
 * deliberately absent: there is NO auto-retry, NO polling, and NO
 * `resumeIfElapsed` — a pause lifts only when one of these triggers fires.
 */
export const QUOTA_RESUME_TRIGGERS = ["new-post", "model-switch", "user-input"] as const;
export type QuotaResumeTrigger = (typeof QUOTA_RESUME_TRIGGERS)[number];

/**
 * Auth blocks resume ONLY on an explicit credential/approval trigger —
 * never on traffic, model switches, or elapsed time. Split from the quota
 * triggers by design: quota resumes on new work arriving, auth resumes when
 * a human (approval surface) or operator (credential rotation) clears the
 * underlying credential problem.
 */
export const AUTH_RESUME_TRIGGERS = ["approval-granted", "credential-rotated"] as const;
export type AuthResumeTrigger = (typeof AUTH_RESUME_TRIGGERS)[number];

export type BlockKind = "quota-paused" | "auth-blocked";

export interface BlockRecord {
  readonly memberId: string;
  readonly kind: BlockKind;
  /** Redacted reason code only (e.g. "402", "401") — never bodies/secrets. */
  readonly reasonCode: string;
  readonly atIso: string;
  /** Zero retries were performed after this block (invariant). */
  readonly followUpSubmits: 0;
}

/**
 * Zero-retry block registry: quota/auth failures freeze attempts with no
 * follow-up submits. Time passing never unblocks (no `resumeIfElapsed`
 * exists by design); only an explicit documented trigger resumes — quota
 * triggers for `quota-paused`, approval/credential triggers for
 * `auth-blocked` (split so traffic can never clear an auth block).
 */
export class BlockRegistry {
  private readonly blocks = new Map<string, BlockRecord>();

  markBlocked(memberId: string, kind: BlockKind, reasonCode: string, atIso: string): BlockRecord {
    checkReasonCode(kind, reasonCode);
    const record: BlockRecord = { memberId, kind, reasonCode, atIso, followUpSubmits: 0 };
    this.blocks.set(memberId, record);
    return record;
  }

  markQuotaPaused(memberId: string, reasonCode: string, atIso: string): BlockRecord {
    return this.markBlocked(memberId, "quota-paused", reasonCode, atIso);
  }

  markAuthBlocked(memberId: string, reasonCode: string, atIso: string): BlockRecord {
    return this.markBlocked(memberId, "auth-blocked", reasonCode, atIso);
  }

  isBlocked(memberId: string): boolean {
    return this.blocks.has(memberId);
  }

  get(memberId: string): BlockRecord | null {
    return this.blocks.get(memberId) ?? null;
  }

  blockedCount(): number {
    return this.blocks.size;
  }

  /**
   * Resume ONLY on a documented trigger for the block's own kind:
   * `QUOTA_RESUME_TRIGGERS` for `quota-paused`, `AUTH_RESUME_TRIGGERS` for
   * `auth-blocked`. Returns true when a block was lifted, false when the
   * member was not blocked (trigger still validated — fail closed).
   * Unknown triggers throw (fail closed).
   */
  resume(memberId: string, trigger: QuotaResumeTrigger | AuthResumeTrigger): boolean {
    const record = this.blocks.get(memberId);
    if (record === undefined) {
      // Unblocked: still fail closed on unknown triggers, no state change.
      const known: readonly string[] = [...QUOTA_RESUME_TRIGGERS, ...AUTH_RESUME_TRIGGERS];
      if (!known.includes(trigger)) {
        throw new Error(`Unknown resume trigger rejected: ${String(trigger)}`);
      }
      return false;
    }
    const allowed: readonly string[] =
      record.kind === "quota-paused" ? QUOTA_RESUME_TRIGGERS : AUTH_RESUME_TRIGGERS;
    if (!allowed.includes(trigger)) {
      throw new Error(`Unknown resume trigger rejected for ${record.kind} member: ${String(trigger)}`);
    }
    return this.blocks.delete(memberId);
  }
}

/**
 * Reason-code allowlist: blocks carry redacted outcome codes only
 * (`402`, `401`, `QUOTA_EXHAUSTED`, …) — never bodies, prompts, or
 * credentials. Values outside the code shape, or values carrying
 * secret-looking prefixes (Slack `xox*` tokens, AWS `ASIA`/`AKIA` keys,
 * GitHub `ghp_`/`gho_`/`gh_sk` tokens, `sk-` keys, `Bearer` material), are
 * rejected (fail closed) so secrets can never be persisted as block
 * metadata.
 */
const REASON_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const SECRET_PREFIX_PATTERN = /^(xox|ASIA|AKIA|ghp_|gho_|gh_sk|sk-|Bearer\s)/i;

function checkReasonCode(kind: BlockKind, reasonCode: string): void {
  if (!REASON_CODE_PATTERN.test(reasonCode) || SECRET_PREFIX_PATTERN.test(reasonCode)) {
    throw new Error(`Invalid ${kind} reasonCode: redacted code only (never bodies/secrets)`);
  }
}
