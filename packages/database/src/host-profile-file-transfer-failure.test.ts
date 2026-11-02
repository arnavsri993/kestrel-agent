import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createEncryptionKey } from "@kestrel/encryption";
import { KestrelDatabase } from "./index";
import { applyHostProfileFileTransfer, HostProfileFileTransferError, planHostProfileFileTransfer, verifyHostProfileFileTransferRecovery } from "./host-profile-file-transfer";

const fault = vi.hoisted(() => ({ mode: "", syncs: 0, linked: false, afterStageSync: undefined as (() => void) | undefined }));
vi.mock("node:fs", async importOriginal => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return { ...fs,
		linkSync(source: string, destination: string) {
			if (fault.mode === "before-publication" || fault.mode === "cleanup") throw new Error("Generated publication failure");
			if (fault.mode === "collision") fs.writeFileSync(destination, "Generated concurrent destination", { mode: 0o600 });
			fs.linkSync(source, destination); fault.linked = true;
		},
		fsyncSync(fd: number) {
			fault.syncs++;
			if (fault.mode === "after-publication" && fault.linked) throw new Error("Generated directory synchronization failure");
			fs.fsyncSync(fd);
			if (fault.syncs === 2) fault.afterStageSync?.();
		},
		rmSync(path: string, options: Parameters<typeof fs.rmSync>[1]) {
			if (fault.mode === "cleanup" && path.includes(".kestrel-core-transfer-")) throw new Error("Generated staging cleanup failure");
			fs.rmSync(path, options);
		},
	};
});

const roots: string[] = [], keys: Buffer[] = [];
afterEach(() => {
	fault.mode = ""; fault.syncs = 0; fault.linked = false; fault.afterStageSync = undefined;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); for (const key of keys.splice(0)) key.fill(0);
});
function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-core-file-fault-"))); roots.push(root);
	const source = join(root, "source", "kestrel.sqlite"), target = join(root, "target", "kestrel.sqlite");
	mkdirSync(dirname(source), { mode: 0o700 }); mkdirSync(dirname(target), { mode: 0o700 });
	const sourceKey = createEncryptionKey(), destinationKey = createEncryptionKey(); keys.push(sourceKey, destinationKey);
	const db = new KestrelDatabase(source, sourceKey); db.setPrivateState("generated-transfer-proof", { text: "Generated confidential fixture" }); db.close();
	const plan = planHostProfileFileTransfer({ sourceDatabasePath: source, sourceKey, destinationDatabasePath: target });
	return { source, target, sourceKey, destinationKey, plan, before: readFileSync(source),
		apply: () => applyHostProfileFileTransfer({ plan, sourceKey, destinationKey, acceptedPlanSha256: plan.planSha256 }) };
}
function failure(action: () => unknown): HostProfileFileTransferError {
	try { action(); throw new Error("Expected transfer failure"); } catch (error) {
		expect(error).toBeInstanceOf(HostProfileFileTransferError);
		expect(String(error)).not.toContain("Generated confidential fixture");
		return error as HostProfileFileTransferError;
	}
}

it("removes its staging files after a publication failure without changing the source", () => {
	const value = fixture(); fault.mode = "before-publication";
	expect(failure(value.apply)).toMatchObject({ code: "APPLY_FAILED", published: false });
	expect(readdirSync(dirname(value.target))).toEqual([]);
	expect(readFileSync(value.source)).toEqual(value.before);
});

it("preserves a destination that appears at the atomic publication boundary", () => {
	const value = fixture(); fault.mode = "collision";
	expect(failure(value.apply)).toMatchObject({ code: "APPLY_FAILED", published: false });
	expect(readFileSync(value.target, "utf8")).toBe("Generated concurrent destination");
	expect(readdirSync(dirname(value.target))).toEqual(["kestrel.sqlite"]);
	expect(readFileSync(value.source)).toEqual(value.before);
});

it("reports committed recovery after a directory-sync failure and preserves the readable encrypted destination", () => {
	const value = fixture(); fault.mode = "after-publication";
	expect(failure(value.apply)).toMatchObject({ code: "PUBLISHED_RECOVERY_REQUIRED", published: true });
	fault.mode = "";
	expect(readdirSync(dirname(value.target))).toEqual(["kestrel.sqlite"]);
	const db = new KestrelDatabase(value.target, value.destinationKey);
	try { expect(db.getPrivateState("generated-transfer-proof")).toEqual({ text: "Generated confidential fixture" }); } finally { db.close(); }
	expect(readFileSync(value.source)).toEqual(value.before);
});

it("reports an encrypted staging cleanup problem without masking it or deleting source data", () => {
	const value = fixture(); fault.mode = "cleanup";
	expect(failure(value.apply)).toMatchObject({ code: "STAGING_RECOVERY_REQUIRED", published: false });
	expect(readdirSync(dirname(value.target))).toHaveLength(1);
	expect(readdirSync(dirname(value.target))[0]).toMatch(/^\.kestrel-core-transfer-/);
	expect(readFileSync(value.source)).toEqual(value.before);
});

it("refuses source changes during destination verification and retains the newer source state", () => {
	const value = fixture();
	fault.afterStageSync = () => { const db = new KestrelDatabase(value.source, value.sourceKey); db.setPrivateState("new-source-work", { keep: true }); db.close(); };
	expect(failure(value.apply)).toMatchObject({ code: "SOURCE_CHANGED", published: false });
	expect(readdirSync(dirname(value.target))).toEqual([]);
	const db = new KestrelDatabase(value.source, value.sourceKey);
	try { expect(db.getPrivateState("new-source-work")).toEqual({ keep: true }); } finally { db.close(); }
});

it("rejects a modified recovery receipt without changing either file", () => {
	const value = fixture(), receipt = value.apply(), targetBefore = readFileSync(value.target);
	receipt.summary.semanticSha256 = "0".repeat(64);
	expect(failure(() => verifyHostProfileFileTransferRecovery(receipt, value))).toMatchObject({ code: "PLAN_CHANGED", published: false });
	expect(readFileSync(value.target)).toEqual(targetBefore); expect(readFileSync(value.source)).toEqual(value.before);
});
