/**
 * Swarm lifecycle writer — M1-02 (contract C-DAEMON-01).
 *
 * M1-01 `SwarmStore` (contract C-DB-01, owned by another worker) exposes
 * no swarm-status mutation, and its file is NOT owned by this task — so
 * this service performs narrowly-scoped, validated `UPDATE swarms SET
 * status` writes through its own busy-tolerant handle on the SAME
 * database file. It never changes schema, never touches other tables,
 * and never bypasses protocol validation: every target status is parsed
 * with the protocol `SwarmStatusSchema` (CHECK-compatible) and every
 * transition is checked against the table below (spec §7 swarm intent:
 * planning -> running/paused/cancelled, no resurrection from terminals).
 *
 * The handle sets WAL + foreign_keys + a long busy_timeout and retries
 * SQLITE_BUSY, so it coexists with the single authoritative store writer
 * (which holds BEGIN IMMEDIATE transactions briefly).
 */
import { Database } from "bun:sqlite";
import {
  ProtocolError,
  SwarmStatusSchema,
  type Swarm,
  type SwarmStatus,
} from "@vuminkosi/protocol";

const SWARM_TRANSITIONS: Record<SwarmStatus, readonly SwarmStatus[]> = {
  planning: ["running", "paused", "cancelled"],
  running: ["paused", "completing", "failed", "cancelled"],
  paused: ["running", "cancelled"],
  completing: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

function isBusyError(err: unknown): boolean {
  return err instanceof Error && (err as { code?: unknown }).code === "SQLITE_BUSY";
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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

function toSwarm(row: SwarmRow): Swarm {
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

export class SwarmLifecycle {
  private readonly db: Database;
  private closed = false;

  constructor(dbPath: string) {
    if (dbPath === ":memory:") {
      throw new ProtocolError("VALIDATION_FAILED", "Lifecycle writer requires a file database (shared with the store)", {
        dbPath,
      });
    }
    this.db = new Database(dbPath, { create: false, readonly: false });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 10000;");
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }

  setStatus(swarmId: string, to: SwarmStatus): Swarm {
    const target = SwarmStatusSchema.parse(to);
    const now = new Date().toISOString();
    for (let attempt = 0; ; attempt += 1) {
      try {
        // Atomic read-check-write: BEGIN IMMEDIATE takes the write lock up
        // front so two concurrent lifecycle intents cannot both pass the
        // transition check. The conditional UPDATE re-asserts the expected
        // `from` status; zero changed rows means a concurrent writer won
        // the race and the loser reports 409, never resurrecting a
        // terminal state.
        // NOTE: `swarms.revision` is intentionally NOT bumped here — it is
        // the board-post sequence allocator (store.appendPost bumps it and
        // uses it as posts.sequence), so bumping it on status changes
        // would punch gaps into the replay sequence.
        this.db.exec("BEGIN IMMEDIATE");
        try {
          const row = this.db.query<SwarmRow, [string]>("SELECT * FROM swarms WHERE id = ?").get(swarmId);
          if (row === null) {
            throw new ProtocolError("NOT_FOUND", `Swarm ${swarmId} not found`, { swarmId });
          }
          const from = row.status as SwarmStatus;
          if (from !== target && !(SWARM_TRANSITIONS[from] ?? []).includes(target)) {
            throw new ProtocolError("INVALID_TRANSITION", `Invalid swarm transition ${from} -> ${target}`, {
              from,
              to: target,
            });
          }
          if (from !== target) {
            const outcome = this.db
              .query<unknown, [string, string, string, string]>(
                "UPDATE swarms SET status = ?, updated_at = ? WHERE id = ? AND status = ?",
              )
              .run(target, now, swarmId, from) as unknown as { changes: number };
            if ((outcome?.changes ?? 0) === 0) {
              throw new ProtocolError("INVALID_TRANSITION", `Concurrent swarm transition on ${swarmId}`, {
                swarmId,
                to: target,
              });
            }
          } else {
            this.db
              .query<[], [string, string]>("UPDATE swarms SET updated_at = ? WHERE id = ?")
              .run(now, swarmId);
          }
          this.db.exec("COMMIT");
        } catch (err) {
          try {
            this.db.exec("ROLLBACK");
          } catch {
            /* already rolled back */
          }
          throw err;
        }
        const updated = this.db.query<SwarmRow, [string]>("SELECT * FROM swarms WHERE id = ?").get(swarmId);
        if (updated === null) throw new ProtocolError("NOT_FOUND", `Swarm ${swarmId} not found`, { swarmId });
        return toSwarm(updated);
      } catch (err) {
        if (isBusyError(err) && attempt < 20) {
          sleepMs(Math.min(5 * (attempt + 1), 100));
          continue;
        }
        throw err;
      }
    }
  }

  pauseSwarm(swarmId: string): Swarm {
    return this.setStatus(swarmId, "paused");
  }

  resumeSwarm(swarmId: string): Swarm {
    return this.setStatus(swarmId, "running");
  }

  cancelSwarm(swarmId: string): Swarm {
    return this.setStatus(swarmId, "cancelled");
  }
}
