CREATE TABLE IF NOT EXISTS idempotency_claims (
  key TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  owner_pid INTEGER NOT NULL CHECK(owner_pid > 0),
  pending_result TEXT NOT NULL,
  created_at TEXT NOT NULL
);
