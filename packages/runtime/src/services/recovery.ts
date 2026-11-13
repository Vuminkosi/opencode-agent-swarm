/**
 * M5-01 crash replay + durable leases recovery (spec §14 M5 + §13
 * failure-injection matrix + §6 follow-on tables + §12 reconciliation).
 *
 * Runs after daemon restart: replays committed-undelivered outbox rows,
 * reconciles unsettled wake intents through the existing M2
 * `InboxReconciler`, reconciles integration runs through the existing M4
 * `IntegrationService.reconcile`, and tracks prompt admission receipts in
 * a service-owned `session_executions` table for the admission-vs-ack
 * crash window.
 *
 * Safety posture (what this service NEVER does):
 * - Never blind-resubmits: ambiguous admissions (submitted but no terminal
 *   record) quarantine via the reconciler; ambiguous executions report via
 *   `listAmbiguousExecutions` for operator review.
 * - Never submits model turns: `replayOutbox` only fans out durable
 *   notification records to SSE/board consumers and marks a row delivered
 *   ONLY after the consumer acks (resolved promise). A throwing consumer
 *   leaves the row pending (attempts untouched) and the failure is
 *   reported, never retried in a hot loop here.
 * - Never acts on live leases: wake/member-turn recovery delegates to the
 *   reconciler (expiry-gated re-acquire, generation/killed guards) and
 *   canonical-lock recovery delegates to `IntegrationService.reconcile`
 *   (stale lease + fencing bump, live foreign lease quarantines).
 * - Never duplicates merges: integration idempotency rests on the
 *   `integration_runs` `task_id PRIMARY KEY` dedupe (M4-03), reused here.
 * - Bounded redelivery (rate limiting): every replay pass takes at most
 *   `maxPerRun` rows (default 100, hard cap 1000) in `created_at` order —
 *   no unbounded fan-out on a deep backlog. The store READ per pass is
 *   additionally scan-bounded by `REPLAY_SCAN_CAP` (M8-01, documented
 *   value 2000): a >10k-row backlog drains across bounded passes.
 * - Quota pause respected by construction: this service owns no paid path
 *   (no harness calls, no inference); paid turns stay with the dispatcher,
 *   which quota-pauses on 402 with zero auto-retry.
 *
 * Schema note: `session_executions` is service-owned and ensured
 * idempotently with `CREATE TABLE IF NOT EXISTS` on the shared DB handle
 * (same precedent as M4-03 `integration_runs` — no migration file, because
 * `store.ts` migrations are owned by another lane and an unwired `.sql`
 * file would be dead schema).
 */

import type { Database } from "bun:sqlite";
import type { BoardPost } from "@vuminkosi/protocol";
import { InboxReconciler, type ReconcileReport, type SnapshotProvider } from "./inbox-reconciler.js";
import type { ReconcileReport as IntegrationReconcileReport } from "./integration.js";
import { SwarmStore, type OutboxEntry } from "../db/store.js";
import { newCorrelationId } from "./wake-events.js";

// --- Service-owned durable schema (see header note re: no migration file) ---

export const SESSION_EXECUTIONS_DDL = `CREATE TABLE IF NOT EXISTS session_executions (
  wake_id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  dedupe_key TEXT UNIQUE,
  admitted_at TEXT NOT NULL,
  acked_at TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('succeeded','failed','cancelled')),
  completed_at TEXT,
  swarm_id TEXT
);`;

/** Idempotent schema ensure for the service-owned table (safe on every open). */
export function ensureSessionExecutionsSchema(db: Database): void {
  db.exec(SESSION_EXECUTIONS_DDL);
  // F-D3 per-swarm scope: legacy DBs created before swarm_id need the
  // nullable column (back-compat: NULL = pre-scope receipt, still matched
  // by unfiltered reads). Tolerate "duplicate column" on re-ensure.
  try {
    db.exec("ALTER TABLE session_executions ADD COLUMN swarm_id TEXT");
  } catch {
    /* column already present — idempotent ensure */
  }
}

// --- Error contract (safe messages only) ---

export type RecoveryErrorCode = "INVALID_INPUT";

export class RecoveryError extends Error {
  readonly code: RecoveryErrorCode;
  readonly details: Readonly<Record<string, string>>;
  constructor(code: RecoveryErrorCode, message: string, details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "RecoveryError";
    this.code = code;
    this.details = details;
  }
}

// --- Public shapes ---

export interface AdmissionReceipt {
  readonly wakeId: string;
  readonly memberId: string;
  readonly sessionId: string;
  readonly externalId: string;
  /** Dedupe marker: repeat receipts with the same key collapse (default: externalId). */
  readonly dedupeKey?: string;
  /** Owning swarm for per-swarm quarantine scopes (F-D3; optional for back-compat). */
  readonly swarmId?: string;
}

export type AdmissionRecordResult = "recorded" | "deduped";

export interface SessionExecution {
  readonly wakeId: string;
  readonly memberId: string;
  readonly sessionId: string;
  readonly externalId: string;
  readonly dedupeKey: string | null;
  readonly admittedAt: string;
  readonly ackedAt: string | null;
  readonly outcome: "succeeded" | "failed" | "cancelled" | null;
  readonly completedAt: string | null;
  readonly swarmId: string | null;
}

/** Consumer of redelivered outbox rows: resolve = ack (row marked delivered). */
export type OutboxConsumer = (entry: OutboxEntry) => Promise<void>;

export interface ReplayReport {
  readonly checked: number;
  readonly delivered: number;
  readonly failed: number;
  readonly deliveredIds: readonly string[];
  readonly failedIds: readonly string[];
  /**
   * M8-01 scan bound (per-fetch bound, F-M8-01): the rows READ from the store
   * by the widest single fetch of this pass (global window, before swarm
   * filtering). Every fetch in a pass re-reads from the head of the pending
   * outbox and is individually `<= REPLAY_SCAN_CAP`, so earlier narrower
   * probes are subsumed by the final window — `scanned` is always
   * `<= REPLAY_SCAN_CAP`. Unfiltered passes are single-fetch, so
   * `scanned == checked <= maxPerRun`.
   */
  readonly scanned: number;
}

export interface BoardSnapshot {
  readonly swarmId: string;
  readonly after: number;
  readonly posts: readonly BoardPost[];
}

/** Structural surface of IntegrationService.reconcile (injected, never constructed here). */
export interface IntegrationReconciler {
  reconcile(
    taskId: string,
    opts?: { readonly worktreeRecord?: { readonly worktreePath: string; readonly branch: string; readonly baseCommit: string } },
  ): Promise<IntegrationReconcileReport>;
}

export interface CrashRecoveryOptions {
  readonly store: SwarmStore;
  /** Shared DB handle for the service-owned `session_executions` table. */
  readonly db: Database;
  readonly nowIso?: () => string;
}

const REPLAY_DEFAULT_MAX = 100;
const REPLAY_HARD_CAP = 1000;

/**
 * M8-01 scan bound (M5 F-01 accepted risk, closed here): a single replay
 * pass READS at most this many outbox rows from the store, no matter how
 * deep the backlog is. Delivery per pass stays capped by `maxPerRun`
 * (<= REPLAY_HARD_CAP); the scan window that feeds the per-swarm filter
 * grows geometrically but never past this cap, so a >10k-row backlog
 * costs a bounded read per pass and drains across passes instead of one
 * widening scan. Value: 2000 rows/pass (2x the delivery hard cap, small
 * enough to stay cheap on file DBs, large enough that an unfiltered pass
 * always covers its delivery quota in one fetch).
 */
export const REPLAY_SCAN_CAP = 2000;

function nowIsoDefault(): string {
  return new Date().toISOString();
}

interface ExecutionRow {
  wake_id: string;
  member_id: string;
  session_id: string;
  external_id: string;
  dedupe_key: string | null;
  admitted_at: string;
  acked_at: string | null;
  outcome: string | null;
  completed_at: string | null;
  swarm_id: string | null;
}

export class CrashRecovery {
  private readonly store: SwarmStore;
  private readonly db: Database;
  private readonly nowIso: () => string;

  constructor(opts: CrashRecoveryOptions) {
    this.store = opts.store;
    this.db = opts.db;
    this.nowIso = opts.nowIso ?? nowIsoDefault;
    ensureSessionExecutionsSchema(this.db);
  }

  private toExecution(row: ExecutionRow): SessionExecution {
    const outcome =
      row.outcome === "succeeded" || row.outcome === "failed" || row.outcome === "cancelled" ? row.outcome : null;
    return {
      wakeId: row.wake_id,
      memberId: row.member_id,
      sessionId: row.session_id,
      externalId: row.external_id,
      dedupeKey: row.dedupe_key,
      admittedAt: row.admitted_at,
      ackedAt: row.acked_at,
      outcome,
      completedAt: row.completed_at,
      swarmId: typeof row.swarm_id === "string" ? row.swarm_id : null,
    };
  }

  /**
   * Record a prompt admission receipt (adapter-internal externalId, never
   * an OpenCode API argument). INSERT-or-ignore on the dedupe marker: a
   * redelivered receipt collapses instead of double-recording.
   */
  recordAdmission(input: AdmissionReceipt): AdmissionRecordResult {
    const wakeId = input.wakeId.trim();
    const memberId = input.memberId.trim();
    const sessionId = input.sessionId.trim();
    const externalId = input.externalId.trim();
    if (wakeId === "" || memberId === "" || sessionId === "" || externalId === "") {
      throw new RecoveryError("INVALID_INPUT", "Admission receipt needs wakeId, memberId, sessionId and externalId", {});
    }
    const dedupeKey = (input.dedupeKey ?? externalId).trim() || externalId;
    const swarmId = input.swarmId !== undefined ? input.swarmId.trim() : "";
    const outcome = this.db
      .query(
        "INSERT INTO session_executions (wake_id, member_id, session_id, external_id, dedupe_key, admitted_at, swarm_id) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING",
      )
      .run(wakeId, memberId, sessionId, externalId, dedupeKey, this.nowIso(), swarmId === "" ? null : swarmId) as unknown as {
      changes?: number;
    };
    return (outcome?.changes ?? 0) > 0 ? "recorded" : "deduped";
  }

  /** Record the local ack for an admitted prompt (closes the admit-vs-ack window). */
  recordAck(wakeId: string): void {
    if (wakeId.trim() === "") throw new RecoveryError("INVALID_INPUT", "wakeId must be non-empty", {});
    this.db
      .query("UPDATE session_executions SET acked_at = COALESCE(acked_at, ?) WHERE wake_id = ?")
      .run(this.nowIso(), wakeId.trim());
  }

  /** Correlate a terminal outcome with its admission receipt (F-02 terminal-once). */
  recordOutcome(wakeId: string, outcome: "succeeded" | "failed" | "cancelled"): void {
    // S3 enum allowlist: never trust a JS caller with a wider string.
    if (outcome !== "succeeded" && outcome !== "failed" && outcome !== "cancelled") {
      throw new RecoveryError("INVALID_INPUT", "outcome must be succeeded, failed or cancelled", {});
    }
    if (wakeId.trim() === "") throw new RecoveryError("INVALID_INPUT", "wakeId must be non-empty", {});
    // Terminal-once guard: the first terminal outcome wins; a late/duplicate
    // delivery (retry, dual writer, crash replay) can never overwrite it.
    this.db
      .query("UPDATE session_executions SET outcome = ?, completed_at = ? WHERE wake_id = ? AND outcome IS NULL")
      .run(outcome, this.nowIso(), wakeId.trim());
  }

  getExecution(wakeId: string): SessionExecution | null {
    const row = this.db
      .query<ExecutionRow, [string]>("SELECT * FROM session_executions WHERE wake_id = ?")
      .get(wakeId) as ExecutionRow | null;
    return row === null ? null : this.toExecution(row);
  }

  /**
   * Crash-window candidates: admitted with neither ack nor terminal
   * outcome. Ambiguous by definition (turn may or may not have reached the
   * backend) — REPORT ONLY, never auto-resubmit; an operator clears each
   * row after review via `recordOutcome` (or deletes the row).
   * F-D3: pass `swarmId` to scope one swarm's crash window; unfiltered
   * reads preserve the legacy single-scope behavior.
   */
  listAmbiguousExecutions(limit = 100, opts?: { readonly swarmId?: string }): SessionExecution[] {
    const n = Math.max(1, Math.min(REPLAY_HARD_CAP, Math.floor(Number.isFinite(limit) ? limit : 100)));
    const swarmId = opts?.swarmId !== undefined ? opts.swarmId.trim() : "";
    if (swarmId !== "") {
      return this.db
        .query<ExecutionRow, [string, number]>(
          "SELECT * FROM session_executions WHERE acked_at IS NULL AND outcome IS NULL AND swarm_id = ? ORDER BY admitted_at ASC LIMIT ?",
        )
        .all(swarmId, n)
        .map((r) => this.toExecution(r));
    }
    return this.db
      .query<ExecutionRow, [number]>(
        "SELECT * FROM session_executions WHERE acked_at IS NULL AND outcome IS NULL ORDER BY admitted_at ASC LIMIT ?",
      )
      .all(n)
      .map((r) => this.toExecution(r));
  }

  /**
   * Resolve an outbox row to its owning swarm (F-D3 per-swarm replay).
   * The `outbox` table itself is store-owned and global (no swarm_id
   * column — store.ts is another lane), so recovery scopes by resolving
   * each row's aggregate: post_committed carries swarmId; wake lifecycle
   * rows resolve via wake id; evidence rows resolve via task id.
   *
   * M8-01-FIX-01 (F2) NULL-swarm quarantine: unknown kinds or vanished
   * aggregates resolve to null and are EXCLUDED from filtered (per-swarm)
   * replays — never leaked cross-swarm — but INCLUDED in unfiltered legacy
   * replays so nothing is lost (proven by the NULL-swarm quarantine row:
   * filtered pass reports checked 0 and preserves the row, the unfiltered
   * pass redelivers it).
   */
  private outboxEntrySwarm(entry: OutboxEntry): string | null {
    const payload = (entry.payload ?? {}) as Record<string, unknown>;
    if (entry.kind === "post_committed") {
      return typeof payload["swarmId"] === "string" ? (payload["swarmId"] as string) : null;
    }
    if (entry.kind === "evidence_recorded") {
      const taskId = payload["taskId"];
      if (typeof taskId !== "string" || taskId === "") return null;
      try {
        return this.store.getTask(taskId).swarmId;
      } catch {
        return null;
      }
    }
    const wakeId =
      typeof payload["wakeId"] === "string" && (payload["wakeId"] as string) !== ""
        ? (payload["wakeId"] as string)
        : entry.aggregateId;
    if (typeof wakeId === "string" && wakeId !== "") {
      try {
        return this.store.getWake(wakeId).swarmId;
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Restart replay: redeliver every committed-undelivered outbox row
   * (`delivered_at IS NULL`, FIFO) to SSE/board consumers. A row is marked
   * delivered ONLY after the consumer acks; a throwing consumer leaves the
   * row pending and the failure is reported (no hot retry here — the next
   * restart pass, or operator action, redrives it).
   * F-D3: pass `swarmId` to replay exactly one swarm's backlog (two swarms
   * sharing one store file never cross-deliver). The scan stays bounded per
   * pass (at most `maxPerRun` deliveries; at most REPLAY_SCAN_CAP rows
   * read): the global fetch pages/expands until the swarm quota is filled,
   * the source is exhausted, or the scan cap is reached — an other-swarm
   * backlog ahead of the window can delay but never unboundedly widen this
   * swarm's pass (M5-01-FIX-02 F2, scan-bounded by M8-01). Unfiltered calls
   * preserve the legacy global behavior.
   *
   * M8-01-FIX-01 (F1) filtered fairness is best-effort: a large other-swarm
   * backlog ahead of the window can starve one pass (fewer than `maxPerRun`
   * rows, possibly zero) without widening the scan. Callers draining one
   * swarm must keep redriving as the global backlog drains — full eventual
   * redelivery is proven by draining across passes, never by widening one
   * pass.
   */
  async replayOutbox(
    consumer: OutboxConsumer,
    opts?: { readonly maxPerRun?: number; readonly swarmId?: string },
  ): Promise<ReplayReport> {
    // S3 NaN clamp: a non-finite maxPerRun must never become an unbounded scan.
    const rawMax = opts?.maxPerRun ?? REPLAY_DEFAULT_MAX;
    const max = Math.max(1, Math.min(REPLAY_HARD_CAP, Math.floor(Number.isFinite(rawMax) ? rawMax : REPLAY_DEFAULT_MAX)));
    const swarmId = opts?.swarmId !== undefined ? opts.swarmId.trim() : "";
    let pending: OutboxEntry[];
    let scanned: number;
    if (swarmId === "") {
      pending = this.store.listPendingOutbox(max);
      scanned = pending.length;
    } else {
      // F2 paged predicate push-down (store lane owns listPendingOutbox, so
      // no offset param exists): grow the global window until the swarm
      // quota is filled, the source is exhausted (fetched < window means
      // no more rows exist), or the M8-01 scan cap is reached. Only the
      // filtered quota is delivered per pass; the remainder (including an
      // other-swarm backlog past the cap) redrives on later passes as the
      // global backlog drains — bounded scan, full eventual redelivery.
      let window = Math.min(max * 5, REPLAY_SCAN_CAP);
      let fetched = this.store.listPendingOutbox(window);
      let filtered = fetched.filter((entry) => this.outboxEntrySwarm(entry) === swarmId);
      while (filtered.length < max && fetched.length >= window && window < REPLAY_SCAN_CAP) {
        window = Math.min(window * 2, REPLAY_SCAN_CAP);
        fetched = this.store.listPendingOutbox(window);
        filtered = fetched.filter((entry) => this.outboxEntrySwarm(entry) === swarmId);
      }
      scanned = fetched.length;
      pending = filtered.slice(0, max);
    }
    const deliveredIds: string[] = [];
    const failedIds: string[] = [];
    for (const entry of pending) {
      try {
        await consumer(entry);
      } catch {
        // S3 error detail: the row id lands in failedIds and stays pending
        // for the next pass — never marked delivered on failure.
        failedIds.push(entry.id);
        continue;
      }
      this.store.markOutboxDelivered(entry.id);
      deliveredIds.push(entry.id);
    }
    return { checked: pending.length, delivered: deliveredIds.length, failed: failedIds.length, deliveredIds, failedIds, scanned };
  }

  /**
   * Reconcile unsettled wake intents after restart/reconnect via the
   * existing M2 `InboxReconciler`: keep live, complete terminally-known,
   * release never-submitted for retry, QUARANTINE ambiguous
   * (submitted-without-terminal-record) — never blind replay.
   */
  reconcileWakes(
    swarmId: string,
    snapshots: SnapshotProvider,
    opts?: { readonly correlationId?: string },
  ): Promise<ReconcileReport> {
    if (swarmId.trim() === "") throw new RecoveryError("INVALID_INPUT", "swarmId must be non-empty", {});
    const reconciler = new InboxReconciler(this.store, snapshots);
    return reconciler.reconcileSwarm(swarmId.trim(), opts?.correlationId ?? newCorrelationId());
  }

  /**
   * Reconcile one integration after restart via the existing M4
   * `IntegrationService.reconcile` (injected): integrated rows dedupe (no
   * duplicate merge — `task_id PRIMARY KEY`), stale leases recover with a
   * fencing bump, live foreign leases quarantine as ambiguous.
   */
  reconcileIntegration(
    integration: IntegrationReconciler,
    taskId: string,
    opts?: { readonly worktreeRecord?: { readonly worktreePath: string; readonly branch: string; readonly baseCommit: string } },
  ): Promise<IntegrationReconcileReport> {
    if (taskId.trim() === "") throw new RecoveryError("INVALID_INPUT", "taskId must be non-empty", {});
    return integration.reconcile(taskId.trim(), opts);
  }

  /**
   * Event-stream reconnect snapshot (overflow recovery): replay the missed
   * range from durable board sequences (`getPostsAfter`), never from
   * volatile stream offsets — a dropped/overflowed stream re-syncs to the
   * journal, so nothing committed is lost and nothing is assumed.
   */
  reconnectBoardSnapshot(swarmId: string, after: number, limit = 100): BoardSnapshot {
    if (swarmId.trim() === "") throw new RecoveryError("INVALID_INPUT", "swarmId must be non-empty", {});
    if (!Number.isFinite(after) || after < 0) throw new RecoveryError("INVALID_INPUT", "after must be a non-negative sequence", {});
    const posts = this.store.getPostsAfter(swarmId.trim(), Math.floor(after), Math.max(1, Math.min(REPLAY_HARD_CAP, Math.floor(limit))));
    return { swarmId: swarmId.trim(), after: Math.floor(after), posts };
  }
}
