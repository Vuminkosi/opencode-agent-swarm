/**
 * M5-02 provider usage ledger (spec §6 usage_ledger follow-on + §14 M5).
 *
 * Service-owned durable table on the shared DB handle — same precedent as
 * M4-03 `integration_runs` (`CREATE TABLE IF NOT EXISTS` via
 * `ensureUsageLedgerSchema`, idempotent on every open). `store.ts` and its
 * migration registry are owned by another lane and are never edited here,
 * so an unwired `.sql` migration file would be dead schema.
 *
 * Records per-admission provider usage (provider/model refs, tokens, cost
 * where observed, outcome) and feeds read-only consumers: per-provider/model
 * totals and cost-per-verified-task telemetry. Consumers read; this module
 * never mutates swarm/member/task/wake state.
 *
 * --- task_attempts disposition (no separate ledger) ---
 * Task attempts are already the system of record in `tasks.attempt`
 * (bumped verifying→ready) plus `verification_evidence` rows per attempt.
 * A separate `task_attempts` table would duplicate that durable state and
 * risk divergence, so this task does NOT create one. Ledger entries carry
 * the store's attempt number (`attempt`) for correlation only; see
 * `describeTaskAttemptAccounting`.
 *
 * Redaction: entries carry refs, counts, and outcome codes only — never
 * prompts, message bodies, or credentials.
 */

import type { Database } from "bun:sqlite";

export const USAGE_LEDGER_DDL = `CREATE TABLE IF NOT EXISTS usage_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  swarm_id TEXT,
  member_id TEXT,
  wake_id TEXT,
  task_id TEXT,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micro INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','rate-limited-terminal','transient-terminal','quota-paused','auth-blocked','permanent','dispatched','failed-transient','failed-permanent')),
  correlation_id TEXT,
  created_at TEXT NOT NULL
);`;

/** Idempotent schema ensure for the service-owned table (safe on every open). */
export function ensureUsageLedgerSchema(db: Database): void {
  db.exec(USAGE_LEDGER_DDL);
}

export type LedgerOutcome =
  | "ok"
  | "rate-limited-terminal"
  | "transient-terminal"
  | "quota-paused"
  | "auth-blocked"
  | "permanent"
  | "dispatched"
  | "failed-transient"
  | "failed-permanent";

export interface UsageRecordInput {
  readonly swarmId?: string;
  readonly memberId?: string;
  readonly wakeId?: string;
  readonly taskId?: string;
  /** Provider/model refs only — never credentials. */
  readonly providerId: string;
  readonly modelId: string;
  /** Store `tasks.attempt` value for correlation (not a second counter). */
  readonly attempt?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** Observed cost in micro-units (0 when unobserved — never estimated). */
  readonly costMicro?: number;
  readonly outcome: LedgerOutcome;
  /**
   * Opaque dispatcher correlation id, carried verbatim (confirmed
   * passthrough: `record` stores it unmodified, `null` when absent).
   * Refs only — never prompts, bodies, or credentials.
   */
  readonly correlationId?: string;
  readonly createdAt?: string;
}

export interface UsageLedgerEntry extends UsageRecordInput {
  readonly id: number;
}

export interface ProviderModelTotals {
  readonly providerId: string;
  readonly modelId: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicro: number;
  readonly outcomes: Readonly<Record<string, number>>;
}

export interface CostPerVerifiedTask {
  readonly verifiedTasks: number;
  readonly totalCostMicro: number;
  readonly avgCostMicroPerVerifiedTask: number;
}

function nonNegativeInt(value: number | undefined, what: string): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid usage ledger ${what}: expected non-negative integer`);
  }
  return value;
}

export class UsageLedger {
  constructor(private readonly db: Database) {
    ensureUsageLedgerSchema(this.db);
  }

  /** Record one provider admission/attempt outcome. Refs + counts only. */
  record(input: UsageRecordInput): number {
    if (input.providerId.trim() === "" || input.modelId.trim() === "") {
      throw new Error("Invalid usage ledger entry: providerId and modelId must be non-empty refs");
    }
    const createdAt = input.createdAt ?? new Date().toISOString();
    const result = this.db
      .query(
        `INSERT INTO usage_ledger
           (swarm_id, member_id, wake_id, task_id, provider_id, model_id, attempt,
            input_tokens, output_tokens, cost_micro, outcome, correlation_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.swarmId ?? null,
        input.memberId ?? null,
        input.wakeId ?? null,
        input.taskId ?? null,
        input.providerId,
        input.modelId,
        nonNegativeInt(input.attempt, "attempt"),
        nonNegativeInt(input.inputTokens, "inputTokens"),
        nonNegativeInt(input.outputTokens, "outputTokens"),
        nonNegativeInt(input.costMicro, "costMicro"),
        input.outcome,
        input.correlationId ?? null,
        createdAt,
      );
    return Number(result.lastInsertRowid);
  }

  /** Read-only consumer: per-provider/model call/token/cost rollups. */
  totalsByProviderModel(): ProviderModelTotals[] {
    const rows = this.db
      .query<{
        provider_id: string;
        model_id: string;
        calls: number;
        input_tokens: number;
        output_tokens: number;
        cost_micro: number;
        outcome: string;
        n: number;
      }, []>(
        `SELECT provider_id, model_id, outcome,
                COUNT(*) AS n,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cost_micro) AS cost_micro
           FROM usage_ledger GROUP BY provider_id, model_id, outcome`,
      )
      .all();
    const byKey = new Map<string, {
      providerId: string;
      modelId: string;
      calls: number;
      inputTokens: number;
      outputTokens: number;
      costMicro: number;
      outcomes: Record<string, number>;
    }>();
    let totalCalls = 0;
    for (const row of rows) {
      const key = `${row.provider_id}\n${row.model_id}`;
      let agg = byKey.get(key);
      if (agg === undefined) {
        agg = {
          providerId: row.provider_id,
          modelId: row.model_id,
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          costMicro: 0,
          outcomes: {},
        };
        byKey.set(key, agg);
      }
      agg.calls += row.n;
      agg.inputTokens += row.input_tokens ?? 0;
      agg.outputTokens += row.output_tokens ?? 0;
      agg.costMicro += row.cost_micro ?? 0;
      agg.outcomes[row.outcome] = (agg.outcomes[row.outcome] ?? 0) + row.n;
      totalCalls += row.n;
    }
    void totalCalls;
    return [...byKey.values()].sort((a, b) =>
      a.providerId === b.providerId ? (a.modelId < b.modelId ? -1 : 1) : a.providerId < b.providerId ? -1 : 1,
    );
  }

  /**
   * Read-only consumer: cost-per-verified-task telemetry. The caller passes
   * the verified task ids (read from the store: tasks in an accepted state
   * with passing `verification_evidence`); the ledger sums observed cost on
   * matching entries. Tasks with no ledger rows contribute zero — costs are
   * observed only, never estimated.
   */
  costPerVerifiedTask(verifiedTaskIds: readonly string[]): CostPerVerifiedTask {
    if (verifiedTaskIds.length === 0) {
      return { verifiedTasks: 0, totalCostMicro: 0, avgCostMicroPerVerifiedTask: 0 };
    }
    const placeholders = verifiedTaskIds.map(() => "?").join(",");
    const row = this.db
      .query<{ total: number | null }, Array<string | number>>(
        `SELECT SUM(cost_micro) AS total FROM usage_ledger WHERE task_id IN (${placeholders})`,
      )
      .get(...verifiedTaskIds) as { total: number | null } | null;
    const total = row?.total ?? 0;
    return {
      verifiedTasks: verifiedTaskIds.length,
      totalCostMicro: total,
      avgCostMicroPerVerifiedTask: Math.floor(total / verifiedTaskIds.length),
    };
  }

  count(): number {
    const row = this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_ledger").get() as { n: number };
    return row.n;
  }
}

/**
 * task_attempts disposition: the store's `tasks.attempt` + linked
 * `verification_evidence` rows are the system of record for attempts — no
 * separate `task_attempts` table is created (a duplicate counter would risk
 * divergence). This helper correlates one task snapshot for evidence.
 */
export interface TaskAttemptAccounting {
  /** Store attempt counter (source of truth). */
  readonly attempt: number;
  readonly evidenceCount: number;
  readonly separateLedgerNeeded: false;
}

export function describeTaskAttemptAccounting(task: {
  readonly attempt: number;
  readonly resultEvidenceIds: readonly string[];
}): TaskAttemptAccounting {
  return {
    attempt: task.attempt,
    evidenceCount: task.resultEvidenceIds.length,
    separateLedgerNeeded: false,
  };
}
