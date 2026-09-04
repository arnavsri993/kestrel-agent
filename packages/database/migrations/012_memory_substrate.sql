/*
 * Memory substrate v1.
 *
 * Identifying metadata is intentionally kept small and queryable.  Human
 * content, structured payloads, vectors, and policy patterns are encrypted by
 * KestrelDatabase before they reach these tables.  Term hashes are keyed
 * HMACs, so lexical search does not require a plaintext transcript index.
 */

CREATE TABLE IF NOT EXISTS memory_timeline_events (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  session_id TEXT,
  actor TEXT NOT NULL,
  agent_id TEXT,
  subagent_id TEXT,
  task_id TEXT,
  importance REAL NOT NULL,
  sensitivity TEXT NOT NULL,
  retention_policy TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL,
  CHECK(ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX IF NOT EXISTS idx_memory_timeline_events_started
  ON memory_timeline_events(started_at, id);
CREATE INDEX IF NOT EXISTS idx_memory_timeline_events_session_started
  ON memory_timeline_events(session_id, started_at, id);
CREATE INDEX IF NOT EXISTS idx_memory_timeline_events_type_started
  ON memory_timeline_events(event_type, started_at, id);
CREATE INDEX IF NOT EXISTS idx_memory_timeline_events_agent_started
  ON memory_timeline_events(agent_id, started_at, id);
CREATE INDEX IF NOT EXISTS idx_memory_timeline_events_status_started
  ON memory_timeline_events(status, started_at, id);

CREATE TABLE IF NOT EXISTS memory_timeline_event_terms (
  event_id TEXT NOT NULL,
  term_hash TEXT NOT NULL,
  PRIMARY KEY(event_id, term_hash),
  FOREIGN KEY(event_id) REFERENCES memory_timeline_events(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_memory_timeline_event_terms_hash
  ON memory_timeline_event_terms(term_hash, event_id);

CREATE TABLE IF NOT EXISTS memory_timeline_sessions (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('active', 'closed', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL,
  CHECK(ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX IF NOT EXISTS idx_memory_timeline_sessions_started
  ON memory_timeline_sessions(started_at, id);
CREATE INDEX IF NOT EXISTS idx_memory_timeline_sessions_status_updated
  ON memory_timeline_sessions(status, updated_at, id);

CREATE TABLE IF NOT EXISTS memory_activity_blocks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  importance REAL NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL,
  CHECK(ended_at IS NULL OR ended_at >= started_at),
  FOREIGN KEY(session_id) REFERENCES memory_timeline_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_memory_activity_blocks_session_started
  ON memory_activity_blocks(session_id, started_at, id);
CREATE INDEX IF NOT EXISTS idx_memory_activity_blocks_started
  ON memory_activity_blocks(started_at, id);

CREATE TABLE IF NOT EXISTS memory_daily_summaries (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_daily_summaries_day
  ON memory_daily_summaries(day, id);

CREATE TABLE IF NOT EXISTS memory_entities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  canonical_name_hash TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'ambiguous', 'merged', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_entities_canonical_active
  ON memory_entities(kind, canonical_name_hash) WHERE status != 'deleted';
CREATE INDEX IF NOT EXISTS idx_memory_entities_kind_status
  ON memory_entities(kind, status, updated_at);

CREATE TABLE IF NOT EXISTS memory_entity_edges (
  id TEXT PRIMARY KEY,
  from_entity_id TEXT NOT NULL,
  to_entity_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  weight REAL NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL,
  FOREIGN KEY(from_entity_id) REFERENCES memory_entities(id) ON DELETE CASCADE,
  FOREIGN KEY(to_entity_id) REFERENCES memory_entities(id) ON DELETE CASCADE,
  CHECK(from_entity_id != to_entity_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_entity_edges_active_pair
  ON memory_entity_edges(from_entity_id, to_entity_id, relation) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_memory_entity_edges_from
  ON memory_entity_edges(from_entity_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_entity_edges_to
  ON memory_entity_edges(to_entity_id, status, updated_at);

CREATE TABLE IF NOT EXISTS memory_agent_identities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('main', 'subagent')),
  parent_agent_id TEXT,
  session_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('active', 'archived', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL,
  FOREIGN KEY(parent_agent_id) REFERENCES memory_agent_identities(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_agent_identities_parent
  ON memory_agent_identities(parent_agent_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_agent_identities_session
  ON memory_agent_identities(session_id, status, updated_at);

CREATE TABLE IF NOT EXISTS memory_agent_memories (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  horizon TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'superseded', 'expired', 'deleted')),
  importance REAL NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL,
  FOREIGN KEY(agent_id) REFERENCES memory_agent_identities(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_memory_agent_memories_agent_status
  ON memory_agent_memories(agent_id, status, importance DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_agent_memories_horizon
  ON memory_agent_memories(horizon, status, updated_at);

CREATE TABLE IF NOT EXISTS memory_working_tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  parent_task_id TEXT,
  agent_id TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL,
  CHECK(completed_at IS NULL OR completed_at >= started_at),
  FOREIGN KEY(parent_task_id) REFERENCES memory_working_tasks(id) ON DELETE SET NULL,
  FOREIGN KEY(agent_id) REFERENCES memory_agent_identities(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_working_tasks_session_status
  ON memory_working_tasks(session_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_working_tasks_agent_status
  ON memory_working_tasks(agent_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS memory_provenance (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  timeline_event_id TEXT,
  actor TEXT NOT NULL,
  extraction_method TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_provenance_owner
  ON memory_provenance(owner_type, owner_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_provenance_source
  ON memory_provenance(source_type, source_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_provenance_timeline
  ON memory_provenance(timeline_event_id, created_at);

CREATE TABLE IF NOT EXISTS memory_capture_policies (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_capture_policies_scope_enabled
  ON memory_capture_policies(scope, enabled, updated_at);

CREATE TABLE IF NOT EXISTS memory_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  run_after TEXT NOT NULL,
  locked_at TEXT,
  lease_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_jobs_ready
  ON memory_jobs(status, run_after, id);
CREATE INDEX IF NOT EXISTS idx_memory_jobs_kind_status
  ON memory_jobs(kind, status, updated_at);

CREATE TABLE IF NOT EXISTS memory_embeddings (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ready', 'queued', 'unavailable', 'failed', 'stale', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_embeddings_owner_version
  ON memory_embeddings(owner_type, owner_id, provider, model, content_hash);
CREATE INDEX IF NOT EXISTS idx_memory_embeddings_owner_status
  ON memory_embeddings(owner_type, owner_id, status, updated_at);
