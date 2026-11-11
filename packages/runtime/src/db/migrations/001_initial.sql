-- M1-01 migration 001: initial durable journal (spec §6 DDL + enum CHECKs).
-- Repeatable: all objects use IF NOT EXISTS; applied once via schema_migrations.
-- Evidence: [DESIGN] (spec §6).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS swarms (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  coordinator_session_id TEXT NOT NULL,
  project_root TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('parity','safe-coding')),
  status TEXT NOT NULL CHECK (status IN ('planning','running','paused','completing','completed','failed','cancelled')),
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  swarm_id TEXT NOT NULL REFERENCES swarms(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('coordinator','coder','verifier','monitor','researcher')),
  native_agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  model_provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  public_state TEXT NOT NULL CHECK (public_state IN ('working','waiting','killed')),
  internal_state TEXT NOT NULL CHECK (internal_state IN ('starting','working','waiting','quota_paused','approval_paused','recovering','killed')),
  generation INTEGER NOT NULL DEFAULT 1,
  last_activity_at TEXT NOT NULL,
  killed_at TEXT,
  UNIQUE (swarm_id, name)
);

CREATE TABLE IF NOT EXISTS member_groups (
  swarm_id TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id),
  group_name TEXT NOT NULL,
  PRIMARY KEY (swarm_id, member_id, group_name)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  swarm_id TEXT NOT NULL REFERENCES swarms(id),
  owner_id TEXT REFERENCES members(id),
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft','ready','leased','running','verifying','blocked','accepted','failed','cancelled')),
  attempt INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 1,
  owned_paths_json TEXT NOT NULL,
  forbidden_paths_json TEXT NOT NULL,
  acceptance_json TEXT NOT NULL,
  base_commit TEXT,
  worktree_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_deps (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  depends_on_id TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY(task_id, depends_on_id),
  CHECK(task_id <> depends_on_id)
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  swarm_id TEXT NOT NULL REFERENCES swarms(id),
  sequence INTEGER NOT NULL,
  author_member_id TEXT REFERENCES members(id),
  kind TEXT NOT NULL CHECK (kind IN ('brief','message','question','progress','result','verification','monitor','done','system')),
  body TEXT NOT NULL,
  related_task_id TEXT REFERENCES tasks(id),
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(swarm_id, sequence),
  UNIQUE(swarm_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS post_recipients (
  post_id TEXT NOT NULL REFERENCES posts(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  PRIMARY KEY(post_id, member_id)
);

CREATE TABLE IF NOT EXISTS post_groups (
  post_id TEXT NOT NULL REFERENCES posts(id),
  group_name TEXT NOT NULL,
  PRIMARY KEY(post_id, group_name)
);

CREATE TABLE IF NOT EXISTS wake_intents (
  id TEXT PRIMARY KEY,
  swarm_id TEXT NOT NULL REFERENCES swarms(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  member_generation INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('mention','assigned_task','verifier_request','monitor_intervention','user_direct')),
  post_sequence INTEGER,
  task_id TEXT REFERENCES tasks(id),
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','admitted','observed_running','succeeded','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(member_id, member_generation, reason, post_sequence, task_id)
);

CREATE TABLE IF NOT EXISTS leases (
  resource_key TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  delivered_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inbox_dedupe (
  source TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY(source, external_event_id)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  swarm_id TEXT NOT NULL REFERENCES swarms(id),
  task_id TEXT REFERENCES tasks(id),
  kind TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  file_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verification_evidence (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  executor_member_id TEXT NOT NULL REFERENCES members(id),
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  exit_code INTEGER NOT NULL,
  commit_sha TEXT,
  stdout_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  stderr_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_posts_swarm_seq ON posts(swarm_id, sequence);
CREATE INDEX IF NOT EXISTS ix_task_state ON tasks(swarm_id, state);
CREATE INDEX IF NOT EXISTS ix_wake_state ON wake_intents(state, created_at);
CREATE INDEX IF NOT EXISTS ix_outbox_pending ON outbox(delivered_at, created_at);
