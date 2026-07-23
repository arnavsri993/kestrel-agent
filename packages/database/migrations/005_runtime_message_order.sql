CREATE TABLE IF NOT EXISTS runtime_message_order (
  session_id TEXT NOT NULL, message_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL,
  UNIQUE(session_id, sequence),
  FOREIGN KEY(session_id) REFERENCES runtime_sessions(id),
  FOREIGN KEY(message_id) REFERENCES runtime_messages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_runtime_message_order_session ON runtime_message_order(session_id, sequence);
