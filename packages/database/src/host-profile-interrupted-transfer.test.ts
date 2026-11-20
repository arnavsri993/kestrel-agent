import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { launchCoreTransferFixture, writeCoreTransferCrashPreload, type TransferCrashPoint } from "../../../scripts/native-core-transfer-crash-fixture.js";
import { KestrelDatabase } from "./index";
import { HostProfileFileTransferError, inspectInterruptedHostProfileFileTransfer, verifyInterruptedHostProfileFileTransfer, recoverInterruptedHostProfileFileTransfer, verifyHostProfileFileTransferRecovery } from "./host-profile-file-transfer";

// Each case starts an actual worker and crosses durable filesystem boundaries.
// Hosted macOS startup/IO exceeded the ordinary five-second unit-test budget.
vi.setConfig({ testTimeout: 20_000 });

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const corePackage = join(repository, "apps/core-service/package.json");
const buildRoot = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-core-crash-build-"))), entry = join(buildRoot, "worker.mjs");
const roots: string[] = [], keys: Buffer[] = [], clients: ReturnType<typeof launchCoreTransferFixture>[] = [];
const privateText = "GENERATED_INTERRUPTED_TRANSFER_PRIVATE_TEXT";
beforeAll(async () => {
	const runtime = createRequire(corePackage), { build } = runtime("esbuild");
	await build({ entryPoints: [join(repository, "apps/core-service/src/host-profile-file-transfer-worker.ts")], outfile: entry, bundle: true, platform: "node", target: "node24", format: "esm", external: ["better-sqlite3", "sharp"],
		plugins: [{ name: "fixture-native-dependency", setup(builder: { onResolve(options: { filter: RegExp }, callback: () => { path: string; external: boolean }): void }) {
			builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: runtime.resolve("better-sqlite3"), external: true }));
		} }],
		banner: { js: `import {createRequire as __createRequire} from 'node:module'; const require=__createRequire(${JSON.stringify(corePackage)});` } });
});
afterAll(() => rmSync(buildRoot, { recursive: true, force: true }));
afterEach(async () => {
	for (const client of clients.splice(0)) { if (client.child.exitCode === null && client.child.signalCode === null) client.child.kill("SIGKILL"); await client.exited; }
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); for (const key of keys.splice(0)) key.fill(0);
});
function client(home: string, preload?: string) {
	const value = launchCoreTransferFixture({ executable: process.execPath, entry, home, ...(preload ? { preload } : {}) }); clients.push(value); return value;
}
async function crashed(point: TransferCrashPoint) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-core-crash-fixture-"))); roots.push(root);
	const source = join(root, "source/kestrel.sqlite"), target = join(root, "target/kestrel.sqlite"), preload = join(root, "crash.mjs");
	mkdirSync(dirname(source), { mode: 0o700 }); mkdirSync(dirname(target), { mode: 0o700 });
	const sourceKey = randomBytes(32), destinationKey = randomBytes(32); keys.push(sourceKey, destinationKey);
	const db = new KestrelDatabase(source, sourceKey); db.setPrivateState("generated-crash-proof", { content: privateText }); db.close();
	const before = readFileSync(source);
	await writeCoreTransferCrashPreload(preload, target, point);
	const owner = client(root, preload);
	const planned = await owner.request("plan", { sourceDatabasePath: source, destinationDatabasePath: target, sourceKeyBase64: sourceKey.toString("base64") });
	expect(planned.ok).toBe(true);
	const preview = planned.preview as { planSha256: string };
	owner.send("apply", { planId: planned.planId, acceptedPlanSha256: preview.planSha256, approved: true, destinationKeyBase64: destinationKey.toString("base64") });
	if (point === "hold-before-link") await owner.ready();
	else expect(await owner.exited).toEqual({ code: null, signal: "SIGKILL" });
	expect(owner.errors()).toBe("");
	for (const content of [privateText, sourceKey.toString("base64"), destinationKey.toString("base64")]) expect(owner.output()).not.toContain(content);
	const raw = readFileSync(target + ".kestrel-transfer-journal", "utf8");
	for (const content of [privateText, sourceKey.toString("base64"), destinationKey.toString("base64")]) expect(raw).not.toContain(content);
	return { root, source, target, sourceKey, destinationKey, before, owner, journal: JSON.parse(raw) as { staging: { path: string } } };
}
function failure(action: () => unknown): HostProfileFileTransferError {
	try { action(); throw new Error("Expected a bounded recovery failure."); } catch (error) { expect(error).toBeInstanceOf(HostProfileFileTransferError); expect(String(error)).not.toContain(privateText); return error as HostProfileFileTransferError; }
}
function recover(value: Awaited<ReturnType<typeof crashed>>) {
	const review = inspectInterruptedHostProfileFileTransfer(value.target);
	return recoverInterruptedHostProfileFileTransfer({ destinationDatabasePath: value.target, sourceKey: value.sourceKey, destinationKey: value.destinationKey, acceptedRecoverySha256: review.recoverySha256 });
}

it.each(["before-link", "after-link", "after-unlink"] as const)("recovers a real process death %s without changing the original Core file", async point => {
	const value = await crashed(point), review = inspectInterruptedHostProfileFileTransfer(value.target);
	expect(review.state).toBe(point === "before-link" ? "staged" : "published");
	if (point === "after-link") expect(statSync(value.target).nlink).toBe(2);
	const receipt = recover(value);
	expect(receipt.activationPerformed).toBe(false); expect(statSync(value.target).nlink).toBe(1);
	expect(readdirSync(dirname(value.target))).toEqual(["kestrel.sqlite"]);
	expect(verifyHostProfileFileTransferRecovery(receipt, value)).toMatchObject({ originalReadable: true, destinationReadable: true });
	expect(readFileSync(value.source)).toEqual(value.before);
});

it.each(["before-link", "after-link", "after-unlink"] as const)("authenticates interrupted recovery %s without changing journals, links or data", async point => {
	const value = await crashed(point), review = inspectInterruptedHostProfileFileTransfer(value.target);
	const files = [value.source, value.target + ".kestrel-transfer-journal", value.target + ".kestrel-transfer-lock",
		...(point === "before-link" ? [] : [value.target]), ...(point === "after-unlink" ? [] : [join(value.journal.staging.path, "kestrel.sqlite")])];
	const before = files.map(path => ({ path, bytes: readFileSync(path), stat: statSync(path) }));
	const entries = readdirSync(dirname(value.target)).sort();
	const options = { destinationDatabasePath: value.target, sourceKey: value.sourceKey, destinationKey: value.destinationKey, acceptedRecoverySha256: review.recoverySha256 };
	expect(verifyInterruptedHostProfileFileTransfer(options)).toEqual({ originalReadable: true, destinationReadable: true, activationPerformed: false });
	const badKey = randomBytes(32); keys.push(badKey);
	expect(failure(() => verifyInterruptedHostProfileFileTransfer({ ...options, destinationKey: badKey })).code).toBe("SOURCE_UNREADABLE");
	expect(failure(() => verifyInterruptedHostProfileFileTransfer({ ...options, sourceKey: badKey })).code).toBe("SOURCE_UNREADABLE");
	expect(failure(() => verifyInterruptedHostProfileFileTransfer({ ...options, acceptedRecoverySha256: "0".repeat(64) })).code).toBe("RECOVERY_REVIEW_CHANGED");
	for (const item of before) {
		expect(readFileSync(item.path)).toEqual(item.bytes);
		const after = statSync(item.path); expect([after.dev, after.ino, after.nlink, after.size, after.mtimeMs, after.ctimeMs]).toEqual([item.stat.dev, item.stat.ino, item.stat.nlink, item.stat.size, item.stat.mtimeMs, item.stat.ctimeMs]);
	}
	expect(readdirSync(dirname(value.target)).sort()).toEqual(entries);
	expect(inspectInterruptedHostProfileFileTransfer(value.target).recoverySha256).toBe(review.recoverySha256);
});

it("reviews and recovers through a fresh private worker with single-use acceptance", async () => {
	const value = await crashed("after-link"), restarted = client(value.root);
	const inspected = await restarted.request("inspect-interrupted", { destinationDatabasePath: value.target }); expect(inspected.ok).toBe(true);
	const input = { reviewId: inspected.reviewId, acceptedRecoverySha256: (inspected.preview as { recoverySha256: string }).recoverySha256,
		sourceKeyBase64: value.sourceKey.toString("base64"), destinationKeyBase64: value.destinationKey.toString("base64") };
	expect(await restarted.request("recover-interrupted", { ...input, approved: false })).toMatchObject({ ok: false, error: { code: "PLAN_NOT_ACCEPTED" } });
	const result = await restarted.request("recover-interrupted", { ...input, approved: true }); expect(result).toMatchObject({ ok: true, receipt: { activationPerformed: false } });
	expect(await restarted.request("recover-interrupted", { ...input, approved: true })).toMatchObject({ ok: false, error: { code: "RECOVERY_EXPIRED" } });
	expect(await restarted.request("verify-recovery", { recoveryId: result.recoveryId })).toMatchObject({ ok: true, recovery: { originalReadable: true, destinationReadable: true } });
	expect(await restarted.stop()).toEqual({ code: 0, signal: null }); expect(restarted.errors()).toBe("");
	for (const content of [privateText, value.sourceKey.toString("base64"), value.destinationKey.toString("base64")]) expect(restarted.output()).not.toContain(content);
	expect(readFileSync(value.source)).toEqual(value.before);
});

it("never steals a reservation from the actual live transfer owner", async () => {
	const value = await crashed("hold-before-link"), journal = readFileSync(value.target + ".kestrel-transfer-journal");
	expect(failure(() => inspectInterruptedHostProfileFileTransfer(value.target)).code).toBe("RECOVERY_BUSY");
	expect(readFileSync(value.target + ".kestrel-transfer-journal")).toEqual(journal);
	expect(readFileSync(value.source)).toEqual(value.before);
});

it.each(["journal-digest", "stage-directory", "extra-stage-file", "file-permissions"])("preserves all files when %s no longer matches", async changed => {
	const value = await crashed("after-link");
	if (changed === "journal-digest") writeFileSync(value.target + ".kestrel-transfer-journal", readFileSync(value.target + ".kestrel-transfer-journal", "utf8") + "\n");
	else if (changed === "stage-directory") { renameSync(value.journal.staging.path, value.journal.staging.path + "-preserved"); mkdirSync(value.journal.staging.path, { mode: 0o700 }); }
	else if (changed === "extra-stage-file") writeFileSync(join(value.journal.staging.path, "generated-user-note"), "Preserve this generated note", { mode: 0o600 });
	else chmodSync(value.target + ".kestrel-transfer-journal", 0o644);
	const targetBefore = readFileSync(value.target);
	expect(failure(() => inspectInterruptedHostProfileFileTransfer(value.target)).code).toBe("RECOVERY_METADATA_INVALID");
	expect(readFileSync(value.target)).toEqual(targetBefore); expect(readFileSync(value.source)).toEqual(value.before);
});

it("refuses later native work instead of replaying an older import over it", async () => {
	const value = await crashed("after-unlink"), db = new KestrelDatabase(value.target, value.destinationKey);
	db.setPrivateState("later-native-work", { retain: true }); db.close();
	const targetBefore = readFileSync(value.target);
	expect(failure(() => recover(value))).toMatchObject({ code: "RECOVERY_CHANGED", published: true });
	expect(readFileSync(value.target)).toEqual(targetBefore); expect(readFileSync(value.source)).toEqual(value.before);
});

it("keeps an incomplete stage after an early process death for a separate review", async () => {
	const value = await crashed("after-journal");
	expect(failure(() => recover(value)).code).toBe("SOURCE_UNREADABLE");
	expect(readdirSync(dirname(value.target))).toContain("kestrel.sqlite.kestrel-transfer-journal");
	expect(readFileSync(value.source)).toEqual(value.before);
});

it("recovers the journal-only finalization case after a process death", async () => {
	const value = await crashed("after-unlink"); unlinkSync(value.target + ".kestrel-transfer-lock");
	expect(recover(value).activationPerformed).toBe(false);
	expect(readdirSync(dirname(value.target))).toEqual(["kestrel.sqlite"]);
});

it("requires a fresh review after source files change and preserves the newer source", async () => {
	const value = await crashed("after-link"), review = inspectInterruptedHostProfileFileTransfer(value.target);
	const db = new KestrelDatabase(value.source, value.sourceKey); db.setPrivateState("new-original-work", { retain: true }); db.close();
	const sourceBefore = readFileSync(value.source), targetBefore = readFileSync(value.target);
	expect(failure(() => recoverInterruptedHostProfileFileTransfer({ ...value, destinationDatabasePath: value.target, acceptedRecoverySha256: review.recoverySha256 }))).toMatchObject({ code: "RECOVERY_REVIEW_CHANGED", published: true });
	expect(readFileSync(value.source)).toEqual(sourceBefore); expect(readFileSync(value.target)).toEqual(targetBefore);
});

it("rejects a wrong recovery key without touching either database or its journal", async () => {
	const value = await crashed("after-link"), review = inspectInterruptedHostProfileFileTransfer(value.target);
	const targetBefore = readFileSync(value.target), journalBefore = readFileSync(value.target + ".kestrel-transfer-journal"), wrongKey = randomBytes(32); keys.push(wrongKey);
	expect(failure(() => recoverInterruptedHostProfileFileTransfer({ ...value, destinationDatabasePath: value.target, destinationKey: wrongKey, acceptedRecoverySha256: review.recoverySha256 }))).toMatchObject({ code: "SOURCE_UNREADABLE", published: true });
	expect(readFileSync(value.source)).toEqual(value.before); expect(readFileSync(value.target)).toEqual(targetBefore);
	expect(readFileSync(value.target + ".kestrel-transfer-journal")).toEqual(journalBefore);
});

it.each(["live", "dead"])("does not steal a %s recovery-worker reservation", async state => {
	const value = await crashed("after-link"), lease = value.target + ".kestrel-transfer-recovery-lock";
	const bytes = JSON.stringify({ ownerPid: state === "live" ? process.pid : value.owner.child.pid }); writeFileSync(lease, bytes, { mode: 0o600 });
	expect(failure(() => inspectInterruptedHostProfileFileTransfer(value.target)).code).toBe(state === "live" ? "RECOVERY_BUSY" : "RECOVERY_RESERVED");
	expect(readFileSync(lease, "utf8")).toBe(bytes); expect(readFileSync(value.source)).toEqual(value.before);
});

it("preserves an unrelated destination that replaces the published filename", async () => {
	const value = await crashed("after-link"); renameSync(value.target, value.target + ".preserved");
	writeFileSync(value.target, "GENERATED_UNRELATED_DESTINATION", { mode: 0o600 });
	expect(failure(() => inspectInterruptedHostProfileFileTransfer(value.target)).code).toBe("RECOVERY_METADATA_INVALID");
	expect(readFileSync(value.target, "utf8")).toBe("GENERATED_UNRELATED_DESTINATION"); expect(readFileSync(value.source)).toEqual(value.before);
});
