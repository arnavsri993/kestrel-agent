/*
 * Encrypted timeline payloads still need a small, non-content relation index
 * for bounded project/person/entity filtering.  The ids are references, not
 * user-facing names or transcript text, and the event payload remains
 * encrypted in memory_timeline_events.
 */

CREATE TABLE IF NOT EXISTS memory_timeline_event_links (
  event_id TEXT NOT NULL,
  link_type TEXT NOT NULL CHECK(link_type IN ('project', 'person', 'entity')),
  link_id TEXT NOT NULL,
  PRIMARY KEY(event_id, link_type, link_id),
  FOREIGN KEY(event_id) REFERENCES memory_timeline_events(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_memory_timeline_event_links_lookup
  ON memory_timeline_event_links(link_type, link_id, event_id);
