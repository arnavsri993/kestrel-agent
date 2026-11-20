import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createEncryptionKey, encryptText } from "@kestrel/encryption";
import { afterEach, expect, it } from "vitest";
import { KestrelDatabase } from "./index.js";
import { HOST_PROFILE_TRANSFER_MAX_BYTES, HOST_PROFILE_TRANSFER_MAX_ROWS, HOST_PROFILE_FILE_TRANSFER_LIMITS } from "./profile-transfer.js";
import { applyHostProfileFileTransfer, HostProfileFileTransferError, planHostProfileFileTransfer, verifyHostProfileFileTransferRecovery } from "./host-profile-file-transfer.js";

const time = "2026-11-04T12:00:00.000Z", roots: string[] = [], keys: Buffer[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); for (const key of keys.splice(0)) key.fill(0); });
function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-file-budget-"))); roots.push(root);
	const sourceDatabasePath = join(root, "source/kestrel.sqlite"), destinationDatabasePath = join(root, "target/kestrel.sqlite");
	mkdirSync(dirname(sourceDatabasePath), { mode: 0o700 }); mkdirSync(dirname(destinationDatabasePath), { mode: 0o700 });
	const sourceKey = createEncryptionKey(), destinationKey = createEncryptionKey(); keys.push(sourceKey, destinationKey);
	const source = new KestrelDatabase(sourceDatabasePath, sourceKey);
	source.setPrivateState("generated-proof", { value: "GENERATED_PRIVATE_FILE_BUDGET_PROOF" });
	return { source, sourceKey, destinationKey, sourceDatabasePath, destinationDatabasePath };
}
function claims(db: KestrelDatabase, count: number) {
	db.db.prepare(`WITH RECURSIVE generated(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM generated WHERE n<?)
		INSERT INTO idempotency_claims SELECT 'generated-'||n,'generated-owner',1,'{}',? FROM generated`).run(count, time);
}

it("retains the original snapshot budget and streams the exact version-one digest", () => {
	const value = fixture(), target = new KestrelDatabase(":memory:", value.destinationKey);
	try {
		expect(HOST_PROFILE_TRANSFER_MAX_BYTES).toBe(64 * 1024 * 1024); expect(HOST_PROFILE_TRANSFER_MAX_ROWS).toBe(100_000);
		value.source.setPrivateState("generated-unicode", { text: "quotes:\"\n\u0000 snow:☃", nested: [[], {}, false, null, 42] });
		const snapshot = value.source.exportHostProfileTransferSnapshot(), logical: Record<string, unknown> = {};
		for (const table of Object.keys(snapshot.rows).sort()) {
			if (["runtime_message_terms", "memory_timeline_event_terms"].includes(table)) continue;
			logical[table] = snapshot.rows[table]!.map(row => { const values = { ...row.values }; delete values.canonical_name_hash; return { values, cleartext: row.cleartext ?? {} }; });
		}
		expect(snapshot.semanticSha256).toBe(createHash("sha256").update(JSON.stringify(logical)).digest("hex"));
		expect(() => target.importHostProfileTransferSnapshot(snapshot, { maxBytes: Buffer.byteLength(JSON.stringify(snapshot)) - 1 })).toThrow(/requested byte limit/);
		expect(target.db.prepare("SELECT COUNT(*) AS count FROM private_runtime_state").get()).toEqual({ count: 0 });
		target.importHostProfileTransferSnapshot(snapshot);
		expect(target.exportHostProfileTransferSnapshot().semanticSha256).toBe(snapshot.semanticSha256);
	} finally { target.close(); value.source.close(); }
});

it("reviews more than the snapshot row budget without carrying inherited claims into the destination", () => {
	const value = fixture(), count = HOST_PROFILE_TRANSFER_MAX_ROWS + 1;
	try { claims(value.source, count); expect(() => value.source.exportHostProfileTransferSnapshot()).toThrow(/row limit/); }
	finally { value.source.close(); }
	const plan = planHostProfileFileTransfer(value);
	expect(plan.summary.excluded.idempotencyClaims).toBe(count);
	const receipt = applyHostProfileFileTransfer({ plan, sourceKey: value.sourceKey, destinationKey: value.destinationKey, acceptedPlanSha256: plan.planSha256 });
	expect(verifyHostProfileFileTransferRecovery(receipt, value)).toEqual({ originalReadable: true, destinationReadable: true, activationPerformed: false });
	const target = new KestrelDatabase(value.destinationDatabasePath, value.destinationKey);
	try {
		expect(target.getPrivateState("generated-proof")).toEqual({ value: "GENERATED_PRIVATE_FILE_BUDGET_PROOF" });
		expect(target.db.prepare("SELECT COUNT(*) AS count FROM idempotency_claims").get()).toEqual({ count: 0 });
	} finally { target.close(); }
});

it.each(["rows", "raw-row", "raw-total"])("rejects an oversized %s source before attempting authentication", mode => {
	const value = fixture();
	try {
		if (mode === "rows") claims(value.source, HOST_PROFILE_FILE_TRANSFER_LIMITS.maxRows + 1);
		else if (mode === "raw-row") value.source.db.prepare("UPDATE private_runtime_state SET value_ciphertext=?").run("x".repeat(HOST_PROFILE_FILE_TRANSFER_LIMITS.maxRawRowBytes + 1));
		else {
			const body = "x".repeat(2 * 1024 * 1024), insert = value.source.db.prepare("INSERT INTO private_runtime_state VALUES (?,?,?,?,?)");
			value.source.db.transaction(() => { for (let i = 0; i < 65; i++) insert.run(`generated-${i}`, body, "invalid", "invalid", time); })();
		}
	} finally { value.source.close(); }
	const before = statSync(value.sourceDatabasePath), wrongKey = createEncryptionKey(); keys.push(wrongKey);
	try { planHostProfileFileTransfer({ ...value, sourceKey: wrongKey }); throw new Error("Expected a source size refusal."); }
	catch (error) { expect(error).toBeInstanceOf(HostProfileFileTransferError); expect((error as HostProfileFileTransferError).code).toBe("SOURCE_LIMIT_EXCEEDED"); }
	const after = statSync(value.sourceDatabasePath);
	expect([after.ino, after.size, after.mtimeMs]).toEqual([before.ino, before.size, before.mtimeMs]);
	expect(readdirSync(dirname(value.destinationDatabasePath))).toEqual([]);
});

it("refuses a record whose JSON expansion exceeds the file row budget", () => {
	const value = fixture();
	try {
		value.source.saveRuntimeSession({ id: "generated-expansion", title: "Generated expansion", allowedTools: [], status: "active", checkpoints: [], createdAt: time, updatedAt: time });
		const encrypted = encryptText("\u0000".repeat(Math.ceil(HOST_PROFILE_FILE_TRANSFER_LIMITS.maxSerializedRowBytes / 6) + 1), value.sourceKey);
		value.source.db.prepare("INSERT INTO runtime_messages (id,session_id,role,content_ciphertext,content_iv,content_auth_tag,parent_message_id,tool_execution_id,created_at) VALUES (?,?,?,?,?,?,NULL,NULL,?)")
			.run("generated-expansion-message", "generated-expansion", "user", encrypted.ciphertext, encrypted.iv, encrypted.authTag, time);
	} finally { value.source.close(); }
	try { planHostProfileFileTransfer(value); throw new Error("Expected a serialized row refusal."); }
	catch (error) { expect(error).toBeInstanceOf(HostProfileFileTransferError); expect((error as HostProfileFileTransferError).code).toBe("SOURCE_LIMIT_EXCEEDED"); }
	expect(readdirSync(dirname(value.destinationDatabasePath))).toEqual([]);
});
