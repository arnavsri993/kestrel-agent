/*
 * Keep source identifiers queryable without exposing encrypted activity
 * payloads.  source_id is the immutable upstream record (message, tab, or
 * provider event); source_session_id preserves the originating runtime
 * conversation after activity sessionization assigns a timeline session id.
 */

ALTER TABLE memory_timeline_events ADD COLUMN source_id TEXT;
ALTER TABLE memory_timeline_events ADD COLUMN source_session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_memory_timeline_events_source
  ON memory_timeline_events(source_id, started_at, id);
CREATE INDEX IF NOT EXISTS idx_memory_timeline_events_source_session
  ON memory_timeline_events(source_session_id, started_at, id);
