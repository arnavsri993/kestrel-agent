CREATE TABLE IF NOT EXISTS memory_metadata (
  memory_id TEXT PRIMARY KEY,
  payload_ciphertext TEXT NOT NULL, payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(memory_id) REFERENCES memories(id)
);
CREATE TABLE IF NOT EXISTS memory_versions (
  id TEXT PRIMARY KEY, memory_id TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL, payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL, changed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(memory_id) REFERENCES memories(id)
);
CREATE INDEX IF NOT EXISTS idx_memory_versions_memory_changed
  ON memory_versions(memory_id, changed_at);
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  payload_ciphertext TEXT NOT NULL, payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_people_status_updated ON people(status, updated_at);
CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  payload_ciphertext TEXT NOT NULL, payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL, provider_id TEXT NOT NULL,
  status TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calendar_events_provider_status
  ON calendar_events(provider_id, status, updated_at);
CREATE TABLE IF NOT EXISTS context_usage (
  id TEXT PRIMARY KEY,
  payload_ciphertext TEXT NOT NULL, payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_usage_created ON context_usage(created_at);
CREATE TABLE IF NOT EXISTS calendar_sync_state (
  provider_id TEXT PRIMARY KEY,
  payload_ciphertext TEXT NOT NULL, payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL, updated_at TEXT NOT NULL
);
