/**
 * OpenCode event ingress dedupe — M1-02 (contract C-DAEMON-01).
 *
 * `POST /v1/swarms/:id/events/ingest` records the external event identity
 * in the M1-01 `inbox_dedupe(source, external_event_id)` table so a
 * duplicate OpenCode delivery (retry / reconnect replay) maps to exactly
 * one daemon observation. Same ownership rule as lifecycle.ts: this task
 * does not own the store file, so this service uses its own busy-tolerant
 * handle, writes ONLY to `inbox_dedupe`, and changes no schema.
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

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class EventIngest {
  private readonly db: Database;
  private closed = false;

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
        const swarm = this.db.query<{ id: string }, [string]>("SELECT id FROM swarms WHERE id = ?").get(swarmId);
        if (swarm === null) {
          throw new ProtocolError("NOT_FOUND", `Swarm ${swarmId} not found`, { swarmId });
        }
        const existing = this.db
          .query<{ source: string }, [string, string]>(
            "SELECT source FROM inbox_dedupe WHERE source = ? AND external_event_id = ?",
          )
          .get(input.source, input.externalEventId);
        if (existing !== null) {
          return { deduped: true, source: input.source, externalEventId: input.externalEventId };
        }
        try {
          this.db
            .query<[], [string, string, string]>(
              "INSERT INTO inbox_dedupe (source, external_event_id, received_at) VALUES (?, ?, ?)",
            )
            .run(input.source, input.externalEventId, now);
          return { deduped: false, source: input.source, externalEventId: input.externalEventId };
        } catch (err) {
          if (isConstraintError(err)) {
            return { deduped: true, source: input.source, externalEventId: input.externalEventId };
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
