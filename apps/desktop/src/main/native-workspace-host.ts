import { realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { RendererRequestSchema, type Project, type RendererResponse } from "@kestrel/shared-types";
import { WorkspaceGrantStore } from "./workspace-grant-store";

export const NATIVE_WORKSPACE_REQUEST_TYPES = new Set([
	"get-workspace-grants", "select-workspace-folder", "remove-workspace-folder", "project-update", "project-delete",
]);

interface Options {
	/** This native profile's private Core data root, never another app's profile. */
	root: string;
	/** Trusted Cocoa picker. A renderer request cannot supply its result. */
	selectFolder(): Promise<string | null>;
	/** The same idle-Core guard used for native provider changes. */
	reconfigure<T>(mutation: () => Promise<T>): Promise<T>;
}

interface Selection {
	controller: AbortController;
	mutating: boolean;
	done?: Promise<RendererResponse>;
}

/** A browser-free host over the existing project/grant source of truth. */
export class NativeWorkspaceHost {
	private readonly store: WorkspaceGrantStore;
	private selection: Selection | undefined;
	private pickerPending = false;
	private readonly mutations = new Set<Promise<RendererResponse>>();
	private closed = false;

	constructor(private readonly options: Options) {
		if (!isAbsolute(options.root)) throw new Error("The native workspace data root must be absolute.");
		this.store = new WorkspaceGrantStore(join(options.root, "workspace-grants.json"));
	}

	async runtimeConfiguration(): Promise<{ workspaceRoots: string[]; configuredWorkspaceRoots: string[]; projects: Project[] }> {
		const projects = await this.store.statusList();
		return {
			workspaceRoots: projects.filter(project => project.available === true).map(project => project.path),
			configuredWorkspaceRoots: projects.map(project => project.path),
			projects,
		};
	}

	private async metadata(extra: { cancelled?: boolean; selectedWorkspacePath?: string } = {}): Promise<RendererResponse> {
		const projects = await this.store.statusList();
		return { ok: true, workspaceGrants: projects, projects, ...extra };
	}

	private mutate(mutation: () => Promise<RendererResponse>): Promise<RendererResponse> {
		// Acquire the shared guard before any filesystem mutation. If shutdown
		// wins while Core stops, reject before writing and let the guard recover.
		const pending = this.options.reconfigure(async () => {
			if (this.closed) throw new Error("The native workspace host is shutting down.");
			return mutation();
		});
		this.mutations.add(pending);
		void pending.finally(() => this.mutations.delete(pending)).catch(() => undefined);
		return pending;
	}

	private select(): Promise<RendererResponse> {
		if (this.selection || this.pickerPending) return Promise.reject(new Error("A native folder picker is already open."));
		const selection: Selection = { controller: new AbortController(), mutating: false };
		this.selection = selection;
		selection.done = this.pick(selection).finally(() => { if (this.selection === selection) this.selection = undefined; });
		return selection.done;
	}

	private async pick(selection: Selection): Promise<RendererResponse> {
		const { signal } = selection.controller;
		let cancel!: () => void;
		const cancelled = new Promise<null>(resolve => { cancel = () => resolve(null); });
		signal.addEventListener("abort", cancel, { once: true });
		try {
			// Core continues running while the native picker is open. Promise.race
			// also observes late picker rejections after cancellation or shutdown.
			const picker = Promise.resolve().then(async () => {
				if (signal.aborted || this.closed) return null;
				this.pickerPending = true;
				try { return await this.options.selectFolder(); }
				finally { this.pickerPending = false; }
			});
			const path = await Promise.race([picker, cancelled]);
			if (path === null || signal.aborted || this.closed) return this.metadata({ cancelled: true });
			if (typeof path !== "string" || !isAbsolute(path)) throw new Error("The native folder picker did not return an absolute folder path.");
			return await this.mutate(async () => {
				signal.throwIfAborted();
				selection.mutating = true;
				// The store validates the selected canonical directory and rejects
				// whole-home and filesystem-volume grants. No renderer path is used.
				const selectedWorkspacePath = await realpath(path);
				await this.store.add(selectedWorkspacePath);
				return this.metadata({ selectedWorkspacePath });
			});
		} finally { signal.removeEventListener("abort", cancel); }
	}

	/** Trusted host cancellation; no late picker completion can grant a folder. */
	cancelSelection(): boolean {
		const selection = this.selection;
		if (!selection || selection.mutating) return false;
		selection.controller.abort(new Error("Native folder selection was cancelled."));
		return true;
	}

	async close(): Promise<void> {
		this.closed = true;
		this.cancelSelection();
		await Promise.allSettled([...this.mutations, ...(this.selection?.done ? [this.selection.done] : [])]);
	}

	async handle(raw: unknown): Promise<RendererResponse> {
		if (this.closed) return { ok: false, error: "The native workspace host is shutting down." };
		const parsed = RendererRequestSchema.safeParse(raw);
		if (!parsed.success || !NATIVE_WORKSPACE_REQUEST_TYPES.has(parsed.data.type)) return { ok: false, error: "Invalid native workspace request." };
		const request = parsed.data;
		switch (request.type) {
			case "get-workspace-grants": return this.metadata();
			case "select-workspace-folder": return this.select();
			case "remove-workspace-folder": return this.mutate(async () => { await this.store.remove(request.path); return this.metadata(); });
			case "project-delete": return this.mutate(async () => { await this.store.remove(request.projectId); return this.metadata(); });
			case "project-update": return this.mutate(async () => {
				await this.store.update(request.projectId, {
					...(request.name !== undefined ? { name: request.name } : {}),
					...(request.instructions !== undefined ? { instructions: request.instructions } : {}),
				});
				return this.metadata();
			});
			default: return { ok: false, error: "Invalid native workspace request." };
		}
	}
}
