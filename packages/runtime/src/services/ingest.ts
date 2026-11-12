/**
 * OpenCode event ingress dedupe — M1-02 (contract C-DAEMON-01), M8 F-C.
 *
 * `POST /v1/swarms/:id/events/ingest` records the external event identity
 * so a duplicate OpenCode delivery (retry / reconnect replay) maps to
 * exactly one daemon observation. F-C: the M1-01
 * `inbox_dedupe(source, external_event_id)` key is GLOBAL, so two swarms
 * sharing one daemon DB dedupe each other's events when the upstream
 * reuses an id. New deliveries are keyed per swarm in
 * `inbox_dedupe_scoped(swarm_id, source, external_event_id)` (migration
 * 004); pre-004 legacy rows carry no swarm attribution and are still
 * honored conservatively as global duplicates (exactly-once for
 * pre-migration deliveries is preserved). Same ownership rule as
 * lifecycle.ts: this task does not own the store file, so this service
 * uses its own busy-tolerant handle and writes ONLY to the dedupe tables.
 */
import { Database } from "bun:sqlite";
import { ProtocolError } from "@opencode-swarm/protocol";

export interface IngestEventInput {
  readonly source: string;
  readonly externalEventId: string;
}

export interface IngestResult {
  readonly deduped: boolean;
  readonly source: string;
  readonly externalEventId: string;
}

function isBusyError(err: unknown): boolean {
  return err instanceof Error && (err as { code?: unknown }).code === "SQLITE_BUSY";
}

function isConstraintError(err: unknown): boolean {
  const code = err instanceof Error ? (err as { code?: unknown }).code : undefined;
  return code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT_UNIQUE";
}

function isForeignKeyError(err: unknown): boolean {
  const code = err instanceof Error ? (err as { code?: unknown }).code : undefined;
  return code === "SQLITE_CONSTRAINT_FOREIGNKEY";
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class EventIngest {
  private readonly db: Database;
  private closed = false;

  /**
   * F-C service-owned ensure (M5 high-water precedent): the scoped table
   * exists even for handles opened without running the store migrations.
   * Must match migration 004 (`004_inbox_dedupe_swarm_scope.sql`).
   * Fail-closed: a DDL failure throws, never a silent unkeyed insert.
   */
  private static readonly SCOPED_DDL = `CREATE TABLE IF NOT EXISTS inbox_dedupe_scoped (
  swarm_id TEXT NOT NULL REFERENCES swarms(id),
  source TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (swarm_id, source, external_event_id)
);`;

  private static readonly SCOPED_INDEX_DDL =
    `CREATE INDEX IF NOT EXISTS ix_inbox_dedupe_scoped_swarm ON inbox_dedupe_scoped(swarm_id, received_at);`;

  constructor(dbPath: string) {
    if (dbPath === ":memory:") {
      throw new ProtocolError("VALIDATION_FAILED", "Ingest writer requires a file database (shared with the store)", {
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

  record(swarmId: string, input: IngestEventInput): IngestResult {
    const now = new Date().toISOString();
    for (let attempt = 0; ; attempt += 1) {
      try {
        // F-C ensure (fail-closed): without the scoped table no swarm key
        // exists, so proceeding would reintroduce the global collision.
        this.db.exec(EventIngest.SCOPED_DDL);
        this.db.exec(EventIngest.SCOPED_INDEX_DDL);
        const swarm = this.db.query<{ id: string }, [string]>("SELECT id FROM swarms WHERE id = ?").get(swarmId);
        if (swarm === null) {
          throw new ProtocolError("NOT_FOUND", `Swarm ${swarmId} not found`, { swarmId });
        }
        // Legacy pre-004 rows carry no swarm: honor them conservatively as
        // global duplicates (exactly-once for pre-migration deliveries).
        const legacy = this.db
          .query<{ source: string }, [string, string]>(
            "SELECT source FROM inbox_dedupe WHERE source = ? AND external_event_id = ?",
          )
          .get(input.source, input.externalEventId);
        if (legacy !== null) {
          return { deduped: true, source: input.source, externalEventId: input.externalEventId };
        }
        // F-C: swarm-scoped key — identical (source, id) in another swarm
        // never collides.
        const scoped = this.db
          .query<{ source: string }, [string, string, string]>(
            "SELECT source FROM inbox_dedupe_scoped WHERE swarm_id = ? AND source = ? AND external_event_id = ?",
          )
          .get(swarmId, input.source, input.externalEventId);
        if (scoped !== null) {
          return { deduped: true, source: input.source, externalEventId: input.externalEventId };
        }
        try {
          this.db
            .query<[], [string, string, string, string]>(
              "INSERT INTO inbox_dedupe_scoped (swarm_id, source, external_event_id, received_at) VALUES (?, ?, ?, ?)",
            )
            .run(swarmId, input.source, input.externalEventId, now);
          return { deduped: false, source: input.source, externalEventId: input.externalEventId };
        } catch (err) {
          if (isConstraintError(err)) {
            return { deduped: true, source: input.source, externalEventId: input.externalEventId };
          }
          if (isForeignKeyError(err)) {
            throw new ProtocolError("NOT_FOUND", `Swarm ${swarmId} not found`, { swarmId });
          }
          throw err;
        }
      } catch (err) {
        if (err instanceof ProtocolError) throw err;
        if (isBusyError(err) && attempt < 20) {
          sleepMs(Math.min(5 * (attempt + 1), 100));
          continue;
        }
        throw err;
      }
    }
  }
}
