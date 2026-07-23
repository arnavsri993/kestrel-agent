CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, payload TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES runtime_sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_session_created ON agent_runs(session_id, created_at);

CREATE TABLE IF NOT EXISTS model_call_audits (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, session_id TEXT NOT NULL,
  payload TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES agent_runs(id),
  FOREIGN KEY(session_id) REFERENCES runtime_sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_model_call_audits_run_started ON model_call_audits(run_id, started_at);
