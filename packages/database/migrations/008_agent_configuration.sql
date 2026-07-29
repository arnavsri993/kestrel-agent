CREATE TABLE IF NOT EXISTS agent_configuration_records (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('version', 'proposal', 'audit', 'improvement')),
  status TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_configuration_records_kind_created
  ON agent_configuration_records(kind, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_configuration_records_kind_status
  ON agent_configuration_records(kind, status);
