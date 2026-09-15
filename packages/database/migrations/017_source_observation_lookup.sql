-- Exact source-message lookup for idempotent imports and revision/deletion handling.
-- Index values are opaque source hashes; message text remains encrypted.
CREATE INDEX IF NOT EXISTS idx_memory_timeline_source_message
 ON memory_timeline_events(source_session_id, source_id, started_at, id);
