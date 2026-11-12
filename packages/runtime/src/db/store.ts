/**
 * Durable SQLite journal store — M1-01 (contract C-DB-01).
 *
 * Single authoritative write owner for swarm state (spec §§6, 7):
 * - WAL mode, foreign keys, busy timeout, repeatable file migrations.
 * - Atomic board sequence: ONE `BEGIN IMMEDIATE` transaction reads and
 *   bumps `swarms.revision` and uses it as `posts.sequence`.
 *   NEVER `MAX(sequence)+1` outside a transaction.
 * - Member / task / wake transition guards (protocol tables) + §7 guards:
 *   killed never wakes, at most one live turn per member (queued intents
 *   defer), DAG cycle rejection at creation, worker cannot self-accept,
 *   acceptance requires real verification evidence.
 * - Normalized wake idempotency: `delivery_key =
 *   sha256hex(memberId|generation|reason|postSeqOr0|taskIdOr0|payloadHash)`
 *   with UNIQUE(swarm_id, delivery_key) (migration 002; closes the
 *   NULL-distinct caveat of the 001 composite key).
 * - Outbox rows are appended in the SAME transaction as the state change
 *   they describe (atomic commit: all or none on crash).
 *
 * Sync API over `bun:sqlite` (synchronous driver = no interleaved
 * statements inside a transaction). Callers may retry idempotent writes
 * (appendPost / createWakeIntent) after a busy/crash failure.
 *
 * Evidence: [DESIGN] (spec §§6, 7, 15 M1-01).
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AppendPostInputSchema,
  CreateSwarmInputSchema,
  AddMemberInputSchema,
  CreateTaskInputSchema,
  CreateWakeIntentInputSchema,
  RecordEvidenceInputSchema,
  assertDepsAcyclic,
  assertMemberTransition,
  assertTaskTransition,
  assertVerifierAccept,
  assertWakeTransition,
  depsSatisfied,
  parseAndResolveMentions,
  projectPublicState,
  type AppendPostInput,
  type BoardPost,
  type CreateSwarmInput,
  type AddMemberInput,
  type CreateTaskInput,
  type CreateWakeIntentInput,
  type InternalMemberState,
  type Member,
  type RecordEvidenceInput,
  type Swarm,
  type Task,
  type TaskState,
  type VerificationEvidence,
  type WakeIntent,
  type WakeReason,
  type WakeState,
} from "@opencode-swarm/protocol";
import { ProtocolError } from "@opencode-swarm/protocol";

const MIGRATIONS: readonly { version: number; file: string }[] = [
  { version: 1, file: "001_initial.sql" },
  { version: 2, file: "002_wake_dedupe_key.sql" },
  // F-C: inbox_dedupe per-swarm scoping (004). Independent of any future
  // version 3 (no cross-migration dependency); applied when missing.
  { version: 4, file: "004_inbox_dedupe_swarm_scope.sql" },
];

const MAX_TXN_BEGIN_ATTEMPTS = 50;

// --- Row shapes (snake_case as stored) ---

interface SwarmRow {
  id: string;
  title: string;
  coordinator_session_id: string;
  project_root: string;
  mode: string;
  status: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface MemberRow {
  id: string;
  swarm_id: string;
  name: string;
  role: string;
  native_agent_id: string;
  session_id: string;
  model_provider_id: string;
  model_id: string;
  public_state: string;
  internal_state: string;
  generation: number;
  last_activity_at: string;
  killed_at: string | null;
}

interface TaskRow {
  id: string;
  swarm_id: string;
  owner_id: string | null;
  title: string;
  brief: string;
  state: string;
  attempt: number;
  generation: number;
  owned_paths_json: string;
  forbidden_paths_json: string;
  acceptance_json: string;
  base_commit: string | null;
  worktree_path: string | null;
  created_at: string;
  updated_at: string;
}

interface PostRow {
  id: string;
  swarm_id: string;
  sequence: number;
  author_member_id: string | null;
  kind: string;
  body: string;
  related_task_id: string | null;
  idempotency_key: string;
  created_at: string;
}

interface WakeRow {
  id: string;
  swarm_id: string;
  member_id: string;
  member_generation: number;
  reason: string;
  post_sequence: number | null;
  task_id: string | null;
  payload_hash: string;
  state: string;
  attempts: number;
  created_at: string;
  updated_at: string;
  delivery_key: string | null;
}

interface OutboxRow {
  id: string;
  kind: string;
  aggregate_id: string;
  payload_json: string;
  delivered_at: string | null;
  attempts: number;
  created_at: string;
}

interface EvidenceRow {
  id: string;
  task_id: string;
  executor_member_id: string;
  command: string;
  cwd: string;
  exit_code: number;
  commit_sha: string | null;
  stdout_artifact_id: string;
  stderr_artifact_id: string;
  started_at: string;
  finished_at: string;
}

export interface OutboxEntry {
  readonly id: string;
  readonly kind: string;
  readonly aggregateId: string;
  readonly payload: unknown;
  readonly deliveredAt: string | null;
  readonly attempts: number;
  readonly createdAt: string;
}

export type ClaimResult =
  | { readonly status: "admitted"; readonly intent: WakeIntent }
  | { readonly status: "deferred-live-turn"; readonly intent: WakeIntent }
  | { readonly status: "deferred-stale"; readonly intent: WakeIntent };

function nowIso(): string {
  return new Date().toISOString();
}

function sha256hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Normalized wake delivery key (migration 002). All components are
 * non-null by construction: NULL post/task collapse to 0, so SQLite's
 * NULL-distinct UNIQUE semantics cannot let duplicates through.
 */
export function computeDeliveryKey(input: {
  readonly memberId: string;
  readonly memberGeneration: number;
  readonly reason: WakeReason;
  readonly postSequence: number | null | undefined;
  readonly taskId: string | null | undefined;
  readonly payloadHash: string;
}): string {
  const postPart = input.postSequence ?? 0;
  const taskPart = input.taskId ?? "0";
  return sha256hex(
    `${input.memberId}|${input.memberGeneration}|${input.reason}|${postPart}|${taskPart}|${input.payloadHash}`,
  );
}

function isBusyError(err: unknown): boolean {
  return err instanceof Error && (err as { code?: unknown }).code === "SQLITE_BUSY";
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Boundary parse: Zod is the single validation source, but raw ZodError
 * must never escape the store (dual-error model) — map to coded
 * VALIDATION_FAILED so M1-02 can return the safe public shape.
 */
function parseInput<T>(what: string, parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    if (err instanceof ProtocolError) throw err;
    throw new ProtocolError("VALIDATION_FAILED", `Invalid ${what} input`, { what });
  }
}

function parseJsonArray(raw: string, what: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((e): e is string => typeof e === "string")) {
    throw new ProtocolError("VALIDATION_FAILED", `Corrupt ${what} JSON in journal`, { what });
  }
  return parsed;
}

/**
 * M2 wake-engine tuning + pure backoff math (module scope so the queue,
 * dispatcher and reconciler share one deterministic formula with the
 * store gate — no duplicated business rules).
 */
export const WAKE_LEASE_TTL_MS_DEFAULT = 60_000 as const;
/**
 * F-B review-after age for quarantine markers. Expiry never auto-admits:
 * an expired marker keeps the wake blocked from dispatch and surfaces it
 * via `listWakesNeedingQuarantineReview` / `isWakeQuarantineReviewDue`
 * until an operator clears or cancels it.
 */
export const WAKE_QUARANTINE_TTL_MS: number = 24 * 3600 * 1000;
export const WAKE_BACKOFF_BASE_MS_DEFAULT = 250 as const;
export const WAKE_BACKOFF_CAP_MS_DEFAULT = 10_000 as const;
export const WAKE_MAX_ATTEMPTS_DEFAULT = 8 as const;

/** Member states the dispatcher may admit a turn for (spec §7.1). */
export const WAKE_ELIGIBLE_MEMBER_STATES = ["starting", "working", "waiting", "recovering"] as const;

/**
 * Bounded exponential backoff with full jitter for TRANSIENT transport
 * failures only: delay = rand * min(cap, base * 2^attempts). Pure and
 * injectable (pass rand + attempts explicitly) for deterministic tests.
 */
export function wakeBackoffDelayMs(
  attempts: number,
  baseMs: number = WAKE_BACKOFF_BASE_MS_DEFAULT,
  capMs: number = WAKE_BACKOFF_CAP_MS_DEFAULT,
  rand: () => number = Math.random,
): number {
  const n = Math.max(0, Math.floor(attempts));
  const exp = Math.min(capMs, baseMs * 2 ** Math.min(n, 20));
  const r = rand();
  const jitter = r >= 0 && r <= 1 ? r : 0.5;
  return Math.floor(jitter * exp);
}

/**
 * Deterministic dispatch gate ceiling: updated_at + max possible backoff
 * (jitter = 1). A restarted dispatcher waits the ceiling, never less —
 * bounded, storm-free, and reproducible without the original roll.
 */
export function wakeNotBeforeMs(
  updatedAtIso: string,
  attempts: number,
  baseMs: number = WAKE_BACKOFF_BASE_MS_DEFAULT,
  capMs: number = WAKE_BACKOFF_CAP_MS_DEFAULT,
  nowMs: number = Date.now(),
): number {
  if (attempts <= 0) return 0;
  const updated = Date.parse(updatedAtIso);
  const base = Number.isFinite(updated) ? (updated as number) : nowMs;
  const n = Math.max(0, Math.floor(attempts));
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.min(n, 20));
  return base + ceiling;
}

/** Fenced-claim outcome for exactly one dispatch attempt (M2). */
export type WakeDispatchClaim =
  | {
      readonly status: "admitted";
      readonly intent: WakeIntent;
      readonly fencingToken: number;
      readonly leaseExpiresAt: string;
      readonly correlationId: string;
    }
  | { readonly status: "deferred-live-turn"; readonly intent: WakeIntent }
  | { readonly status: "deferred-stale"; readonly intent: WakeIntent }
  | { readonly status: "deferred-ineligible"; readonly intent: WakeIntent }
  | { readonly status: "deferred-backoff"; readonly intent: WakeIntent }
  | { readonly status: "deferred-quarantined"; readonly intent: WakeIntent };

/**
 * F-B operator re-review queue entry (M8): one quarantined wake and the
 * age of its marker. `reviewDue` is true once the marker TTL has elapsed;
 * expiry never auto-admits — the entry waits for operator review.
 */
export interface QuarantineReviewItem {
  readonly wakeId: string;
  readonly swarmId: string;
  readonly memberId: string;
  readonly wakeState: WakeState;
  readonly quarantineExpiresAt: string;
  readonly reviewDue: boolean;
  readonly quarantinedForMs: number;
}

export class SwarmStore {
  private readonly db: Database;
  private closed = false;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.runMigrations();
    this.backfillDeliveryKeys();
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }

  // --- Migrations (repeatable) ---

  private migrationDir(): string {
    return fileURLToPath(new URL("./migrations/", import.meta.url));
  }

  /** Apply pending migrations; safe to run on every open (idempotent). */
  runMigrations(): number[] {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
    const applied = new Set<number>(
      this.db.query<{ version: number }, []>("SELECT version FROM schema_migrations").all().map((r) => r.version),
    );
    const newly: number[] = [];
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      // R1: v2 is a phased migration — ADD COLUMN (002 SQL) -> JS
      // backfill (SQLite has no sha256) -> deterministic keep-earliest
      // cleanup -> UNIQUE index, all in ONE transaction. The index must
      // never be created before the backfill/cleanup: pre-002 NULL-era
      // duplicates would fail it, ROLLBACK, and poison every reopen.
      if (m.version === 2) {
        this.applyMigrationV2(m.file);
      } else {
        const sql = readFileSync(`${this.migrationDir()}${m.file}`, "utf8");
        this.db.exec("BEGIN IMMEDIATE;");
        try {
          this.db.exec(sql);
          this.db
            .query<[], [number, string]>("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
            .run(m.version, nowIso());
          this.db.exec("COMMIT;");
        } catch (err) {
          try {
            this.db.exec("ROLLBACK;");
          } catch {
            /* already rolled back */
          }
          throw err;
        }
      }
      newly.push(m.version);
    }
    return newly;
  }

  /**
   * Phased v2 application (R1). Single BEGIN IMMEDIATE transaction:
   * ADD COLUMN -> backfill keys -> delete dupes (keep earliest, logged)
   * -> CREATE UNIQUE INDEX -> record version. Tolerates a pre-existing
   * delivery_key column (dirty-state DBs that saw the old 002 layout)
   * but never tolerates a half-built index: the index is created last.
   */
  private applyMigrationV2(file: string): void {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      if (!this.hasDeliveryKeyColumn()) {
        const sql = readFileSync(`${this.migrationDir()}${file}`, "utf8");
        this.db.exec(sql);
      }
      const backfilled = this.backfillDeliveryKeysInTxn();
      const cleanedIds = this.dedupeDeliveryKeysInTxn();
      if (cleanedIds.length > 0) {
        // Logged cleanup: deterministic keep-earliest, rest removed.
        console.warn(
          `[M1-01 migration v2] delivery_key cleanup: backfilled ${backfilled}, ` +
            `removed ${cleanedIds.length} NULL-era duplicate wake_intent(s): ${cleanedIds.join(", ")}. ` +
            `Survivors: earliest (created_at, id) per (swarm_id, delivery_key). ` +
            `Audit remainder: SELECT id, swarm_id, member_id, reason, created_at FROM wake_intents ` +
            `WHERE delivery_key IS NULL;`,
        );
      }
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS ix_wake_delivery_key ON wake_intents(swarm_id, delivery_key);",
      );
      this.db
        .query<[], [number, string]>("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(2, nowIso());
      this.db.exec("COMMIT;");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        /* already rolled back */
      }
      throw err;
    }
  }

  private hasDeliveryKeyColumn(): boolean {
    return (
      this.db
        .query<{ name: string }, []>("SELECT name FROM pragma_table_info('wake_intents')")
        .all()
        .some((c) => c.name === "delivery_key")
    );
  }

  /** Backfill NULL delivery_key rows. Caller must hold the write txn. */
  private backfillDeliveryKeysInTxn(): number {
    let count = 0;
    const rows = this.db
      .query<WakeRow, []>("SELECT * FROM wake_intents WHERE delivery_key IS NULL")
      .all();
    for (const row of rows) {
      const key = computeDeliveryKey({
        memberId: row.member_id,
        memberGeneration: row.member_generation,
        reason: row.reason as WakeReason,
        postSequence: row.post_sequence,
        taskId: row.task_id,
        payloadHash: row.payload_hash,
      });
      this.db
        .query<[], [string, string]>("UPDATE wake_intents SET delivery_key = ? WHERE id = ?")
        .run(key, row.id);
      count += 1;
    }
    return count;
  }

  /**
   * Delete duplicate (swarm_id, delivery_key) rows, keeping the earliest
   * (created_at, id) per group. Returns the removed ids for logging.
   * Caller must hold the write txn.
   */
  private dedupeDeliveryKeysInTxn(): string[] {
    const dupes = this.db
      .query<{ swarm_id: string; delivery_key: string }, []>(
        `SELECT swarm_id, delivery_key FROM wake_intents
          WHERE delivery_key IS NOT NULL
          GROUP BY swarm_id, delivery_key HAVING COUNT(*) > 1`,
      )
      .all();
    const removed: string[] = [];
    for (const d of dupes) {
      const rows = this.db
        .query<{ id: string }, [string, string]>(
          `SELECT id FROM wake_intents WHERE swarm_id = ? AND delivery_key = ?
            ORDER BY created_at ASC, id ASC`,
        )
        .all(d.swarm_id, d.delivery_key);
      for (const extra of rows.slice(1)) {
        this.db.query<[], [string]>("DELETE FROM wake_intents WHERE id = ?").run(extra.id);
        removed.push(extra.id);
      }
    }
    return removed.sort();
  }

  /**
   * Safety-net backfill for NULL delivery_key rows observed AFTER
   * migrations (e.g. rows written while v2 was unapplied). UNIQUE permits
   * NULLs, so conflicting rows cannot be merged here — they are surfaced,
   * not silently dropped (R2). Returns the remainder ids.
   *
   * NOT NULL timeline: delivery_key stays nullable until the remainder is
   * drained by operators (query below); a later migration then enforces
   * NOT NULL.
   * TODO(M1-02/R12): enforce `delivery_key NOT NULL` (new migration) once
   * the backfill remainder is empty; add a startup hard-fail if any NULL
   * delivery_key rows exist at open.
   * Remainder audit query:
   *   SELECT id, swarm_id, member_id, reason, created_at FROM wake_intents
   *   WHERE delivery_key IS NULL ORDER BY created_at;
   * Dedupe audit query (should return no rows post-v2):
   *   SELECT swarm_id, delivery_key, COUNT(*) AS n FROM wake_intents
   *   WHERE delivery_key IS NOT NULL GROUP BY swarm_id, delivery_key
   *   HAVING n > 1;
   */
  private backfillDeliveryKeys(): string[] {
    const remainder: string[] = [];
    const rows = this.db
      .query<WakeRow, []>("SELECT * FROM wake_intents WHERE delivery_key IS NULL")
      .all();
    for (const row of rows) {
      const key = computeDeliveryKey({
        memberId: row.member_id,
        memberGeneration: row.member_generation,
        reason: row.reason as WakeReason,
        postSequence: row.post_sequence,
        taskId: row.task_id,
        payloadHash: row.payload_hash,
      });
      try {
        this.db
          .query<[], [string, string]>("UPDATE wake_intents SET delivery_key = ? WHERE id = ?")
          .run(key, row.id);
      } catch {
        // Duplicate from the NULL-caveat era colliding with the v2 index:
        // leave the row for operator review, never delete journal data here.
        remainder.push(row.id);
      }
    }
    const stillNull = this.db
      .query<{ id: string }, []>(
        "SELECT id FROM wake_intents WHERE delivery_key IS NULL ORDER BY created_at",
      )
      .all()
      .map((r) => r.id);
    for (const id of stillNull) if (!remainder.includes(id)) remainder.push(id);
    if (remainder.length > 0) {
      console.warn(
        `[M1-01] delivery_key backfill remainder: ${remainder.length} wake_intent(s) left NULL: ` +
          `${remainder.join(", ")}. Audit: SELECT id, swarm_id, member_id, reason, created_at ` +
          `FROM wake_intents WHERE delivery_key IS NULL ORDER BY created_at; ` +
          `Dupes: SELECT swarm_id, delivery_key, COUNT(*) AS n FROM wake_intents ` +
          `WHERE delivery_key IS NOT NULL GROUP BY swarm_id, delivery_key HAVING n > 1;`,
      );
    }
    return remainder.sort();
  }

  // --- Transaction helper (explicit BEGIN IMMEDIATE) ---

  private txn<T>(fn: () => T): T {
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        this.db.exec("BEGIN IMMEDIATE;");
      } catch (err) {
        if (isBusyError(err) && attempts < MAX_TXN_BEGIN_ATTEMPTS) {
          sleepMs(Math.min(5 * attempts, 100));
          continue;
        }
        throw err;
      }
      try {
        const result = fn();
        this.db.exec("COMMIT;");
        return result;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK;");
        } catch {
          /* ignore rollback failure */
        }
        throw err;
      }
    }
  }

  // --- Row mappers ---

  private memberGroups(memberId: string): string[] {
    return this.db
      .query<{ group_name: string }, [string]>("SELECT group_name FROM member_groups WHERE member_id = ? ORDER BY group_name")
      .all(memberId)
      .map((r) => r.group_name);
  }

  private toMember(row: MemberRow): Member {
    return {
      id: row.id,
      swarmId: row.swarm_id,
      name: row.name,
      groups: this.memberGroups(row.id),
      role: row.role as Member["role"],
      nativeAgentId: row.native_agent_id,
      sessionId: row.session_id,
      model: { providerID: row.model_provider_id, id: row.model_id },
      publicState: row.public_state as Member["publicState"],
      internalState: row.internal_state as Member["internalState"],
      generation: row.generation,
      lastActivityAt: row.last_activity_at,
      killedAt: row.killed_at,
    };
  }

  private toTask(row: TaskRow, deps: string[], evidenceIds: string[]): Task {
    return {
      id: row.id,
      swarmId: row.swarm_id,
      title: row.title,
      brief: row.brief,
      ownerId: row.owner_id,
      deps,
      ownedPaths: parseJsonArray(row.owned_paths_json, "owned_paths"),
      forbiddenPaths: parseJsonArray(row.forbidden_paths_json, "forbidden_paths"),
      acceptanceCriteria: parseJsonArray(row.acceptance_json, "acceptance"),
      state: row.state as Task["state"],
      attempt: row.attempt,
      generation: row.generation,
      worktreePath: row.worktree_path,
      baseCommit: row.base_commit,
      resultEvidenceIds: evidenceIds,
    };
  }

  private loadTask(id: string): { row: TaskRow; deps: string[]; evidenceIds: string[] } {
    const row = this.db.query<TaskRow, [string]>("SELECT * FROM tasks WHERE id = ?").get(id);
    if (row === null) throw new ProtocolError("NOT_FOUND", `Task ${id} not found`, { taskId: id });
    const deps = this.db
      .query<{ depends_on_id: string }, [string]>("SELECT depends_on_id FROM task_deps WHERE task_id = ?")
      .all(id)
      .map((r) => r.depends_on_id);
    const evidenceIds = this.db
      .query<{ id: string }, [string]>("SELECT id FROM verification_evidence WHERE task_id = ? ORDER BY finished_at")
      .all(id)
      .map((r) => r.id);
    return { row, deps, evidenceIds };
  }

  private toWake(row: WakeRow): WakeIntent {
    return {
      id: row.id,
      swarmId: row.swarm_id,
      memberId: row.member_id,
      memberGeneration: row.member_generation,
      reason: row.reason as WakeIntent["reason"],
      postSequence: row.post_sequence,
      taskId: row.task_id,
      payloadHash: row.payload_hash,
      state: row.state as WakeIntent["state"],
      attempts: row.attempts,
      createdAt: row.created_at,
    };
  }

  private toPost(row: PostRow): BoardPost {
    const mentions = this.db
      .query<{ member_id: string }, [string]>("SELECT member_id FROM post_recipients WHERE post_id = ? ORDER BY member_id")
      .all(row.id)
      .map((r) => r.member_id);
    const groupMentions = this.db
      .query<{ group_name: string }, [string]>("SELECT group_name FROM post_groups WHERE post_id = ? ORDER BY group_name")
      .all(row.id)
      .map((r) => r.group_name);
    const mentionAll = groupMentions.includes("@all");
    return {
      id: row.id,
      swarmId: row.swarm_id,
      sequence: row.sequence,
      authorMemberId: row.author_member_id,
      kind: row.kind as BoardPost["kind"],
      body: row.body,
      mentions,
      groupMentions: groupMentions.filter((g) => g !== "@all"),
      mentionAll,
      createdAt: row.created_at,
      idempotencyKey: row.idempotency_key,
      relatedTaskId: row.related_task_id,
    };
  }

  private enqueueOutbox(kind: string, aggregateId: string, payload: unknown): void {
    this.db
      .query<[], [string, string, string, string, string]>(
        "INSERT INTO outbox (id, kind, aggregate_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(crypto.randomUUID(), kind, aggregateId, JSON.stringify(payload), nowIso());
  }

  private requireSwarm(id: string): SwarmRow {
    const row = this.db.query<SwarmRow, [string]>("SELECT * FROM swarms WHERE id = ?").get(id);
    if (row === null) throw new ProtocolError("NOT_FOUND", `Swarm ${id} not found`, { swarmId: id });
    return row;
  }

  private requireMember(id: string): MemberRow {
    const row = this.db.query<MemberRow, [string]>("SELECT * FROM members WHERE id = ?").get(id);
    if (row === null) throw new ProtocolError("NOT_FOUND", `Member ${id} not found`, { memberId: id });
    return row;
  }

  // --- Swarms ---

  createSwarm(input: CreateSwarmInput): Swarm {
    const parsed = parseInput("swarm", () => CreateSwarmInputSchema.parse(input));
    const now = nowIso();
    const id = crypto.randomUUID();
    this.db
      .query<[], [string, string, string, string, string, string, string]>(
        `INSERT INTO swarms (id, title, coordinator_session_id, project_root, mode, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'planning', ?, ?)`,
      )
      .run(id, parsed.title, parsed.coordinatorSessionId, parsed.projectRoot, parsed.mode, now, now);
    const row = this.requireSwarm(id);
    return {
      id: row.id,
      title: row.title,
      coordinatorSessionId: row.coordinator_session_id,
      projectRoot: row.project_root,
      mode: row.mode as Swarm["mode"],
      status: row.status as Swarm["status"],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revision: row.revision,
    };
  }

  getSwarm(id: string): Swarm {
    const row = this.requireSwarm(id);
    return {
      id: row.id,
      title: row.title,
      coordinatorSessionId: row.coordinator_session_id,
      projectRoot: row.project_root,
      mode: row.mode as Swarm["mode"],
      status: row.status as Swarm["status"],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revision: row.revision,
    };
  }

  // --- Members ---

  addMember(swarmId: string, input: AddMemberInput): Member {
    const parsed = parseInput("member", () => AddMemberInputSchema.parse(input));
    // R3: member INSERT + group rows commit atomically — a crash between
    // them must never leave a member without groups (or vice versa).
    return this.txn(() => {
      this.requireSwarm(swarmId);
      const id = crypto.randomUUID();
      const now = nowIso();
      try {
        this.db
          .query<[], [string, string, string, string, string, string, string, string, string]>(
            `INSERT INTO members (id, swarm_id, name, role, native_agent_id, session_id,
               model_provider_id, model_id, public_state, internal_state, last_activity_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'working', 'starting', ?)`,
          )
          .run(
            id,
            swarmId,
            parsed.name,
            parsed.role,
            parsed.nativeAgentId,
            parsed.sessionId,
            parsed.model.providerID,
            parsed.model.id,
            now,
          );
      } catch (err) {
        if (err instanceof Error && (err as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE") {
          throw new ProtocolError("DUPLICATE_NAME", `Member name or session already taken in swarm ${swarmId}`, {
            swarmId,
          });
        }
        throw err;
      }
      for (const group of parsed.groups) {
        this.db
          .query<[], [string, string, string]>(
            "INSERT OR IGNORE INTO member_groups (swarm_id, member_id, group_name) VALUES (?, ?, ?)",
          )
          .run(swarmId, id, group);
      }
      return this.toMember(this.requireMember(id));
    });
  }

  getMember(id: string): Member {
    return this.toMember(this.requireMember(id));
  }

  listMembers(swarmId: string): Member[] {
    return this.db
      .query<MemberRow, [string]>("SELECT * FROM members WHERE swarm_id = ? ORDER BY name")
      .all(swarmId)
      .map((r) => this.toMember(r));
  }

  transitionMember(id: string, to: InternalMemberState): Member {
    return this.txn(() => {
      const row = this.requireMember(id);
      const from = row.internal_state as InternalMemberState;
      // R5: same-state is a no-op — return before any side effect
      // (no updated_at rewrite, no killed-cancel cascade).
      if (from === to) return this.toMember(row);
      assertMemberTransition(from, to);
      const now = nowIso();
      this.db
        .query<[], [string, string, string, string, string, string]>(
          `UPDATE members SET internal_state = ?, public_state = ?, last_activity_at = ?,
             killed_at = CASE WHEN ? = 'killed' THEN ? ELSE killed_at END WHERE id = ?`,
        )
        .run(to, projectPublicState(to), now, to, now, id);
      if (to === "killed") {
        // Killed members never wake: cancel queued intents (durable audit trail kept).
        this.db
          .query<[], [string, string]>(
            "UPDATE wake_intents SET state = 'cancelled', updated_at = ? WHERE member_id = ? AND state = 'queued'",
          )
          .run(now, id);
      }
      return this.toMember(this.requireMember(id));
    });
  }

  // --- Tasks ---

  createTask(swarmId: string, input: CreateTaskInput): Task {
    const parsed = parseInput("task", () => CreateTaskInputSchema.parse(input));
    this.requireSwarm(swarmId);
    if (parsed.ownerId !== undefined) this.requireMemberInSwarm(parsed.ownerId, swarmId);
    const swarmTasks = this.db
      .query<{ id: string }, [string]>("SELECT id FROM tasks WHERE swarm_id = ?")
      .all(swarmId)
      .map((r) => r.id);
    const existingEdges: [string, string][] = [];
    if (swarmTasks.length > 0) {
      const placeholders = swarmTasks.map(() => "?").join(",");
      existingEdges.push(
        ...this.db
          .query<{ task_id: string; depends_on_id: string }, string[]>(
            `SELECT task_id, depends_on_id FROM task_deps WHERE task_id IN (${placeholders})`,
          )
          .all(...swarmTasks)
          .map((r): [string, string] => [r.task_id, r.depends_on_id]),
      );
    }
    const id = crypto.randomUUID();
    assertDepsAcyclic(id, parsed.deps, swarmTasks, existingEdges);
    const now = nowIso();
    return this.txn(() => {
      this.db
        .query<[], [string, string, string | null, string, string, string, string, string, string, string]>(
          `INSERT INTO tasks (id, swarm_id, owner_id, title, brief, state, owned_paths_json,
             forbidden_paths_json, acceptance_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          swarmId,
          parsed.ownerId ?? null,
          parsed.title,
          parsed.brief,
          JSON.stringify(parsed.ownedPaths),
          JSON.stringify(parsed.forbiddenPaths),
          JSON.stringify(parsed.acceptanceCriteria),
          now,
          now,
        );
      for (const dep of parsed.deps) {
        this.db
          .query<[], [string, string]>("INSERT INTO task_deps (task_id, depends_on_id) VALUES (?, ?)")
          .run(id, dep);
      }
      const loaded = this.loadTask(id);
      return this.toTask(loaded.row, loaded.deps, loaded.evidenceIds);
    });
  }

  private requireMemberInSwarm(memberId: string, swarmId: string): MemberRow {
    const row = this.requireMember(memberId);
    if (row.swarm_id !== swarmId) {
      throw new ProtocolError("NOT_FOUND", `Member ${memberId} is not in swarm ${swarmId}`, { memberId, swarmId });
    }
    return row;
  }

  getTask(id: string): Task {
    const loaded = this.loadTask(id);
    return this.toTask(loaded.row, loaded.deps, loaded.evidenceIds);
  }

  listTasks(swarmId: string): Task[] {
    return this.db
      .query<TaskRow, [string]>("SELECT * FROM tasks WHERE swarm_id = ? ORDER BY created_at")
      .all(swarmId)
      .map((row) => {
        const deps = this.db
          .query<{ depends_on_id: string }, [string]>("SELECT depends_on_id FROM task_deps WHERE task_id = ?")
          .all(row.id)
          .map((r) => r.depends_on_id);
        const evidenceIds = this.db
          .query<{ id: string }, [string]>("SELECT id FROM verification_evidence WHERE task_id = ? ORDER BY finished_at")
          .all(row.id)
          .map((r) => r.id);
        return this.toTask(row, deps, evidenceIds);
      });
  }

  transitionTask(id: string, to: TaskState, opts?: { readonly verifierMemberId?: string }): Task {
    return this.txn(() => {
      const loaded = this.loadTask(id);
      const from = loaded.row.state as TaskState;
      // R5: same-state is a no-op — return before any side effect
      // (no generation/attempt bump, no updated_at rewrite).
      if (from === to) return this.toTask(loaded.row, loaded.deps, loaded.evidenceIds);
      assertTaskTransition(from, to);
      const now = nowIso();
      if (to === "leased") {
        if (loaded.row.owner_id === null) {
          throw new ProtocolError("VALIDATION_FAILED", `Task ${id} cannot be leased without an owner`, {
            taskId: id,
          });
        }
        // Ready -> leased: all dependencies must be accepted (spec §7).
        const depStates: Record<string, TaskState> = {};
        for (const depId of loaded.deps) {
          const dep = this.db.query<TaskRow, [string]>("SELECT * FROM tasks WHERE id = ?").get(depId);
          if (dep !== null) depStates[depId] = dep.state as TaskState;
        }
        if (!depsSatisfied(depStates)) {
          throw new ProtocolError("VALIDATION_FAILED", `Task ${id} blocked: dependencies not accepted`, {
            taskId: id,
          });
        }
        this.db
          .query<[], [string, string]>("UPDATE tasks SET generation = generation + 1, updated_at = ? WHERE id = ?")
          .run(now, id);
      }
      if (to === "accepted") {
        const verifier = opts?.verifierMemberId;
        if (verifier === undefined) {
          throw new ProtocolError("VALIDATION_FAILED", `Task ${id} acceptance requires a verifier member`, {
            taskId: id,
          });
        }
        assertVerifierAccept(loaded.row.owner_id, verifier);
        this.requireMemberInSwarm(verifier, loaded.row.swarm_id);
        // R6: acceptance requires REAL PASSING evidence — at least one
        // exit_code === 0 row. A failing-only evidence set (or none) keeps
        // the task in verifying. No override path in M1; an explicit
        // operator override (if ever needed) belongs to M1-02 with an
        // audit-trailed reason — see TODO(M1-02/R13).
        const passing = this.db
          .query<{ n: number }, [string]>(
            "SELECT COUNT(*) AS n FROM verification_evidence WHERE task_id = ? AND exit_code = 0",
          )
          .get(id);
        if (passing === null || passing.n === 0) {
          throw new ProtocolError(
            "VALIDATION_FAILED",
            `Task ${id} acceptance requires passing (exit_code 0) verification evidence`,
            { taskId: id },
          );
        }
      }
      const attemptBump = from === "verifying" && to === "ready" ? 1 : 0;
      this.db
        .query<[], [string, number, string, string]>(
          "UPDATE tasks SET state = ?, attempt = attempt + ?, updated_at = ? WHERE id = ?",
        )
        .run(to, attemptBump, now, id);
      const reloaded = this.loadTask(id);
      return this.toTask(reloaded.row, reloaded.deps, reloaded.evidenceIds);
    });
  }

  // --- Board posts (atomic sequence + fanout) ---

  appendPost(
    swarmId: string,
    input: AppendPostInput,
  ): { readonly post: BoardPost; readonly deduped: boolean; readonly wakeIds: readonly string[] } {
    const parsed = parseInput("post", () => AppendPostInputSchema.parse(input));
    return this.txn(() => {
      this.requireSwarm(swarmId);
      let author: MemberRow | null = null;
      if (parsed.authorMemberId !== null) {
        author = this.requireMemberInSwarm(parsed.authorMemberId, swarmId);
        if (author.internal_state === "killed") {
          throw new ProtocolError("KILLED_MEMBER", `Killed member ${author.id} cannot post`, {
            memberId: author.id,
          });
        }
      }
      if (parsed.relatedTaskId !== undefined) {
        const task = this.db
          .query<TaskRow, [string, string]>("SELECT * FROM tasks WHERE id = ? AND swarm_id = ?")
          .get(parsed.relatedTaskId, swarmId);
        if (task === null) {
          throw new ProtocolError("NOT_FOUND", `Task ${parsed.relatedTaskId} not found in swarm`, {
            taskId: parsed.relatedTaskId,
          });
        }
      }
      const existing = this.db
        .query<PostRow, [string, string]>("SELECT * FROM posts WHERE swarm_id = ? AND idempotency_key = ?")
        .get(swarmId, parsed.idempotencyKey);
      if (existing !== null) {
        return { post: this.toPost(existing), deduped: true, wakeIds: [] };
      }

      // Atomic sequence allocation: bump swarm revision, use it as the post
      // sequence — no MAX(sequence)+1, inside BEGIN IMMEDIATE.
      const bumped = this.db
        .query<{ revision: number }, [string, string]>(
          "UPDATE swarms SET revision = revision + 1, updated_at = ? WHERE id = ? RETURNING revision",
        )
        .get(nowIso(), swarmId);
      if (bumped === null) throw new ProtocolError("NOT_FOUND", `Swarm ${swarmId} not found`, { swarmId });
      const sequence: number = bumped.revision;

      const postId = crypto.randomUUID();
      const createdAt = nowIso();
      this.db
        .query<[], [string, string, number, string | null, string, string, string | null, string, string]>(
          `INSERT INTO posts (id, swarm_id, sequence, author_member_id, kind, body,
             related_task_id, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          postId,
          swarmId,
          sequence,
          parsed.authorMemberId,
          parsed.kind,
          parsed.body,
          parsed.relatedTaskId ?? null,
          parsed.idempotencyKey,
          createdAt,
        );

      // Resolve mentions against an immutable membership snapshot.
      const members = this.db
        .query<MemberRow, [string]>("SELECT * FROM members WHERE swarm_id = ?")
        .all(swarmId);
      const groupRows = this.db
        .query<{ member_id: string; group_name: string }, [string]>(
          "SELECT member_id, group_name FROM member_groups WHERE swarm_id = ?",
        )
        .all(swarmId);
      const groups: Record<string, string[]> = {};
      for (const g of groupRows) {
        const list = groups[g.group_name] ?? [];
        list.push(g.member_id);
        groups[g.group_name] = list;
      }
      const resolved = parseAndResolveMentions(
        parsed.body,
        {
          members: members.map((m) => ({ id: m.id, name: m.name, isKilled: m.internal_state === "killed" })),
          groups,
        },
      );

      const recipientIds = new Set<string>(resolved.memberIds);
      if (resolved.mentionAll) {
        for (const m of members) {
          if (m.internal_state !== "killed" && m.id !== parsed.authorMemberId) recipientIds.add(m.id);
        }
      }
      if (parsed.authorMemberId !== null) recipientIds.delete(parsed.authorMemberId);

      for (const memberId of recipientIds) {
        this.db
          .query<[], [string, string]>("INSERT OR IGNORE INTO post_recipients (post_id, member_id) VALUES (?, ?)")
          .run(postId, memberId);
      }
      for (const groupName of resolved.groupNames) {
        this.db
          .query<[], [string, string]>("INSERT OR IGNORE INTO post_groups (post_id, group_name) VALUES (?, ?)")
          .run(postId, groupName);
      }
      if (resolved.mentionAll) {
        this.db
          .query<[], [string, string]>("INSERT OR IGNORE INTO post_groups (post_id, group_name) VALUES (?, ?)")
          .run(postId, "@all");
      }

      // Fan out one wake intent per live recipient (killed never wakes).
      const wakeIds: string[] = [];
      const payloadHash = sha256hex(`post:${postId}`);
      for (const memberId of recipientIds) {
        const member = members.find((m) => m.id === memberId);
        if (member === undefined || member.internal_state === "killed") continue;
        const deliveryKey = computeDeliveryKey({
          memberId,
          memberGeneration: member.generation,
          reason: "mention",
          postSequence: sequence,
          taskId: parsed.relatedTaskId ?? null,
          payloadHash,
        });
        const wakeId = crypto.randomUUID();
        const inserted = this.db
          .query<{ id: string }, [string, string, string, number, number, string | null, string, string, string, string, string, string]>(
            `INSERT INTO wake_intents (id, swarm_id, member_id, member_generation, reason,
               post_sequence, task_id, payload_hash, state, created_at, updated_at, delivery_key)
             SELECT ?, ?, ?, ?, 'mention', ?, ?, ?, 'queued', ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM wake_intents WHERE swarm_id = ? AND delivery_key = ?)
             RETURNING id`,
          )
          .get(
            wakeId,
            swarmId,
            memberId,
            member.generation,
            sequence,
            parsed.relatedTaskId ?? null,
            payloadHash,
            createdAt,
            createdAt,
            deliveryKey,
            swarmId,
            deliveryKey,
          );
        if (inserted !== null) {
          wakeIds.push(inserted.id);
          this.enqueueOutbox("wake_queued", inserted.id, { wakeId: inserted.id, memberId, postSequence: sequence });
        }
      }

      this.enqueueOutbox("post_committed", postId, { postId, swarmId, sequence });
      const row = this.db.query<PostRow, [string]>("SELECT * FROM posts WHERE id = ?").get(postId);
      if (row === null) throw new ProtocolError("NOT_FOUND", "Post vanished after insert", { postId });
      return { post: this.toPost(row), deduped: false, wakeIds };
    });
  }

  getPostsAfter(swarmId: string, after: number, limit = 100): BoardPost[] {
    return this.db
      .query<PostRow, [string, number, number]>(
        "SELECT * FROM posts WHERE swarm_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
      )
      .all(swarmId, after, limit)
      .map((r) => this.toPost(r));
  }

  // --- Wake intents ---

  createWakeIntent(
    swarmId: string,
    input: CreateWakeIntentInput,
  ): { readonly intent: WakeIntent; readonly deduped: boolean } {
    const parsed = parseInput("wake-intent", () => CreateWakeIntentInputSchema.parse(input));
    return this.txn(() => {
      this.requireSwarm(swarmId);
      const member = this.requireMemberInSwarm(parsed.memberId, swarmId);
      if (member.internal_state === "killed") {
        throw new ProtocolError("KILLED_MEMBER", `Killed member ${member.id} cannot receive wakes`, {
          memberId: member.id,
        });
      }
      if (member.generation !== parsed.memberGeneration) {
        throw new ProtocolError(
          "STALE_GENERATION",
          `Wake generation ${parsed.memberGeneration} != member generation ${member.generation}`,
          { memberId: member.id },
        );
      }
      const deliveryKey = computeDeliveryKey({
        memberId: parsed.memberId,
        memberGeneration: parsed.memberGeneration,
        reason: parsed.reason,
        postSequence: parsed.postSequence ?? null,
        taskId: parsed.taskId ?? null,
        payloadHash: parsed.payloadHash,
      });
      const dupe = this.db
        .query<WakeRow, [string, string]>("SELECT * FROM wake_intents WHERE swarm_id = ? AND delivery_key = ?")
        .get(swarmId, deliveryKey);
      if (dupe !== null) return { intent: this.toWake(dupe), deduped: true };
      const id = crypto.randomUUID();
      const now = nowIso();
      try {
        this.db
          .query<[], [string, string, string, number, string, number | null, string | null, string, string, string, string]>(
            `INSERT INTO wake_intents (id, swarm_id, member_id, member_generation, reason,
               post_sequence, task_id, payload_hash, state, created_at, updated_at, delivery_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
          )
          .run(
            id,
            swarmId,
            parsed.memberId,
            parsed.memberGeneration,
            parsed.reason,
            parsed.postSequence ?? null,
            parsed.taskId ?? null,
            parsed.payloadHash,
            now,
            now,
            deliveryKey,
          );
      } catch (err) {
        // R11: SELECT-then-INSERT races under concurrency (or a fan-out
        // collision with an identical key). On UNIQUE violation, re-SELECT
        // the winner and report deduped:true instead of throwing.
        if (err instanceof Error && (err as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE") {
          const winner = this.db
            .query<WakeRow, [string, string]>("SELECT * FROM wake_intents WHERE swarm_id = ? AND delivery_key = ?")
            .get(swarmId, deliveryKey);
          if (winner !== null) return { intent: this.toWake(winner), deduped: true };
        }
        throw err;
      }
      this.enqueueOutbox("wake_queued", id, { wakeId: id, memberId: parsed.memberId, reason: parsed.reason });
      const row = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(id);
      if (row === null) throw new ProtocolError("NOT_FOUND", "Wake vanished after insert", { wakeId: id });
      return { intent: this.toWake(row), deduped: false };
    });
  }

  getWake(id: string): WakeIntent {
    const row = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(id);
    if (row === null) throw new ProtocolError("NOT_FOUND", `Wake ${id} not found`, { wakeId: id });
    return this.toWake(row);
  }

  listWakes(swarmId: string, state: WakeState, limit = 100): WakeIntent[] {
    return this.db
      .query<WakeRow, [string, string, number]>(
        "SELECT * FROM wake_intents WHERE swarm_id = ? AND state = ? ORDER BY created_at LIMIT ?",
      )
      .all(swarmId, state, limit)
      .map((r) => this.toWake(r));
  }

  // --- M2 wake engine (contract C-DB-01 extension; spec §§7, 8 M2) ---
  //
  // Durable exactly-once-logical wake queue on top of the M1-01 journal.
  // No schema change (no 003 migration): delivery_key UNIQUE (002) gives
  // one persisted logical action per (member|generation|reason|post|task|
  // payloadHash); the M1 `leases` table provides fencing tokens + TTLs for
  // member-turn serialization and quarantine markers; `outbox` carries the
  // persistent lifecycle records. Transport stays at-least-once — receipts
  // and acks are admission proof, never execution proof (spec §8 crash
  // window). Daemon owns durability; the harness owns backend mapping.
  //
  // Transition discipline: every mutation below runs inside ONE BEGIN
  // IMMEDIATE txn and honors protocol assertWakeTransition /
  // assertMemberTransition — never invents an edge (e.g. there is NO
  // admitted->queued edge, so transient submit failures keep their state,
  // bump attempts, release the member lease and schedule a bounded retry;
  // only the reconciler re-drives them after verifying the session is idle).

  /**
   * Claim a queued intent for dispatch (one live turn per member).
   * - stale (killed / generation drift) -> cancelled + deferred-stale.
   * - another admitted/observed_running turn exists -> deferred-live-turn.
   * - else -> admitted + deferred? no: admitted.
   */
  claimWakeIntent(id: string): ClaimResult {
    return this.txn(() => {
      const row = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(id);
      if (row === null) throw new ProtocolError("NOT_FOUND", `Wake ${id} not found`, { wakeId: id });
      if (row.state !== "queued") {
        throw new ProtocolError("INVALID_TRANSITION", `Wake ${id} is ${row.state}, not queued`, { wakeId: id });
      }
      const now = nowIso();
      const member = this.requireMember(row.member_id);
      if (member.internal_state === "killed" || member.generation !== row.member_generation) {
        this.db
          .query<[], [string, string]>("UPDATE wake_intents SET state = 'cancelled', updated_at = ? WHERE id = ?")
          .run(now, id);
        const updated = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(id);
        if (updated === null) throw new ProtocolError("NOT_FOUND", `Wake ${id} not found`, { wakeId: id });
        return { status: "deferred-stale", intent: this.toWake(updated) };
      }
      const live = this.db
        .query<{ id: string }, [string]>(
          "SELECT id FROM wake_intents WHERE member_id = ? AND state IN ('admitted','observed_running') LIMIT 1",
        )
        .get(row.member_id);
      if (live !== null) {
        this.db
          .query<[], [string]>("UPDATE wake_intents SET attempts = attempts + 1 WHERE id = ?")
          .run(id);
        const updated = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(id);
        if (updated === null) throw new ProtocolError("NOT_FOUND", `Wake ${id} not found`, { wakeId: id });
        return { status: "deferred-live-turn", intent: this.toWake(updated) };
      }
      this.db
        .query<[], [string, string]>(
          "UPDATE wake_intents SET state = 'admitted', attempts = attempts + 1, updated_at = ? WHERE id = ?",
        )
        .run(now, id);
      const updated = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(id);
      if (updated === null) throw new ProtocolError("NOT_FOUND", `Wake ${id} not found`, { wakeId: id });
      return { status: "admitted", intent: this.toWake(updated) };
    });
  }

  setWakeState(id: string, to: WakeState): WakeIntent {
    // R4: SELECT-guard-UPDATE inside ONE txn — the guard and the write
    // must not interleave with a concurrent claim/cancel. R5: same-state
    // returns the current row with no write (no updated_at touch).
    return this.txn(() => {
      const row = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(id);
      if (row === null) throw new ProtocolError("NOT_FOUND", `Wake ${id} not found`, { wakeId: id });
      if ((row.state as WakeState) === to) return this.toWake(row);
      assertWakeTransition(row.state as WakeState, to);
      this.db
        .query<[], [string, string, string]>("UPDATE wake_intents SET state = ?, updated_at = ? WHERE id = ?")
        .run(to, nowIso(), id);
      const updated = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(id);
      if (updated === null) throw new ProtocolError("NOT_FOUND", `Wake ${id} not found`, { wakeId: id });
      return this.toWake(updated);
    });
  }

  // --- M2 wake engine: lease/ack/retry/backoff/quota (spec §§7, 8 M2) ---
  //
  // All methods below operate ONLY on wake_intents + members + leases +
  // outbox (no other tables, no schema change). Each mutating method runs
  // in ONE BEGIN IMMEDIATE txn and appends an outbox lifecycle record in
  // the SAME txn (atomic commit: state change and its record land or
  // neither does — the persistent lifecycle trail).
  //
  // Fencing: `leases` row `member-turn:{memberId}` = {holder: wakeId,
  // fencing_token: monotonic via the `lease_fencing_high_water` table (F-A:
  // strictly increasing across release/re-acquire cycles and restarts),
  // expires_at}. Exactly one holder per member; ack/complete validate the
  // token when supplied. Quarantine markers use `wake-quarantine:{wakeId}`
  // rows (holder "quarantine", 24h review-after TTL) so an ambiguous wake
  // can never auto-dispatch — not while live, and not after expiry either:
  // an expired marker routes to the operator re-review queue
  // (`listWakesNeedingQuarantineReview`, F-B) instead of becoming
  // dispatchable. `outbox` carries the persistent lifecycle records.
  //
  // Backoff: attempts-driven bounded exponential backoff with jitter for
  // TRANSIENT transport failures only (429/5xx/network/timeout). Quota
  // (402) NEVER schedules a retry — it quota-pauses the member. The gate
  // is deterministic: dispatchers skip wakes whose
  // updated_at + ceiling(attempts) is in the future.

  /** Member states that may receive a dispatched turn (spec §7.1). */
  // (Exported constants live at module scope below the class.)

  private leaseKeyForMember(memberId: string): string {
    return `member-turn:${memberId}`;
  }

  private quarantineKeyForWake(wakeId: string): string {
    return `wake-quarantine:${wakeId}`;
  }

  private readLease(resourceKey: string): { holder: string; fencingToken: number; expiresAt: string } | null {
    const row = this.db
      .query<{ resource_key: string; holder: string; fencing_token: number; expires_at: string }, [string]>(
        "SELECT resource_key, holder, fencing_token, expires_at FROM leases WHERE resource_key = ?",
      )
      .get(resourceKey);
    if (row === null) return null;
    return { holder: row.holder, fencingToken: row.fencing_token, expiresAt: row.expires_at };
  }

  /**
   * F-A fencing high-water (M8; M5 IntegrationLock precedent): `deleteLease`
   * DELETES the `leases` row so `getWakeLeaseInfo` stays null-after-release,
   * but a bare DELETE resets the next acquire token to 1 — the same token
   * repeats across release/re-acquire cycles. This table retains the
   * monotonic high-water per member-turn `resource_key` so every acquire
   * strictly exceeds every previously issued token, including across
   * release cycles and restarts. Quarantine markers (`wake-quarantine:*`)
   * are per-wake single-use (never re-acquired under the same key) and are
   * excluded, so the table cannot grow one row per wake.
   * Service-owned ensure (CREATE TABLE IF NOT EXISTS, same precedent as
   * the M5 `integration_runs` ensure): safe on legacy DBs that predate
   * this table. FAIL-CLOSED: any DDL/read/write failure throws — never a
   * silent fallback that could let the next token reuse a retired value.
   */
  private static readonly FENCING_HIGH_WATER_DDL = `CREATE TABLE IF NOT EXISTS lease_fencing_high_water (
  resource_key TEXT PRIMARY KEY,
  fencing_token INTEGER NOT NULL
);`;

  private ensureFencingHighWater(): void {
    try {
      this.db.exec(SwarmStore.FENCING_HIGH_WATER_DDL);
    } catch (err) {
      throw new Error(
        `Fencing high-water unavailable (DDL failed, fail-closed): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private readFencingHighWater(resourceKey: string): number {
    this.ensureFencingHighWater();
    let row: { fencing_token: number } | null;
    try {
      row = this.db
        .query<{ fencing_token: number }, [string]>(
          "SELECT fencing_token FROM lease_fencing_high_water WHERE resource_key = ?",
        )
        .get(resourceKey);
    } catch (err) {
      throw new Error(
        `Fencing high-water unavailable (read failed, fail-closed): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const value = row?.fencing_token;
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  }

  private recordFencingHighWater(resourceKey: string, token: number): void {
    const safe = Number.isFinite(token) && token >= 0 ? Math.floor(token) : 0;
    try {
      this.ensureFencingHighWater();
      this.db
        .query<[], [string, number]>(
          "INSERT INTO lease_fencing_high_water (resource_key, fencing_token) VALUES (?, ?) " +
            "ON CONFLICT(resource_key) DO UPDATE SET fencing_token = excluded.fencing_token " +
            "WHERE excluded.fencing_token > lease_fencing_high_water.fencing_token",
        )
        .run(resourceKey, safe);
    } catch (err) {
      throw new Error(
        `Fencing high-water write failed (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private writeLease(resourceKey: string, holder: string, now: string, ttlMs: number): { fencingToken: number; expiresAt: string } {
    // F-A: seed from the durable high-water so a token can never repeat
    // across release/re-acquire cycles (`deleteLease` removes the `leases`
    // row, so the live row alone always restarts at 1). The high-water is
    // reserved BEFORE the lease write: a crash between the two leaves a
    // gap (safe), never a reuse. The caller holds the write txn, so the
    // reserve+write pair is atomic on the happy path.
    let highWater = 0;
    const tracked = resourceKey.startsWith("member-turn:");
    if (tracked) highWater = this.readFencingHighWater(resourceKey);
    const existing = this.readLease(resourceKey);
    const liveToken =
      typeof existing?.fencingToken === "number" &&
      Number.isFinite(existing.fencingToken) &&
      existing.fencingToken >= 0
        ? Math.floor(existing.fencingToken)
        : 0;
    const fencingToken = Math.max(liveToken, highWater) + 1;
    if (!Number.isFinite(fencingToken) || fencingToken <= 0) {
      throw new Error(`Fencing token overflow (fail-closed) for ${resourceKey}`);
    }
    if (tracked) this.recordFencingHighWater(resourceKey, fencingToken);
    const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
    this.db
      .query<[], [string, string, number, string]>(
        "INSERT OR REPLACE INTO leases (resource_key, holder, fencing_token, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(resourceKey, holder, fencingToken, expiresAt);
    return { fencingToken, expiresAt };
  }

  private deleteLease(resourceKey: string, holder: string): boolean {
    const outcome = this.db
      .query<unknown, [string, string]>("DELETE FROM leases WHERE resource_key = ? AND holder = ?")
      .run(resourceKey, holder) as unknown as { changes?: number };
    return (outcome?.changes ?? 0) > 0;
  }

  private leaseLive(lease: { expiresAt: string } | null, now: string): boolean {
    return lease !== null && lease.expiresAt > now;
  }

  private wakeLifecycleEvent(kind: string, aggregateId: string, payload: Record<string, string>): void {
    this.enqueueOutbox(kind, aggregateId, payload);
  }

  /**
   * M2 fenced claim: like claimWakeIntent but with a fencing-token lease,
   * member activation (waiting/starting/recovering -> working, spec §7.1:
   * "Waiting -> Working: durable mention/assignment admitted"), backoff
   * gating, quarantine and ineligible-state guards. All in ONE txn.
   */
  claimWakeForDispatch(
    id: string,
    opts?: { readonly leaseTtlMs?: number; readonly correlationId?: string; readonly nowIso?: string; readonly baseMs?: number; readonly capMs?: number },
  ): WakeDispatchClaim {
    const leaseTtlMs = opts?.leaseTtlMs ?? WAKE_LEASE_TTL_MS_DEFAULT;
    const correlationId = opts?.correlationId ?? crypto.randomUUID();
    const baseMs = opts?.baseMs ?? WAKE_BACKOFF_BASE_MS_DEFAULT;
    const capMs = opts?.capMs ?? WAKE_BACKOFF_CAP_MS_DEFAULT;
    return this.txn(() => {
      const now = opts?.nowIso ?? nowIso();
      const row = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(id);
      if (row === null) throw new ProtocolError("NOT_FOUND", `Wake ${id} not found`, { wakeId: id });
      // S2-2 in-txn paused-swarm guard: the dispatcher's volatile
      // pre-check races lifecycle transitions, so the authoritative swarm
      // status is re-read HERE inside the claim txn. Paused/terminal never
      // admits, activates, or leases — the wake stays queued for resume.
      const swarmStatus = this.requireSwarm(row.swarm_id).status;
      if (
        swarmStatus === "paused" ||
        swarmStatus === "completing" ||
        swarmStatus === "completed" ||
        swarmStatus === "failed" ||
        swarmStatus === "cancelled"
      ) {
        this.wakeLifecycleEvent("wake_deferred", id, {
          wakeId: id, memberId: row.member_id, correlationId, reason: `swarm-${swarmStatus}`,
        });
        return { status: "deferred-ineligible", intent: this.toWake(row) };
      }
      if (row.state !== "queued") {
        const live = this.db
          .query<{ id: string }, [string]>(
            "SELECT id FROM wake_intents WHERE member_id = ? AND state IN ('admitted','observed_running') LIMIT 1",
          )
          .get(row.member_id);
        if (live !== null) {
          const current = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(id);
          if (current === null) throw new ProtocolError("NOT_FOUND", `Wake ${id} not found`, { wakeId: id });
          return { status: "deferred-live-turn", intent: this.toWake(current) };
        }
        throw new ProtocolError("INVALID_TRANSITION", `Wake ${id} is ${row.state}, not queued`, { wakeId: id });
      }
      const member = this.requireMember(row.member_id);
      if (member.internal_state === "killed" || member.generation !== row.member_generation) {
        this.db
          .query<[], [string, string]>("UPDATE wake_intents SET state = 'cancelled', updated_at = ? WHERE id = ?")
          .run(now, id);
        this.wakeLifecycleEvent("wake_cancelled_stale", id, {
          wakeId: id, memberId: row.member_id, correlationId, reason: "stale-generation-or-killed",
        });
        const updated = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(id);
        if (updated === null) throw new ProtocolError("NOT_FOUND", `Wake ${id} not found`, { wakeId: id });
        return { status: "deferred-stale", intent: this.toWake(updated) };
      }
      if (
        member.internal_state === "quota_paused" ||
        member.internal_state === "approval_paused"
      ) {
        this.wakeLifecycleEvent("wake_deferred", id, {
          wakeId: id, memberId: row.member_id, correlationId, reason: `ineligible-member-state:${member.internal_state}`,
        });
        return { status: "deferred-ineligible", intent: this.toWake(row) };
      }
      // Backoff gate: a transiently-failed wake is not claimable until its
      // deterministic ceiling elapses. No attempts bump here (no storm).
      if (row.attempts > 0 && wakeNotBeforeMs(row.updated_at, row.attempts, baseMs, capMs, Date.parse(now)) > Date.parse(now)) {
        this.wakeLifecycleEvent("wake_deferred", id, {
          wakeId: id, memberId: row.member_id, correlationId, reason: "backoff-pending",
        });
        return { status: "deferred-backoff", intent: this.toWake(row) };
      }
      const live = this.db
        .query<{ id: string }, [string]>(
          "SELECT id FROM wake_intents WHERE member_id = ? AND state IN ('admitted','observed_running') LIMIT 1",
        )
        .get(row.member_id);
      if (live !== null) {
        // Coalesce behind the live turn: no attempts bump (a deferral is
        // not a failure), just a durable outbox note + the queued row.
        this.wakeLifecycleEvent("wake_deferred", id, {
          wakeId: id, memberId: row.member_id, correlationId, reason: "live-turn-active",
        });
        return { status: "deferred-live-turn", intent: this.toWake(row) };
      }
      // Quarantine marker: ambiguous wakes never auto-dispatch (F-B).
      // A LIVE marker defers with reason "quarantined"; a TTL-EXPIRED
      // marker defers with "quarantine-expired-needs-review" and waits for
      // the operator re-review queue — expiry never re-admits the wake.
      const quarantine = this.readLease(this.quarantineKeyForWake(id));
      if (quarantine !== null) {
        this.wakeLifecycleEvent("wake_deferred", id, {
          wakeId: id, memberId: row.member_id, correlationId,
          reason: this.leaseLive(quarantine, now) ? "quarantined" : "quarantine-expired-needs-review",
        });
        return { status: "deferred-quarantined", intent: this.toWake(row) };
      }
      // Member-turn lease: exactly one holder per member (one live turn).
      const memberLease = this.readLease(this.leaseKeyForMember(row.member_id));
      if (this.leaseLive(memberLease, now) && memberLease !== null && memberLease.holder !== id) {
        this.wakeLifecycleEvent("wake_deferred", id, {
          wakeId: id, memberId: row.member_id, correlationId, reason: `lease-held-by:${memberLease.holder}`,
        });
        return { status: "deferred-live-turn", intent: this.toWake(row) };
      }
      // Activate the member (spec §7.1 Waiting -> Working on admission).
      const internal = member.internal_state;
      if (internal === "waiting" || internal === "starting" || internal === "recovering") {
        assertMemberTransition(internal, "working");
        this.db
          .query<[], [string, string, string]>(
            "UPDATE members SET internal_state = 'working', public_state = ?, last_activity_at = ? WHERE id = ?",
          )
          .run(projectPublicState("working"), now, member.id);
      }
      const lease = this.writeLease(this.leaseKeyForMember(row.member_id), id, now, leaseTtlMs);
      this.db
        .query<[], [string, string]>(
          "UPDATE wake_intents SET state = 'admitted', attempts = attempts + 1, updated_at = ? WHERE id = ?",
        )
        .run(now, id);
      this.wakeLifecycleEvent("wake_admitted", id, {
        wakeId: id,
        memberId: row.member_id,
        correlationId,
        fencingToken: String(lease.fencingToken),
        leaseExpiresAt: lease.expiresAt,
      });
      const updated = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(id);
      if (updated === null) throw new ProtocolError("NOT_FOUND", `Wake ${id} not found`, { wakeId: id });
      return {
        status: "admitted",
        intent: this.toWake(updated),
        fencingToken: lease.fencingToken,
        leaseExpiresAt: lease.expiresAt,
        correlationId,
      };
    });
  }

  /**
   * Ack a successfully admitted turn as observed-running. Idempotent:
   * double-ack (at-least-once transport redelivery) returns the current
   * row when already observed_running. Fencing token is enforced when a
   * live member lease names a different holder.
   */
  ackWakeObservedRunning(id: string, fencingToken?: number): WakeIntent {
    return this.txn(() => {
      const now = nowIso();
      const row = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(id);
      if (row === null) throw new ProtocolError("NOT_FOUND", `Wake ${id} not found`, { wakeId: id });
      if (row.state === "observed_running") {
        this.assertWakeFencing(row.member_id, id, fencingToken);
        return this.toWake(row);
      }
      assertWakeTransition(row.state as WakeState, "observed_running");
      this.assertWakeFencing(row.member_id, id, fencingToken);
      this.db
        .query<[], [string, string]>("UPDATE wake_intents SET state = 'observed_running', updated_at = ? WHERE id = ?")
        .run(now, id);
      this.wakeLifecycleEvent("wake_observed_running", id, { wakeId: id, memberId: row.member_id });
      const updated = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(id);
      if (updated === null) throw new ProtocolError("NOT_FOUND", `Wake ${id} not found`, { wakeId: id });
      return this.toWake(updated);
    });
  }

  /**
   * Complete a wake (succeeded | failed | cancelled). `admitted ->
   * succeeded` chains through observed_running inside the same txn (the
   * direct edge does not exist; the two-step path is recorded in the
   * outbox payload). Releases the member lease when this wake holds it.
   */
  completeWake(
    id: string,
    outcome: "succeeded" | "failed" | "cancelled",
    fencingToken?: number,
    correlationId?: string,
  ): WakeIntent {
    return this.txn(() => {
      const now = nowIso();
      const cid = correlationId ?? crypto.randomUUID();
      const row = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(id);
      if (row === null) throw new ProtocolError("NOT_FOUND", `Wake ${id} not found`, { wakeId: id });
      if (row.state === outcome) return this.toWake(row);
      this.assertWakeFencing(row.member_id, id, fencingToken);
      let from = row.state as WakeState;
      if (from === "admitted" && outcome === "succeeded") {
        assertWakeTransition("admitted", "observed_running");
        this.db
          .query<[], [string, string]>("UPDATE wake_intents SET state = 'observed_running', updated_at = ? WHERE id = ?")
          .run(now, id);
        from = "observed_running";
      }
      assertWakeTransition(from, outcome);
      this.db
        .query<[], [string, string, string]>("UPDATE wake_intents SET state = ?, updated_at = ? WHERE id = ?")
        .run(outcome, now, id);
      this.deleteLease(this.leaseKeyForMember(row.member_id), id);
      this.wakeLifecycleEvent("wake_completed", id, {
        wakeId: id, memberId: row.member_id, correlationId: cid, outcome, via: from === row.state ? from : `${row.state}->${from}`,
      });
      const updated = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(id);
      if (updated === null) throw new ProtocolError("NOT_FOUND", `Wake ${id} not found`, { wakeId: id });
      return this.toWake(updated);
    });
  }

  /**
   * Record a TRANSIENT transport failure (429/5xx/network/timeout — never
   * quota). Keeps the current state (no admitted->queued edge exists),
   * bumps attempts, releases the member lease, and schedules a bounded
   * exp-backoff retry. Past maxAttempts the wake is terminally closed
   * (admitted -> failed; queued -> cancelled) instead of retried forever.
   */
  failWakeTransient(
    id: string,
    opts?: {
      readonly fencingToken?: number;
      readonly correlationId?: string;
      readonly baseMs?: number;
      readonly capMs?: number;
      readonly maxAttempts?: number;
      readonly rand?: () => number;
      readonly nowIso?: string;
    },
  ): { readonly intent: WakeIntent; readonly scheduled: boolean; readonly exhausted: boolean; readonly notBefore: string; readonly attempts: number; readonly correlationId: string } {
    const baseMs = opts?.baseMs ?? WAKE_BACKOFF_BASE_MS_DEFAULT;
    const capMs = opts?.capMs ?? WAKE_BACKOFF_CAP_MS_DEFAULT;
    const maxAttempts = opts?.maxAttempts ?? WAKE_MAX_ATTEMPTS_DEFAULT;
    const rand = opts?.rand ?? Math.random;
    const cid = opts?.correlationId ?? crypto.randomUUID();
    return this.txn(() => {
      const now = opts?.nowIso ?? nowIso();
      const row = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(id);
      if (row === null) throw new ProtocolError("NOT_FOUND", `Wake ${id} not found`, { wakeId: id });
      if (row.state !== "queued" && row.state !== "admitted") {
        throw new ProtocolError("INVALID_TRANSITION", `Transient retry needs queued/admitted, not ${row.state}`, { wakeId: id });
      }
      this.assertWakeFencing(row.member_id, id, opts?.fencingToken);
      const attempts = row.attempts + 1;
      const delayMs = wakeBackoffDelayMs(attempts, baseMs, capMs, rand);
      const notBefore = new Date(Date.parse(now) + delayMs).toISOString();
      this.deleteLease(this.leaseKeyForMember(row.member_id), id);
      if (attempts >= maxAttempts) {
        // Bounded retries exhausted: close terminally, never loop forever.
        const terminal = row.state === "admitted" ? "failed" : "cancelled";
        assertWakeTransition(row.state as WakeState, terminal);
        this.db
          .query<[], [string, number, string, string]>("UPDATE wake_intents SET state = ?, attempts = ?, updated_at = ? WHERE id = ?")
          .run(terminal, attempts, now, id);
        this.wakeLifecycleEvent("wake_completed", id, {
          wakeId: id, memberId: row.member_id, correlationId: cid, outcome: terminal, reason: "retry-budget-exhausted",
        });
        const updated = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(id);
        if (updated === null) throw new ProtocolError("NOT_FOUND", `Wake ${id} not found`, { wakeId: id });
        return { intent: this.toWake(updated), scheduled: false, exhausted: true, notBefore, attempts, correlationId: cid };
      }
      this.db
        .query<[], [number, string, string]>("UPDATE wake_intents SET attempts = ?, updated_at = ? WHERE id = ?")
        .run(attempts, now, id);
      this.wakeLifecycleEvent("wake_retry_scheduled", id, {
        wakeId: id, memberId: row.member_id, correlationId: cid, attempts: String(attempts), notBefore, delayMs: String(delayMs),
      });
      const updated = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(id);
      if (updated === null) throw new ProtocolError("NOT_FOUND", `Wake ${id} not found`, { wakeId: id });
      return { intent: this.toWake(updated), scheduled: true, exhausted: false, notBefore, attempts, correlationId: cid };
    });
  }

  /**
   * F-01 non-budget deferral for pre-transport checks (live session, snapshot
   * unavailable, already-terminal externalId): releases the member-turn lease
   * WITHOUT bumping attempts, touching updated_at, or changing wake state,
   * and returns the deterministic notBefore gate. A deferral is not a
   * failure — retry budget is consumed ONLY by actual transport attempts
   * (failWakeTransient). All in ONE txn.
   */
  deferWakeWithoutBudget(
    id: string,
    opts?: {
      readonly correlationId?: string;
      readonly reason?: string;
      readonly baseMs?: number;
      readonly capMs?: number;
    },
  ): { readonly intent: WakeIntent; readonly notBefore: string; readonly correlationId: string } {
    const baseMs = opts?.baseMs ?? WAKE_BACKOFF_BASE_MS_DEFAULT;
    const capMs = opts?.capMs ?? WAKE_BACKOFF_CAP_MS_DEFAULT;
    const cid = opts?.correlationId ?? crypto.randomUUID();
    return this.txn(() => {
      const row = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(id);
      if (row === null) throw new ProtocolError("NOT_FOUND", `Wake ${id} not found`, { wakeId: id });
      if (row.state !== "queued" && row.state !== "admitted") {
        throw new ProtocolError("INVALID_TRANSITION", `Deferral needs queued/admitted, not ${row.state}`, { wakeId: id });
      }
      this.deleteLease(this.leaseKeyForMember(row.member_id), id);
      const notBefore =
        row.attempts > 0
          ? new Date(wakeNotBeforeMs(row.updated_at, row.attempts, baseMs, capMs)).toISOString()
          : nowIso();
      this.wakeLifecycleEvent("wake_deferred", id, {
        wakeId: id, memberId: row.member_id, correlationId: cid, reason: opts?.reason ?? "pre-dispatch-deferral",
      });
      const updated = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(id);
      if (updated === null) throw new ProtocolError("NOT_FOUND", `Wake ${id} not found`, { wakeId: id });
      return { intent: this.toWake(updated), notBefore, correlationId: cid };
    });
  }

  /**
   * Record a quota (402) refusal: quota-pause the member and NEVER
   * schedule an automatic paid retry. The wake keeps its state; dispatch
   * stays blocked until an operator/post/model-switch resume. When the
   * member transition is illegal from its current state, the wake is
   * quarantined instead so it still cannot auto-retry.
   */
  markQuotaBlocked(
    memberId: string,
    wakeId?: string,
    correlationId?: string,
  ): { readonly member: Member; readonly memberTransition: "applied" | "already" | "skipped-illegal"; readonly quarantinedWakeId: string | null } {
    return this.txn(() => {
      const now = nowIso();
      const cid = correlationId ?? crypto.randomUUID();
      const member = this.requireMember(memberId);
      let transition: "applied" | "already" | "skipped-illegal" = "already";
      let quarantinedWakeId: string | null = null;
      if (member.internal_state !== "quota_paused") {
        try {
          assertMemberTransition(member.internal_state as InternalMemberState, "quota_paused");
          this.db
            .query<[], [string, string, string]>(
              "UPDATE members SET internal_state = 'quota_paused', public_state = ?, last_activity_at = ? WHERE id = ?",
            )
            .run(projectPublicState("quota_paused"), now, memberId);
          transition = "applied";
        } catch (err) {
          if (err instanceof ProtocolError && err.code === "INVALID_TRANSITION") {
            transition = "skipped-illegal";
          } else {
            throw err;
          }
        }
      }
      if (wakeId !== undefined) {
        const row = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(wakeId);
        if (row === null) throw new ProtocolError("NOT_FOUND", `Wake ${wakeId} not found`, { wakeId });
        this.deleteLease(this.leaseKeyForMember(memberId), wakeId);
        this.wakeLifecycleEvent("wake_quota_blocked", wakeId, {
          wakeId, memberId, correlationId: cid, memberTransition: transition, attempts: String(row.attempts),
        });
        if (transition === "skipped-illegal" && row.state !== "succeeded" && row.state !== "failed" && row.state !== "cancelled") {
          this.writeLease(this.quarantineKeyForWake(wakeId), "quarantine", now, WAKE_QUARANTINE_TTL_MS);
          this.wakeLifecycleEvent("wake_quarantined", wakeId, {
            wakeId, memberId, correlationId: cid, reason: "quota-block-with-illegal-member-transition",
          });
          quarantinedWakeId = wakeId;
        }
      } else {
        this.wakeLifecycleEvent("wake_quota_blocked", memberId, { memberId, correlationId: cid, memberTransition: transition });
      }
      return { member: this.toMember(this.requireMember(memberId)), memberTransition: transition, quarantinedWakeId };
    });
  }

  /** Release a member-turn lease held by the given wake (reconciler path). */
  releaseWakeLease(memberId: string, holderWakeId: string): boolean {
    return this.txn(() => this.deleteLease(this.leaseKeyForMember(memberId), holderWakeId));
  }

  /**
   * Re-acquire the member-turn lease for an ADMITTED wake whose lease was
   * lost (crash between claim and submitTurn). Same guards as the fenced
   * claim, but the wake is already admitted so no state edge is needed —
   * the reconciler verified the session idle first, and the dispatcher
   * re-verifies before submitting the SAME externalId (no duplicate
   * logical action, never blind replay).
   */
  reacquireWakeLease(
    id: string,
    opts?: { readonly leaseTtlMs?: number; readonly correlationId?: string; readonly nowIso?: string; readonly baseMs?: number; readonly capMs?: number },
  ): WakeDispatchClaim {
    const leaseTtlMs = opts?.leaseTtlMs ?? WAKE_LEASE_TTL_MS_DEFAULT;
    const correlationId = opts?.correlationId ?? crypto.randomUUID();
    const baseMs = opts?.baseMs ?? WAKE_BACKOFF_BASE_MS_DEFAULT;
    const capMs = opts?.capMs ?? WAKE_BACKOFF_CAP_MS_DEFAULT;
    return this.txn(() => {
      const now = opts?.nowIso ?? nowIso();
      const row = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(id);
      if (row === null) throw new ProtocolError("NOT_FOUND", `Wake ${id} not found`, { wakeId: id });
      // S2-2 in-txn paused-swarm guard (mirror of the claim guard): a
      // paused/terminal swarm never re-acquires — the admitted wake is
      // preserved untouched (no state edge, no lease write) for resume.
      const swarmStatus = this.requireSwarm(row.swarm_id).status;
      if (
        swarmStatus === "paused" ||
        swarmStatus === "completing" ||
        swarmStatus === "completed" ||
        swarmStatus === "failed" ||
        swarmStatus === "cancelled"
      ) {
        this.wakeLifecycleEvent("wake_deferred", id, {
          wakeId: id, memberId: row.member_id, correlationId, reason: `swarm-${swarmStatus}`,
        });
        return { status: "deferred-ineligible", intent: this.toWake(row) };
      }
      if (row.state !== "admitted") {
        throw new ProtocolError("INVALID_TRANSITION", `Re-acquire needs admitted, not ${row.state}`, { wakeId: id });
      }
      const member = this.requireMember(row.member_id);
      if (member.internal_state === "killed" || member.generation !== row.member_generation) {
        this.db
          .query<[], [string, string]>("UPDATE wake_intents SET state = 'cancelled', updated_at = ? WHERE id = ?")
          .run(now, id);
        this.wakeLifecycleEvent("wake_cancelled_stale", id, {
          wakeId: id, memberId: row.member_id, correlationId, reason: "stale-generation-or-killed",
        });
        const updated = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(id);
        if (updated === null) throw new ProtocolError("NOT_FOUND", `Wake ${id} not found`, { wakeId: id });
        return { status: "deferred-stale", intent: this.toWake(updated) };
      }
      if (member.internal_state === "quota_paused" || member.internal_state === "approval_paused") {
        this.wakeLifecycleEvent("wake_deferred", id, {
          wakeId: id, memberId: row.member_id, correlationId, reason: `ineligible-member-state:${member.internal_state}`,
        });
        return { status: "deferred-ineligible", intent: this.toWake(row) };
      }
      if (row.attempts > 0 && wakeNotBeforeMs(row.updated_at, row.attempts, baseMs, capMs, Date.parse(now)) > Date.parse(now)) {
        this.wakeLifecycleEvent("wake_deferred", id, {
          wakeId: id, memberId: row.member_id, correlationId, reason: "backoff-pending",
        });
        return { status: "deferred-backoff", intent: this.toWake(row) };
      }
      const other = this.db
        .query<{ id: string }, [string, string]>(
          "SELECT id FROM wake_intents WHERE member_id = ? AND id != ? AND state IN ('admitted','observed_running') LIMIT 1",
        )
        .get(row.member_id, id);
      if (other !== null) {
        this.wakeLifecycleEvent("wake_deferred", id, {
          wakeId: id, memberId: row.member_id, correlationId, reason: `live-turn-active:${other.id}`,
        });
        return { status: "deferred-live-turn", intent: this.toWake(row) };
      }
      const quarantine = this.readLease(this.quarantineKeyForWake(id));
      if (quarantine !== null) {
        this.wakeLifecycleEvent("wake_deferred", id, {
          wakeId: id, memberId: row.member_id, correlationId,
          reason: this.leaseLive(quarantine, now) ? "quarantined" : "quarantine-expired-needs-review",
        });
        return { status: "deferred-quarantined", intent: this.toWake(row) };
      }
      const internal = member.internal_state;
      if (internal === "waiting" || internal === "starting" || internal === "recovering") {
        assertMemberTransition(internal, "working");
        this.db
          .query<[], [string, string, string]>(
            "UPDATE members SET internal_state = 'working', public_state = ?, last_activity_at = ? WHERE id = ?",
          )
          .run(projectPublicState("working"), now, member.id);
      }
      const lease = this.writeLease(this.leaseKeyForMember(row.member_id), id, now, leaseTtlMs);
      this.wakeLifecycleEvent("wake_admitted", id, {
        wakeId: id, memberId: row.member_id, correlationId,
        fencingToken: String(lease.fencingToken), leaseExpiresAt: lease.expiresAt, reacquired: "true",
      });
      return {
        status: "admitted", intent: this.toWake(row),
        fencingToken: lease.fencingToken, leaseExpiresAt: lease.expiresAt, correlationId,
      };
    });
  }

  /** Deterministic retry gate for an admitted wake (null when immediately retryable). */
  wakeRetryNotBefore(id: string, baseMs: number = WAKE_BACKOFF_BASE_MS_DEFAULT, capMs: number = WAKE_BACKOFF_CAP_MS_DEFAULT): string | null {
    const row = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(id);
    if (row === null) throw new ProtocolError("NOT_FOUND", `Wake ${id} not found`, { wakeId: id });
    if (row.attempts <= 0) return null;
    return new Date(wakeNotBeforeMs(row.updated_at, row.attempts, baseMs, capMs)).toISOString();
  }

  /** Inspect the live member-turn lease (null when free/expired-unknown). */
  getWakeLeaseInfo(memberId: string): { holder: string; fencingToken: number; expiresAt: string } | null {
    return this.readLease(this.leaseKeyForMember(memberId));
  }

  /**
   * Quarantine an ambiguous wake (lost-ack, unknown admission outcome):
   * persistent marker + outbox record, NO state change, NO resubmit.
   * F-B: the marker blocks auto-dispatch while live AND after its TTL
   * elapses (expired markers wait in `listWakesNeedingQuarantineReview`,
   * never auto-admit). Clear only via clearWakeQuarantine after operator
   * review, or close terminally via cancelStaleWake.
   */
  quarantineWake(id: string, reason: string, correlationId?: string): WakeIntent {
    return this.txn(() => {
      const now = nowIso();
      const cid = correlationId ?? crypto.randomUUID();
      const row = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(id);
      if (row === null) throw new ProtocolError("NOT_FOUND", `Wake ${id} not found`, { wakeId: id });
      if (row.state === "succeeded" || row.state === "failed" || row.state === "cancelled") {
        throw new ProtocolError("INVALID_TRANSITION", `Cannot quarantine terminal wake ${id} (${row.state})`, { wakeId: id });
      }
      this.writeLease(this.quarantineKeyForWake(id), "quarantine", now, WAKE_QUARANTINE_TTL_MS);
      this.wakeLifecycleEvent("wake_quarantined", id, { wakeId: id, memberId: row.member_id, correlationId: cid, reason });
      const updated = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(id);
      if (updated === null) throw new ProtocolError("NOT_FOUND", `Wake ${id} not found`, { wakeId: id });
      return this.toWake(updated);
    });
  }

  /** Clear a quarantine marker after operator review (persistent record). */
  clearWakeQuarantine(id: string, correlationId?: string): WakeIntent {
    return this.txn(() => {
      const cid = correlationId ?? crypto.randomUUID();
      const row = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(id);
      if (row === null) throw new ProtocolError("NOT_FOUND", `Wake ${id} not found`, { wakeId: id });
      this.db.query<[], [string]>("DELETE FROM leases WHERE resource_key = ?").run(this.quarantineKeyForWake(id));
      this.wakeLifecycleEvent("wake_quarantine_cleared", id, { wakeId: id, memberId: row.member_id, correlationId: cid });
      return this.toWake(row);
    });
  }

  /** True when a live (unexpired) quarantine marker names this wake. */
  isWakeQuarantined(id: string, now?: string): boolean {
    return this.leaseLive(this.readLease(this.quarantineKeyForWake(id)), now ?? nowIso());
  }

  /**
   * F-B: true when a quarantine marker exists for this wake AND its TTL
   * has elapsed — operator re-review is due. The wake is still blocked
   * from auto-dispatch (claim/reacquire/eligible-list gates treat any
   * marker as quarantined); it becomes dispatchable only via
   * `clearWakeQuarantine` after review, or terminal via `cancelStaleWake`.
   */
  isWakeQuarantineReviewDue(id: string, now?: string): boolean {
    const marker = this.readLease(this.quarantineKeyForWake(id));
    if (marker === null) return false;
    return !this.leaseLive(marker, now ?? nowIso());
  }

  /**
   * F-B operator re-review queue: every quarantined wake in the swarm —
   * live markers AND TTL-expired ones — oldest expiry first. Expiry never
   * auto-admits: expired entries stay blocked until an operator clears
   * (re-review, dispatchable again) or cancels (terminal) them.
   * `quarantinedForMs` is the approximate age of the marker (TTL minus
   * remaining; markers carry expiry only, clamped at 0).
   */
  listWakesNeedingQuarantineReview(swarmId: string, now?: string): QuarantineReviewItem[] {
    const nowIsoValue = now ?? nowIso();
    const nowMs = Date.parse(nowIsoValue);
    const markers = this.db
      .query<{ resource_key: string; expires_at: string }, []>(
        "SELECT resource_key, expires_at FROM leases WHERE resource_key LIKE 'wake-quarantine:%' ORDER BY expires_at ASC",
      )
      .all();
    const items: QuarantineReviewItem[] = [];
    for (const marker of markers) {
      const wakeId = marker.resource_key.slice("wake-quarantine:".length);
      const row = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(wakeId);
      if (row === null || row.swarm_id !== swarmId) continue;
      const remainingMs = Date.parse(marker.expires_at) - nowMs;
      items.push({
        wakeId,
        swarmId: row.swarm_id,
        memberId: row.member_id,
        wakeState: row.state as WakeState,
        quarantineExpiresAt: marker.expires_at,
        reviewDue: !this.leaseLive({ expiresAt: marker.expires_at }, nowIsoValue),
        quarantinedForMs: Number.isFinite(remainingMs)
          ? Math.max(0, WAKE_QUARANTINE_TTL_MS - remainingMs)
          : WAKE_QUARANTINE_TTL_MS,
      });
    }
    return items;
  }

  /** Cancel a stale wake (killed/stale-generation found by the reconciler). */
  cancelStaleWake(id: string, reason: string, correlationId?: string): WakeIntent {
    return this.txn(() => {
      const now = nowIso();
      const cid = correlationId ?? crypto.randomUUID();
      const row = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(id);
      if (row === null) throw new ProtocolError("NOT_FOUND", `Wake ${id} not found`, { wakeId: id });
      if ((row.state as WakeState) === "cancelled") return this.toWake(row);
      assertWakeTransition(row.state as WakeState, "cancelled");
      this.db
        .query<[], [string, string]>("UPDATE wake_intents SET state = 'cancelled', updated_at = ? WHERE id = ?")
        .run(now, id);
      this.deleteLease(this.leaseKeyForMember(row.member_id), id);
      this.wakeLifecycleEvent("wake_cancelled_stale", id, {
        wakeId: id, memberId: row.member_id, correlationId: cid, reason,
      });
      const updated = this.db.query<WakeRow, [string]>("SELECT * FROM wake_intents WHERE id = ?").get(id);
      if (updated === null) throw new ProtocolError("NOT_FOUND", `Wake ${id} not found`, { wakeId: id });
      return this.toWake(updated);
    });
  }

  /**
   * Oldest-first eligible queued wakes: member in an admittable state,
   * generation matches, not quarantined, backoff ceiling elapsed.
   * (Ordering = created_at FIFO = board-fair order; identity/ownership
   * preserved because every row carries memberId + delivery_key.)
   */
  listEligibleQueuedWakes(
    swarmId: string,
    limit = 100,
    opts?: { readonly baseMs?: number; readonly capMs?: number; readonly nowMs?: number },
  ): WakeIntent[] {
    const baseMs = opts?.baseMs ?? WAKE_BACKOFF_BASE_MS_DEFAULT;
    const capMs = opts?.capMs ?? WAKE_BACKOFF_CAP_MS_DEFAULT;
    const nowMs = opts?.nowMs ?? Date.now();
    const now = new Date(nowMs).toISOString();
    const rows = this.db
      .query<WakeRow, [string]>(
        "SELECT * FROM wake_intents WHERE swarm_id = ? AND state = 'queued' ORDER BY created_at ASC, id ASC LIMIT 500",
      )
      .all(swarmId);
    const eligible: WakeIntent[] = [];
    for (const row of rows) {
      if (eligible.length >= limit) break;
      let member: MemberRow | null = null;
      try {
        member = this.requireMember(row.member_id);
      } catch {
        continue;
      }
      if (member === null) continue;
      if (
        member.internal_state === "killed" ||
        member.internal_state === "quota_paused" ||
        member.internal_state === "approval_paused"
      ) {
        continue;
      }
      if (member.generation !== row.member_generation) continue;
      const quarantine = this.readLease(this.quarantineKeyForWake(row.id));
      // F-B: live OR TTL-expired markers both exclude the wake. Expiry
      // routes to the operator re-review queue — never back to dispatch.
      if (quarantine !== null) continue;
      if (row.attempts > 0 && wakeNotBeforeMs(row.updated_at, row.attempts, baseMs, capMs, nowMs) > nowMs) continue;
      const live = this.db
        .query<{ id: string }, [string]>(
          "SELECT id FROM wake_intents WHERE member_id = ? AND state IN ('admitted','observed_running') LIMIT 1",
        )
        .get(row.member_id);
      if (live !== null) continue;
      const memberLease = this.readLease(this.leaseKeyForMember(row.member_id));
      if (this.leaseLive(memberLease, now) && memberLease !== null && memberLease.holder !== row.id) continue;
      eligible.push(this.toWake(row));
    }
    return eligible;
  }

  /** Admitted/observed_running wakes needing reconciliation (restart path). */
  listUnsettledWakes(swarmId: string, limit = 100): WakeIntent[] {
    return this.db
      .query<WakeRow, [string, number]>(
        "SELECT * FROM wake_intents WHERE swarm_id = ? AND state IN ('admitted','observed_running') ORDER BY created_at ASC, id ASC LIMIT ?",
      )
      .all(swarmId, limit)
      .map((r) => this.toWake(r));
  }

  /** The single live (admitted/observed_running) wake for a member, if any. */
  findLiveWakeForMember(memberId: string): WakeIntent | null {
    const row = this.db
      .query<WakeRow, [string]>(
        "SELECT * FROM wake_intents WHERE member_id = ? AND state IN ('admitted','observed_running') ORDER BY created_at ASC LIMIT 1",
      )
      .get(memberId);
    return row === null ? null : this.toWake(row);
  }

  private assertWakeFencing(memberId: string, wakeId: string, fencingToken: number | undefined): void {
    if (fencingToken === undefined) return;
    const lease = this.readLease(this.leaseKeyForMember(memberId));
    if (lease !== null && lease.holder !== wakeId) {
      throw new ProtocolError("LIVE_TURN_ACTIVE", `Fencing conflict: member turn held by ${lease.holder}`, {
        memberId, wakeId, holder: lease.holder,
      });
    }
    if (lease !== null && lease.holder === wakeId && lease.fencingToken !== fencingToken) {
      throw new ProtocolError("LIVE_TURN_ACTIVE", `Stale fencing token ${fencingToken} (current ${lease.fencingToken})`, {
        memberId, wakeId,
      });
    }
  }

  // --- Verification evidence (real process proof, not model prose) ---

  recordVerificationEvidence(input: RecordEvidenceInput): VerificationEvidence {
    const parsed = parseInput("evidence", () => RecordEvidenceInputSchema.parse(input));
    return this.txn(() => {
      const loaded = this.loadTask(parsed.taskId);
      const state = loaded.row.state as Task["state"];
      if (state !== "verifying") {
        throw new ProtocolError(
          "INVALID_TRANSITION",
          `Evidence requires task in verifying, not ${state}`,
          { taskId: parsed.taskId, state },
        );
      }
      const executor = this.requireMemberInSwarm(parsed.executorMemberId, loaded.row.swarm_id);
      if (executor.internal_state === "killed") {
        throw new ProtocolError("KILLED_MEMBER", "Killed member cannot record evidence", {
          memberId: executor.id,
        });
      }
      const now = nowIso();
      const evidenceId = crypto.randomUUID();
      const stdoutId = crypto.randomUUID();
      const stderrId = crypto.randomUUID();
      const insertArtifact =
        "INSERT INTO artifacts (id, swarm_id, task_id, kind, sha256, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)";
      this.db
        .query<[], [string, string, string, string, string, string, string]>(insertArtifact)
        .run(stdoutId, loaded.row.swarm_id, parsed.taskId, "stdout", parsed.stdout.sha256, parsed.stdout.filePath, now);
      this.db
        .query<[], [string, string, string, string, string, string, string]>(insertArtifact)
        .run(stderrId, loaded.row.swarm_id, parsed.taskId, "stderr", parsed.stderr.sha256, parsed.stderr.filePath, now);
      this.db
        .query<[], [string, string, string, string, string, number, string | null, string, string, string, string]>(
          `INSERT INTO verification_evidence (id, task_id, executor_member_id, command, cwd,
             exit_code, commit_sha, stdout_artifact_id, stderr_artifact_id, started_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          evidenceId,
          parsed.taskId,
          parsed.executorMemberId,
          parsed.command,
          parsed.cwd,
          parsed.exitCode,
          parsed.commitSha ?? null,
          stdoutId,
          stderrId,
          parsed.startedAt,
          parsed.finishedAt,
        );
      this.enqueueOutbox("evidence_recorded", evidenceId, { evidenceId, taskId: parsed.taskId });
      const row = this.db
        .query<EvidenceRow, [string]>("SELECT * FROM verification_evidence WHERE id = ?")
        .get(evidenceId);
      if (row === null) throw new ProtocolError("NOT_FOUND", "Evidence vanished after insert", { evidenceId });
      return {
        id: row.id,
        taskId: row.task_id,
        commitSha: row.commit_sha,
        command: row.command,
        cwd: row.cwd,
        exitCode: row.exit_code,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        stdoutArtifactId: row.stdout_artifact_id,
        stderrArtifactId: row.stderr_artifact_id,
        executorMemberId: row.executor_member_id,
      };
    });
  }

  // --- Outbox ---

  listPendingOutbox(limit = 100): OutboxEntry[] {
    return this.db
      .query<OutboxRow, [number]>(
        "SELECT * FROM outbox WHERE delivered_at IS NULL ORDER BY created_at LIMIT ?",
      )
      .all(limit)
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        aggregateId: r.aggregate_id,
        payload: JSON.parse(r.payload_json) as unknown,
        deliveredAt: r.delivered_at,
        attempts: r.attempts,
        createdAt: r.created_at,
      }));
  }

  markOutboxDelivered(id: string): void {
    this.db
      .query<[], [string, string]>("UPDATE outbox SET delivered_at = ?, attempts = attempts + 1 WHERE id = ?")
      .run(nowIso(), id);
  }
}
