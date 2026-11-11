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
