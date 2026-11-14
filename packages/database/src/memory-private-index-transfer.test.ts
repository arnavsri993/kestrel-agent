import { createHmac } from "node:crypto";
import { createEncryptionKey, encryptText } from "@kestrel/encryption";
import { MemoryJobSchema, EmbeddingRecordSchema } from "@kestrel/shared-types";
import { afterEach, expect, it } from "vitest";
import { KestrelDatabase } from "./index";

const time = "2026-11-04T12:00:00.000Z";
const opened: KestrelDatabase[] = [], keys: Buffer[] = [];
function fixture() {
	const key = createEncryptionKey(), db = new KestrelDatabase(":memory:", key);
	keys.push(key); opened.push(db); return { key, db };
}
afterEach(() => { for (const db of opened.splice(0)) db.close(); for (const key of keys.splice(0)) key.fill(0); });
const job = () => MemoryJobSchema.parse({ id: "private-index-job", kind: "cleanup", dedupeKey: "GENERATED_SENSITIVE_JOB_DEDUPE", status: "failed", payload: {}, attempts: 3, maxAttempts: 3, runAfter: time, createdAt: time, updatedAt: time });
const embedding = () => EmbeddingRecordSchema.parse({ id: "private-index-embedding", ownerType: "memory", ownerId: "generated-owner", provider: "fixture", model: "fixture", dimension: 2, contentHash: "a".repeat(64), vector: [0.1, 0.2], status: "ready", createdAt: time, updatedAt: time });
const hash = (key: Buffer, purpose: string, value: string) => createHmac("sha256", key).update(`kestrel-memory-index-v1:${purpose}:`).update(value).digest("hex");
function raw(db: KestrelDatabase) {
	return {
		job: (db.db.prepare("SELECT dedupe_key FROM memory_jobs").get() as { dedupe_key: string }).dedupe_key,
		embedding: (db.db.prepare("SELECT content_hash FROM memory_embeddings").get() as { content_hash: string }).content_hash,
	};
}
function seed(db: KestrelDatabase) { db.queueMemoryJob(job()); db.upsertMemoryEmbedding(embedding()); }

it("keeps logical fingerprints in authenticated payloads and writes independently keyed SQL indexes", () => {
	const a = fixture(), b = fixture(); seed(a.db); seed(b.db);
	expect(raw(a.db)).toEqual({ job: hash(a.key, "job-dedupe", job().dedupeKey), embedding: hash(a.key, "embedding-content", embedding().contentHash) });
	expect(raw(a.db)).not.toEqual(raw(b.db));
	expect(a.db.getMemoryJobByDedupeKey(job().dedupeKey)).toEqual(job());
	expect(a.db.getMemoryEmbedding(embedding().id)).toEqual(embedding());
});

it.each([false, true])("rekeys a %s legacy source without changing its bytes or semantic records", legacy => {
	const a = fixture(), b = fixture(); seed(a.db);
	if (legacy) {
		a.db.db.prepare("UPDATE memory_jobs SET dedupe_key=?").run(job().dedupeKey);
		a.db.db.prepare("UPDATE memory_embeddings SET content_hash=?").run(embedding().contentHash);
	}
	const before = a.db.db.serialize(), snapshot = a.db.exportHostProfileTransferSnapshot();
	const result = b.db.importHostProfileTransferSnapshot(snapshot);
	expect(a.db.db.serialize()).toEqual(before);
	expect(result.semanticSha256).toBe(snapshot.semanticSha256);
	expect(b.db.exportHostProfileTransferSnapshot().semanticSha256).toBe(snapshot.semanticSha256);
	expect(raw(b.db)).toEqual({ job: hash(b.key, "job-dedupe", job().dedupeKey), embedding: hash(b.key, "embedding-content", embedding().contentHash) });
	expect(b.db.getMemoryJobByDedupeKey(job().dedupeKey)).toEqual(job());
	expect(b.db.getMemoryEmbedding(embedding().id)).toEqual(embedding());
});

it("upgrades a legacy row on explicit writes and retains terminal jobs across both index encodings", () => {
	const { db } = fixture(); seed(db);
	db.db.prepare("UPDATE memory_jobs SET dedupe_key=?").run(job().dedupeKey);
	db.db.prepare("UPDATE memory_embeddings SET content_hash=?").run(embedding().contentHash);
	expect(() => db.queueMemoryJob({ ...job(), id: "replacement-job", attempts: 0, status: "pending" })).toThrow(/dedupe identity/);
	expect(db.getMemoryJob(job().id)).toEqual(job());
	db.upsertMemoryEmbedding({ ...embedding(), id: "replacement-vector", vector: [0.3, 0.4] });
	expect(db.listMemoryEmbeddings()).toEqual([{ ...embedding(), vector: [0.3, 0.4] }]);
	db.queueMemoryJob(job());
	expect(raw(db).job).not.toBe(job().dedupeKey); expect(raw(db).embedding).not.toBe(embedding().contentHash);
});

it.each(["job", "embedding"] as const)("rejects an unauthenticated %s index in reads and transfer", kind => {
	const { db } = fixture(); seed(db);
	if (kind === "job") db.db.prepare("UPDATE memory_jobs SET dedupe_key=?").run("b".repeat(64));
	else db.db.prepare("UPDATE memory_embeddings SET content_hash=?").run("b".repeat(64));
	expect(() => kind === "job" ? db.getMemoryJob(job().id) : db.getMemoryEmbedding(embedding().id)).toThrow(/identity does not match/);
	expect(() => db.exportHostProfileTransferSnapshot()).toThrow(/private index metadata/);
});

it("refuses ambiguous mixed job identities without replacing either retry budget", () => {
	const { db, key } = fixture(); db.queueMemoryJob(job());
	const duplicate = { ...job(), id: "legacy-duplicate", status: "pending", attempts: 0 };
	const encrypted = encryptText(JSON.stringify(duplicate), key);
	db.db.prepare(`INSERT INTO memory_jobs SELECT ?,kind,?, ?,?,max_attempts,run_after,locked_at,lease_until,last_error,created_at,updated_at,?,?,? FROM memory_jobs WHERE id=?`)
		.run(duplicate.id, duplicate.dedupeKey, duplicate.status, duplicate.attempts, encrypted.ciphertext, encrypted.iv, encrypted.authTag, job().id);
	const before = db.db.serialize();
	expect(() => db.getMemoryJobByDedupeKey(job().dedupeKey)).toThrow(/ambiguous/);
	expect(() => db.queueMemoryJob(job())).toThrow(/ambiguous/);
	expect(() => db.exportHostProfileTransferSnapshot()).toThrow(/ambiguous logical fingerprint/);
	expect(db.db.serialize()).toEqual(before);
});
