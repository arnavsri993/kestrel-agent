CREATE TABLE IF NOT EXISTS browser_activity_events (
  id TEXT PRIMARY KEY,
  owner_session_id TEXT NOT NULL,
  surface TEXT NOT NULL CHECK(surface IN ('autonomous', 'visible')),
  outcome TEXT NOT NULL CHECK(outcome IN ('performed', 'blocked', 'failed', 'cancelled')),
  created_at TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_browser_activity_owner_created
  ON browser_activity_events(owner_session_id, created_at);
