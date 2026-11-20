import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { createEncryptionKey, decryptText, encryptText } from "@kestrel/encryption";
import { afterEach, describe, expect, it } from "vitest";
import { KestrelDatabase } from "./index.js";
import { planHostProfileFileTransfer, applyHostProfileFileTransfer } from "./host-profile-file-transfer.js";
import { seedNativeLegacy19Source } from "./legacy-profile-source-fixture.js";
import {
	LEGACY_CONFLICTED_JOB_PREFIX, LEGACY_JOB_CONFLICT_PREFIX, LEGACY_PROFILE_SECRET_KEY,
	LEGACY_JOB_CONFLICT_MANIFEST_KEY, legacyProfileStateKey, parseLegacyProfileSecret,
} from "./legacy-profile-state.js";
import { isLegacyJobConflictPurged, readLegacyMemoryJobConflict } from "./legacy-memory-job-conflicts.js";
import { computeHostProfileTransferSemanticHash, type HostProfileTransferSnapshot } from "./profile-transfer.js";

const roots: string[] = [], keys: Buffer[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	for (const key of keys.splice(0)) key.fill(0);
});

type JobReferences = { ownerId?: string; sourceId?: string };
function fixture(options: { references?: JobReferences | [JobReferences, JobReferences]; mutableJobMetadata?: boolean } = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-conflict-safety-"))); roots.push(root);
	mkdirSync(join(root, "source"), { mode: 0o700 }); mkdirSync(join(root, "target"), { mode: 0o700 });
	const sourceKey = createEncryptionKey(), destinationKey = createEncryptionKey(); keys.push(sourceKey, destinationKey);
	const sourceDatabasePath = join(root, "source/kestrel.sqlite"), destinationDatabasePath = join(root, "target/kestrel.sqlite");
	const generated = seedNativeLegacy19Source(sourceDatabasePath, sourceKey, { conflictingJobs: true,
		...(options.mutableJobMetadata === undefined ? {} : { mutableJobMetadata: options.mutableJobMetadata }) });
	if (options.references) addReferences(sourceDatabasePath, sourceKey, generated.job.id, generated.alias, options.references);
	return { ...generated, sourceKey, destinationKey, sourceDatabasePath, destinationDatabasePath };
}

function addReferences(path: string, key: Buffer, primaryId: string, observedId: string, refs: JobReferences | [JobReferences, JobReferences]) {
	const raw = new Database(path);
	try {
		for (const [index, id] of [primaryId, observedId].entries()) {
			const row = raw.prepare("SELECT * FROM memory_jobs WHERE id=?").get(id) as { payload_ciphertext: string; payload_iv: string; payload_auth_tag: string };
			const payload = JSON.parse(decryptText({ ciphertext: row.payload_ciphertext, iv: row.payload_iv, authTag: row.payload_auth_tag }, key));
			payload.payload = { ...payload.payload, ...(Array.isArray(refs) ? refs[index] : refs) };
			const encrypted = encryptText(JSON.stringify(payload), key);
			raw.prepare("UPDATE memory_jobs SET payload_ciphertext=?,payload_iv=?,payload_auth_tag=? WHERE id=?")
				.run(encrypted.ciphertext, encrypted.iv, encrypted.authTag, id);
		}
	} finally { raw.close(); }
}

function applyFixture(value: ReturnType<typeof fixture>) {
	const plan = planHostProfileFileTransfer(value);
	applyHostProfileFileTransfer({ plan, sourceKey: value.sourceKey, destinationKey: value.destinationKey, acceptedPlanSha256: plan.planSha256 });
	return plan;
}

function conflictState(db: KestrelDatabase, dedupeKey: string) {
	const secret = parseLegacyProfileSecret(db.getPrivateState(LEGACY_PROFILE_SECRET_KEY));
	keys.push(secret);
	return readLegacyMemoryJobConflict(secret, dedupeKey, item => db.getPrivateState(item));
}

function activeConflictState(db: KestrelDatabase, dedupeKey: string) {
	const conflict = conflictState(db, dedupeKey);
	if (!conflict || isLegacyJobConflictPurged(conflict)) throw new Error("Expected active legacy job conflict.");
	return conflict;
}

function snapshotRow(snapshot: HostProfileTransferSnapshot, predicate: (row: NonNullable<HostProfileTransferSnapshot["rows"]["private_runtime_state"]>[number]) => boolean) {
	const row = snapshot.rows.private_runtime_state!.find(predicate);
	if (!row) throw new Error("Expected generated conflict archive row.");
	return row;
}

describe("legacy conflicted-job transfer safety", () => {
	it("keeps conflict fences through an independent rekey and snapshot re-export", () => {
		const value = fixture(), plan = applyFixture(value), first = new KestrelDatabase(value.destinationDatabasePath, value.destinationKey);
		const secondKey = createEncryptionKey(); keys.push(secondKey); const second = new KestrelDatabase(":memory:", secondKey);
		try {
			const snapshot = first.exportHostProfileTransferSnapshot();
			second.importHostProfileTransferSnapshot(snapshot);
			activeConflictState(second, value.job.dedupeKey);
			expect(() => second.queueMemoryJob({ ...value.job, id: "after-rekey", status: "pending", attempts: 0 })).toThrow(/remain paused/);
			expect(second.exportHostProfileTransferSnapshot().semanticSha256).toBe(snapshot.semanticSha256);
			expect(snapshot.semanticSha256).toBe(plan.summary.semanticSha256);
		} finally { first.close(); second.close(); }
	});

	it("protects the legacy secret and conflict namespace from public private-state mutation", () => {
		const value = fixture(); applyFixture(value); const db = new KestrelDatabase(value.destinationDatabasePath, value.destinationKey);
		try {
			const secret = parseLegacyProfileSecret(db.getPrivateState(LEGACY_PROFILE_SECRET_KEY)); keys.push(secret);
			const groupKey = legacyProfileStateKey(secret, "job-conflict", value.job.dedupeKey);
			const jobKey = legacyProfileStateKey(secret, "conflicted-job", value.job.id);
			for (const key of [LEGACY_PROFILE_SECRET_KEY, LEGACY_JOB_CONFLICT_MANIFEST_KEY, groupKey, jobKey]) {
				expect(() => db.setPrivateState(key, { changed: true })).toThrow();
				expect(() => db.deletePrivateState(key)).toThrow();
			}
			activeConflictState(db, value.job.dedupeKey);
		} finally { db.close(); }
	});

	it.each(["group", "first job", "second job"] as const)("refuses to reopen a conflict graph with its %s node deleted", node => {
		const value = fixture(); applyFixture(value); const db = new KestrelDatabase(value.destinationDatabasePath, value.destinationKey);
		const secret = parseLegacyProfileSecret(db.getPrivateState(LEGACY_PROFILE_SECRET_KEY)); keys.push(secret);
		const archive = activeConflictState(db, value.job.dedupeKey);
		const key = node === "group" ? legacyProfileStateKey(secret, "job-conflict", value.job.dedupeKey)
			: legacyProfileStateKey(secret, "conflicted-job", archive.jobs[node === "first job" ? 0 : 1]!.jobId);
		db.db.prepare("DELETE FROM private_runtime_state WHERE key=?").run(key); db.close();
		expect(() => new KestrelDatabase(value.destinationDatabasePath, value.destinationKey)).toThrow();
	});

	it("refuses to reopen when all conflict nodes are deleted but the manifest remains", () => {
		const value = fixture(); applyFixture(value); const db = new KestrelDatabase(value.destinationDatabasePath, value.destinationKey);
		const secret = parseLegacyProfileSecret(db.getPrivateState(LEGACY_PROFILE_SECRET_KEY)); keys.push(secret);
		const keysToDelete = [
			legacyProfileStateKey(secret, "job-conflict", value.job.dedupeKey),
			legacyProfileStateKey(secret, "conflicted-job", value.job.id),
			legacyProfileStateKey(secret, "conflicted-job", value.alias),
		];
		db.db.prepare(`DELETE FROM private_runtime_state WHERE key IN (${keysToDelete.map(() => "?").join(",")})`).run(...keysToDelete);
		expect(db.getPrivateState(LEGACY_JOB_CONFLICT_MANIFEST_KEY)).toBeDefined();
		db.close();
		expect(() => new KestrelDatabase(value.destinationDatabasePath, value.destinationKey)).toThrow();
	});

	it("refuses to reopen when the manifest alone is missing", () => {
		const value = fixture(); applyFixture(value); const db = new KestrelDatabase(value.destinationDatabasePath, value.destinationKey);
		db.db.prepare("DELETE FROM private_runtime_state WHERE key=?").run(LEGACY_JOB_CONFLICT_MANIFEST_KEY);
		db.close();
		expect(() => new KestrelDatabase(value.destinationDatabasePath, value.destinationKey)).toThrow();
	});

	it.each(["active overlap", "malformed archive", "orphan archive"] as const)("atomically rejects an imported snapshot with %s", kind => {
		const value = fixture(); applyFixture(value); const imported = new KestrelDatabase(value.destinationDatabasePath, value.destinationKey);
		const emptyKey = createEncryptionKey(); keys.push(emptyKey); const empty = new KestrelDatabase(":memory:", emptyKey);
		try {
			const snapshot = imported.exportHostProfileTransferSnapshot();
			if (kind === "active overlap") {
				const activeValue = fixture(); // Read its regular job as a canonical logical transfer row.
				const activeDb = new KestrelDatabase(":memory:", value.destinationKey);
				try {
					activeDb.queueMemoryJob({ ...activeValue.job, id: "active-overlap", dedupeKey: value.job.dedupeKey, status: "pending", attempts: 0 });
					const active = activeDb.exportHostProfileTransferSnapshot().rows.memory_jobs![0]!;
					snapshot.rows.memory_jobs!.push(active);
				} finally { activeDb.close(); }
				activeValue.sourceKey.fill(0); activeValue.destinationKey.fill(0);
			} else {
			const row = snapshotRow(snapshot, candidate => typeof candidate.values.key === "string" && candidate.values.key.startsWith(kind === "malformed archive" ? LEGACY_CONFLICTED_JOB_PREFIX : LEGACY_JOB_CONFLICT_PREFIX));
				if (kind === "malformed archive") row.cleartext!.value_ciphertext = JSON.stringify({ version: 1, extra: "invalid" });
				else snapshot.rows.private_runtime_state = snapshot.rows.private_runtime_state!.filter(candidate => candidate !== row);
			}
			snapshot.semanticSha256 = computeHostProfileTransferSemanticHash(snapshot.rows);
			expect(() => empty.importHostProfileTransferSnapshot(snapshot)).toThrow();
			expect(empty.listMemoryJobs()).toEqual([]);
			expect(empty.db.prepare("SELECT COUNT(*) AS count FROM private_runtime_state").get()).toEqual({ count: 0 });
		} finally { imported.close(); empty.close(); }
	});

	it.each(["owner", "source"] as const)("purges archived %s job preimages while retaining opaque no-retry guards", kind => {
		const refs = kind === "owner" ? { ownerId: "generated-delete-owner" } : { sourceId: "generated-delete-source" };
		const value = fixture({ references: refs }); applyFixture(value); const db = new KestrelDatabase(value.destinationDatabasePath, value.destinationKey);
		try {
			const before = activeConflictState(db, value.job.dedupeKey);
			const originalPayloads = before.jobs.map(job => job.originalPayloadJson);
			if (kind === "owner") db.deleteMemoryJobsForOwner(refs.ownerId!);
			else db.deleteMemoryArtifactsForSource(refs.sourceId!);
			const after = conflictState(db, value.job.dedupeKey)!;
			expect(isLegacyJobConflictPurged(after)).toBe(true);
			const serialized = JSON.stringify(after);
			for (const preimage of [value.job.id, value.alias, value.job.dedupeKey, "generated-delete-owner", "generated-delete-source", ...originalPayloads])
				expect(serialized).not.toContain(preimage);
			expect(db.getMemoryJob(value.alias)).toBeUndefined();
			for (const id of [value.job.id, value.alias]) expect(() => db.queueMemoryJob({ ...value.job, id, status: "pending", attempts: 0 })).toThrow(/remain paused/);
			expect(() => db.queueMemoryJob({ ...value.job, id: "reused-dedupe", status: "pending", attempts: 0 })).toThrow(/remain paused/);
			db.queueMemoryJob({ ...value.job, id: "unrelated-job", dedupeKey: "unrelated-job-dedupe", status: "pending", attempts: 0 });
			expect(db.claimMemoryJob(value.time)?.id).toBe("unrelated-job");
		} finally { db.close(); }
	});

	it("purges only the matching archived member, keeps the other identity fenced, then purges the remainder", () => {
		const owners = [{ ownerId: "member-owner-one" }, { ownerId: "member-owner-two" }] as const;
		const value = fixture({ references: [owners[0], owners[1]] }); applyFixture(value);
		const db = new KestrelDatabase(value.destinationDatabasePath, value.destinationKey);
		try {
			const before = activeConflictState(db, value.job.dedupeKey);
			const secret = parseLegacyProfileSecret(db.getPrivateState(LEGACY_PROFILE_SECRET_KEY)); keys.push(secret);
			const idForOwnerOne = before.jobs.find(job => JSON.parse(job.originalPayloadJson).payload.ownerId === owners[0].ownerId)!.jobId;
			const idForOwnerTwo = before.jobs.find(job => JSON.parse(job.originalPayloadJson).payload.ownerId === owners[1].ownerId)!.jobId;
			db.deleteMemoryJobsForOwner(owners[0].ownerId);
			const partial = conflictState(db, value.job.dedupeKey)!;
			expect(isLegacyJobConflictPurged(partial)).toBe(true);
			expect(partial.jobs).toHaveLength(2);
			expect(partial.jobs.filter(isLegacyJobConflictPurged)).toHaveLength(1);
			const retained = partial.jobs.find(job => "originalPayloadJson" in job);
			expect(retained && "jobId" in retained ? retained.jobId : undefined).toBe(idForOwnerTwo);
			expect(JSON.stringify(partial)).not.toContain(owners[0].ownerId);
			expect(JSON.stringify(partial)).toContain(owners[1].ownerId);
			expect(() => db.queueMemoryJob({ ...value.job, id: idForOwnerOne, status: "pending", attempts: 0 })).toThrow(/remain paused/);
			expect(() => db.queueMemoryJob({ ...value.job, id: idForOwnerTwo, status: "pending", attempts: 0 })).toThrow(/remain paused/);
			db.deleteMemoryJobsForOwner(owners[1].ownerId);
			const fullyPurged = conflictState(db, value.job.dedupeKey)!;
			expect(fullyPurged.jobs.filter(isLegacyJobConflictPurged)).toHaveLength(2);
			for (const preimage of [owners[0].ownerId, owners[1].ownerId, idForOwnerOne, idForOwnerTwo, value.job.dedupeKey])
				expect(JSON.stringify(fullyPurged)).not.toContain(preimage);
			for (const id of [idForOwnerOne, idForOwnerTwo]) expect(() => db.queueMemoryJob({ ...value.job, id, status: "pending", attempts: 0 })).toThrow(/remain paused/);
		} finally { db.close(); }
	});

	it("rechecks the full conflict graph after another SQLite connection changes it", () => {
		const value = fixture(); applyFixture(value); const db = new KestrelDatabase(value.destinationDatabasePath, value.destinationKey);
		const secret = parseLegacyProfileSecret(db.getPrivateState(LEGACY_PROFILE_SECRET_KEY)); keys.push(secret);
		const groupKey = legacyProfileStateKey(secret, "job-conflict", value.job.dedupeKey);
		const external = new Database(value.destinationDatabasePath);
		try {
			external.prepare("DELETE FROM private_runtime_state WHERE key=?").run(groupKey);
			expect(() => db.queueMemoryJob({ ...value.job, id: "after-external-delete", status: "pending", attempts: 0 })).toThrow();
		} finally { external.close(); db.close(); }
	});

	it.each(["archive", "operative job"] as const)("rejects an oversized %s row before decrypting it", kind => {
		const value = fixture(); applyFixture(value); const db = new KestrelDatabase(value.destinationDatabasePath, value.destinationKey);
		if (kind === "operative job") db.queueMemoryJob({ ...value.job, id: "oversized-probe", dedupeKey: "oversized-probe-dedupe", status: "pending", attempts: 0 });
		db.close();
		const raw = new Database(value.destinationDatabasePath);
		try {
			if (kind === "archive") {
				const row = raw.prepare("SELECT key FROM private_runtime_state WHERE key LIKE ? LIMIT 1").get(`${LEGACY_JOB_CONFLICT_PREFIX}%`) as { key: string };
				raw.prepare("UPDATE private_runtime_state SET value_ciphertext=? WHERE key=?").run("x".repeat(8 * 1024 * 1024 + 1), row.key);
			} else {
				raw.prepare("UPDATE memory_jobs SET payload_ciphertext=? WHERE id=?").run("x".repeat(8 * 1024 * 1024 + 1), "oversized-probe");
			}
		} finally { raw.close(); }
		expect(() => new KestrelDatabase(value.destinationDatabasePath, value.destinationKey)).toThrow(/limit/i);
	});

	it("preserves original pending and observed running conflict versions without counting a runnable cancellation", () => {
		const value = fixture({ mutableJobMetadata: true }), plan = applyFixture(value);
		expect(plan.summary.excluded.runningMemoryJobsCancelled).toBe(0);
		const db = new KestrelDatabase(value.destinationDatabasePath, value.destinationKey);
		try {
			const conflict = activeConflictState(db, value.job.dedupeKey);
			for (const job of conflict.jobs) {
				const original = JSON.parse(job.originalPayloadJson), observed = JSON.parse(job.observedPayloadJson);
				expect(original.status).toBe("pending");
				expect(original.attempts).toBe(0);
				expect(observed.status).toBe("running");
				expect(observed.attempts).toBe(2);
				expect(observed.maxAttempts).toBe(3);
			}
		} finally { db.close(); }
	});
});
