import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, rmdirSync, rmSync, unlinkSync, writeFileSync, writeSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createHostProfileTransferSnapshot, HOST_PROFILE_TRANSFER_POLICY, importHostProfileTransferSnapshot, type HostProfileTransferSnapshot } from "./profile-transfer.js";
import { LATEST_SCHEMA_VERSION, listMigrationVersions, loadMigrationSql } from "./migrations.js";

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
type TransferJournal = {
	format: "kestrel-core-transfer-journal"; version: 1; runId: string; ownerPid: number;
	plan: HostProfileFileTransferPlan;
	staging: { path: string; directory: Identity; file: Identity };
};
type TransferLock = { format: "kestrel-core-transfer-lock"; version: 1; runId: string; ownerPid: number; planSha256: string; journalSha256: string };
export type HostProfileInterruptedTransferReview = {
	format: "kestrel-core-transfer-recovery-review"; version: 1;
	destinationDatabasePath: string; state: "published" | "staged" | "missing-stage";
	plan: HostProfileFileTransferPlan; recoverySha256: string;
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
function ownedFile(path: string, recoveryLink?: Identity): Identity {
	const info = lstatSync(path);
	if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() ||
		(info.nlink !== 1 && !(info.nlink === 2 && recoveryLink && same(identity(info), recoveryLink))))
		fail("UNSAFE_PATH", "Core transfer requires owned regular database files without links.");
	return identity(info);
}
function absolute(path: string): string {
	if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) fail("UNSAFE_PATH", "Core transfer requires an explicit canonical database path.");
	return path;
}
function sourceAt(path: string, recoveryLink?: Identity): Source {
	absolute(path);
	const parent = directory(dirname(path)), file = ownedFile(path, recoveryLink);
	for (const suffix of ["-wal", "-shm", "-journal"]) if (!missing(path + suffix)) ownedFile(path + suffix);
	return { path, file, directory: parent };
}
const lockPath = (path: string) => path + ".kestrel-transfer-lock";
const journalPath = (path: string) => path + ".kestrel-transfer-journal";
const recoveryLockPath = (path: string) => path + ".kestrel-transfer-recovery-lock";
function destinationAt(path: string, ignoreOwnedReservation = false): Destination {
	absolute(path);
	const parent = directory(dirname(path));
	for (const suffix of ["", "-wal", "-shm", "-journal", ...(ignoreOwnedReservation ? [] : [".kestrel-transfer-lock", ".kestrel-transfer-journal", ".kestrel-transfer-recovery-lock"])]) {
		if (!missing(path + suffix)) fail("DESTINATION_EXISTS", "Core transfer destination or its recovery files already exist; nothing was overwritten.");
	}
	return { path, directory: parent };
}
function summary(snapshot: HostProfileTransferSnapshot): Summary {
	return { schemaVersion: snapshot.schemaVersion, policy: snapshot.policy, counts: snapshot.counts, excluded: snapshot.excluded, semanticSha256: snapshot.semanticSha256 };
}
const MAX_SOURCE_FILE_BYTES = 256_000_000;
type HeldSourceFile = { path: string; fd?: number; stat?: Stats };
function sameSourceStat(left: Stats, right: Stats): boolean {
	return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino &&
		left.uid === right.uid && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size &&
		left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
/** Copy only encrypted bytes to a private temporary directory; never open source in SQLite. */
function copySourceForRead(source: Source, recoveryLink?: Identity): { path: string; verify(): void; close(): void } {
	const held: HeldSourceFile[] = [];
	const root = mkdtempSync(join(tmpdir(), "kestrel-core-transfer-read-"));
	const clone = join(root, "kestrel.sqlite");
	const verify = () => {
		if (!same(sourceAt(source.path, recoveryLink), source)) fail("SOURCE_CHANGED", "The Core source changed during inspection.");
		for (const file of held) {
			if (file.fd === undefined || file.stat === undefined) {
				if (!missing(file.path)) fail("SOURCE_CHANGED", "The Core source changed during inspection.");
				continue;
			}
			let current: Stats;
			try { current = lstatSync(file.path); } catch { return fail("SOURCE_CHANGED", "The Core source changed during inspection."); }
			if (!sameSourceStat(file.stat, fstatSync(file.fd)) || !sameSourceStat(file.stat, current))
				fail("SOURCE_CHANGED", "The Core source changed during inspection.");
		}
	};
	const close = () => {
		let failure: unknown;
		for (const file of held) if (file.fd !== undefined) {
			try { closeSync(file.fd); } catch (error) { failure ??= error; }
			delete file.fd;
		}
		try { rmSync(root, { recursive: true, force: true }); } catch (error) { failure ??= error; }
		if (failure) throw failure;
	};
	try {
		if (!same(sourceAt(source.path, recoveryLink), source)) fail("SOURCE_CHANGED", "The Core source changed before inspection.");
		// An existing rollback journal may contain uncommitted changes; copying it
		// is not a safe snapshot and recovery must not mutate the original.
		if (!missing(`${source.path}-journal`)) fail("SOURCE_UNREADABLE", "The Core source has an unsettled SQLite journal.");
		for (const suffix of ["", "-wal", "-shm", "-journal"]) {
			const path = source.path + suffix;
			if (suffix && missing(path)) { held.push({ path }); continue; }
			if (suffix === "-journal") fail("SOURCE_UNREADABLE", "The Core source has an unsettled SQLite journal.");
			const named = lstatSync(path);
			const permittedLinks = suffix === "" && recoveryLink && same(identity(named), recoveryLink) ? [1, 2] : [1];
			if (!named.isFile() || named.isSymbolicLink() || named.uid !== process.getuid?.() || !permittedLinks.includes(named.nlink) || named.size > MAX_SOURCE_FILE_BYTES)
				fail("UNSAFE_PATH", "The Core source file is unavailable or exceeds its size limit.");
			const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			held.push({ path, fd, stat: named });
			if (!sameSourceStat(named, fstatSync(fd))) fail("SOURCE_CHANGED", "The Core source changed before inspection.");
			if (suffix === "-shm") continue;
			const out = openSync(clone + suffix, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
			try {
				const buffer = Buffer.allocUnsafe(64 * 1024); let position = 0;
				while (position < named.size) {
					const count = readSync(fd, buffer, 0, Math.min(buffer.length, named.size - position), position);
					if (!count) fail("SOURCE_CHANGED", "The Core source changed during inspection.");
					let offset = 0;
					while (offset < count) { const written = writeSync(out, buffer, offset, count - offset); if (!written) fail("SOURCE_UNREADABLE", "The Core snapshot could not be copied."); offset += written; }
					position += count;
				}
			} finally { closeSync(out); }
		}
		verify();
		return { path: clone, verify, close };
	} catch (error) { close(); throw error; }
}
function rejectDeclaredNewerSchema(db: Database.Database): void {
	// This is unauthenticated format metadata, not proof that any row or key is
	// valid. Read a bounded integer only from an ordinary migration table. Views,
	// virtual tables and changed column types still reach the strict validator.
	const table = db.prepare("SELECT type, sql FROM sqlite_master WHERE name = ?").get("schema_migrations") as { type?: string; sql?: string } | undefined;
	if (table?.type !== "table" || !/^CREATE TABLE\s/iu.test(table.sql ?? "")) return;
	const columns = db.pragma("table_info(schema_migrations)") as Array<{ name: string; type: string; pk: number }>;
	if (!columns.some(column => column.name === "version" && column.type.toUpperCase() === "INTEGER" && column.pk === 1)) return;
	const row = db.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get() as { version?: unknown } | undefined;
	if (typeof row?.version === "number" && Number.isSafeInteger(row.version) && row.version > LATEST_SCHEMA_VERSION && row.version <= 1_000_000)
		fail("SOURCE_SCHEMA_NEWER", `The selected profile declares schema ${row.version}; this build supports up to ${LATEST_SCHEMA_VERSION}. Review it with a compatible Kestrel build. Existing data was preserved.`);
}
function readSource(source: Source, key: Buffer, recoveryLink?: Identity): { snapshot: HostProfileTransferSnapshot; authenticatedEnvelopes: number } {
	let db: Database.Database | undefined;
	let copy: ReturnType<typeof copySourceForRead> | undefined;
	try {
		copy = copySourceForRead(source, recoveryLink);
		db = new Database(copy.path, { readonly: true, fileMustExist: true });
		const reader = db;
		const result = reader.transaction(() => {
			rejectDeclaredNewerSchema(reader);
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
		copy.verify();
		return result;
	} catch (error) {
		if (error instanceof HostProfileFileTransferError) throw error;
		// Contract/SQLite errors can contain stored values. Do not forward those
		// details, error causes or decrypted content across the host boundary.
		return fail("SOURCE_UNREADABLE", "The selected Core source could not be authenticated or its schema is unsupported; it was preserved.");
	} finally { try { db?.close(); } finally { copy?.close(); } }
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
	if (!same(Object.keys(plan).sort(), ["format", "version", "source", "destination", "summary", "authenticatedEnvelopes", "planSha256"].sort()) ||
		plan.format !== "kestrel-host-core-file-transfer" || plan.version !== 1 || hash(value) !== planSha256)
		fail("PLAN_CHANGED", "The Core transfer review is invalid. Review the source again.");
}

const MAX_RECOVERY_METADATA = 64 * 1024;
function exactFields(value: unknown, names: string[]): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value) && same(Object.keys(value).sort(), [...names].sort()));
}
function validIdentity(value: unknown): value is Identity {
	return exactFields(value, ["device", "inode"]) && [value.device, value.inode].every(part => typeof part === "string" && /^\d{1,30}$/.test(part));
}
function validPid(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 0x7fff_ffff; }
function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
		fail("RECOVERY_UNAVAILABLE", "The previous transfer worker's ownership could not be verified.");
	}
}
function metadata(path: string): { value: unknown; sha256: string; file: Identity } {
	ownedFile(path);
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const before = fstatSync(fd);
		if (!before.isFile() || before.uid !== process.getuid?.() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 || before.size < 1 || before.size > MAX_RECOVERY_METADATA)
			fail("RECOVERY_METADATA_INVALID", "The interrupted Core transfer metadata is invalid; all files were preserved.");
		const bytes = Buffer.alloc(MAX_RECOVERY_METADATA + 1); let length = 0;
		while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, length); if (!count) break; length += count; }
		const after = fstatSync(fd);
		if (length !== before.size || length > MAX_RECOVERY_METADATA || before.mtimeMs !== after.mtimeMs || !same(identity(before), identity(lstatSync(path))))
			fail("RECOVERY_METADATA_INVALID", "The interrupted Core transfer metadata changed during inspection.");
		const raw = bytes.subarray(0, length);
		return { value: JSON.parse(raw.toString("utf8")), sha256: createHash("sha256").update(raw).digest("hex"), file: identity(before) };
	} finally { closeSync(fd); }
}
function validateJournal(value: unknown): asserts value is TransferJournal {
	if (!exactFields(value, ["format", "version", "runId", "ownerPid", "plan", "staging"]) || value.format !== "kestrel-core-transfer-journal" || value.version !== 1 ||
		typeof value.runId !== "string" || !/^[a-f0-9-]{36}$/.test(value.runId) || !validPid(value.ownerPid))
		fail("RECOVERY_METADATA_INVALID", "The interrupted Core transfer journal is invalid; all files were preserved.");
	validatePlan(value.plan as HostProfileFileTransferPlan);
	const plan = value.plan as HostProfileFileTransferPlan;
	if (!exactFields(plan.source, ["path", "file", "directory"]) || typeof plan.source.path !== "string" || !validIdentity(plan.source.file) || !validIdentity(plan.source.directory) ||
		!exactFields(plan.destination, ["path", "directory"]) || typeof plan.destination.path !== "string" || !validIdentity(plan.destination.directory) ||
		!exactFields(plan.summary, ["schemaVersion", "policy", "counts", "excluded", "semanticSha256"]) ||
		plan.summary.schemaVersion !== 18 || plan.summary.policy !== HOST_PROFILE_TRANSFER_POLICY || !/^[a-f0-9]{64}$/.test(plan.summary.semanticSha256) ||
		!Number.isSafeInteger(plan.authenticatedEnvelopes) || plan.authenticatedEnvelopes < 1 ||
		![plan.summary.counts, plan.summary.excluded].every(record => record && typeof record === "object" && !Array.isArray(record) && Object.keys(record).length <= 100 && Object.entries(record).every(([name, count]) => /^[a-zA-Z_]{1,64}$/.test(name) && Number.isSafeInteger(count) && Number(count) >= 0)))
		fail("RECOVERY_METADATA_INVALID", "The interrupted Core transfer plan metadata is invalid.");
	if (!exactFields(value.staging, ["path", "directory", "file"]) || typeof value.staging.path !== "string" || !validIdentity(value.staging.directory) || !validIdentity(value.staging.file))
		fail("RECOVERY_METADATA_INVALID", "The interrupted Core staging identity is invalid.");
}
function fingerprint(path: string, recoveryLink?: Identity): Record<string, unknown> {
	const file = ownedFile(path, recoveryLink), info = lstatSync(path);
	if ((info.mode & 0o777) !== 0o600) fail("RECOVERY_METADATA_INVALID", "Interrupted Core files require private permissions.");
	return { file, links: info.nlink, size: info.size, modifiedAt: info.mtimeMs };
}
function inspectInterrupted(path: string, ownedRecoveryLock?: Identity) {
	absolute(path); const parent = directory(dirname(path));
	if (!missing(recoveryLockPath(path)) && !same(ownedFile(recoveryLockPath(path)), ownedRecoveryLock)) {
		const reservation = metadata(recoveryLockPath(path)).value as { ownerPid?: unknown };
		if (validPid(reservation?.ownerPid) && alive(reservation.ownerPid)) fail("RECOVERY_BUSY", "Another recovery worker still owns this Core destination.");
		fail("RECOVERY_RESERVED", "A previous recovery reservation needs its own review; no files were changed.");
	}
	const saved = metadata(journalPath(path)); validateJournal(saved.value);
	const journal = saved.value, plan = journal.plan;
	if (plan.destination.path !== path || !same(plan.destination.directory, parent)) fail("RECOVERY_METADATA_INVALID", "The Core destination no longer matches its recovery journal.");
	if (alive(journal.ownerPid)) fail("RECOVERY_BUSY", "The original Core transfer worker is still running. Stop it before recovery.");
	let lock: ReturnType<typeof metadata> | undefined;
	if (!missing(lockPath(path))) {
		lock = metadata(lockPath(path)); const value = lock.value;
		if (!exactFields(value, ["format", "version", "runId", "ownerPid", "planSha256", "journalSha256"]) || value.format !== "kestrel-core-transfer-lock" || value.version !== 1 ||
			value.runId !== journal.runId || value.ownerPid !== journal.ownerPid || value.planSha256 !== plan.planSha256 || value.journalSha256 !== saved.sha256)
			fail("RECOVERY_METADATA_INVALID", "The Core transfer lock and journal do not match.");
	}
	const stage = journal.staging.path;
	if (dirname(stage) !== dirname(path) || !/^\.kestrel-core-transfer-[a-zA-Z0-9]+$/.test(basename(stage))) fail("RECOVERY_METADATA_INVALID", "The recorded Core staging path is outside its destination.");
	const stagePresent = !missing(stage);
	if (stagePresent && !same(directory(stage), journal.staging.directory)) fail("RECOVERY_METADATA_INVALID", "The recorded Core staging directory was replaced.");
	const entries = stagePresent ? readdirSync(stage).sort() : [];
	if (entries.some(name => !["kestrel.sqlite", "kestrel.sqlite-journal", "kestrel.sqlite-wal", "kestrel.sqlite-shm"].includes(name))) fail("RECOVERY_METADATA_INVALID", "The Core staging directory contains unrecognized files; it was preserved.");
	const stagedPath = join(stage, "kestrel.sqlite"), stagedPresent = stagePresent && !missing(stagedPath), targetPresent = !missing(path);
	const staged = stagedPresent ? fingerprint(stagedPath, journal.staging.file) : null;
	const target = targetPresent ? fingerprint(path, journal.staging.file) : null;
	if ((staged && !same(staged.file, journal.staging.file)) || (target && !same(target.file, journal.staging.file)) ||
		(target && target.links !== (staged ? 2 : 1)) || (staged && staged.links !== (target ? 2 : 1)))
		fail("RECOVERY_METADATA_INVALID", "The staged and published Core file identities do not match; all files were preserved.");
	const state = target ? "published" as const : staged ? "staged" as const : "missing-stage" as const;
	const source = sourceAt(plan.source.path);
	if (!same(source, plan.source)) fail("SOURCE_CHANGED", "The original Core source was replaced. Preserve both profiles for review.");
	const recoverySha256 = hash({ journalSha256: saved.sha256, journalFile: saved.file, lockFile: lock?.file ?? null, stagePresent, entries, staged, target,
		source: { ...source, size: lstatSync(source.path).size, modifiedAt: lstatSync(source.path).mtimeMs } });
	return { journal, saved, lock, stage, entries, stagedPath, staged, target, state, recoverySha256 };
}

// Read metadata only; no database, Keychain, key or process termination. The
// native profile owner must hold this review privately and obtain recovery
// consent. A dead recovery-worker reservation is deliberately not stolen.
export function inspectInterruptedHostProfileFileTransfer(destinationDatabasePath: string): HostProfileInterruptedTransferReview {
	try {
		const value = inspectInterrupted(destinationDatabasePath);
		return { format: "kestrel-core-transfer-recovery-review", version: 1, destinationDatabasePath, state: value.state, plan: value.journal.plan, recoverySha256: value.recoverySha256 };
	} catch (error) {
		if (error instanceof HostProfileFileTransferError) throw error;
		return fail("RECOVERY_METADATA_INVALID", "The interrupted Core transfer could not be inspected safely; all files were preserved.");
	}
}

// Explicit offline recovery for a fully verified staged/published import.
// Preserve incomplete/corrupt stages and later work for a separate review.
// A native host can retain the immutable journal until a separate profile
// selection. It remains review metadata, never consent or authentication;
// later recovery still requires fresh review and both existing keys.
// The dedicated reservation serializes recovery; a crashed recovery reservation
// stays blocked pending its own review, rather than stealing a live lease.
export function recoverInterruptedHostProfileFileTransfer(options: { destinationDatabasePath: string; sourceKey: Buffer; destinationKey: Buffer; acceptedRecoverySha256: string; retainRecoveryJournal?: boolean }): HostProfileFileTransferReceipt {
	verifyKey(options.sourceKey); verifyKey(options.destinationKey);
	if (timingSafeEqual(options.sourceKey, options.destinationKey)) fail("KEY_REUSE", "Core transfer requires an independent destination key.");
	let lease: number | undefined, leaseIdentity: Identity | undefined, published = false, finalizing = false;
	const path = options.destinationDatabasePath;
	try {
		const reviewed = inspectInterrupted(path);
		published = Boolean(reviewed.target);
		if (reviewed.recoverySha256 !== options.acceptedRecoverySha256) fail("RECOVERY_REVIEW_CHANGED", "The interrupted Core transfer changed after review. Inspect it again.");
		if (reviewed.state === "missing-stage" || reviewed.entries.some(name => name !== "kestrel.sqlite")) fail("STAGING_UNAVAILABLE", "The interrupted stage is incomplete or unsettled. Preserve it and the original profile for a separate recovery review.");
		lease = openSync(recoveryLockPath(path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		leaseIdentity = identity(fstatSync(lease));
		writeFileSync(lease, canonical({ format: "kestrel-core-transfer-recovery-lock", version: 1, ownerPid: process.pid, recoverySha256: reviewed.recoverySha256 })); fsyncSync(lease); syncPath(dirname(path));
		const plan = reviewed.journal.plan;
		const original = readSource(plan.source, options.sourceKey);
		if (!same(planFor(plan.source, plan.destination, original.snapshot, original.authenticatedEnvelopes), plan)) fail("RECOVERY_CHANGED", "Original Core data changed after transfer review. Preserve both profiles for a new review.");
		const databasePath = reviewed.target ? path : reviewed.stagedPath;
		const imported = readSource({ path: databasePath, file: reviewed.journal.staging.file, directory: reviewed.target ? plan.destination.directory : reviewed.journal.staging.directory }, options.destinationKey, reviewed.journal.staging.file);
		if (imported.snapshot.semanticSha256 !== plan.summary.semanticSha256) fail("RECOVERY_CHANGED", "Native Core data changed after transfer. Preserve all work for a new review.");
		if (inspectInterrupted(path, leaseIdentity).recoverySha256 !== reviewed.recoverySha256) fail("RECOVERY_REVIEW_CHANGED", "The interrupted Core files changed during verification. Inspect them again.");
		if (!reviewed.target) { syncPath(reviewed.stagedPath); syncPath(reviewed.stage); linkSync(reviewed.stagedPath, path); }
		published = true; finalizing = true;
		if (reviewed.staged) unlinkSync(reviewed.stagedPath);
		syncPath(dirname(path));
		const file = ownedFile(path);
		if (!missing(reviewed.stage)) rmdirSync(reviewed.stage);
		if (reviewed.lock && !missing(lockPath(path)) && same(ownedFile(lockPath(path)), reviewed.lock.file)) unlinkSync(lockPath(path));
		if (!same(ownedFile(journalPath(path)), reviewed.saved.file)) fail("RECOVERY_REVIEW_CHANGED", "The Core recovery journal changed during finalization.");
		if (!options.retainRecoveryJournal) unlinkSync(journalPath(path));
		syncPath(dirname(path));
		return { format: "kestrel-host-core-file-transfer-receipt", version: 1, planSha256: plan.planSha256, source: plan.source, destination: { ...plan.destination, file },
			summary: plan.summary, authenticatedEnvelopes: plan.authenticatedEnvelopes, activationPerformed: false };
	} catch (error) {
		if (finalizing) throw new HostProfileFileTransferError("PUBLISHED_RECOVERY_REQUIRED", "The recovered encrypted Core database was preserved, but finalization still requires review.", true);
		if (error instanceof HostProfileFileTransferError) throw new HostProfileFileTransferError(error.code, error.message, published || error.published);
		return fail("RECOVERY_UNAVAILABLE", "Interrupted Core transfer recovery could not finish; all data files were preserved.");
	} finally {
		let cleanupFailed = false;
		try { if (lease !== undefined) closeSync(lease); } catch { cleanupFailed = true; }
		try {
			if (leaseIdentity && !missing(recoveryLockPath(path)) && same(ownedFile(recoveryLockPath(path)), leaseIdentity)) {
				unlinkSync(recoveryLockPath(path));
				syncPath(dirname(path));
			}
		} catch { cleanupFailed = true; }
		if (cleanupFailed) throw new HostProfileFileTransferError("RECOVERY_RESERVATION_RETAINED", "The Core recovery reservation needs review. All data files were preserved.", published);
	}
}

// Offline file apply: neither source nor destination Core may be activated by
// this API. The product must quiesce source writes before its final cutover.
// A fresh encrypted database is fully verified in a private staging directory,
// then hard-linked into the final filename atomically without replacement.
// Crashes can leave encrypted staging/lock files for explicit recovery. Once
// publication occurs, an error never deletes the published database.
// Retaining a completed journal closes the host's verify-to-selection crash
// window without persisting keys or implicitly activating the imported data.
export function applyHostProfileFileTransfer(options: { plan: HostProfileFileTransferPlan; sourceKey: Buffer; destinationKey: Buffer; acceptedPlanSha256: string; retainRecoveryJournal?: boolean }): HostProfileFileTransferReceipt {
	verifyKey(options.sourceKey); verifyKey(options.destinationKey); validatePlan(options.plan);
	if (options.acceptedPlanSha256 !== options.plan.planSha256) fail("PLAN_NOT_ACCEPTED", "Apply requires the exact reviewed Core transfer plan.");
	if (timingSafeEqual(options.sourceKey, options.destinationKey)) fail("KEY_REUSE", "Core transfer requires an independent destination key.");
	const { plan, sourceKey, destinationKey } = options;
	let lock: number | undefined, lockIdentity: Identity | undefined, journalIdentity: Identity | undefined, staging: string | undefined, db: Database.Database | undefined;
	let published = false, completed = false;
	try {
		const fresh = planHostProfileFileTransfer({ sourceDatabasePath: plan.source.path, sourceKey, destinationDatabasePath: plan.destination.path });
		if (!same(fresh, plan)) fail("SOURCE_CHANGED", "The Core source or destination changed after review. Review it again.");
		const source = readSource(plan.source, sourceKey);
		if (!same(planFor(plan.source, plan.destination, source.snapshot, source.authenticatedEnvelopes), plan)) fail("SOURCE_CHANGED", "The Core source changed after review. Review it again.");
		staging = mkdtempSync(join(dirname(plan.destination.path), ".kestrel-core-transfer-"));
		const stagedDatabase = join(staging, "kestrel.sqlite");
		const fd = openSync(stagedDatabase, "wx", 0o600); closeSync(fd);
		const runId = randomUUID();
		const journal: TransferJournal = { format: "kestrel-core-transfer-journal", version: 1, runId, ownerPid: process.pid, plan,
			staging: { path: staging, directory: directory(staging), file: ownedFile(stagedDatabase) } };
		const journalBytes = Buffer.from(canonical(journal));
		const reservation: TransferLock = { format: "kestrel-core-transfer-lock", version: 1, runId, ownerPid: process.pid,
			planSha256: plan.planSha256, journalSha256: createHash("sha256").update(journalBytes).digest("hex") };
		lock = openSync(lockPath(plan.destination.path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		lockIdentity = identity(fstatSync(lock)); writeFileSync(lock, canonical(reservation)); fsyncSync(lock);
		const journalFd = openSync(journalPath(plan.destination.path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		journalIdentity = identity(fstatSync(journalFd));
		try { writeFileSync(journalFd, journalBytes); fsyncSync(journalFd); } finally { closeSync(journalFd); }
		syncPath(dirname(plan.destination.path));
		if (!same(destinationAt(plan.destination.path, true), plan.destination)) fail("DESTINATION_CHANGED", "The Core destination changed after review.");
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
		completed = true;
		return { format: "kestrel-host-core-file-transfer-receipt", version: 1, planSha256: plan.planSha256, source: plan.source,
			destination: { ...plan.destination, file }, summary: plan.summary, authenticatedEnvelopes: plan.authenticatedEnvelopes, activationPerformed: false };
	} catch (error) {
		if (published) throw new HostProfileFileTransferError("PUBLISHED_RECOVERY_REQUIRED", "Core transfer published its encrypted destination but finalization needs recovery. Preserve both profiles; do not retry or activate automatically.", true);
		if (error instanceof HostProfileFileTransferError) throw error;
		return fail("APPLY_FAILED", "Core transfer failed before publication. The source and any existing destination were preserved.");
	} finally {
		let cleanupFailed = false;
		try { db?.close(); } catch { cleanupFailed = true; }
		if (completed || !published) { try { if (staging) rmSync(staging, { recursive: true, force: true }); } catch { cleanupFailed = true; } }
		if (lock !== undefined) { try { closeSync(lock); } catch { cleanupFailed = true; } }
		// Keep the immutable journal whenever committed/cleanup recovery is
		// required. Removing the lock first leaves a valid journal-only recovery
		// record if the final metadata unlink is interrupted.
		if (!cleanupFailed && (completed || !published)) {
			try {
				if (lockIdentity && !missing(lockPath(plan.destination.path)) && same(identity(lstatSync(lockPath(plan.destination.path))), lockIdentity)) unlinkSync(lockPath(plan.destination.path));
				if ((!completed || !options.retainRecoveryJournal) && journalIdentity && !missing(journalPath(plan.destination.path)) && same(identity(lstatSync(journalPath(plan.destination.path))), journalIdentity)) unlinkSync(journalPath(plan.destination.path));
				if (completed && options.retainRecoveryJournal) syncPath(dirname(plan.destination.path));
			} catch { cleanupFailed = true; }
		}
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
