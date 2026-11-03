import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEncryptionKey } from "@kestrel/encryption";
import { MemoryRecordSchema } from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import { KestrelDatabase } from "./index.js";
import { applyHostProfileFileTransfer, planHostProfileFileTransfer } from "./host-profile-file-transfer.js";
import { EMBEDDING_LEGACY_MIGRATION_KEY } from "./memory-embedding-state.js";

const now = "2026-11-02T12:00:00.000Z";
function owner(db: KestrelDatabase, id: string) {
 db.upsertMemory(MemoryRecordSchema.parse({ id, type: "semantic", content: `Sentinel ${id}`, structuredData: {}, sourceIds: [], sourceType: "fixture", confidence: 0.8, importance: 0.5, sensitivity: "personal", entityIds: [], userConfirmed: true, inferred: false, status: "active", createdAt: now, updatedAt: now }));
}
function legacy(db: KestrelDatabase, id: string, ownerId: string, status: "pending" | "failed" | "cancelled" | "running" = "pending") {
 db.queueMemoryJob({ id, kind: "embed", dedupeKey: `embed:memory:${ownerId}:${"a".repeat(16)}`, status,
  payload: { ownerType: "memory", ownerId, fixture: true }, attempts: status === "failed" ? 3 : 0, maxAttempts: 3,
  runAfter: now, createdAt: now, updatedAt: now, ...(status === "running" ? { lockedAt: now, leaseUntil: "2026-11-02T13:00:00.000Z", leaseToken: "ad7d9896-b7ad-47ca-8fd4-e082b3dd653b" } : {}) });
}
function finish(db: KestrelDatabase) {
 for (let i = 0; i < 100; i++) if (db.migrateLegacyMemoryEmbeddingIdentifiers(now, 1).done) return;
 throw new Error("Migration failed to finish");
}
describe("explicit legacy embedding identifier migration", () => {
 it("resumes across reopen, neutralizes legacy identifiers once and preserves current rows and transfer snapshots", () => {
  const dir = mkdtempSync(join(tmpdir(), "kestrel-legacy-")), path = join(dir, "db.sqlite"), key = createEncryptionKey();
  let db = new KestrelDatabase(path, key);
  try {
   owner(db, "eligible"); legacy(db, "a", "eligible");
   const input = db.getMemoryEmbeddingInput("memory", "eligible")!;
   db.queueMemoryJob({ id: "current-job", kind: "embed", dedupeKey: `embed:memory:eligible:${input.generation}`, status: "completed", payload: { ownerType: "memory", ownerId: "eligible", generation: input.generation }, attempts: 1, maxAttempts: 3, runAfter: now, createdAt: now, updatedAt: now });
   db.upsertMemoryEmbedding({ id: "legacy-vector", ownerType: "memory", ownerId: "eligible", provider: "fixture", model: "old", dimension: 1, contentHash: "a".repeat(64), vector: [1], status: "ready", createdAt: now, updatedAt: now });
   db.upsertMemoryEmbedding({ id: "current-vector", ownerType: "memory", ownerId: "eligible", provider: "fixture", model: "new", dimension: 1, contentHash: input.contentHash, generation: input.generation, vector: [1], status: "ready", createdAt: now, updatedAt: now });
   const snapshot = db.exportHostProfileTransferSnapshot();
   expect(db.exportHostProfileTransferSnapshot()).toEqual(snapshot);
   expect(db.getPrivateState(EMBEDDING_LEGACY_MIGRATION_KEY)).toBeUndefined();
   db.migrateLegacyMemoryEmbeddingIdentifiers(now, 1);
   const changed = db.listMemoryJobs({ kind: "embed" }).find(job => job.payload.fixture === true)!;
   expect(changed.id).toMatch(/^legacy-retired-job-/); expect(changed.dedupeKey).toMatch(/^legacy-embedding-opaque:/);
   db.close(); db = new KestrelDatabase(path, key); finish(db);
   expect(db.getMemoryJob(changed.id)).toEqual(changed);
   expect(db.getMemoryJob("current-job")?.payload.generation).toBe(input.generation);
   expect(db.getMemoryEmbedding("current-vector")?.generation).toBe(input.generation);
   expect(db.getMemoryEmbedding("legacy-vector")).toMatchObject({ status: "ready", vector: [1] });
   expect(db.getMemoryEmbedding("legacy-vector")?.generation).toBeUndefined();
   expect(db.getMemoryEmbedding("legacy-vector")?.contentHash).not.toBe("a".repeat(64));
   expect(db.exportHostProfileTransferSnapshot().semanticSha256).not.toBe(snapshot.semanticSha256);
   const after = db.exportHostProfileTransferSnapshot(); finish(db); expect(db.exportHostProfileTransferSnapshot()).toEqual(after);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
 });
 it("rejects a reviewed file-transfer plan after explicit source migration", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-legacy-plan-")));
  const source = join(dir, "source.sqlite"), destination = join(dir, "destination.sqlite");
  const sourceKey = createEncryptionKey(), destinationKey = createEncryptionKey();
  let db = new KestrelDatabase(source, sourceKey);
  try {
   owner(db, "x"); legacy(db, "a", "x"); db.close();
   const options = { sourceDatabasePath: source, sourceKey, destinationDatabasePath: destination };
   const plan = planHostProfileFileTransfer(options);
   expect(planHostProfileFileTransfer(options)).toEqual(plan);
   db = new KestrelDatabase(source, sourceKey); finish(db); db.close();
   expect(() => applyHostProfileFileTransfer({ plan, sourceKey, destinationKey, acceptedPlanSha256: plan.planSha256 })).toThrow(/changed after review/i);
  } finally { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); }
 });
 it.each(["memory_jobs", "memory_embeddings"] as const)("rejects oversized %s ciphertext before loading the page and leaves its checkpoint unchanged", table => {
  const db = new KestrelDatabase(":memory:", createEncryptionKey());
  try {
   if (table === "memory_jobs") legacy(db, "a", "x");
   else {
    db.upsertMemoryEmbedding({ id: "a", ownerType: "memory", ownerId: "x", provider: "fixture", model: "fixture", dimension: 1, contentHash: "a".repeat(64), vector: [1], status: "ready", createdAt: now, updatedAt: now });
    db.migrateLegacyMemoryEmbeddingIdentifiers(now, 8);
   }
   const before = db.getPrivateState(EMBEDDING_LEGACY_MIGRATION_KEY);
   db.db.prepare(`UPDATE ${table} SET payload_ciphertext=zeroblob(4000001) WHERE id='a'`).run();
   expect(() => db.migrateLegacyMemoryEmbeddingIdentifiers(now, 8)).toThrow(/byte limit/);
   expect(db.getPrivateState(EMBEDDING_LEGACY_MIGRATION_KEY)).toEqual(before);
  } finally { db.close(); }
 });
 it("rejects a page whose combined ciphertext exceeds the total byte budget", () => {
  const db = new KestrelDatabase(":memory:", createEncryptionKey());
  try {
   for (const id of ["a", "b", "c"]) legacy(db, id, id);
   db.db.prepare("UPDATE memory_jobs SET payload_ciphertext=zeroblob(2700000)").run();
   expect(() => db.migrateLegacyMemoryEmbeddingIdentifiers(now, 8)).toThrow(/byte limit/);
   expect(db.getPrivateState(EMBEDDING_LEGACY_MIGRATION_KEY)).toBeUndefined();
  } finally { db.close(); }
 });
 it("blocks an active legacy job with no expiry for manual recovery", () => {
  const db = new KestrelDatabase(":memory:", createEncryptionKey());
  try {
   legacy(db, "a", "x", "running");
   const job = db.getMemoryJob("a")!;
   db.queueMemoryJob({ ...job, leaseUntil: undefined });
   expect(db.migrateLegacyMemoryEmbeddingIdentifiers(now, 8)).toMatchObject({ blocked: true, processed: 0 });
   expect(db.getMemoryJob("a")?.status).toBe("running");
  } finally { db.close(); }
 });
 it("blocks at an active lease without moving past it", () => {
  const db = new KestrelDatabase(":memory:", createEncryptionKey());
  try { owner(db, "x"); legacy(db, "a", "x", "running");
   expect(db.migrateLegacyMemoryEmbeddingIdentifiers(now, 1)).toMatchObject({ blocked: true, processed: 0, done: false });
   expect(db.getMemoryJob("a")?.status).toBe("running");
   expect(db.migrateLegacyMemoryEmbeddingIdentifiers("2026-11-02T13:00:00.000Z", 1)).toMatchObject({ blocked: false, processed: 1 });
  } finally { db.close(); }
 });
 it("rolls back the page and checkpoint when vector metadata disagrees with its encrypted payload", () => {
  const db = new KestrelDatabase(":memory:", createEncryptionKey());
  try {
   for (const id of ["a", "b"]) db.upsertMemoryEmbedding({ id, ownerType: "memory", ownerId: id, provider: "fixture", model: "fixture", dimension: 1, contentHash: "b".repeat(64), vector: [1], status: "ready", createdAt: now, updatedAt: now });
   db.migrateLegacyMemoryEmbeddingIdentifiers(now, 8);
   db.db.prepare("UPDATE memory_embeddings SET status='deleted' WHERE id='b'").run();
   expect(() => db.migrateLegacyMemoryEmbeddingIdentifiers(now, 8)).toThrow(/identity/);
   expect(db.getMemoryEmbedding("a")?.contentHash).toBe("b".repeat(64));
   expect(db.getPrivateState(EMBEDDING_LEGACY_MIGRATION_KEY)).toMatchObject({ phase: "embeddings", afterId: "" });
  } finally { db.close(); }
 });
 it("rolls back earlier job rewrites when a later job has mismatched encrypted identity", () => {
  const db = new KestrelDatabase(":memory:", createEncryptionKey());
  try {
   legacy(db, "a", "first"); legacy(db, "b", "second");
   db.db.prepare("UPDATE memory_jobs SET dedupe_key='tampered' WHERE id='b'").run();
   expect(() => db.migrateLegacyMemoryEmbeddingIdentifiers(now, 8)).toThrow(/identity/);
   expect(db.getMemoryJob("a")?.dedupeKey).toContain("a".repeat(16));
   expect(db.getPrivateState(EMBEDDING_LEGACY_MIGRATION_KEY)).toBeUndefined();
  } finally { db.close(); }
 });
 it.each(["failed", "cancelled"] as const)("retains a current-generation %s guard without overriding existing jobs", status => {
  const db = new KestrelDatabase(":memory:", createEncryptionKey());
  try { owner(db, "x"); legacy(db, "a", "x", status); finish(db);
   const generation = db.getMemoryEmbeddingInput("memory", "x")!.generation;
   expect(db.getMemoryJobByDedupeKey(`embed:memory:x:${generation}`)).toMatchObject({ status, attempts: status === "failed" ? 3 : 0, maxAttempts: 3 });
  } finally { db.close(); }
 });
 it("never overwrites an existing current-generation job when binding a terminal guard", () => {
  const db = new KestrelDatabase(":memory:", createEncryptionKey());
  try {
   owner(db, "x"); const input = db.getMemoryEmbeddingInput("memory", "x")!;
   const current = { id: "current", kind: "embed" as const, dedupeKey: `embed:memory:x:${input.generation}`, status: "completed" as const,
    payload: { ownerType: "memory", ownerId: "x", generation: input.generation }, attempts: 1, maxAttempts: 3, runAfter: now, createdAt: now, updatedAt: now };
   db.queueMemoryJob(current); legacy(db, "a", "x", "failed"); finish(db);
   expect(db.getMemoryJob("current")).toEqual(current);
   const retired = db.listMemoryJobs({ kind: "embed" }).find(job => job.id.startsWith("legacy-retired-job-"))!;
   expect(db.bindLegacyMemoryEmbeddingTerminalGuard(retired.id, now)).toMatchObject({ terminal: true, boundGeneration: input.generation });
  } finally { db.close(); }
 });
 it("keeps denied owners without claiming a generation", () => {
  const db = new KestrelDatabase(":memory:", createEncryptionKey());
  try { legacy(db, "a", "missing", "failed"); finish(db);
   const jobs = db.listMemoryJobs({ kind: "embed" }); expect(jobs).toHaveLength(1);
   expect(jobs[0]!.payload).not.toHaveProperty("generation"); expect(jobs[0]!.status).toBe("failed");
   expect(db.bindLegacyMemoryEmbeddingTerminalGuard(jobs[0]!.id, now)).toEqual({ terminal: true });
   owner(db, "missing");
   const bound = db.bindLegacyMemoryEmbeddingTerminalGuard(jobs[0]!.id, now);
   expect(bound.boundGeneration).toBe(db.getMemoryEmbeddingInput("memory", "missing")!.generation);
   expect(db.getMemoryJobByDedupeKey(`embed:memory:missing:${bound.boundGeneration}`)).toMatchObject({ status: "failed", attempts: 3, maxAttempts: 3 });
   expect(db.bindLegacyMemoryEmbeddingTerminalGuard(jobs[0]!.id, now)).toEqual(bound);
  } finally { db.close(); }
 });
});
