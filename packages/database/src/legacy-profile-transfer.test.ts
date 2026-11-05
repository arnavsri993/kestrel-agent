import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createEncryptionKey, encryptText } from "@kestrel/encryption";
import { afterEach, expect, it } from "vitest";
import { seedNativeLegacy19Source } from "./legacy-profile-source-fixture.js";
import { KestrelDatabase } from "./index.js";
import { planHostProfileFileTransfer, applyHostProfileFileTransfer, verifyHostProfileFileTransferRecovery, HostProfileFileTransferError } from "./host-profile-file-transfer.js";
import { LEGACY_PROFILE_SECRET_KEY, LEGACY_JOB_ALIAS_PREFIX, LEGACY_DIAGNOSTIC_PREFIX } from "./legacy-profile-state.js";
import { memoryFingerprintIndex } from "./memory-fingerprint-index.js";
import { computeHostProfileTransferSemanticHash, readHostProfileTransferSourceSnapshot } from "./profile-transfer.js";

const roots: string[] = [], keys: Buffer[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); for (const key of keys.splice(0)) key.fill(0); });
function fixture(options: Parameters<typeof seedNativeLegacy19Source>[2] = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-legacy19-transfer-"))); roots.push(root);
	mkdirSync(join(root, "source"), { mode: 0o700 }); mkdirSync(join(root, "target"), { mode: 0o700 });
	const sourceKey = createEncryptionKey(), destinationKey = createEncryptionKey(); keys.push(sourceKey, destinationKey);
	const sourceDatabasePath = join(root, "source/kestrel.sqlite"), destinationDatabasePath = join(root, "target/kestrel.sqlite");
	const generated = seedNativeLegacy19Source(sourceDatabasePath, sourceKey, options);
	return { ...generated, sourceKey, destinationKey, sourceDatabasePath, destinationDatabasePath };
}
function apply(value: ReturnType<typeof fixture>) {
	const plan = planHostProfileFileTransfer(value);
	const receipt = applyHostProfileFileTransfer({ plan, sourceKey: value.sourceKey, destinationKey: value.destinationKey, acceptedPlanSha256: plan.planSha256 });
	return { plan, receipt };
}

it.each([false, true])("preserves a historical19 source (compact DDL %s) with independent indexes and encrypted archives", compactDdl => {
	const value = fixture({ compactDdl }), before = readFileSync(value.sourceDatabasePath);
	const plan = planHostProfileFileTransfer(value);
	expect(plan.summary.legacy).toEqual({ sourceSchemaVersion: 19, jobAliases: 1, archivedDiagnosticEvents: 1 });
	expect(plan.authenticatedEnvelopes).toBe(4);
	for (const secret of [value.privateMessage, value.diagnostic, value.job.dedupeKey, value.alias, value.sourceKey.toString("base64")]) expect(JSON.stringify(plan)).not.toContain(secret);
	expect(planHostProfileFileTransfer(value)).toEqual(plan);
	expect(readdirSync(join(value.destinationDatabasePath, ".."))).toEqual([]);
	const { receipt } = apply(value);
	expect(verifyHostProfileFileTransferRecovery(receipt, value)).toEqual({ originalReadable: true, destinationReadable: true, activationPerformed: false });
	expect(readFileSync(value.sourceDatabasePath)).toEqual(before);
	const db = new KestrelDatabase(value.destinationDatabasePath, value.destinationKey);
	try {
		expect(db.listRuntimeMessages("generated-legacy19-session")[0]?.content).toBe(value.privateMessage);
		expect(db.getMemoryJob(value.alias)).toMatchObject(value.job);
		expect(db.getMemoryJobByDedupeKey(value.job.dedupeKey)).toMatchObject(value.job);
		expect(db.getMemoryEmbedding(value.embedding.id)).toEqual(value.embedding);
		const job = db.db.prepare("SELECT dedupe_key FROM memory_jobs").get() as { dedupe_key: string };
		expect(job.dedupe_key).toBe(memoryFingerprintIndex(value.destinationKey, "job-dedupe", value.job.dedupeKey));
		expect(job.dedupe_key).not.toBe(memoryFingerprintIndex(value.sourceKey, "job-dedupe", value.job.dedupeKey));
		const archived = db.db.prepare("SELECT key,value_ciphertext FROM private_runtime_state").all() as Array<{ key: string; value_ciphertext: string }>;
		const errorKey = archived.find(row => row.key.startsWith(LEGACY_DIAGNOSTIC_PREFIX))!.key;
		const error = db.getPrivateState<{ payloadUtf8Base64: string }>(errorKey)!;
		expect(Buffer.from(error.payloadUtf8Base64, "base64").toString("utf8")).toBe(value.diagnostic);
		for (const row of archived) { expect(row.value_ciphertext).not.toContain(value.diagnostic); expect(row.key).not.toContain(value.alias); }
		expect(db.exportHostProfileTransferSnapshot().semanticSha256).toBe(plan.summary.semanticSha256);
	} finally { db.close(); }
});

it("uses authoritative legacy transition columns, cancels a running job and preserves its attempts", () => {
	const value = fixture({ mutableJobMetadata: true, diagnostics: false }); apply(value);
	const db = new KestrelDatabase(value.destinationDatabasePath, value.destinationKey);
	try { expect(db.getMemoryJob(value.alias)).toMatchObject({ id: value.job.id, status: "cancelled", attempts: 2, maxAttempts: 3 }); }
	finally { db.close(); }
});

function addHistoricalConfigurationAudit(value: ReturnType<typeof fixture>, action = "default_migrated", status = action) {
	const audit = { id: "config-audit-00000000-0000-4000-8000-000000000019", action, actor: "system", detail: "Generated historical default migration audit", evidence: ["Generated audit evidence"], createdAt: value.time };
	const encrypted = encryptText(JSON.stringify(audit), value.sourceKey), raw = new Database(value.sourceDatabasePath);
	try { raw.prepare("INSERT INTO agent_configuration_records VALUES (?,?,?,?,?,?,?,?)").run(audit.id, "audit", status, encrypted.ciphertext, encrypted.iv, encrypted.authTag, value.time, value.time); }
	finally { raw.close(); }
	return audit;
}

it("preserves historical default-migration audit records for the normal configuration reader", () => {
	const value = fixture(), audit = addHistoricalConfigurationAudit(value), before = readFileSync(value.sourceDatabasePath);
	apply(value);
	const db = new KestrelDatabase(value.destinationDatabasePath, value.destinationKey);
	try { expect(db.listAgentConfigurationAuditEvents()).toEqual([audit]); }
	finally { db.close(); }
	expect(readFileSync(value.sourceDatabasePath)).toEqual(before);
});

it.each([["unknown_historical_action", "unknown_historical_action"], ["default_migrated", "applied"]])("refuses unsupported or mismatched configuration audits (%s, %s)", (action, status) => {
	const value = fixture(); addHistoricalConfigurationAudit(value, action, status);
	const before = readFileSync(value.sourceDatabasePath);
	expect(() => planHostProfileFileTransfer(value)).toThrow(HostProfileFileTransferError);
	expect(readFileSync(value.sourceDatabasePath)).toEqual(before);
	expect(readdirSync(join(value.destinationDatabasePath, ".."))).toEqual([]);
});

it("reports an authenticated mixed-index job conflict without leaking identities or choosing a retry budget", () => {
	const value = fixture(), raw = new Database(value.sourceDatabasePath);
	const duplicate = { ...value.job, id: "generated-ambiguous-job", status: "pending", attempts: 0 }, encrypted = encryptText(JSON.stringify(duplicate), value.sourceKey);
	try {
		raw.prepare("INSERT INTO memory_jobs SELECT ?,kind,?,?,?,max_attempts,run_after,locked_at,lease_until,last_error,created_at,updated_at,?,?,? FROM memory_jobs WHERE id=?")
			.run(duplicate.id, duplicate.dedupeKey, duplicate.status, duplicate.attempts, encrypted.ciphertext, encrypted.iv, encrypted.authTag, value.job.id);
	} finally { raw.close(); }
	const before = readFileSync(value.sourceDatabasePath);
	try { planHostProfileFileTransfer(value); expect.fail("Conflicting source must be refused."); }
	catch (error) {
		expect(error).toBeInstanceOf(HostProfileFileTransferError);
		expect((error as HostProfileFileTransferError).code).toBe("SOURCE_MEMORY_CONFLICT");
		for (const secret of [value.job.dedupeKey, value.job.id, duplicate.id, value.privateMessage, value.sourceKey.toString("base64")]) expect(String(error)).not.toContain(secret);
	}
	expect(readFileSync(value.sourceDatabasePath)).toEqual(before);
	expect(readdirSync(join(value.destinationDatabasePath, ".."))).toEqual([]);
});

it("keeps stale aliases inert when the referenced id is deleted or reused", () => {
	const value = fixture(); apply(value);
	const db = new KestrelDatabase(value.destinationDatabasePath, value.destinationKey);
	try {
		db.db.prepare("DELETE FROM memory_jobs WHERE id=?").run(value.job.id);
		expect(db.getMemoryJob(value.alias)).toBeUndefined();
		db.queueMemoryJob({ ...value.job, dedupeKey: "different-job", createdAt: "2026-11-04T13:00:00.000Z" });
		expect(db.getMemoryJob(value.alias)).toBeUndefined();
		expect(() => db.exportHostProfileTransferSnapshot()).not.toThrow();
	} finally { db.close(); }
});

it.each([
	"UPDATE memory_job_id_aliases SET alias_hash='forged'",
	"UPDATE memory_job_id_aliases SET job_id='missing'",
	"UPDATE internal_error_events SET payload_auth_tag='forged'",
	"CREATE TABLE unknown_legacy_data (id TEXT)",
	"CREATE TRIGGER unexpected AFTER INSERT ON memory_jobs BEGIN DELETE FROM memory_job_id_aliases; END",
])("refuses a changed legacy source without writing a destination: %s", sql => {
	const value = fixture(), raw = new Database(value.sourceDatabasePath); raw.pragma("foreign_keys=OFF"); raw.exec(sql); raw.close();
	const before = readFileSync(value.sourceDatabasePath);
	expect(() => planHostProfileFileTransfer(value)).toThrow(HostProfileFileTransferError);
	expect(readFileSync(value.sourceDatabasePath)).toEqual(before);
	expect(readdirSync(join(value.destinationDatabasePath, ".."))).toEqual([]);
});

it("rejects malformed and secretless preserved state during export", () => {
	const value = fixture(); apply(value);
	const db = new KestrelDatabase(value.destinationDatabasePath, value.destinationKey);
	try {
		const alias = db.db.prepare("SELECT key FROM private_runtime_state WHERE key LIKE ?").get(`${LEGACY_JOB_ALIAS_PREFIX}%`) as { key: string };
		const good = db.getPrivateState(alias.key);
		db.setPrivateState(alias.key, { ...(good as object), jobKind: "invalid" });
		expect(() => db.exportHostProfileTransferSnapshot()).toThrow();
		db.setPrivateState(alias.key, good);
		db.db.prepare("DELETE FROM private_runtime_state WHERE key=?").run(LEGACY_PROFILE_SECRET_KEY);
		expect(() => db.exportHostProfileTransferSnapshot()).toThrow(/missing its secret/);
	} finally { db.close(); }
});

it("rejects a forged archive even when its snapshot checksum was recomputed", () => {
	const value = fixture(); apply(value);
	const source = new KestrelDatabase(value.destinationDatabasePath, value.destinationKey), destinationKey = createEncryptionKey(); keys.push(destinationKey);
	const destination = new KestrelDatabase(":memory:", destinationKey);
	try {
		const snapshot = source.exportHostProfileTransferSnapshot();
		const row = snapshot.rows.private_runtime_state!.find(row => String(row.values.key).startsWith(LEGACY_JOB_ALIAS_PREFIX))!;
		row.values.key = LEGACY_JOB_ALIAS_PREFIX + "0".repeat(64);
		snapshot.semanticSha256 = computeHostProfileTransferSemanticHash(snapshot.rows);
		expect(() => destination.importHostProfileTransferSnapshot(snapshot)).toThrow();
		expect(destination.listRuntimeSessions()).toEqual([]); expect(destination.listMemoryJobs()).toEqual([]);
		expect(destination.db.prepare("SELECT COUNT(*) AS count FROM private_runtime_state").get()).toEqual({ count: 0 });
	} finally { source.close(); destination.close(); }
});

it("refuses an unauthenticated plaintext alias and a diagnostic changed after review", () => {
	const value = fixture(), plan = planHostProfileFileTransfer(value), raw = new Database(value.sourceDatabasePath);
	raw.prepare("UPDATE memory_job_id_aliases SET alias_hash=?").run(value.alias); raw.close();
	expect(() => planHostProfileFileTransfer(value)).toThrow();
	const valid = fixture(), reviewed = planHostProfileFileTransfer(valid), changed = new Database(valid.sourceDatabasePath);
	const encrypted = encryptText("Generated changed diagnostic", valid.sourceKey);
	changed.prepare("UPDATE internal_error_events SET payload_ciphertext=?,payload_iv=?,payload_auth_tag=?").run(encrypted.ciphertext, encrypted.iv, encrypted.authTag); changed.close();
	const before = readFileSync(valid.sourceDatabasePath);
	expect(() => applyHostProfileFileTransfer({ plan: reviewed, sourceKey: valid.sourceKey, destinationKey: valid.destinationKey, acceptedPlanSha256: reviewed.planSha256 })).toThrow(/changed after review/);
	expect(readFileSync(valid.sourceDatabasePath)).toEqual(before);
	expect(readdirSync(join(valid.destinationDatabasePath, ".."))).toEqual([]);
	expect(plan.summary.legacy?.jobAliases).toBe(1);
});

it("bounds the legacy tables before attempting any source decryption", () => {
	const value = fixture(), raw = new Database(value.sourceDatabasePath);
	raw.prepare("UPDATE internal_error_events SET payload_ciphertext=?").run("x".repeat(200_000)); raw.close();
	const reader = new Database(value.sourceDatabasePath, { readonly: true }), wrongKey = createEncryptionKey(); keys.push(wrongKey);
	try { expect(() => readHostProfileTransferSourceSnapshot(reader, wrongKey, 1024 * 1024)).toThrow(/Legacy profile transfer exceeds/); }
	finally { reader.close(); }
});

it("requires the full source authentication tag rather than accepting its valid truncated prefix", () => {
	const value = fixture(), raw = new Database(value.sourceDatabasePath);
	const row = raw.prepare("SELECT payload_auth_tag FROM internal_error_events").get() as { payload_auth_tag: string };
	raw.prepare("UPDATE internal_error_events SET payload_auth_tag=?").run(Buffer.from(row.payload_auth_tag, "base64").subarray(0, 4).toString("base64")); raw.close();
	expect(() => planHostProfileFileTransfer(value)).toThrow(HostProfileFileTransferError);
	expect(readdirSync(join(value.destinationDatabasePath, ".."))).toEqual([]);
});
