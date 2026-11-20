import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { RendererRequestSchema, type Project, type RendererResponse } from "@kestrel/shared-types";
import { WorkspaceGrantStore, projectIdForPath } from "./workspace-grant-store";
import { NativeProjectHandoffFile } from "./native-project-handoff-file";
import { parseNativeProjectHandoffState, PROJECT_HANDOFF_ID, PROJECT_HANDOFF_INVALID, type NativeProjectHandoffState } from "./native-project-handoff-state";

export const NATIVE_WORKSPACE_REQUEST_TYPES = new Set([
	"get-workspace-grants", "select-workspace-folder", "remove-workspace-folder", "project-update", "project-delete",
	"reconnect-workspace-project", "remove-pending-workspace-project",
]);

interface Options {
	/** This native profile's private Core data root, never another app's profile. */
	root: string;
	/** Expected identity comes from the native owner's profile selection. */
	projectHandoff?: { id: string; keyBase64: string };
	/** Trusted Cocoa picker. A renderer request cannot supply its result. */
	selectFolder(signal: AbortSignal): Promise<string | null>;
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
	private readonly handoffFile: NativeProjectHandoffFile | undefined;
	private handoffTail: Promise<void> = Promise.resolve();
	private selection: Selection | undefined;
	private pickerPending = false;
	private readonly mutations = new Set<Promise<RendererResponse>>();
	private closed = false;

	constructor(private readonly options: Options) {
		if (!isAbsolute(options.root)) throw new Error("The native workspace data root must be absolute.");
		this.store = new WorkspaceGrantStore(join(options.root, "workspace-grants.json"));
		if (options.projectHandoff) {
			const key = Buffer.from(options.projectHandoff.keyBase64, "base64");
			try {
				if (!PROJECT_HANDOFF_ID.test(options.projectHandoff.id) || key.length !== 32 || key.toString("base64") !== options.projectHandoff.keyBase64) throw new Error(PROJECT_HANDOFF_INVALID);
				this.handoffFile = new NativeProjectHandoffFile({ root: options.root, key });
			} finally { key.fill(0); }
		}
	}

	private async withHandoff<T>(operation: () => Promise<T>, allowClosed = false): Promise<T> {
		const previous = this.handoffTail;
		let release!: () => void; this.handoffTail = new Promise<void>(resolve => { release = resolve; });
		await previous;
		try { if (this.closed && !allowClosed) throw new Error("The native workspace host is shutting down."); return await operation(); }
		finally { release(); }
	}

	private async handoff(reconcile = true) {
		if (!this.handoffFile || !this.options.projectHandoff) {
			try { await lstat(join(this.options.root, "pending-project-handoff.json")); throw new Error(PROJECT_HANDOFF_INVALID); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			return undefined;
		}
		let loaded = await this.handoffFile.read(this.options.projectHandoff.id);
		let state = parseNativeProjectHandoffState(loaded.value, this.options.projectHandoff.id);
		if (state.state !== "ready" || state.corePlan.destination.path !== join(this.options.root, "database/kestrel.sqlite")) throw new Error(PROJECT_HANDOFF_INVALID);
		if (state.connection && reconcile) {
			// Reconcile only an already saved grant with an exact recorded hash.
			// No imported hint or interrupted intent can create a folder grant.
			const status = await this.store.handoffConnectionState(state.connection);
			const { connection, ...rest } = state;
			const next: NativeProjectHandoffState = { ...rest, revision: state.revision + 1,
				pendingProjectIds: status === "after" ? state.pendingProjectIds.filter(id => id !== connection.project.id) : state.pendingProjectIds,
				settledProjectIds: status === "after" ? [...state.settledProjectIds, { id: connection.project.id, disposition: "connected" }] : state.settledProjectIds };
			loaded = await this.handoffFile.replace(this.options.projectHandoff.id, next, loaded.witness);
			state = parseNativeProjectHandoffState(loaded.value, this.options.projectHandoff.id);
		}
		return { ...loaded, state };
	}

	async runtimeConfiguration(): Promise<{ workspaceRoots: string[]; configuredWorkspaceRoots: string[]; projects: Project[]; pendingProjectIds?: string[] }> {
		return this.withHandoff(async () => {
		const handoff = await this.handoff();
		const projects = await this.store.statusList();
		if (handoff?.state.pendingProjectIds.some(id => projects.some(project => project.id === id))) throw new Error(PROJECT_HANDOFF_INVALID);
		return {
			workspaceRoots: projects.filter(project => project.available === true).map(project => project.path),
			configuredWorkspaceRoots: projects.map(project => project.path),
			projects,
			...(handoff ? { pendingProjectIds: [...handoff.state.pendingProjectIds] } : {}),
		};
		});
	}

	private async metadata(extra: { cancelled?: boolean; selectedWorkspacePath?: string } = {}): Promise<RendererResponse> {
		return this.withHandoff(async () => {
			const handoff = await this.handoff(!this.closed), projects = await this.store.statusList();
			const metadata = new Map(handoff?.state.projects.map(project => [project.id, project]) ?? []);
			const pendingWorkspaceProjects = handoff?.state.pendingProjectIds.map(id => ({ id, name: metadata.get(id)?.name ?? "Project to reconnect" })) ?? [];
			return { ok: true, workspaceGrants: projects, projects, pendingWorkspaceProjects, ...extra };
		}, true);
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

	private select(projectId?: string): Promise<RendererResponse> {
		if (this.selection || this.pickerPending) return Promise.reject(new Error("A native folder picker is already open."));
		const selection: Selection = { controller: new AbortController(), mutating: false };
		this.selection = selection;
		selection.done = this.pick(selection, projectId).finally(() => { if (this.selection === selection) this.selection = undefined; });
		return selection.done;
	}

	private async pick(selection: Selection, projectId?: string): Promise<RendererResponse> {
		const { signal } = selection.controller;
		let cancel!: () => void;
		const cancelled = new Promise<null>(resolve => { cancel = () => resolve(null); });
		signal.addEventListener("abort", cancel, { once: true });
		try {
			const reviewed = projectId ? await this.withHandoff(() => this.handoff()) : undefined;
			if (projectId && !reviewed?.state.pendingProjectIds.includes(projectId)) throw new Error(PROJECT_HANDOFF_INVALID);
			// Core continues running while the native picker is open. Promise.race
			// also observes late picker rejections after cancellation or shutdown.
			const picker = Promise.resolve().then(async () => {
				if (signal.aborted || this.closed) return null;
				this.pickerPending = true;
				try { return await this.options.selectFolder(signal); }
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
				if (projectId) {
					await this.withHandoff(async () => {
						const current = await this.handoff();
						if (!current || !reviewed || current.witness.sha256 !== reviewed.witness.sha256 || !current.state.pendingProjectIds.includes(projectId) || !this.handoffFile || !this.options.projectHandoff) throw new Error(PROJECT_HANDOFF_INVALID);
						const original = current.state.projects.find(project => project.id === projectId), now = new Date().toISOString();
						const metadata = { id: projectId, name: original?.name ?? (basename(selectedWorkspacePath) || "Project"),
							...(original?.instructions !== undefined ? { instructions: original.instructions } : {}), createdAt: original?.createdAt ?? now, updatedAt: original?.updatedAt ?? now };
						await this.store.connectFromHandoff(selectedWorkspacePath, metadata, async connection => {
							signal.throwIfAborted();
							await this.handoffFile!.replace(this.options.projectHandoff!.id, { ...current.state, revision: current.state.revision + 1, connection }, current.witness);
						});
						await this.handoff();
					});
				} else {
					const accepted = await this.withHandoff(async () => {
						const current = await this.handoff();
						if (current?.state.pendingProjectIds.includes(projectIdForPath(selectedWorkspacePath))) return false;
						await this.store.add(selectedWorkspacePath); return true;
					});
					if (!accepted) return { ok: false, error: "Reconnect this project using Choose folder in the project list." };
				}
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
		await this.handoffTail; this.handoffFile?.close();
	}

	async handle(raw: unknown): Promise<RendererResponse> {
		if (this.closed) return { ok: false, error: "The native workspace host is shutting down." };
		const parsed = RendererRequestSchema.safeParse(raw);
		if (!parsed.success || !NATIVE_WORKSPACE_REQUEST_TYPES.has(parsed.data.type)) return { ok: false, error: "Invalid native workspace request." };
		const request = parsed.data;
		switch (request.type) {
			case "get-workspace-grants": return this.metadata();
			case "select-workspace-folder": return this.select();
			case "reconnect-workspace-project": return this.select(request.projectId);
			case "remove-pending-workspace-project": return this.mutate(async () => {
				await this.withHandoff(async () => {
					const current = await this.handoff();
					if (!current || !current.state.pendingProjectIds.includes(request.projectId) || !this.handoffFile || !this.options.projectHandoff) throw new Error(PROJECT_HANDOFF_INVALID);
					await this.handoffFile.replace(this.options.projectHandoff.id, { ...current.state, revision: current.state.revision + 1,
						pendingProjectIds: current.state.pendingProjectIds.filter(id => id !== request.projectId), projects: current.state.projects.filter(project => project.id !== request.projectId),
						settledProjectIds: [...current.state.settledProjectIds, { id: request.projectId, disposition: "removed" }] }, current.witness);
				});
				return this.metadata();
			});
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
