import { lstat, mkdtemp, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { setMaxListeners } from "node:events";
import { basename, isAbsolute, join, sep } from "node:path";
import {
	CoreRequestSchema,
	RendererRequestSchema,
	type RendererResponse,
	type SelectedAttachment,
} from "@kestrel/shared-types";
import { mediaTypeForPath } from "./file-tabs";
import { PastedTextAttachmentStore } from "./pasted-text-attachment-store";
import { listWorkspaceFiles } from "./workspace-file-search";

export const NATIVE_CONTEXT_ATTACHMENT_REQUEST_TYPES = new Set([
	"list-workspace-files", "create-pasted-text-attachment", "remove-pasted-text-attachment", "select-context-files",
]);

interface Options {
	/** This native Core profile only; never an Electron or provider profile. */
	root: string;
	/** Fresh, currently available grants from the native workspace host. */
	workspaceRoots(): Promise<string[]>;
	/** Host-owned Cocoa picker only. Null means user cancellation. Never take
	 * selected paths or this callback from a renderer-controlled source. */
	selectFiles?(workspaceRoot: string, signal: AbortSignal): Promise<string[] | null>;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
const stopped = "The native attachment host is shutting down.";
const unowned = "Kestrel only sends external files created by this native attachment host.";

function cleanPath(path: string): void {
	if (!isAbsolute(path) || path.length > 4096 || /[\u0000-\u001f\u007f]/.test(path))
		throw new Error("Choose a regular local file in a granted task workspace.");
}

function contained(root: string, path: string): boolean {
	return path !== root && path.startsWith(`${root}${sep}`);
}

/** Browser-free attachment ownership and current-grant enforcement. */
export class NativeContextAttachmentHost {
	private closed = false;
	private readonly cancellation = new AbortController();
	private readonly operations = new Set<Promise<unknown>>();
	private preparation?: Promise<PastedTextAttachmentStore>;
	private store?: PastedTextAttachmentStore;
	private pasteDirectory?: string;
	private pasteDirectoryIdentity?: { dev: number; ino: number };
	private closing?: Promise<void>;
	private readonly pastes = new Map<string, { dev: number; ino: number; size: number }>();
	private pickerPending = false;
	private readonly pickedFiles = new Map<string, { dev: number; ino: number; size: number; mtimeMs: number; mediaType: string; workspaceRoot: string }>();

	constructor(private readonly options: Options) {
		cleanPath(options.root);
		setMaxListeners(64, this.cancellation.signal);
	}

	private checkOpen(): void { if (this.closed) throw new Error(stopped); }

	private async profileRoot(): Promise<string> {
		this.checkOpen();
		const info = await lstat(this.options.root);
		if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
			throw new Error("Native attachments require a private profile directory owned by the current user.");
		const root = await realpath(this.options.root);
		this.checkOpen();
		return root;
	}

	private async pasteStore(): Promise<PastedTextAttachmentStore> {
		if (!this.preparation) this.preparation = (async () => {
			const root = await this.profileRoot();
			this.checkOpen();
			// A fresh private directory cannot adopt another launch's attachments.
			const directory = await mkdtemp(join(root, "composer-attachments-"));
			this.pasteDirectory = directory;
			const info = await lstat(directory);
			this.pasteDirectoryIdentity = { dev: info.dev, ino: info.ino };
			this.store = new PastedTextAttachmentStore(directory);
			this.checkOpen();
			return this.store;
		})();
		return this.preparation;
	}

	private async validatePasteDirectory(): Promise<void> {
		this.checkOpen();
		if (!this.pasteDirectory || !this.pasteDirectoryIdentity) throw new Error(unowned);
		const info = await lstat(this.pasteDirectory);
		if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
			info.uid !== process.getuid?.() || info.dev !== this.pasteDirectoryIdentity.dev || info.ino !== this.pasteDirectoryIdentity.ino)
			throw new Error("The private attachment directory changed. Restart Kestrel before adding files.");
		this.checkOpen();
	}

	private track<T>(operation: () => Promise<T>): Promise<T> {
		if (this.closed) return Promise.reject(new Error(stopped));
		if (this.operations.size >= 64) return Promise.reject(new Error("The native attachment host has too many pending requests."));
		const pending = Promise.resolve().then(() => { this.checkOpen(); return operation(); });
		this.operations.add(pending);
		void pending.finally(() => this.operations.delete(pending)).catch(() => undefined);
		return pending;
	}

	private async cancellable<T>(operation: () => Promise<T>): Promise<T> {
		this.checkOpen();
		const { signal } = this.cancellation;
		let abort!: () => void;
		const cancelled = new Promise<never>((_resolve, reject) => {
			abort = () => reject(new Error(stopped));
			signal.addEventListener("abort", abort, { once: true });
		});
		try {
			const result = await Promise.race([Promise.resolve().then(() => {
				this.checkOpen(); return operation();
			}), cancelled]);
			this.checkOpen();
			return result;
		} finally { signal.removeEventListener("abort", abort); }
	}

	private async grants(): Promise<string[]> {
		const paths = await this.cancellable(() => this.options.workspaceRoots());
		const roots = await Promise.all(paths.map(async path => {
			try {
				cleanPath(path);
				const canonical = await realpath(path);
				return (await lstat(canonical)).isDirectory() ? canonical : undefined;
			} catch { return undefined; }
		}));
		this.checkOpen();
		return [...new Set(roots.filter((path): path is string => path !== undefined))];
	}

	private async workspaceRoot(path: string): Promise<string> {
		cleanPath(path);
		const root = await realpath(path);
		if (!(await this.grants()).includes(root))
			throw new Error("Choose a currently granted task workspace before adding files.");
		return root;
	}

	private async file(path: string): Promise<{ canonical: string; metadata: Stats }> {
		cleanPath(path);
		const canonical = await realpath(path);
		const metadata = await lstat(canonical);
		this.checkOpen();
		if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES)
			throw new Error("Attachments must be regular files no larger than 10 MB.");
		return { canonical, metadata };
	}

	private async ownsPaste(attachment: SelectedAttachment): Promise<boolean> {
		const owned = this.pastes.get(attachment.path);
		if (owned) await this.validatePasteDirectory();
		if (!owned || !this.store || !await this.store.owns(attachment.path)) return false;
		const info = await lstat(attachment.path);
		return info.dev === owned.dev && info.ino === owned.ino && info.size === owned.size &&
			info.size === attachment.size && info.nlink === 1 && info.uid === process.getuid?.() &&
			(info.mode & 0o077) === 0 && attachment.mediaType === "text/plain";
	}

	private async selectFiles(workspace: string): Promise<RendererResponse> {
		if (!this.options.selectFiles) throw new Error("The native context file picker is unavailable.");
		if (this.pickerPending) throw new Error("A native context file picker is already open.");
		this.pickerPending = true;
		try {
			const workspaceRoot = await this.workspaceRoot(workspace);
			const selected = await this.cancellable(() => this.options.selectFiles!(workspaceRoot, this.cancellation.signal));
			if (selected === null) return { ok: true, cancelled: true, selectedAttachments: [] };
			if (!Array.isArray(selected) || selected.length === 0 || selected.length > 8 || selected.some(path => typeof path !== "string"))
				throw new Error("Select between 1 and 8 attachments per message.");
			const validated = await Promise.all(selected.map(async path => {
				const { canonical, metadata } = await this.file(path);
				if (!contained(workspaceRoot, canonical)) throw new Error("Attachments must stay inside the selected task workspace.");
				return { canonical, metadata, mediaType: mediaTypeForPath(canonical) };
			}));
			if (new Set(validated.map(item => item.canonical)).size !== validated.length)
				throw new Error("Select each attachment only once.");
			await this.workspaceRoot(workspaceRoot);
			this.checkOpen();
			// Attestation is recorded only after the trusted picker, every file,
			// and the current grant pass. No renderer request can populate it.
			const selectedAttachments = validated.map(({ canonical, metadata, mediaType }) => {
				this.pickedFiles.set(canonical, { dev: metadata.dev, ino: metadata.ino, size: metadata.size, mtimeMs: metadata.mtimeMs, mediaType, workspaceRoot });
				return { path: canonical, name: basename(canonical), size: metadata.size, mediaType };
			});
			return { ok: true, selectedAttachments };
		} finally { this.pickerPending = false; }
	}

	/** Call immediately before forwarding a renderer Core request. Resume/retry
	 * schemas carry no new attachments; run-agent has one flat attachment list. */
	assertRequestAttachments(raw: unknown): Promise<void> {
		return this.track(async () => {
			const request = CoreRequestSchema.parse(raw);
			if (request.type !== "runtime-run-agent" || !request.attachments?.length) return;
			await this.profileRoot();
			let totalBytes = 0;
			const roots = request.attachments.some(item => item.source !== "external") ? await this.grants() : [];
			for (const attachment of request.attachments) {
				if (attachment.source === "external" && !await this.ownsPaste(attachment)) throw new Error(unowned);
				const { canonical, metadata } = await this.file(attachment.path);
				if (attachment.source !== "external" && !roots.some(root => contained(root, canonical)))
					throw new Error("Attachment escapes the currently granted task workspaces.");
				const picked = this.pickedFiles.get(canonical);
				if (attachment.source !== "external" && picked && (metadata.dev !== picked.dev || metadata.ino !== picked.ino || metadata.size !== picked.size || metadata.mtimeMs !== picked.mtimeMs || attachment.mediaType !== picked.mediaType || !roots.includes(picked.workspaceRoot)))
					throw new Error("A selected attachment changed. Select the file again.");
				if (attachment.size !== metadata.size || attachment.mediaType !== mediaTypeForPath(canonical))
					throw new Error("Attachment metadata changed. Select the file again.");
				totalBytes += metadata.size;
				if (totalBytes > MAX_MESSAGE_BYTES) throw new Error("Attachments are limited to 25 MB per message.");
			}
			// A grant revoked during filesystem validation must not authorize a send.
			const current = roots.length ? await this.grants() : [];
			if (roots.some(root => !current.includes(root))) throw new Error("Project access changed. Select the attachments again.");
			this.checkOpen();
		});
	}

	handle(raw: unknown): Promise<RendererResponse> {
		return this.track(async (): Promise<RendererResponse> => {
			const parsed = RendererRequestSchema.safeParse(raw);
			if (!parsed.success || !NATIVE_CONTEXT_ATTACHMENT_REQUEST_TYPES.has(parsed.data.type))
				return { ok: false, error: "Invalid native attachment request." };
			await this.profileRoot();
			const request = parsed.data;
			if (request.type === "select-context-files") return this.selectFiles(request.workspaceRoot);
			if (request.type === "list-workspace-files") {
				const root = await this.workspaceRoot(request.workspaceRoot);
				const listed = await this.cancellable(() => listWorkspaceFiles({ workspaceRoot: root, ...(request.query ? { query: request.query } : {}), mediaTypeForPath }));
				const workspaceFiles: SelectedAttachment[] = [];
				for (const attachment of listed) {
					try {
						const { canonical, metadata } = await this.file(attachment.path);
						if (contained(root, canonical)) workspaceFiles.push({ ...attachment, path: canonical, size: metadata.size });
					} catch { this.checkOpen(); /* A changed file is omitted. */ }
				}
				await this.workspaceRoot(root);
				return { ok: true, workspaceFiles };
			}
			if (request.type === "create-pasted-text-attachment") {
				const store = await this.pasteStore();
				await this.validatePasteDirectory();
				const attachment = await store.create(request.text);
				const info = await lstat(attachment.path);
				await this.validatePasteDirectory();
				this.pastes.set(attachment.path, { dev: info.dev, ino: info.ino, size: info.size });
				return { ok: true, selectedAttachments: [attachment] };
			}
			if (request.type === "remove-pasted-text-attachment") {
				if (!this.pastes.has(request.path)) throw new Error(unowned);
				await this.validatePasteDirectory();
				this.pastes.delete(request.path);
				await this.store!.remove(request.path);
				this.checkOpen();
				return { ok: true };
			}
			return { ok: false, error: "Invalid native attachment request." };
		});
	}

	/** Cancel pending grant lookups, wait for writes, and remove only this
	 * process's generated directory. Existing profile/workspace files remain. */
	close(): Promise<void> {
		if (!this.closing) {
			this.closed = true;
			this.cancellation.abort();
			this.closing = (async () => {
				await Promise.allSettled([...this.operations]);
				this.pastes.clear();
				this.pickedFiles.clear();
				if (this.store && this.pasteDirectory && this.pasteDirectoryIdentity) {
					let info: Stats;
					try { info = await lstat(this.pasteDirectory); }
					catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
					if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== this.pasteDirectoryIdentity.dev || info.ino !== this.pasteDirectoryIdentity.ino)
						throw new Error("The attachment directory changed. Cleanup preserved the replacement directory.");
				}
				await this.store?.dispose();
			})();
		}
		return this.closing;
	}
}
