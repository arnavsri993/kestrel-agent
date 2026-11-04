import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEncryptionKey } from '@kestrel/encryption';
import { MemoryRecordSchema, TimelineEventSchema } from '@kestrel/shared-types';
import { describe, it, expect } from 'vitest';
import { KestrelDatabase } from './index.js';
import { EMBEDDING_LEGACY_MIGRATION_KEY, EMBEDDING_STATE_SECRET_KEY } from './memory-embedding-state.js';

const now = '2026-11-02T12:00:00.000Z';
const later = '2026-11-02T12:01:00.000Z';
const leaseToken = 'ad7d9896-b7ad-47ca-8fd4-e082b3dd653b';
function fixture(withOwner = true) {
 const root = mkdtempSync(join(tmpdir(), 'kestrel-host-lease-'));
 const path = join(root, 'data.sqlite'), key = createEncryptionKey(), bindingKey = randomBytes(32);
 const db = new KestrelDatabase(path, key);
 const record = MemoryRecordSchema.parse({ id: 'owner', type: 'semantic', content: 'generated source', structuredData: {}, sourceIds: [], sourceType: 'fixture', confidence: .8, importance: .5, sensitivity: 'personal', entityIds: [], userConfirmed: true, inferred: false, status: 'active', createdAt: now, updatedAt: now });
 if (withOwner) db.upsertMemory(record);
 db.queueMemoryJob({ id: 'a', kind: 'embed', dedupeKey: 'embed:memory:owner:aaaaaaaaaaaaaaaa', status: 'running', payload: { ownerType: 'memory', ownerId: 'owner', fixture: true }, attempts: 2, maxAttempts: 3, runAfter: now, createdAt: now, updatedAt: now, lockedAt: now, leaseToken });
 expect(db.migrateLegacyMemoryEmbeddingIdentifiers(now)).toMatchObject({ blocked: true });
 db.close();
 const open = (readonly: boolean) => KestrelDatabase.openForHostLegacyEmbeddingRecovery(path, key, { readonly });
 const normal = () => new KestrelDatabase(path, key);
 return { root, path, key, bindingKey, record, open, normal, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function digest(root: string) {
 return readdirSync(root).sort().map(name => [name, createHash('sha256').update(readFileSync(join(root, name))).digest('hex')]);
}
function plan(f: ReturnType<typeof fixture>) {
 const db = f.open(true);
 try { return db.reviewLegacyEmbeddingLeaseRecovery(f.bindingKey)!; } finally { db.close(); }
}
function apply(f: ReturnType<typeof fixture>, snapshot: ReturnType<typeof plan>) {
 const db = f.open(false);
 try { return db.cancelLegacyEmbeddingLeaseRecovery(snapshot, f.bindingKey, later); } finally { db.close(); }
}
function mutate(f: ReturnType<typeof fixture>, edit: (db: KestrelDatabase) => void) {
 const db = f.normal(); try { edit(db); } finally { db.close(); }
}
describe('host-only legacy missing-lease recovery', () => {
 it('previews without file or secret changes, cancels once, fences old workers and keeps terminal guard', () => {
  const f = fixture();
  try {
   const before = digest(f.root); const snapshot = plan(f);
   expect(snapshot).toEqual({ jobId: 'a', binding: expect.stringMatching(/^[0-9a-f]{64}$/) });
   expect(digest(f.root)).toEqual(before);
   expect(apply(f, snapshot)).toEqual({ cancelled: true });
   expect(() => apply(f, snapshot)).toThrow();
   mutate(f, db => {
    expect(db.getMemoryJob('a')).toMatchObject({ status: 'cancelled', attempts: 2, maxAttempts: 3, payload: { fixture: true } });
    expect(db.getMemoryJob('a')?.leaseToken).toBeUndefined();
    expect(db.completeMemoryJob('a', later, leaseToken)).toBe(false);
    expect(db.failMemoryJob('a', 'late', later, 30000, leaseToken)).toBeUndefined();
    for (let i = 0; i < 20; i++) if (db.migrateLegacyMemoryEmbeddingIdentifiers(later).done) break;
    const retired = db.listMemoryJobs({ kind: 'embed' }).find(job => job.id.startsWith('legacy-retired-job-'))!;
    expect(retired).toMatchObject({ status: 'cancelled', attempts: 2, maxAttempts: 3 });
    const input = db.getMemoryEmbeddingInput('memory', 'owner')!;
    expect(db.getMemoryJobByDedupeKey(`embed:memory:owner:${input.generation}`)).toMatchObject({ status: 'cancelled', attempts: 2 });
   });
  } finally { f.cleanup(); }
 });
 it.each(['attempt', 'lease', 'cursor', 'owner'] as const)('rejects stale review after %s change', change => {
  const f = fixture();
  try {
   const snapshot = plan(f);
   mutate(f, db => {
    const job = db.getMemoryJob('a')!;
    if (change === 'attempt') db.queueMemoryJob({ ...job, attempts: 3 });
    if (change === 'lease') db.queueMemoryJob({ ...job, leaseUntil: '2026-11-02T13:00:00.000Z' });
    if (change === 'cursor') db.setPrivateState(EMBEDDING_LEGACY_MIGRATION_KEY, { version: 1, phase: 'jobs', afterId: 'a' });
    if (change === 'owner') db.upsertMemory({ ...f.record, content: 'changed source' });
   });
   expect(() => apply(f, snapshot)).toThrow();
   mutate(f, db => expect(db.getMemoryJob('a')?.status).toBe('running'));
  } finally { f.cleanup(); }
 });
 it('does not initialize a missing generation secret during preview or cancellation', () => {
  const f = fixture(); try {
   mutate(f, db => db.db.prepare("DELETE FROM private_runtime_state WHERE key LIKE 'kestrel.embedding-generation.v1.%' OR key LIKE 'kestrel.embedding-authority.v1.%'").run());
   mutate(f, db => { expect(db.getPrivateState(EMBEDDING_STATE_SECRET_KEY)).toBeUndefined(); db.migrateLegacyMemoryEmbeddingIdentifiers(now); });
   const before = digest(f.root); const snapshot = plan(f); expect(digest(f.root)).toEqual(before);
   expect(apply(f, snapshot)).toEqual({ cancelled: true });
   const read = f.open(true); try { expect(read.getPrivateState(EMBEDDING_STATE_SECRET_KEY)).toBeUndefined(); } finally { read.close(); }
  } finally { f.cleanup(); }
 });
 it('invalidates previously eligible authority after revoke and regrant', () => {
  const f = fixture(); try {
   mutate(f, db => { expect(db.getMemoryEmbeddingInput('memory', 'owner')).toBeDefined(); });
   const snapshot = plan(f);
   mutate(f, db => { db.upsertMemory({ ...f.record, status: 'deleted' }); db.upsertMemory(f.record); });
   expect(() => apply(f, snapshot)).toThrow();
  } finally { f.cleanup(); }
 });
 it('invalidates denied authority after revoke and regrant', () => {
  const f = fixture(false); try {
   const snapshot = plan(f);
   mutate(f, db => { db.upsertMemory(f.record); db.upsertMemory({ ...f.record, status: 'deleted' }); });
   expect(() => apply(f, snapshot)).toThrow();
   expect(apply(f, plan(f))).toEqual({ cancelled: true });
  } finally { f.cleanup(); }
 });
 it('tolerates checkpoint re-encryption with the same logical cursor', () => {
  const f = fixture(); try {
   const snapshot = plan(f);
   mutate(f, db => db.setPrivateState(EMBEDDING_LEGACY_MIGRATION_KEY, { version: 1, phase: 'jobs', afterId: '' }));
   expect(apply(f, snapshot)).toEqual({ cancelled: true });
  } finally { f.cleanup(); }
 });
 it.each(['missing', 'deleted'] as const)('recovers %s source without granting authority', which => {
  const f = fixture(which !== 'missing');
  try {
   if (which === 'deleted') mutate(f, db => db.upsertMemory({ ...f.record, status: 'deleted' }));
   expect(apply(f, plan(f))).toEqual({ cancelled: true });
   mutate(f, db => { for (let i=0;i<20;i++) if (db.migrateLegacyMemoryEmbeddingIdentifiers(later).done) break;
    expect(db.listMemoryJobs({ kind:'embed' }).find(job => job.id.startsWith('legacy-retired-job-'))?.status).toBe('cancelled');
    expect(db.getMemoryEmbeddingInput('memory', 'owner')).toBeUndefined(); });
  } finally { f.cleanup(); }
 });
 it('reviews marked nonretired blockers but ignores actual retired identifiers', () => {
  const f = fixture(); try {
   mutate(f, db => { const job = db.getMemoryJob('a')!; db.queueMemoryJob({ ...job, payload: { ...job.payload, legacyIdentifierMigration: { version: 1 } } });
    expect(db.migrateLegacyMemoryEmbeddingIdentifiers(now)).toMatchObject({ blocked: true }); });
   expect(apply(f, plan(f))).toEqual({ cancelled: true });
   mutate(f, db => { db.db.prepare("DELETE FROM memory_jobs WHERE id='a'").run();
    db.queueMemoryJob({ id: `legacy-retired-job-${leaseToken}`, kind: 'embed', dedupeKey: `legacy-embedding-opaque:${leaseToken}`,
     status: 'running', payload: { ownerType: 'memory', ownerId: 'owner', legacyIdentifierMigration: { version: 1 } },
     attempts: 2, maxAttempts: 3, runAfter: now, createdAt: now, updatedAt: now });
    expect(db.migrateLegacyMemoryEmbeddingIdentifiers(now)).toMatchObject({ blocked: false });
    db.setPrivateState(EMBEDDING_LEGACY_MIGRATION_KEY, { version: 1, phase: 'jobs', afterId: '' }); });
   expect(plan(f)).toBeUndefined();
  } finally { f.cleanup(); }
 });
 it.each(['database', 'wal', 'symlink-wal'] as const)('rejects %s before either SQLite opener', kind => {
  const f = fixture(); try {
   const snapshot = plan(f);
   if (kind === 'database') truncateSync(f.path, 256_000_001);
   if (kind === 'wal') { writeFileSync(`${f.path}-wal`, ''); truncateSync(`${f.path}-wal`, 256_000_001); }
   if (kind === 'symlink-wal') { writeFileSync(join(f.root, 'target'), 'sentinel'); symlinkSync(join(f.root, 'target'), `${f.path}-wal`); }
   for (const readonly of [true, false]) expect(() => f.open(readonly)).toThrow(/file/);
   if (kind === 'symlink-wal') expect(readFileSync(join(f.root, 'target'), 'utf8')).toBe('sentinel');
   expect(snapshot).toBeDefined();
  } finally { f.cleanup(); }
 });
 it.each(['malformed descendant', 'graph depth'] as const)('cancellation for %s never creates authority or a runnable job', kind => {
  const f = fixture(); try {
   mutate(f, db => {
    if (kind === 'malformed descendant') {
     const event = TimelineEventSchema.parse({ id:'bad', startedAt:now, eventType:'note', source:'fixture', actor:'user', textSummary:'generated', structuredData:{}, projectIds:[], personIds:[], entityIds:[], importance:.5, sensitivity:'personal', retentionPolicy:'durable', embeddingStatus:'queued', status:'active', createdAt:now, updatedAt:now });
     db.upsertTimelineEvent(event); db.upsertMemory({ ...f.record, sourceIds:['timeline_event:bad'] });
     db.db.prepare("UPDATE memory_timeline_events SET status='deleted' WHERE id='bad'").run();
    } else {
     for (let i=70;i>=0;i--) db.upsertMemory({ ...f.record, id:`depth-${i}`, sourceIds: i === 70 ? [] : [`memory:depth-${i+1}`] });
     db.upsertMemory({ ...f.record, sourceIds:['memory:depth-0'] });
    }
    expect(db.getMemoryEmbeddingInput('memory','owner')).toBeUndefined();
   });
   expect(apply(f, plan(f))).toEqual({ cancelled: true });
   mutate(f, db => {
    expect(db.completeMemoryJob('a', later, leaseToken)).toBe(false);
    expect(db.failMemoryJob('a', 'late', later, 30000, leaseToken)).toBeUndefined();
    for(let i=0;i<20;i++) if(db.migrateLegacyMemoryEmbeddingIdentifiers(later).done) break;
    expect(db.getMemoryEmbeddingInput('memory','owner')).toBeUndefined();
    expect(db.listMemoryEmbeddings({ownerType:'memory',ownerId:'owner'})).toEqual([]);
    expect(db.listMemoryJobs({kind:'embed'}).every(job => job.status === 'cancelled')).toBe(true);
   });
  } finally { f.cleanup(); }
 });
 it('refuses finite lease and current generation, even if expired', () => {
  const f = fixture(); try {
   mutate(f, db => { const job = db.getMemoryJob('a')!; db.queueMemoryJob({ ...job, leaseUntil: '2026-11-02T11:00:00.000Z' }); });
   expect(plan(f)).toBeUndefined();
   mutate(f, db => { const job = db.getMemoryJob('a')!; db.queueMemoryJob({ ...job, leaseUntil: undefined, payload: { ...job.payload, generation: leaseToken } }); });
   expect(plan(f)).toBeUndefined();
  } finally { f.cleanup(); }
 });
 it('refuses oversized source before attempting recovery', () => {
  const f = fixture(); try {
   mutate(f, db => db.db.prepare("UPDATE memories SET content_ciphertext=? WHERE id='owner'").run('x'.repeat(4_000_001)));
   expect(() => plan(f)).toThrow();
  } finally { f.cleanup(); }
 });
 it('fails closed on wrong key, missing file, and schema mismatch', () => {
  const f = fixture(); try {
   expect(() => KestrelDatabase.openForHostLegacyEmbeddingRecovery(f.path, createEncryptionKey(), { readonly: true })).toThrow();
   expect(() => KestrelDatabase.openForHostLegacyEmbeddingRecovery(join(f.root, 'absent'), f.key, { readonly: false })).toThrow();
   mutate(f, db => { db.db.prepare('DELETE FROM schema_migrations WHERE version=(SELECT MAX(version) FROM schema_migrations)').run(); });
   expect(() => f.open(true)).toThrow(/schema/);
  } finally { f.cleanup(); }
 });
 it('rolls back failed writes', () => {
  const f = fixture(); try {
   const snapshot = plan(f), db = f.open(false);
   try {
    db.db.exec(`CREATE TRIGGER deny_recovery BEFORE UPDATE ON memory_jobs BEGIN SELECT RAISE(ABORT,'no'); END;`);
    expect(() => db.cancelLegacyEmbeddingLeaseRecovery(snapshot, f.bindingKey, later)).toThrow();
    expect(db.getMemoryJob('a')?.status).toBe('running');
   } finally { db.close(); }
  } finally { f.cleanup(); }
 });
});
