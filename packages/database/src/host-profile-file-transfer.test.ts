import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, linkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createEncryptionKey } from "@kestrel/encryption";
import { afterEach, expect, it } from "vitest";
import { KestrelDatabase } from "./index";
import { applyHostProfileFileTransfer, HostProfileFileTransferError, planHostProfileFileTransfer, verifyHostProfileFileTransferRecovery } from "./host-profile-file-transfer";

const timestamp = "2026-11-02T15:30:00.000Z", privateText = "GENERATED_CORE_FILE_TRANSFER_PRIVATE_TEXT";
const roots: string[] = [], keys: Buffer[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); for (const key of keys.splice(0)) key.fill(0); });
function key(): Buffer { const value = createEncryptionKey(); keys.push(value); return value; }
function seed(file: string, sourceKey: Buffer): void {
	const db = new KestrelDatabase(file, sourceKey);
	try {
		db.saveRuntimeSession({ id: "transfer-session", title: "Generated Core file fixture", allowedTools: [], status: "active", checkpoints: [], createdAt: timestamp, updatedAt: timestamp });
		db.saveRuntimeMessage({ id: "transfer-message", sessionId: "transfer-session", role: "user", content: privateText, createdAt: timestamp });
		db.setPrivateState("generated-private-setting", { value: privateText });
	} finally { db.close(); }
}
function fixture(empty = false) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-core-file-transfer-"))); roots.push(root);
	const sourceDatabasePath = join(root, "source", "kestrel.sqlite"), destinationDatabasePath = join(root, "destination", "kestrel.sqlite");
	mkdirSync(dirname(sourceDatabasePath), { mode: 0o700 }); mkdirSync(dirname(destinationDatabasePath), { mode: 0o700 });
	const sourceKey = key(), destinationKey = key();
	if (empty) new KestrelDatabase(sourceDatabasePath, sourceKey).close(); else seed(sourceDatabasePath, sourceKey);
	const options = { sourceDatabasePath, sourceKey, destinationDatabasePath };
	return { ...options, destinationKey, plan: () => planHostProfileFileTransfer(options) };
}
function apply(value: ReturnType<typeof fixture>, plan = value.plan()) {
	return applyHostProfileFileTransfer({ plan, sourceKey: value.sourceKey, destinationKey: value.destinationKey, acceptedPlanSha256: plan.planSha256 });
}
function code(action: () => unknown): string {
	try { action(); throw new Error("Expected a bounded transfer error."); } catch (error) {
		expect(error).toBeInstanceOf(HostProfileFileTransferError);
		expect(String(error)).not.toContain(privateText);
		return (error as HostProfileFileTransferError).code;
	}
}

it("previews without writes and atomically publishes independently encrypted Core data with both files recoverable", () => {
	const value = fixture(), before = readFileSync(value.sourceDatabasePath), sourceKeyBefore = Buffer.from(value.sourceKey), destinationKeyBefore = Buffer.from(value.destinationKey);
	const plan = value.plan();
	expect(plan.authenticatedEnvelopes).toBe(2);
	expect(JSON.stringify(plan)).not.toContain(privateText);
	expect(JSON.stringify(plan)).not.toContain(value.sourceKey.toString("base64"));
	expect(readdirSync(dirname(value.destinationDatabasePath))).toEqual([]);
	expect(readFileSync(value.sourceDatabasePath)).toEqual(before);
	const receipt = apply(value, plan);
	expect(receipt.activationPerformed).toBe(false);
	expect(readdirSync(dirname(value.destinationDatabasePath))).toEqual(["kestrel.sqlite"]);
	expect(statSync(value.destinationDatabasePath).mode & 0o777).toBe(0o600);
	expect(statSync(value.destinationDatabasePath).nlink).toBe(1);
	const restored = new KestrelDatabase(value.destinationDatabasePath, value.destinationKey);
	try { expect(restored.listRuntimeMessages("transfer-session")[0]?.content).toBe(privateText); expect(restored.getPrivateState("generated-private-setting")).toEqual({ value: privateText }); }
	finally { restored.close(); }
	expect(verifyHostProfileFileTransferRecovery(receipt, value)).toEqual({ originalReadable: true, destinationReadable: true, activationPerformed: false });
	expect(readFileSync(value.sourceDatabasePath)).toEqual(before);
	expect(value.sourceKey).toEqual(sourceKeyBefore); expect(value.destinationKey).toEqual(destinationKeyBefore);
	sourceKeyBefore.fill(0); destinationKeyBefore.fill(0);
});

it("requires the exact accepted plan and an independent destination key", () => {
	const value = fixture(), plan = value.plan();
	expect(code(() => applyHostProfileFileTransfer({ plan, sourceKey: value.sourceKey, destinationKey: value.destinationKey, acceptedPlanSha256: "unaccepted" }))).toBe("PLAN_NOT_ACCEPTED");
	expect(code(() => applyHostProfileFileTransfer({ plan, sourceKey: value.sourceKey, destinationKey: value.sourceKey, acceptedPlanSha256: plan.planSha256 }))).toBe("KEY_REUSE");
	const tampered = structuredClone(plan); tampered.summary.counts.runtime_messages = 0;
	expect(code(() => apply(value, tampered))).toBe("PLAN_CHANGED");
	expect(readdirSync(dirname(value.destinationDatabasePath))).toEqual([]);
});

it("refuses changed source data and source replacement after review", () => {
	const value = fixture(), plan = value.plan();
	const db = new KestrelDatabase(value.sourceDatabasePath, value.sourceKey);
	db.setPrivateState("new-source-state", { generated: true }); db.close();
	const changed = readFileSync(value.sourceDatabasePath);
	expect(code(() => apply(value, plan))).toBe("SOURCE_CHANGED");
	expect(readFileSync(value.sourceDatabasePath)).toEqual(changed);
	const fresh = value.plan();
	renameSync(value.sourceDatabasePath, value.sourceDatabasePath + ".preserved"); seed(value.sourceDatabasePath, value.sourceKey);
	expect(code(() => apply(value, fresh))).toBe("SOURCE_CHANGED");
	expect(readdirSync(dirname(value.destinationDatabasePath))).toEqual([]);
});

it.each(["", "-wal", "-shm", "-journal", ".kestrel-transfer-lock", ".kestrel-transfer-journal", ".kestrel-transfer-recovery-lock"])("never overwrites an existing destination%s", suffix => {
	const value = fixture(), plan = value.plan(), existing = value.destinationDatabasePath + suffix;
	writeFileSync(existing, "generated-existing-destination", { mode: 0o600 });
	expect(code(() => apply(value, plan))).toBe("DESTINATION_EXISTS");
	expect(readFileSync(existing, "utf8")).toBe("generated-existing-destination");
	expect(readdirSync(dirname(existing))).toEqual(["kestrel.sqlite" + suffix]);
});

it.each(["symbolic", "hard"])("rejects a %s source file link", kind => {
	const value = fixture(), preserved = value.sourceDatabasePath + ".preserved";
	renameSync(value.sourceDatabasePath, preserved);
	if (kind === "symbolic") symlinkSync(preserved, value.sourceDatabasePath); else linkSync(preserved, value.sourceDatabasePath);
	expect(code(value.plan)).toBe("UNSAFE_PATH");
	expect(readdirSync(dirname(value.destinationDatabasePath))).toEqual([]);
});

it("rejects an unauthenticated key and an empty source without creating target files", () => {
	const value = fixture();
	expect(code(() => planHostProfileFileTransfer({ ...value, sourceKey: key() }))).toBe("SOURCE_UNREADABLE");
	const empty = fixture(true); expect(code(empty.plan)).toBe("NO_AUTHENTICATED_RECORDS");
	expect(readdirSync(dirname(value.destinationDatabasePath))).toEqual([]);
	expect(readdirSync(dirname(empty.destinationDatabasePath))).toEqual([]);
});

it("preserves later native work when recovery no longer matches the original transfer", () => {
	const value = fixture(), receipt = apply(value), sourceBefore = readFileSync(value.sourceDatabasePath);
	const native = new KestrelDatabase(value.destinationDatabasePath, value.destinationKey);
	native.saveRuntimeMessage({ id: "later-native-message", sessionId: "transfer-session", role: "user", content: "Keep later native work", createdAt: "2026-11-02T16:00:00.000Z" }); native.close();
	const targetBefore = readFileSync(value.destinationDatabasePath);
	expect(code(() => verifyHostProfileFileTransferRecovery(receipt, value))).toBe("RECOVERY_CHANGED");
	expect(readFileSync(value.sourceDatabasePath)).toEqual(sourceBefore);
	expect(readFileSync(value.destinationDatabasePath)).toEqual(targetBefore);
});
