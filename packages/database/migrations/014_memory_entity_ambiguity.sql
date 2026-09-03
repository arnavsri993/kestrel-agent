/*
 * Two people can intentionally share a display name.  Entity resolution
 * keeps candidate identity in the encrypted payload, so the canonical-name
 * index must not silently merge those candidates.
 */
DROP INDEX IF EXISTS idx_memory_entities_canonical_active;
CREATE INDEX IF NOT EXISTS idx_memory_entities_canonical_active
  ON memory_entities(kind, canonical_name_hash, status);
