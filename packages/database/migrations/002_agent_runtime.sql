CREATE TABLE IF NOT EXISTS runtime_sessions (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_executions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES runtime_sessions(id)
);
