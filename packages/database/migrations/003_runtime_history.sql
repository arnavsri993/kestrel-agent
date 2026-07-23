CREATE TABLE IF NOT EXISTS runtime_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content_ciphertext TEXT NOT NULL,
  content_iv TEXT NOT NULL,
  content_auth_tag TEXT NOT NULL,
  parent_message_id TEXT,
  tool_execution_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES runtime_sessions(id)
);

CREATE TABLE IF NOT EXISTS runtime_message_terms (
  message_id TEXT NOT NULL,
  term_hash TEXT NOT NULL,
  PRIMARY KEY(message_id, term_hash),
  FOREIGN KEY(message_id) REFERENCES runtime_messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runtime_message_terms_hash
  ON runtime_message_terms(term_hash);
CREATE INDEX IF NOT EXISTS idx_runtime_messages_session_created
  ON runtime_messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS workspace_mutations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool_execution_id TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  undone_at TEXT,
  FOREIGN KEY(session_id) REFERENCES runtime_sessions(id),
  FOREIGN KEY(tool_execution_id) REFERENCES tool_executions(id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_mutations_session_created
  ON workspace_mutations(session_id, created_at);
