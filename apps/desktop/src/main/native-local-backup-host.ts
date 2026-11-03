import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { decryptText, encryptText, type EncryptedPayload } from "@kestrel/encryption";
import { NativeLocalBackupResultSchema, type RendererResponse } from "@kestrel/shared-types";
import { z } from "zod";
import { createVerifiedNativeCoreBackup, VerifiedNativeCoreBackupError, type VerifiedNativeCoreBackup, type VerifiedNativeCoreBackupOptions } from "./verified-native-core-backup";
import { writeNativePrivateFile } from "./native-private-file";

export { NATIVE_LOCAL_BACKUP_REQUEST_TYPES } from "./native-local-backup-requests";

const RequestSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("create-local-backup") }).strict(),
	z.object({ type: z.literal("reveal-created-local-backup"), backupId: z.string().uuid() }).strict(),
]);
const CANCELLED = { ok: true, cancelled: true } as const;
const ERROR_INVALID = "Invalid native local backup request.";
const ERROR_CLOSED = "Native local backup is closed.";
const ERROR_BUSY = "Core is busy. Try again when its current operation is complete.";
const ERROR_DUPLICATE = "Another native local backup operation is already in progress.";
const ERROR_CREATE = "The native Core backup could not be created safely. Incomplete private files may remain in the chosen folder.";
const ERROR_RESTART = "Core restart is required. No backup was created.";
const ERROR_COMMITTED_UNCERTAIN = "Backup files were published, but disk sync is unconfirmed; the files were preserved.";
const ERROR_RECEIPT = "The backup receipt is unavailable or no longer matches the saved backup.";
const RECEIPT_DIRECTORY = ".native-backup-receipts";
const RECEIPT_FORMAT = "native-local-backup-receipt";
const MAX_RECEIPT_BYTES = 32_768;
const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const OPTIONAL_ENTRIES = [
	"secure",
	"provider-accounts.json",
	"native-runtime-preferences.json",
	"workspace-grants.json",
	"computer-use.json",
	"trusted-plugin-publishers.json",
	"native-plugin-activation-ids.json",
	"plugins",
	"learned-skills",
] as const;

type CoreStatus = "ready" | "restart-required";
type CoreGateResult<T> =
	| { completed: true; value: T; coreStatus: CoreStatus }
	| { completed: false; error: unknown; coreStatus: CoreStatus };
type NativeDirectoryPublisher = VerifiedNativeCoreBackupOptions["publishDirectory"];
type BackupReceipt = {
	format: typeof RECEIPT_FORMAT;
	version: 1;
	backupId: string;
	createdAt: string;
	files: number;
	bytes: number;
	verified: true;
	scope: "native-core-data";
	directoryPath: string;
	directoryDev: string;
	directoryIno: string;
	directoryMode: string;
	directoryUid: string;
	parentPath: string;
	parentDev: string;
	parentIno: string;
	parentMode: string;
	parentUid: string;
};

export type NativeLocalBackupHostOptions = {
	root: string;
	forbiddenDestinationRoots: readonly string[];
	appVersion: string;
	encryptionKeyBase64: string;
	selectDestination(signal: AbortSignal): Promise<string | null>;
	publishDirectory: NativeDirectoryPublisher;
	revealDirectory(path: string, signal: AbortSignal): Promise<void>;
	withStoppedCore<T>(
		operation: () => Promise<T>,
		options: { signal: AbortSignal; shouldRestoreCore?: () => boolean },
	): Promise<CoreGateResult<T>>;
	isBusy?: () => boolean;
	shouldRestoreCore?: () => boolean;
};

function errnoCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}
function currentUid(): bigint | undefined {
	return typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
}
function ownedDirectory(stat: BigIntStats): boolean {
	return stat.isDirectory() && (currentUid() === undefined || stat.uid === currentUid());
}
function privateDirectory(stat: BigIntStats): boolean {
	return ownedDirectory(stat) && (stat.mode & 0o077n) === 0n;
}
function regularPrivateFile(stat: BigIntStats): boolean {
	return stat.isFile() && stat.nlink === 1n && (stat.mode & 0o077n) === 0n &&
		(currentUid() === undefined || stat.uid === currentUid());
}
function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}
function sameStableFile(a: BigIntStats, b: BigIntStats): boolean {
	return sameIdentity(a, b) && a.size === b.size && a.mode === b.mode && a.uid === b.uid && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function validAbsolutePath(value: unknown): value is string {
	return typeof value === "string" && isAbsolute(value) && Buffer.byteLength(value, "utf8") <= 4096 &&
		!/[\u0000-\u001f\u007f-\u009f]/u.test(value) && basename(value) !== "." && basename(value) !== "..";
}
function keyFromBase64(value: string): Buffer {
	if (!/^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=?$/.test(value)) return Buffer.alloc(0);
	const key = Buffer.from(value, "base64");
	return key.length === 32 && key.toString("base64") === value ? key : Buffer.alloc(0);
}
function validEncryptedPayload(value: unknown): value is EncryptedPayload {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.ciphertext === "string" && candidate.ciphertext.length <= MAX_RECEIPT_BYTES &&
		typeof candidate.iv === "string" && typeof candidate.authTag === "string";
}
function isCommittedSyncUncertain(error: unknown): boolean {
	return errnoCode(error) === "KESTREL_BACKUP_COMMITTED_SYNC_UNCERTAIN" ||
		(error instanceof VerifiedNativeCoreBackupError && error.code === "committedSyncUncertain");
}

/** Owns private encrypted backup receipts; paths and encryption material stay in the host. */
export class NativeLocalBackupHost {
	private closed = false;
	private active: Promise<RendererResponse> | undefined;
	private closing: Promise<void> | undefined;
	private readonly abort = new AbortController();
	private readonly key: Buffer;
	private readonly rootInput: string;
	private readonly callbacks: Omit<NativeLocalBackupHostOptions, "root" | "encryptionKeyBase64">;
	private readonly receiptCache = new Map<string, BackupReceipt>();

	constructor(options: NativeLocalBackupHostOptions) {
		this.key = keyFromBase64(options.encryptionKeyBase64);
		// Do not retain the caller's options object, which contains the encoded Key.
		this.rootInput = options.root;
		const { root: _root, encryptionKeyBase64: _encodedKey, ...callbacks } = options;
		this.callbacks = callbacks;
	}

	handle(raw: unknown, externalSignal?: AbortSignal): Promise<RendererResponse> {
		const parsed = RequestSchema.safeParse(raw);
		if (!parsed.success) return Promise.resolve({ ok: false, error: ERROR_INVALID });
		if (this.closed) return Promise.resolve({ ok: false, error: ERROR_CLOSED });
		if (this.active) return Promise.resolve({ ok: false, error: ERROR_DUPLICATE });
		const signal = externalSignal ? AbortSignal.any([this.abort.signal, externalSignal]) : this.abort.signal;
		// Claim the single operation slot before any injected callback runs.
		const operation = Promise.resolve().then(() => this.run(parsed.data, signal)).catch((error: unknown): RendererResponse => {
			if (isCommittedSyncUncertain(error)) return { ok: false, error: ERROR_COMMITTED_UNCERTAIN };
			if (signal.aborted || this.closed) return CANCELLED;
			return { ok: false, error: ERROR_CREATE };
		});
		this.active = operation;
		void operation.then(() => { if (this.active === operation) this.active = undefined; });
		return operation;
	}

	async status(): Promise<{ verified: boolean; createdAt?: string }> {
		if (this.closed || this.key.length !== 32) return { verified: false };
		try {
			await this.nativeRoot();
			const receipts = [...this.receiptCache.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
			for (const receipt of receipts) {
				if (await this.verifyReceiptLocation(receipt)) {
					return this.closed ? { verified: false } : { verified: true, createdAt: receipt.createdAt };
				}
			}
			return { verified: false };
		} catch { return { verified: false }; }
	}

	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.abort.abort();
		const active = this.active;
		this.closing = (async () => {
			await active;
			this.key.fill(0);
			this.receiptCache.clear();
		})();
		return this.closing;
	}

	private check(signal: AbortSignal): void {
		if (this.closed || signal.aborted) throw new Error("cancelled");
	}

	private async nativeRoot(): Promise<string> {
		const input = resolve(this.rootInput);
		const [canonical, inputStat] = await Promise.all([realpath(input), lstat(input, { bigint: true })]);
		if (inputStat.isSymbolicLink()) throw new Error("invalid root");
		const rootStat = await lstat(canonical, { bigint: true });
		if (!privateDirectory(rootStat)) throw new Error("invalid root");
		return canonical;
	}

	private async run(request: z.infer<typeof RequestSchema>, signal: AbortSignal): Promise<RendererResponse> {
		if (this.key.length !== 32) return { ok: false, error: ERROR_CREATE };
		this.check(signal);
		if (request.type === "reveal-created-local-backup") return this.reveal(request.backupId, signal);
		try {
			if (this.callbacks.isBusy?.()) return { ok: false, error: ERROR_BUSY };
		} catch { return { ok: false, error: ERROR_BUSY }; }
		const root = await this.nativeRoot();
		this.check(signal);
		let destination: string | null;
		try { destination = await this.callbacks.selectDestination(signal); }
		catch {
			if (signal.aborted || this.closed) return CANCELLED;
			return { ok: false, error: ERROR_CREATE };
		}
		if (destination === null) return CANCELLED;
		if (!validAbsolutePath(destination)) return { ok: false, error: ERROR_CREATE };
		if (signal.aborted || this.closed) return CANCELLED;

		let created: VerifiedNativeCoreBackup | undefined;
		let stopped: CoreGateResult<VerifiedNativeCoreBackup> | undefined;
		try {
			stopped = await this.callbacks.withStoppedCore(async () => {
				this.check(signal);
				created = await createVerifiedNativeCoreBackup({
					sourceRoot: root,
					destinationParent: destination!,
					forbiddenDestinationRoots: this.callbacks.forbiddenDestinationRoots,
					entries: ["database", ...OPTIONAL_ENTRIES],
					selectedChildren: { secure: ["credentials"] },
					appVersion: this.callbacks.appVersion,
					signal,
					publishDirectory: this.callbacks.publishDirectory,
				});
				return created;
			}, { signal, ...(this.callbacks.shouldRestoreCore ? { shouldRestoreCore: this.callbacks.shouldRestoreCore } : {}) });
		} catch (error) {
			if (isCommittedSyncUncertain(error)) return { ok: false, error: ERROR_COMMITTED_UNCERTAIN };
			if (!created) {
				if (signal.aborted || this.closed) return CANCELLED;
				return { ok: false, error: ERROR_CREATE };
			}
		}

		if (!created && stopped?.completed) created = stopped.value;
		if (!created && stopped && !stopped.completed && isCommittedSyncUncertain(stopped.error)) return { ok: false, error: ERROR_COMMITTED_UNCERTAIN };
		if (!created) {
			if (stopped?.coreStatus === "restart-required") return { ok: false, error: ERROR_RESTART };
			if (stopped && !stopped.completed && signal.aborted) return CANCELLED;
			return { ok: false, error: ERROR_CREATE };
		}
		const coreStatus = stopped?.completed ? stopped.coreStatus : "restart-required";
		return this.completed(created, coreStatus);
	}

	private async completed(backup: VerifiedNativeCoreBackup, coreStatus: CoreStatus): Promise<RendererResponse> {
		const backupId = randomUUID();
		let receipt: BackupReceipt;
		try { receipt = await this.captureReceipt(backupId, backup); }
		catch {
			// The files are already committed; report completion without claiming they were rolled back.
			return { ok: false, error: "Backup files were created and preserved, but the private reveal receipt could not be verified." };
		}
		this.receiptCache.set(backupId, receipt);
		try { await this.persistReceipt(receipt); } catch { /* In-memory receipt remains usable for this process. */ }
		const result = NativeLocalBackupResultSchema.parse({
			backupId,
			createdAt: backup.createdAt,
			files: backup.files,
			bytes: backup.bytes,
			verified: true,
			scope: "native-core-data",
			coreStatus,
		});
		return { ok: true, localBackupCreated: result };
	}

	private async captureReceipt(backupId: string, backup: VerifiedNativeCoreBackup): Promise<BackupReceipt> {
		const directoryPath = resolve(backup.path);
		const parentPath = dirname(directoryPath);
		if (basename(directoryPath).length === 0 || await realpath(directoryPath) !== directoryPath || await realpath(parentPath) !== parentPath) throw new Error("noncanonical backup");
		let directory: FileHandle | undefined;
		let parent: FileHandle | undefined;
		try {
			directory = await open(directoryPath, DIR_FLAGS);
			parent = await open(parentPath, DIR_FLAGS);
			const [directoryNamed, parentNamed] = await Promise.all([
				lstat(directoryPath, { bigint: true }), lstat(parentPath, { bigint: true }),
			]);
			const [directoryHeld, parentHeld] = await Promise.all([directory.stat({ bigint: true }), parent.stat({ bigint: true })]);
			if (!privateDirectory(directoryHeld) || !ownedDirectory(parentHeld) || !sameIdentity(directoryHeld, directoryNamed) || !sameIdentity(parentHeld, parentNamed)) throw new Error("unsafe published backup");
			return {
				format: RECEIPT_FORMAT,
				version: 1,
				backupId,
				createdAt: backup.createdAt,
				files: backup.files,
				bytes: backup.bytes,
				verified: true,
				scope: "native-core-data",
				directoryPath,
				directoryDev: directoryHeld.dev.toString(),
				directoryIno: directoryHeld.ino.toString(),
				directoryMode: directoryHeld.mode.toString(),
				directoryUid: directoryHeld.uid.toString(),
				parentPath,
				parentDev: parentHeld.dev.toString(),
				parentIno: parentHeld.ino.toString(),
				parentMode: parentHeld.mode.toString(),
				parentUid: parentHeld.uid.toString(),
			};
		} finally { try { await directory?.close(); } finally { await parent?.close(); } }
	}

	private async receiptDirectory(): Promise<string> {
		const root = await this.nativeRoot();
		const path = join(root, RECEIPT_DIRECTORY);
		try { await mkdir(path, { mode: 0o700 }); }
		catch (error) { if (errnoCode(error) !== "EEXIST") throw error; }
		const [stat, named] = await Promise.all([lstat(path, { bigint: true }), realpath(path)]);
		if (!privateDirectory(stat) || named !== path) throw new Error("unsafe receipts directory");
		const handle = await open(path, DIR_FLAGS);
		try {
			const held = await handle.stat({ bigint: true });
			if (!privateDirectory(held) || !sameIdentity(held, stat)) throw new Error("receipts directory changed");
		} finally { await handle.close(); }
		return path;
	}

	private async persistReceipt(receipt: BackupReceipt): Promise<void> {
		const directory = await this.receiptDirectory();
		const payload = encryptText(JSON.stringify(receipt), this.key);
		const encoded = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
		if (encoded.length > MAX_RECEIPT_BYTES) throw new Error("receipt limit");
		const path = join(directory, `${receipt.backupId}.json`);
		await writeNativePrivateFile(path, directory, encoded, () => {}, () => false);
	}

	private async loadReceipt(backupId: string): Promise<BackupReceipt | undefined> {
		const cached = this.receiptCache.get(backupId);
		if (cached) return cached;
		const directory = await this.receiptDirectory();
		const parent = await open(directory, DIR_FLAGS);
		let file: FileHandle | undefined;
		const path = join(directory, `${backupId}.json`);
		try {
			const parentHeld = await parent.stat({ bigint: true });
			const parentNamed = await lstat(directory, { bigint: true });
			if (!privateDirectory(parentHeld) || !sameIdentity(parentHeld, parentNamed)) throw new Error("receipt parent changed");
			file = await open(path, FILE_FLAGS);
			const initial = await file.stat({ bigint: true });
			if (!regularPrivateFile(initial) || initial.size <= 0n || initial.size > BigInt(MAX_RECEIPT_BYTES)) throw new Error("invalid receipt file");
			const named = await lstat(path, { bigint: true });
			if (!sameStableFile(initial, named)) throw new Error("receipt replaced");
			const bytes = Buffer.alloc(Number(initial.size));
			let offset = 0;
			while (offset < bytes.length) {
				const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
				if (!bytesRead) throw new Error("receipt shortened");
				offset += bytesRead;
			}
			const [final, finalName] = await Promise.all([file.stat({ bigint: true }), lstat(path, { bigint: true })]);
			if (!sameStableFile(initial, final) || !sameStableFile(final, finalName)) throw new Error("receipt changed");
			const envelope: unknown = JSON.parse(bytes.toString("utf8"));
			if (!validEncryptedPayload(envelope)) throw new Error("invalid receipt envelope");
			const decoded: unknown = JSON.parse(decryptText(envelope, this.key));
			const receipt = this.validateReceipt(decoded, backupId);
			this.receiptCache.set(backupId, receipt);
			return receipt;
		} catch {
			return undefined;
		} finally { try { await file?.close(); } finally { await parent.close(); } }
	}

	private validateReceipt(value: unknown, backupId: string): BackupReceipt {
		if (!value || typeof value !== "object") throw new Error("invalid receipt");
		const record = value as Record<string, unknown>;
		const stringFields = ["directoryPath", "directoryDev", "directoryIno", "directoryMode", "directoryUid", "parentPath", "parentDev", "parentIno", "parentMode", "parentUid"] as const;
		if (record.format !== RECEIPT_FORMAT || record.version !== 1 || record.backupId !== backupId || record.verified !== true || record.scope !== "native-core-data" ||
			typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt)) || !Number.isSafeInteger(record.files) || (record.files as number) < 1 ||
			!Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0 || stringFields.some(field => typeof record[field] !== "string")) throw new Error("invalid receipt");
		if (!validAbsolutePath(record.directoryPath) || !validAbsolutePath(record.parentPath) || dirname(record.directoryPath) !== record.parentPath) throw new Error("invalid receipt paths");
		for (const field of ["directoryDev", "directoryIno", "directoryMode", "directoryUid", "parentDev", "parentIno", "parentMode", "parentUid"] as const) {
			if (!/^\d+$/.test(record[field] as string)) throw new Error("invalid receipt identity");
		}
		return record as unknown as BackupReceipt;
	}

	private async reveal(backupId: string, signal: AbortSignal): Promise<RendererResponse> {
		this.check(signal);
		let receipt: BackupReceipt | undefined;
		try { receipt = await this.loadReceipt(backupId); } catch { receipt = undefined; }
		if (!receipt || !(await this.verifyReceiptLocation(receipt))) return { ok: false, error: ERROR_RECEIPT };
		this.check(signal);
		try { await this.callbacks.revealDirectory(receipt.directoryPath, signal); }
		catch {
			if (signal.aborted || this.closed) return CANCELLED;
			return { ok: false, error: ERROR_RECEIPT };
		}
		return { ok: true };
	}

	private async verifyReceiptLocation(receipt: BackupReceipt): Promise<boolean> {
		let parent: FileHandle | undefined;
		let directory: FileHandle | undefined;
		try {
			if (await realpath(receipt.parentPath) !== receipt.parentPath || await realpath(receipt.directoryPath) !== receipt.directoryPath) return false;
			const [parentNamed, directoryNamed] = await Promise.all([
				lstat(receipt.parentPath, { bigint: true }), lstat(receipt.directoryPath, { bigint: true }),
			]);
			if (!ownedDirectory(parentNamed) || !privateDirectory(directoryNamed) || dirname(receipt.directoryPath) !== receipt.parentPath) return false;
			parent = await open(receipt.parentPath, DIR_FLAGS);
			directory = await open(receipt.directoryPath, DIR_FLAGS);
			const [parentHeld, directoryHeld] = await Promise.all([parent.stat({ bigint: true }), directory.stat({ bigint: true })]);
			return ownedDirectory(parentHeld) && privateDirectory(directoryHeld) &&
				sameIdentity(parentHeld, parentNamed) && sameIdentity(directoryHeld, directoryNamed) &&
				parentHeld.dev.toString() === receipt.parentDev && parentHeld.ino.toString() === receipt.parentIno &&
				parentHeld.mode.toString() === receipt.parentMode && parentHeld.uid.toString() === receipt.parentUid &&
				directoryHeld.dev.toString() === receipt.directoryDev && directoryHeld.ino.toString() === receipt.directoryIno &&
				directoryHeld.mode.toString() === receipt.directoryMode && directoryHeld.uid.toString() === receipt.directoryUid;
		} catch { return false; }
		finally { try { await directory?.close(); } finally { await parent?.close(); } }
	}
}
