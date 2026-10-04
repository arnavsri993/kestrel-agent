import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createEncryptionKey, encryptText } from "@kestrel/encryption";
import { afterEach, expect, it } from "vitest";
import { DatabaseMigrationError, KestrelDatabase } from "./index";
import type { MemoryJob } from "@kestrel/shared-types";
const roots: string[] = [];
const at = "2026-10-03T12:00:00.000Z";
const digest = createHash("sha256").update("Owned ordinary memory fixture").digest("hex");
const dedupe = `embed:memory:fixture:${digest.slice(0,16)}`;
const oldId = `memory-job-${createHash("sha256").update(dedupe).digest("hex").slice(0,40)}`;
const job = (id = oldId): MemoryJob => ({ id, kind: "embed", dedupeKey: dedupe, payload: { ownerType: "memory", ownerId: "fixture" }, status: "pending", attempts: 1, maxAttempts: 4, runAfter: at, createdAt: at, updatedAt: at });
const embedding = { id: "embedding-fixture", ownerType: "memory" as const, ownerId: "fixture", provider: "synthetic", model: "synthetic", dimension: 1, vector: [1], contentHash: digest, status: "ready" as const, createdAt: at, updatedAt: at };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive:true, force:true }); });
function fixture() { const root=mkdtempSync(join(tmpdir(), "kestrel-private-index-")); roots.push(root); return { path:join(root,"db.sqlite"), key:createEncryptionKey() }; }
function legacyFixture(corrupt = false) {
 const f=fixture(); const d=new KestrelDatabase(f.path,f.key); d.queueMemoryJob(job()); d.upsertMemoryEmbedding(embedding);
 const encrypted=encryptText(JSON.stringify(job()),f.key);
 d.db.prepare("UPDATE memory_jobs SET id=?,dedupe_key=?,payload_ciphertext=?,payload_iv=?,payload_auth_tag=?,status='running',attempts=2,locked_at=?,lease_until=?")
  .run(oldId,dedupe,encrypted.ciphertext,encrypted.iv,encrypted.authTag,at,"2026-10-03T12:01:00.000Z");
 d.db.prepare("UPDATE memory_embeddings SET content_hash=?").run(digest);
 if(corrupt) d.db.prepare("UPDATE memory_embeddings SET payload_auth_tag=?").run("00".repeat(16));
 d.db.exec("DROP TABLE memory_job_id_aliases; DELETE FROM schema_migrations WHERE version=19"); d.close(); return f;
}
it("keyed public indexes differ across profiles, preserve dedupe and do not expose ordinary content guesses", () => {
 const a=new KestrelDatabase(":memory:",createEncryptionKey()), b=new KestrelDatabase(":memory:",createEncryptionKey());
 try {
  const first=a.queueMemoryJob(job()), second=b.queueMemoryJob(job());
  a.upsertMemoryEmbedding(embedding); b.upsertMemoryEmbedding(embedding);
  expect(first.id).not.toBe(oldId); expect(first.id).not.toBe(second.id);
  expect(a.getMemoryJob(oldId)?.id).toBe(first.id); expect(a.getMemoryJobByDedupeKey(dedupe)?.id).toBe(first.id);
  const row=a.db.prepare("SELECT id,dedupe_key,payload_ciphertext FROM memory_jobs").get() as any;
  const other=b.db.prepare("SELECT dedupe_key FROM memory_jobs").get() as any;
  expect(row.dedupe_key).toMatch(/^[a-f0-9]{64}$/); expect(row.dedupe_key).not.toBe(other.dedupe_key); expect(JSON.stringify(row)).not.toContain(digest.slice(0,16));
  a.upsertMemoryEmbedding({...embedding,id:"other-id",vector:[2]});
  const columns=a.db.prepare("SELECT content_hash FROM memory_embeddings").all() as any[];
  expect(columns).toHaveLength(1); expect(columns[0].content_hash).not.toBe(digest);
  expect(columns[0].content_hash).not.toBe((b.db.prepare("SELECT content_hash FROM memory_embeddings").get() as any).content_hash);
  expect(a.getMemoryEmbedding(embedding.id)?.vector).toEqual([2]);
  expect(a.getMemoryEmbedding(embedding.id)?.contentHash).toBe(digest);
 } finally { a.close(); b.close(); }
});
it("backs up and migrates legacy indexes, retaining old handles, work leases, encrypted evidence and idempotent reopen", () => {
 const f=legacyFixture(); const d=new KestrelDatabase(f.path,f.key);
 let id:string;
 try {
  expect(d.lastMigrationBackupPath).toBeDefined();
  const migrated=d.getMemoryJob(oldId)!; id=migrated.id;
  expect(migrated).toMatchObject({...job(id),status:"running",attempts:2,lockedAt:at,leaseUntil:"2026-10-03T12:01:00.000Z"});
  expect(id).not.toBe(oldId); expect(d.getMemoryJobByDedupeKey(dedupe)?.id).toBe(id);
  expect((d.db.prepare("SELECT dedupe_key FROM memory_jobs").get() as any).dedupe_key).not.toBe(dedupe);
  expect((d.db.prepare("SELECT content_hash FROM memory_embeddings").get() as any).content_hash).not.toBe(digest);
  expect(d.getMemoryEmbedding(embedding.id)).toEqual(embedding);
  const original=new Database(d.lastMigrationBackupPath!,{readonly:true});
  try { expect((original.prepare("SELECT id,dedupe_key FROM memory_jobs").get() as any)).toEqual({id:oldId,dedupe_key:dedupe}); } finally { original.close(); }
  expect(d.completeMemoryJob(oldId,at)).toBe(true); expect(d.getMemoryJob(id)?.status).toBe("completed");
 } finally { d.close(); }
 const reopened=new KestrelDatabase(f.path,f.key);
 try { expect(reopened.lastMigrationBackupPath).toBeUndefined(); expect(reopened.getMemoryJob(oldId)).toMatchObject({id:id!,status:"completed"}); } finally { reopened.close(); }
});
it("preserves custom job identity and returns authoritative retry/lease state", () => {
 const d=new KestrelDatabase(":memory:",createEncryptionKey());
 try {
  expect(d.queueMemoryJob(job("custom-opaque-job")).id).toBe("custom-opaque-job");
  const claimed=d.claimMemoryJob(at)!; expect(claimed).toMatchObject({id:"custom-opaque-job",status:"running",attempts:2,lockedAt:at});
  expect(d.failMemoryJob(claimed.id,"synthetic failure",at)).toMatchObject({status:"pending",attempts:2,lastError:"synthetic failure"});
  expect(d.getMemoryJob(claimed.id)?.lockedAt).toBeUndefined();
 } finally { d.close(); }
});
it("rolls back all rekeying on authenticated-payload failure and retains a recoverable original", () => {
 const f=legacyFixture(true); let failure:DatabaseMigrationError|undefined;
 try { new KestrelDatabase(f.path,f.key); } catch(error) { expect(error).toBeInstanceOf(DatabaseMigrationError); failure=error as DatabaseMigrationError; }
 expect(failure?.backupPath).toBeDefined();
 const original=new Database(f.path,{readonly:true});
 try { expect(original.prepare("SELECT id,dedupe_key,status,attempts FROM memory_jobs").get()).toEqual({id:oldId,dedupe_key:dedupe,status:"running",attempts:2}); expect(original.prepare("SELECT version FROM schema_migrations WHERE version=19").get()).toBeUndefined(); } finally { original.close(); }
});
