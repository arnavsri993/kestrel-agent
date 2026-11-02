import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { TextDecoder } from "node:util";
import { MemoryRecoveryPreviewSchema, type CoreRequest, type RendererResponse } from "@kestrel/shared-types";
import { z } from "zod";
export { NATIVE_MEMORY_RECOVERY_REQUEST_TYPES, isNativeMemoryRecoveryInternalRequest } from "./native-memory-recovery-requests";

const RequestSchema = z.object({
	type: z.enum(["memory-recovery-save-file", "memory-recovery-open-file"]),
	sessionId: z.string().min(1).max(4096),
}).strict();
const MAX_BYTES = 16_000_000;
const CANCELLED = { ok: true, cancelled: true } as const;
interface Options {
	coreRequest: (request: CoreRequest) => Promise<RendererResponse>;
	/** The native panel owns its .kestrel-memory filter and default extension. */
	selectFile: (operation: "save" | "open", signal: AbortSignal) => Promise<string | null>;
}
class RecoveryFailure extends Error {}
class Closed extends Error {}
const sameIdentity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const sameContents = (a: BigIntStats, b: BigIntStats) => sameIdentity(a, b) &&
	a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;
function regular(stat: BigIntStats): boolean {
	return stat.isFile() && stat.nlink === 1n && (typeof process.getuid !== "function" || stat.uid === BigInt(process.getuid()));
}
function validPath(path: unknown): path is string {
	return typeof path === "string" && isAbsolute(path) && Buffer.byteLength(path, "utf8") <= 4096 &&
		!/[\u0000-\u001f\u007f-\u009f]/u.test(path) && basename(path) !== "." && basename(path) !== "..";
}

/** File paths and encrypted backup data stay in the host; only preview metadata crosses back. */
export class NativeMemoryRecoveryHost {
	private closed = false;
	private active: Promise<RendererResponse> | undefined;
	private readonly abort = new AbortController();
	private operationSignal: AbortSignal = this.abort.signal;
	constructor(private readonly options: Options) {}

	handle(raw: unknown, externalSignal?: AbortSignal): Promise<RendererResponse> {
		const parsed = RequestSchema.safeParse(raw);
		if (!parsed.success) return Promise.resolve({ ok: false, error: "Invalid knowledge recovery request." });
		if (this.closed) return Promise.resolve({ ok: false, error: "Knowledge recovery is closed." });
		if (this.active) return Promise.resolve({ ok: false, error: "Another knowledge recovery operation is already in progress." });
		this.operationSignal = externalSignal ? AbortSignal.any([this.abort.signal, externalSignal]) : this.abort.signal;
		// Reserve admission synchronously, before calling either callback.
		const operation = Promise.resolve().then(() => this.run(parsed.data)).catch((error: unknown): RendererResponse => {
			if (error instanceof Closed) return CANCELLED;
			return { ok: false, error: error instanceof RecoveryFailure ? error.message : "Knowledge recovery failed. Choose the backup again." };
		});
		this.active = operation;
		void operation.then(() => { if (this.active === operation) this.active = undefined; });
		return operation;
	}

	async close(): Promise<void> {
		this.closed = true;
		this.abort.abort();
		// External callbacks can finish late, but every owned filesystem operation settles here.
		await this.active;
	}

	private check(): void { if (this.closed || this.operationSignal.aborted) throw new Closed(); }
	private async external<T>(callback: () => Promise<T>): Promise<T> {
		this.check();
		const signal = this.operationSignal;
		let onAbort!: () => void;
		const interrupted = new Promise<never>((_, reject) => { onAbort = () => reject(new Closed()); signal.addEventListener("abort", onAbort, { once: true }); });
		try {
			const result = await Promise.race([callback(), interrupted]);
			this.check();
			return result;
		} finally { signal.removeEventListener("abort", onAbort); }
	}

	private async run(request: z.infer<typeof RequestSchema>): Promise<RendererResponse> {
		this.check();
		let data: Buffer | undefined;
		if (request.type === "memory-recovery-save-file") {
			const response = await this.external(() => this.options.coreRequest({ type: "memory-recovery-export", sessionId: request.sessionId }));
			if (!response || response.ok !== true || !("memoryRecoveryData" in response) || typeof response.memoryRecoveryData !== "string" ||
				!response.memoryRecoveryData.length || Buffer.byteLength(response.memoryRecoveryData, "utf8") > MAX_BYTES) {
				throw new RecoveryFailure("A valid encrypted knowledge backup is unavailable.");
			}
			data = Buffer.from(response.memoryRecoveryData, "utf8");
		}
		const selected = await this.external(() => this.options.selectFile(data ? "save" : "open", this.operationSignal));
		if (selected === null) return CANCELLED;
		if (!validPath(selected)) throw new RecoveryFailure("The selected backup location is invalid.");
		// Resolve directory aliases (including macOS /var -> /private/var) while refusing a final symlink.
		const parent = await realpath(dirname(selected));
		this.check();
		const path = join(parent, basename(selected));
		if (!validPath(path)) throw new RecoveryFailure("The selected backup location is invalid.");
		if (data) {
			await this.save(path, parent, data);
			return { ok: true };
		}
		const encoded = await this.read(path, parent);
		this.check();
		const response = await this.external(() => this.options.coreRequest({ type: "memory-recovery-preview", sessionId: request.sessionId, encoded }));
		if (!response || response.ok !== true || !("memoryRecoveryPreview" in response)) throw new RecoveryFailure("The encrypted backup could not be previewed.");
		const preview = MemoryRecoveryPreviewSchema.safeParse(response.memoryRecoveryPreview);
		if (!preview.success) throw new RecoveryFailure("The encrypted backup returned an invalid recovery preview.");
		// Parsing strips unexpected nested properties, and nothing else from the core is forwarded.
		return { ok: true, memoryRecoveryPreview: preview.data };
	}

	private async parentHandle(parent: string): Promise<FileHandle> {
		this.check();
		return open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	}
	private async checkParent(parent: string, directory: FileHandle): Promise<void> {
		this.check();
		const [held, current] = await Promise.all([directory.stat({ bigint: true }), lstat(parent, { bigint: true })]);
		this.check();
		if (!held.isDirectory() || !current.isDirectory() || !sameIdentity(held, current)) throw new RecoveryFailure("The backup folder changed. Choose it again.");
	}
	private async save(path: string, parent: string, data: Buffer): Promise<void> {
		const directory = await this.parentHandle(parent);
		let file: FileHandle | undefined;
		let created = false;
		try {
			await this.checkParent(parent, directory);
			this.check();
			file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
			created = true;
			this.check();
			await this.checkParent(parent, directory);
			const initial = await file.stat({ bigint: true });
			this.check();
			const named = await lstat(path, { bigint: true });
			this.check();
			if (!regular(initial) || initial.size !== 0n || (initial.mode & 0o077n) !== 0n || !sameIdentity(initial, named)) throw new RecoveryFailure("The new backup file changed before it could be written.");
			let offset = 0;
			while (offset < data.length) {
				this.check();
				const { bytesWritten } = await file.write(data, offset, data.length - offset, offset);
				this.check();
				if (!bytesWritten) throw new RecoveryFailure("The backup could not be completely written.");
				offset += bytesWritten;
			}
			this.check();
			await file.sync();
			this.check();
			const [final, finalName] = await Promise.all([file.stat({ bigint: true }), lstat(path, { bigint: true })]);
			this.check();
			if (!regular(final) || (final.mode & 0o077n) !== 0n || !sameIdentity(initial, final) || !sameIdentity(final, finalName) || final.size !== BigInt(data.length)) throw new RecoveryFailure("The backup file changed while saving.");
			await this.checkParent(parent, directory);
			await directory.sync();
			this.check();
		} catch (error) {
			if (created) throw new RecoveryFailure("Saving did not finish safely. The new backup file has been preserved and may be incomplete. Choose a different filename to retry.");
			if (error instanceof Closed) throw error;
			throw new RecoveryFailure("The backup could not be created. Choose a new filename in an existing writable folder; existing files are never overwritten.");
		} finally {
			try {
				try { await file?.close(); } finally { await directory.close(); }
			} catch {
				throw new RecoveryFailure(created
					? "Saving did not finish safely. The new backup file has been preserved and may be incomplete. Choose a different filename to retry."
					: "The backup location could not be closed safely. Choose it again.");
			}
		}
	}

	private async read(path: string, parent: string): Promise<string> {
		const directory = await this.parentHandle(parent);
		let file: FileHandle | undefined;
		try {
			await this.checkParent(parent, directory);
			this.check();
			// NONBLOCK prevents a substituted FIFO/device from blocking before the type check.
			file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			this.check();
			const initial = await file.stat({ bigint: true });
			this.check();
			if (!regular(initial) || initial.size <= 0n || initial.size > BigInt(MAX_BYTES)) throw new RecoveryFailure("Select a regular knowledge backup owned by you, between 1 byte and 16 MB, without links.");
			const named = await lstat(path, { bigint: true });
			this.check();
			if (!sameContents(initial, named)) throw new RecoveryFailure("The backup changed while being opened. Choose it again.");
			await this.checkParent(parent, directory);
			const bytes = Buffer.alloc(Number(initial.size) + 1);
			let offset = 0;
			while (offset < bytes.length) {
				this.check();
				const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
				this.check();
				if (!bytesRead) break;
				offset += bytesRead;
			}
			const [final, finalName] = await Promise.all([file.stat({ bigint: true }), lstat(path, { bigint: true })]);
			this.check();
			if (offset !== Number(initial.size) || !regular(final) || !sameContents(initial, final) || !sameContents(final, finalName)) throw new RecoveryFailure("The backup changed while being read. Choose it again.");
			await this.checkParent(parent, directory);
			try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, offset)); }
			catch { throw new RecoveryFailure("The backup is not valid UTF-8 data."); }
		} finally {
			try { await file?.close(); } finally { await directory.close(); }
		}
	}
}
