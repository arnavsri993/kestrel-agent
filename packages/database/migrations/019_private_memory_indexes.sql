-- Content-derived public indexes are rekeyed transactionally by KestrelDatabase
-- using the existing profile key. Opaque aliases preserve historical job handles.
CREATE TABLE IF NOT EXISTS memory_job_id_aliases (
 alias_hash TEXT PRIMARY KEY,
 job_id TEXT NOT NULL REFERENCES memory_jobs(id) ON DELETE CASCADE ON UPDATE CASCADE
);
