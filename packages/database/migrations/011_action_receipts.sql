CREATE TABLE IF NOT EXISTS action_receipts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool_execution_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES runtime_sessions(id),
  FOREIGN KEY(tool_execution_id) REFERENCES tool_executions(id)
);
CREATE INDEX IF NOT EXISTS idx_action_receipts_session_started
  ON action_receipts(session_id, started_at);
