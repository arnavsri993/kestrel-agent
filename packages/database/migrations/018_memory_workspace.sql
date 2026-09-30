/* Canonical documents are encrypted. Tombstones suppress legacy projections
   without deleting source records or modifying the existing memory substrate. */
CREATE TABLE IF NOT EXISTS memory_workspace_documents (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK(version > 0),
  status TEXT NOT NULL CHECK(status IN ('active', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_ciphertext TEXT,
  payload_iv TEXT,
  payload_auth_tag TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_workspace_updated
  ON memory_workspace_documents(status, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS memory_workspace_day_summaries (
  id TEXT PRIMARY KEY,
  viewer_id TEXT NOT NULL,
  domain_id TEXT,
  day TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL,
  UNIQUE(viewer_id, domain_id, day)
);
CREATE INDEX IF NOT EXISTS idx_memory_workspace_day_scope
  ON memory_workspace_day_summaries(viewer_id, domain_id, day DESC);
