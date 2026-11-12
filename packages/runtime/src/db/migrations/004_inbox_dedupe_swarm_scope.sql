-- M8-01 migration 004: scope inbox_dedupe per swarm (F-C data-integrity).
--
-- Defect: `inbox_dedupe(source, external_event_id)` is keyed globally, so
-- two swarms sharing one daemon DB dedupe each other's external events
-- when the upstream reuses an event id (source, id) in both swarms.
--
-- Shape: ADDITIVE ONLY. The legacy `inbox_dedupe` table is frozen in place
-- (pre-004 rows carry no swarm attribution and are kept for audit; the
-- ingest service still honors them conservatively as global duplicates).
-- New deliveries land in `inbox_dedupe_scoped` with
-- PRIMARY KEY (swarm_id, source, external_event_id), so identical external
-- ids in different swarms never collide.
--
-- Repeatable: all objects use IF NOT EXISTS; applied once via
-- schema_migrations (version 4). Independent of any future version 3.
-- Evidence: M8-01 F-C.

CREATE TABLE IF NOT EXISTS inbox_dedupe_scoped (
  swarm_id TEXT NOT NULL REFERENCES swarms(id),
  source TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (swarm_id, source, external_event_id)
);

CREATE INDEX IF NOT EXISTS ix_inbox_dedupe_scoped_swarm ON inbox_dedupe_scoped(swarm_id, received_at);
