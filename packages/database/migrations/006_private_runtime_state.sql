CREATE TABLE IF NOT EXISTS private_runtime_state (
  key TEXT PRIMARY KEY, value_ciphertext TEXT NOT NULL, value_iv TEXT NOT NULL,
  value_auth_tag TEXT NOT NULL, updated_at TEXT NOT NULL
);
