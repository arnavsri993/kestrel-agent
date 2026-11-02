import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdtempSync, openSync, realpathSync, rmSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { createHostProfileTransferSnapshot, importHostProfileTransferSnapshot, type HostProfileTransferSnapshot } from "./profile-transfer.js";
import { listMigrationVersions, loadMigrationSql } from "./migrations.js";

type Identity = { device: string; inode: string };
type Source = { path: string; file: Identity; directory: Identity };
type Destination = { path: string; directory: Identity };
type Summary = Pick<HostProfileTransferSnapshot, "schemaVersion" | "policy" | "counts" | "excluded" | "semanticSha256">;

export type HostProfileFileTransferPlan = {
	format: "kestrel-host-core-file-transfer";
	version: 1;
	source: Source;
	destination: Destination;
	summary: Summary;
	authenticatedEnvelopes: number;
	planSha256: string;
};
export type HostProfileFileTransferReceipt = {
	format: "kestrel-host-core-file-transfer-receipt";
	version: 1;
	planSha256: string;
	source: Source;
	destination: Destination & { file: Identity };
	summary: Summary;
	authenticatedEnvelopes: number;
	activationPerformed: false;
};
export class HostProfileFileTransferError extends Error {
	constructor(readonly code: string, message: string, readonly published = false) {
		super(message); this.name = "HostProfileFileTransferError";
	}
}
function fail(code: string, message: string): never { throw new HostProfileFileTransferError(code, message); }
const canonical = (value: unknown): string => JSON.stringify(value);
const hash = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
const identity = (info: Stats): Identity => ({ device: String(info.dev), inode: String(info.ino) });
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
function verifyKey(key: Buffer): void {
	if (!Buffer.isBuffer(key) || key.length !== 32) fail("INVALID_KEY", "Core transfer requires a protected 32-byte host key.");
}
function missing(path: string): boolean {
	try { lstatSync(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}
function directory(path: string): Identity {
	const info = lstatSync(path);
	if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || realpathSync(path) !== path)
		fail("UNSAFE_PATH", "Core transfer requires canonical private directories owned by the current user.");
	return identity(info);
}
function ownedFile(path: string): Identity {
	const info = lstatSync(path);
	if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.nlink !== 1)
		fail("UNSAFE_PATH", "Core transfer requires owned regular database files without links.");
	return identity(info);
}
function absolute(path: string): string {
	if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) fail("UNSAFE_PATH", "Core transfer requires an explicit canonical database path.");
	return path;
}
function sourceAt(path: string): Source {
	absolute(path);
	const parent = directory(dirname(path)), file = ownedFile(path);
	for (const suffix of ["-wal", "-shm", "-journal"]) if (!missing(path + suffix)) ownedFile(path + suffix);
	return { path, file, directory: parent };
}
const lockPath = (path: string) => path + ".kestrel-transfer-lock";
function destinationAt(path: string, ignoreOwnedLock = false): Destination {
	absolute(path);
	const parent = directory(dirname(path));
	for (const suffix of ["", "-wal", "-shm", "-journal", ...(ignoreOwnedLock ? [] : [".kestrel-transfer-lock"])]) {
		if (!missing(path + suffix)) fail("DESTINATION_EXISTS", "Core transfer destination or its recovery files already exist; nothing was overwritten.");
	}
	return { path, directory: parent };
}
function summary(snapshot: HostProfileTransferSnapshot): Summary {
	return { schemaVersion: snapshot.schemaVersion, policy: snapshot.policy, counts: snapshot.counts, excluded: snapshot.excluded, semanticSha256: snapshot.semanticSha256 };
}
function readSource(source: Source, key: Buffer): { snapshot: HostProfileTransferSnapshot; authenticatedEnvelopes: number } {
	let db: Database.Database | undefined;
	try {
		if (!same(sourceAt(source.path), source)) fail("SOURCE_CHANGED", "The selected Core source was replaced. Review it again.");
		db = new Database(source.path, { readonly: true, fileMustExist: true });
		const reader = db;
		const result = reader.transaction(() => {
			// Validate canonical schema and aggregate limits before integrity scans
			// or decrypted rows can grow with an unsupported source. Check only the
			// first foreign-key violation instead of materializing an error list.
			const snapshot = createHostProfileTransferSnapshot(reader, key);
			const integrity = reader.pragma("integrity_check") as Array<{ integrity_check: string }>;
			if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok" || reader.prepare("PRAGMA foreign_key_check").get())
				fail("SOURCE_UNREADABLE", "The selected Core source failed integrity validation; it was preserved.");
			let authenticatedEnvelopes = Object.values(snapshot.rows).reduce((count, rows) => count + rows.reduce((total, row) => total + Object.values(row.cleartext ?? {}).filter(value => typeof value === "string").length, 0), 0);
			for (const row of reader.prepare("SELECT payload FROM tool_executions").iterate() as Iterable<{ payload: string }>) if (JSON.parse(row.payload)?.kestrelEncryptedTool === 1) authenticatedEnvelopes++;
			for (const row of reader.prepare("SELECT result FROM idempotency_keys").iterate() as Iterable<{ result: string }>) if (row.result.startsWith("kestrel-encrypted-idempotency-v1:")) authenticatedEnvelopes++;
			if (!authenticatedEnvelopes) fail("NO_AUTHENTICATED_RECORDS", "This Core source has no authenticated encrypted records. Use the separate empty-profile choice; no data was changed.");
			return { snapshot, authenticatedEnvelopes };
		}).deferred();
		if (!same(sourceAt(source.path), source)) fail("SOURCE_CHANGED", "The selected Core source was replaced. Review it again.");
		return result;
	} catch (error) {
		if (error instanceof HostProfileFileTransferError) throw error;
		// Contract/SQLite errors can contain stored values. Do not forward those
		// details, error causes or decrypted content across the host boundary.
		return fail("SOURCE_UNREADABLE", "The selected Core source could not be authenticated or its schema is unsupported; it was preserved.");
	} finally { db?.close(); }
}
function planFor(source: Source, destination: Destination, snapshot: HostProfileTransferSnapshot, authenticatedEnvelopes: number): HostProfileFileTransferPlan {
	const value = { format: "kestrel-host-core-file-transfer" as const, version: 1 as const, source, destination, summary: summary(snapshot), authenticatedEnvelopes };
	return { ...value, planSha256: hash(value) };
}

// Host-only API. Keys stay in caller-owned memory and plans contain metadata
// only. A plan hash is a consistency check, never approval or an agent token.
// A product caller must select the source explicitly, hold the reviewed plan
// privately and obtain apply consent. No renderer/Core RPC is exposed here.
export function planHostProfileFileTransfer(options: { sourceDatabasePath: string; sourceKey: Buffer; destinationDatabasePath: string }): HostProfileFileTransferPlan {
	verifyKey(options.sourceKey);
	try {
		const source = sourceAt(options.sourceDatabasePath), destination = destinationAt(options.destinationDatabasePath);
		if (source.path === destination.path) fail("UNSAFE_PATH", "Core source and destination must be different.");
		const result = readSource(source, options.sourceKey);
		return planFor(source, destination, result.snapshot, result.authenticatedEnvelopes);
	} catch (error) {
		if (error instanceof HostProfileFileTransferError) throw error;
		fail("UNSAFE_PATH", "Core transfer paths could not be inspected safely; nothing was changed.");
	}
}
function initializeEmpty(db: Database.Database): void {
	db.pragma("journal_mode = DELETE"); db.pragma("synchronous = FULL");
	db.pragma("foreign_keys = ON"); db.pragma("secure_delete = ON");
	db.transaction(() => {
		for (const version of listMigrationVersions()) {
			db.exec(loadMigrationSql(version));
			db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, new Date().toISOString());
		}
	})();
}
function syncPath(path: string): void {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try { fsyncSync(fd); } finally { closeSync(fd); }
}
function validatePlan(plan: HostProfileFileTransferPlan): void {
	if (!plan || typeof plan !== "object") fail("PLAN_CHANGED", "The Core transfer review is invalid. Review the source again.");
	const { planSha256, ...value } = plan;
	if (plan.format !== "kestrel-host-core-file-transfer" || plan.version !== 1 || hash(value) !== planSha256)
		fail("PLAN_CHANGED", "The Core transfer review is invalid. Review the source again.");
}

// Offline file apply: neither source nor destination Core may be activated by
// this API. The product must quiesce source writes before its final cutover.
// A fresh encrypted database is fully verified in a private staging directory,
// then hard-linked into the final filename atomically without replacement.
// Crashes can leave encrypted staging/lock files for explicit recovery. Once
// publication occurs, an error never deletes the published database.
export function applyHostProfileFileTransfer(options: { plan: HostProfileFileTransferPlan; sourceKey: Buffer; destinationKey: Buffer; acceptedPlanSha256: string }): HostProfileFileTransferReceipt {
	verifyKey(options.sourceKey); verifyKey(options.destinationKey); validatePlan(options.plan);
	if (options.acceptedPlanSha256 !== options.plan.planSha256) fail("PLAN_NOT_ACCEPTED", "Apply requires the exact reviewed Core transfer plan.");
	if (timingSafeEqual(options.sourceKey, options.destinationKey)) fail("KEY_REUSE", "Core transfer requires an independent destination key.");
	const { plan, sourceKey, destinationKey } = options;
	let lock: number | undefined, lockIdentity: Identity | undefined, staging: string | undefined, db: Database.Database | undefined;
	let published = false;
	try {
		const fresh = planHostProfileFileTransfer({ sourceDatabasePath: plan.source.path, sourceKey, destinationDatabasePath: plan.destination.path });
		if (!same(fresh, plan)) fail("SOURCE_CHANGED", "The Core source or destination changed after review. Review it again.");
		lock = openSync(lockPath(plan.destination.path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		lockIdentity = identity(fstatSync(lock)); writeFileSync(lock, plan.planSha256 + "\n"); fsyncSync(lock);
		if (!same(destinationAt(plan.destination.path, true), plan.destination)) fail("DESTINATION_CHANGED", "The Core destination changed after review.");
		const source = readSource(plan.source, sourceKey);
		if (!same(planFor(plan.source, plan.destination, source.snapshot, source.authenticatedEnvelopes), plan)) fail("SOURCE_CHANGED", "The Core source changed after review. Review it again.");
		staging = mkdtempSync(join(dirname(plan.destination.path), ".kestrel-core-transfer-"));
		const stagedDatabase = join(staging, "kestrel.sqlite");
		const fd = openSync(stagedDatabase, "wx", 0o600); closeSync(fd);
		db = new Database(stagedDatabase, { fileMustExist: true }); initializeEmpty(db);
		importHostProfileTransferSnapshot(db, destinationKey, source.snapshot);
		db.close(); db = undefined; syncPath(stagedDatabase); syncPath(staging);
		// Refuse source changes during verification; source remains preserved even
		// if another writer changes it after this point. Activation is separate.
		const finalSource = readSource(plan.source, sourceKey);
		if (!same(planFor(plan.source, plan.destination, finalSource.snapshot, finalSource.authenticatedEnvelopes), plan)) fail("SOURCE_CHANGED", "The Core source changed during transfer. Review it again.");
		if (!same(destinationAt(plan.destination.path, true), plan.destination)) fail("DESTINATION_CHANGED", "The Core destination changed during transfer.");
		linkSync(stagedDatabase, plan.destination.path); published = true;
		unlinkSync(stagedDatabase); syncPath(dirname(plan.destination.path));
		const file = ownedFile(plan.destination.path);
		return { format: "kestrel-host-core-file-transfer-receipt", version: 1, planSha256: plan.planSha256, source: plan.source,
			destination: { ...plan.destination, file }, summary: plan.summary, authenticatedEnvelopes: plan.authenticatedEnvelopes, activationPerformed: false };
	} catch (error) {
		if (published) throw new HostProfileFileTransferError("PUBLISHED_RECOVERY_REQUIRED", "Core transfer published its encrypted destination but finalization needs recovery. Preserve both profiles; do not retry or activate automatically.", true);
		if (error instanceof HostProfileFileTransferError) throw error;
		return fail("APPLY_FAILED", "Core transfer failed before publication. The source and any existing destination were preserved.");
	} finally {
		let cleanupFailed = false;
		for (const clean of [
			() => db?.close(),
			() => { if (staging) rmSync(staging, { recursive: true, force: true }); },
			() => { if (lock !== undefined) closeSync(lock); },
			() => { if (lockIdentity && !missing(lockPath(plan.destination.path)) && same(identity(lstatSync(lockPath(plan.destination.path))), lockIdentity)) unlinkSync(lockPath(plan.destination.path)); },
		]) { try { clean(); } catch { cleanupFailed = true; } }
		if (cleanupFailed) throw new HostProfileFileTransferError(published ? "PUBLISHED_RECOVERY_REQUIRED" : "STAGING_RECOVERY_REQUIRED",
			"Core transfer cleanup needs recovery. Preserve both profiles and any encrypted staging files; do not retry automatically.", published);
	}
}

// Read-only recovery acceptance for the Core files. This proves both copies
// remain readable; switching apps/profiles and browser/credential rollback are
// separate product operations. Never delete native work to "roll back".
export function verifyHostProfileFileTransferRecovery(receipt: HostProfileFileTransferReceipt, keys: { sourceKey: Buffer; destinationKey: Buffer }): { originalReadable: true; destinationReadable: true; activationPerformed: false } {
	verifyKey(keys.sourceKey); verifyKey(keys.destinationKey);
	try {
		if (receipt.format !== "kestrel-host-core-file-transfer-receipt" || receipt.version !== 1 || receipt.activationPerformed !== false)
			fail("INVALID_RECEIPT", "Core transfer recovery receipt is invalid.");
		validatePlan({ format: "kestrel-host-core-file-transfer", version: 1, source: receipt.source,
			destination: { path: receipt.destination.path, directory: receipt.destination.directory }, summary: receipt.summary,
			authenticatedEnvelopes: receipt.authenticatedEnvelopes, planSha256: receipt.planSha256 });
		if (!same(sourceAt(receipt.destination.path), { path: receipt.destination.path, file: receipt.destination.file, directory: receipt.destination.directory }))
			fail("DESTINATION_CHANGED", "The Core destination was replaced. Preserve both profiles for recovery.");
		const original = readSource(receipt.source, keys.sourceKey), destination = readSource(sourceAt(receipt.destination.path), keys.destinationKey);
		if (original.snapshot.semanticSha256 !== receipt.summary.semanticSha256 || destination.snapshot.semanticSha256 !== receipt.summary.semanticSha256)
			fail("RECOVERY_CHANGED", "Core data changed after transfer. Preserve both profiles; recovery requires a new review.");
		return { originalReadable: true, destinationReadable: true, activationPerformed: false };
	} catch (error) {
		if (error instanceof HostProfileFileTransferError) throw error;
		fail("RECOVERY_UNAVAILABLE", "Core transfer recovery could not be verified. Preserve both profiles.");
	}
}
