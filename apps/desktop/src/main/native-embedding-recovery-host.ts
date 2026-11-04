import { randomBytes, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { KestrelDatabase, type LegacyEmbeddingLeaseRecoverySnapshot } from "@kestrel/database";
import { NativeEmbeddingRecoveryRequestSchema, type RendererResponse } from "@kestrel/shared-types";
export { NATIVE_EMBEDDING_RECOVERY_REQUEST_TYPES } from "./native-embedding-recovery-requests";

type CoreStatus = "ready" | "restart-required";
type GateResult<T> = { completed: true; value: T; coreStatus: CoreStatus } | { completed: false; error: unknown; coreStatus: CoreStatus };
type RecoveryDatabase = Pick<KestrelDatabase, "reviewLegacyEmbeddingLeaseRecovery" | "cancelLegacyEmbeddingLeaseRecovery" | "close">;
type Identity = { root: BigIntStats; directory: BigIntStats; file: BigIntStats };
type Plan = { id: string; snapshot: LegacyEmbeddingLeaseRecoverySnapshot; bindingKey: Buffer; issuedAt: number; expiresAt: number; identity: Identity };
export interface NativeEmbeddingRecoveryHostOptions {
	root: string;
	encryptionKeyBase64: string;
	withStoppedCore<T>(operation: () => Promise<T>, options: { signal: AbortSignal; shouldRestoreCore?: () => boolean }): Promise<GateResult<T>>;
	shouldRestoreCore?: () => boolean;
	isBusy?: () => boolean;
	now?: () => Date;
	openDatabase?: (path: string, key: Buffer, options: { readonly: boolean }) => RecoveryDatabase;
}
const TTL = 120_000;
const INVALID = "Invalid memory repair request.";
const UNAVAILABLE = "Memory repair is unavailable.";
const BUSY = "Finish or cancel active work before reviewing memory processing.";
const STALE = "The repair review expired or changed. Review memory processing again.";
const FAILED = "Memory processing could not be reviewed safely. No repair was applied.";
const RESTART = "Restart Kestrel before reviewing memory processing again.";
const APPLY_FAILED = "The repair was not applied. Review memory processing again.";
const sameIdentity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const owned = (value: BigIntStats) => typeof process.getuid !== "function" || value.uid === BigInt(process.getuid());
const privateDirectory = (value: BigIntStats) => value.isDirectory() && owned(value) && (value.mode & 0o077n) === 0n;
// SQLite creates 0644 files under the app's existing umask. Both containing
// directories remain private; refuse writable exposure without chmod on review.
const privateFile = (value: BigIntStats) => value.isFile() && owned(value) && value.nlink === 1n && (value.mode & 0o022n) === 0n;
function keyFromBase64(value: string): Buffer {
	const key = Buffer.from(value, "base64");
	if (key.length === 32 && key.toString("base64") === value) return key;
	key.fill(0); return Buffer.alloc(0);
}

/** One-use reviews stay in this host. Callers cannot choose a database or job. */
export class NativeEmbeddingRecoveryHost {
	private readonly rootInput: string;
	private readonly key: Buffer;
	private readonly callbacks: Omit<NativeEmbeddingRecoveryHostOptions, "root" | "encryptionKeyBase64">;
	private readonly abort = new AbortController();
	private active: Promise<RendererResponse> | undefined;
	private plan: Plan | undefined;
	private expiry: ReturnType<typeof setTimeout> | undefined;
	private closed = false;
	private closing: Promise<void> | undefined;
	constructor(options: NativeEmbeddingRecoveryHostOptions) {
		this.rootInput = options.root;
		this.key = keyFromBase64(options.encryptionKeyBase64);
		const { root: _root, encryptionKeyBase64: _encoded, ...callbacks } = options;
		this.callbacks = callbacks;
	}
	private clock(): number {
		const value = (this.callbacks.now?.() ?? new Date()).getTime();
		if (!Number.isSafeInteger(value)) throw new Error("clock");
		return value;
	}
	private clearPlan(): void {
		if (this.expiry) clearTimeout(this.expiry); this.expiry = undefined;
		this.plan?.bindingKey.fill(0); this.plan = undefined;
	}
	private check(signal: AbortSignal): void { if (this.closed || signal.aborted) throw new Error("closed"); }
	handle(raw: unknown, externalSignal?: AbortSignal): Promise<RendererResponse> {
		const parsed = NativeEmbeddingRecoveryRequestSchema.safeParse(raw);
		if (!parsed.success) return Promise.resolve({ ok: false, error: INVALID });
		const request = parsed.data;
		if (this.closed || this.key.length !== 32) return Promise.resolve({ ok: false, error: UNAVAILABLE });
		if (request.type === "native-embedding-recovery-discard") {
			if (this.plan?.id === request.planId) this.clearPlan();
			return Promise.resolve({ ok: true });
		}
		if (this.active || this.callbacks.isBusy?.()) return Promise.resolve({ ok: false, error: BUSY });
		const signal = externalSignal ? AbortSignal.any([this.abort.signal, externalSignal]) : this.abort.signal;
		// Reserve synchronously; a second operation cannot slip in before stop.
		const operation = Promise.resolve().then(() => this.run(request, signal)).catch((): RendererResponse => ({ ok: false, error: UNAVAILABLE }));
		this.active = operation;
		void operation.then(() => { if (this.active === operation) this.active = undefined; });
		return operation;
	}
	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true; this.abort.abort(); this.clearPlan();
		this.closing = (async () => { await this.active; this.key.fill(0); })();
		return this.closing;
	}
	private gateOptions(signal: AbortSignal) {
		return { signal, ...(this.callbacks.shouldRestoreCore ? { shouldRestoreCore: this.callbacks.shouldRestoreCore } : {}) };
	}
	private async withDatabase<T>(readonly: boolean, signal: AbortSignal, callback: (database: RecoveryDatabase, identity: Identity) => T, expected?: Identity): Promise<T> {
		this.check(signal);
		if (!isAbsolute(this.rootInput) || resolve(this.rootInput) !== this.rootInput || Buffer.byteLength(this.rootInput) > 4096 || /[\u0000-\u001f\u007f]/.test(this.rootInput)) throw new Error("path");
		const root = await realpath(this.rootInput); this.check(signal);
		if (root !== this.rootInput) throw new Error("canonical");
		const directory = join(root, "database"), path = join(directory, "kestrel.sqlite");
		const handles: FileHandle[] = [];
		let database: RecoveryDatabase | undefined;
		try {
			const rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(rootHandle);
			const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(directoryHandle);
			const fileHandle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); handles.push(fileHandle);
			const identity = { root: await rootHandle.stat({ bigint: true }), directory: await directoryHandle.stat({ bigint: true }), file: await fileHandle.stat({ bigint: true }) };
			const revalidate = async () => {
				this.check(signal);
				const named = { root: await lstat(root, { bigint: true }), directory: await lstat(directory, { bigint: true }), file: await lstat(path, { bigint: true }) };
				this.check(signal);
				if (!privateDirectory(identity.root) || !privateDirectory(identity.directory) || !privateFile(identity.file) ||
					!privateDirectory(named.root) || !privateDirectory(named.directory) || !privateFile(named.file) ||
					!sameIdentity(identity.root, named.root) || !sameIdentity(identity.directory, named.directory) || !sameIdentity(identity.file, named.file) ||
					(expected && (!sameIdentity(expected.root, named.root) || !sameIdentity(expected.directory, named.directory) || !sameIdentity(expected.file, named.file)))) throw new Error("identity");
			};
			await revalidate();
			database = this.callbacks.openDatabase ? this.callbacks.openDatabase(path, this.key, { readonly }) : KestrelDatabase.openForHostLegacyEmbeddingRecovery(path, this.key, { readonly });
			await revalidate();
			// No awaits between the final check and the synchronous transaction.
			this.check(signal);
			return callback(database, identity);
		} finally {
			try { database?.close(); }
			finally { for (const handle of handles.reverse()) await handle.close().catch(() => {}); }
		}
	}
	private async run(request: { type: "native-embedding-recovery-review" } | { type: "native-embedding-recovery-apply"; planId: string }, signal: AbortSignal): Promise<RendererResponse> {
		this.check(signal);
		if (request.type === "native-embedding-recovery-review") {
			this.clearPlan();
			const bindingKey = randomBytes(32);
			let retained = false;
			try {
				const result = await this.callbacks.withStoppedCore(() => this.withDatabase(true, signal, (database, identity) => ({ snapshot: database.reviewLegacyEmbeddingLeaseRecovery(bindingKey), identity })), this.gateOptions(signal));
				if (result.coreStatus !== "ready") return { ok: false, error: RESTART };
				this.check(signal);
				if (!result.completed) return { ok: false, error: FAILED };
				if (!result.value.snapshot) return { ok: true, nativeEmbeddingRecoveryPreview: { state: "not-needed", coreStatus: "ready" } };
				const issuedAt = this.clock();
				const plan: Plan = { id: randomUUID(), snapshot: result.value.snapshot, bindingKey, issuedAt, expiresAt: issuedAt + TTL, identity: result.value.identity };
				this.plan = plan; retained = true;
				this.expiry = setTimeout(() => { if (this.plan === plan) this.clearPlan(); }, TTL); this.expiry.unref?.();
				return { ok: true, nativeEmbeddingRecoveryPreview: { state: "review", planId: plan.id, expiresAt: new Date(plan.expiresAt).toISOString(), cancelledJobs: 1, coreStatus: "ready" } };
			} finally { if (!retained) bindingKey.fill(0); }
		}
		const plan = this.plan;
		if (!plan || plan.id !== request.planId) return { ok: false, error: STALE };
		this.plan = undefined; if (this.expiry) clearTimeout(this.expiry); this.expiry = undefined;
		let committed = false;
		try {
			const validTime = () => { const now = this.clock(); if (now < plan.issuedAt || now >= plan.expiresAt) throw new Error("expired"); return new Date(now).toISOString(); };
			validTime();
			const result = await this.callbacks.withStoppedCore(() => this.withDatabase(false, signal, database => {
				const now = validTime();
				const applied = database.cancelLegacyEmbeddingLeaseRecovery(plan.snapshot, plan.bindingKey, now);
				if (applied.cancelled !== true) throw new Error("not committed");
				committed = true;
				return true;
			}, plan.identity), this.gateOptions(signal));
			// A late cancellation/teardown cannot undo a transaction already committed.
			if (committed) return { ok: true, nativeEmbeddingRecoveryApplied: { cancelledJobs: 1, coreStatus: result.coreStatus } };
			return { ok: false, error: result.coreStatus === "restart-required" ? RESTART : APPLY_FAILED };
		} catch {
			return committed ? { ok: true, nativeEmbeddingRecoveryApplied: { cancelledJobs: 1, coreStatus: "restart-required" } } : { ok: false, error: APPLY_FAILED };
		} finally { plan.bindingKey.fill(0); }
	}
}
