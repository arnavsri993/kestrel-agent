/* Keep provenance rows compatible with the encrypted-payload upsert contract.
 * Existing profiles may already have applied v12 before this column was
 * introduced, so this is a forward-only, data-preserving migration. */
ALTER TABLE memory_provenance ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
UPDATE memory_provenance SET updated_at = created_at WHERE updated_at = '';
