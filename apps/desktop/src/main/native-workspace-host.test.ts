import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RendererResponse } from "@kestrel/shared-types";
import { NativeWorkspaceHost } from "./native-workspace-host";
// @ts-expect-error Native runtime modules run unchanged under bundled Node.
import { createNativeCoreConfiguration } from "../../../native-chromium-host/resources/native-core-configuration.mjs";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "kestrel-native-workspaces-")); roots.push(root);
	const data = join(root, "native-core"); await mkdir(data, { mode: 0o700 });
	const folder = join(root, "selected-project"); await mkdir(folder);
	const selectFolder = vi.fn(async (): Promise<string | null> => folder);
	const isBusy = vi.fn(() => false);
	const core = { start: vi.fn(async (_config: unknown) => {}), stop: vi.fn(async () => {}) };
	const options = { root: data, selectFolder, reconfigure: async <T>(mutation: () => Promise<T>): Promise<T> => configuration.reconfigure(mutation) };
	const host = new NativeWorkspaceHost(options);
	const configuration = createNativeCoreConfiguration({ core, isBusy,
		configuration: async () => ({ databasePath: join(data, "database.sqlite"), encryptionKeyBase64: "same-native-profile-key", ...await host.runtimeConfiguration() }),
	});
	await configuration.start();
	return { root, data, folder, selectFolder, isBusy, core, options, host, configuration, file: join(data, "workspace-grants.json") };
}

function projects(response: RendererResponse) {
	if (!response.ok || !("projects" in response) || !response.projects) throw new Error("Expected workspace project metadata.");
	return response.projects;
}

describe("native workspace host", () => {
	it("adds only the native-picked canonical folder and restarts the same Core with its actual grant", async () => {
		const { host, folder, root, core, file, options } = await fixture();
		const alias = join(root, "picked-alias"); await symlink(folder, alias);
		options.selectFolder.mockResolvedValueOnce(alias);
		const result = await host.handle({ type: "select-workspace-folder" });
		const path = await realpath(folder);
		expect(result).toMatchObject({ ok: true, selectedWorkspacePath: path, workspaceGrants: [{ path, available: true }] });
		const selected = projects(result);
		expect(selected).toHaveLength(1);
		expect(core.stop).toHaveBeenCalledOnce();
		expect(core.start).toHaveBeenLastCalledWith(expect.objectContaining({
			databasePath: join(options.root, "database.sqlite"), encryptionKeyBase64: "same-native-profile-key",
			workspaceRoots: [path], configuredWorkspaceRoots: [path], projects: selected,
		}));
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		expect(await new NativeWorkspaceHost(options).runtimeConfiguration()).toMatchObject({ workspaceRoots: [path], projects: selected });
	});

	it("keeps Core running while one trusted picker waits and treats native cancellation as no change", async () => {
		const { host, selectFolder, core, file } = await fixture();
		const picker = deferred<string | null>(); selectFolder.mockReturnValueOnce(picker.promise);
		const first = host.handle({ type: "select-workspace-folder" });
		await vi.waitFor(() => expect(selectFolder).toHaveBeenCalledOnce());
		expect(core.stop).not.toHaveBeenCalled();
		await expect(host.handle({ type: "select-workspace-folder" })).rejects.toThrow("already open");
		expect(await host.handle({ type: "get-workspace-grants" })).toMatchObject({ ok: true, projects: [] });
		picker.resolve(null);
		expect(await first).toMatchObject({ ok: true, cancelled: true, workspaceGrants: [], projects: [] });
		expect(core.stop).not.toHaveBeenCalled(); await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects a busy Core after the native choice and before persisting a grant", async () => {
		const { host, isBusy, selectFolder, core, file } = await fixture(); isBusy.mockReturnValue(true);
		await expect(host.handle({ type: "select-workspace-folder" })).rejects.toThrow("active task");
		expect(selectFolder).toHaveBeenCalledOnce(); expect(core.stop).not.toHaveBeenCalled();
		await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
		isBusy.mockReturnValue(false);
		expect((await host.handle({ type: "select-workspace-folder" })).ok).toBe(true);
	});

	it.each(["remove-workspace-folder", "project-delete"])("%s revokes the grant from the restarted Core and preserves project data", async type => {
		const { host, folder, core, options } = await fixture();
		const ownedFile = join(folder, "keep.txt"); await writeFile(ownedFile, "User-owned project contents.");
		const [project] = projects(await host.handle({ type: "select-workspace-folder" }));
		const result = await host.handle(type === "project-delete" ? { type, projectId: project!.id } : { type, path: folder });
		expect(projects(result)).toEqual([]);
		expect(core.start).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceRoots: [], configuredWorkspaceRoots: [], projects: [] }));
		expect(core.stop).toHaveBeenCalledTimes(2);
		expect(await readFile(ownedFile, "utf8")).toBe("User-owned project contents.");
		expect((await new NativeWorkspaceHost(options).runtimeConfiguration()).workspaceRoots).toEqual([]);
	});

	it.each(["project-update", "project-delete", "remove-workspace-folder"])("guards %s before modifying existing metadata", async type => {
		const { host, folder, isBusy, core, file } = await fixture();
		const [project] = projects(await host.handle({ type: "select-workspace-folder" }));
		const before = await readFile(file, "utf8"); isBusy.mockReturnValue(true);
		const request = type === "remove-workspace-folder" ? { type, path: folder } : { type, projectId: project!.id, name: "Must not persist" };
		await expect(host.handle(request)).rejects.toThrow("active task");
		expect(core.stop).toHaveBeenCalledOnce(); expect(await readFile(file, "utf8")).toBe(before);
	});

	it("keeps unavailable projects visible and configured without granting them to Core", async () => {
		const { host, folder, root } = await fixture();
		const [project] = projects(await host.handle({ type: "select-workspace-folder" }));
		await rename(folder, join(root, "folder-moved-by-owner"));
		expect(await host.runtimeConfiguration()).toEqual({ workspaceRoots: [], configuredWorkspaceRoots: [project!.path], projects: [{ ...project, available: false }] });
		expect(await host.handle({ type: "get-workspace-grants" })).toMatchObject({ workspaceGrants: [{ ...project, available: false }], projects: [{ ...project, available: false }] });
	});

	it("persists updated project metadata and cleared instructions in the shared grant registry", async () => {
		const { host, options, core, file } = await fixture();
		const [project] = projects(await host.handle({ type: "select-workspace-folder" }));
		const updated = await host.handle({ type: "project-update", projectId: project!.id, name: " Native project ", instructions: " Limit work to this project. " });
		expect(projects(updated)[0]).toMatchObject({ id: project!.id, name: "Native project", instructions: "Limit work to this project." });
		expect(core.start).toHaveBeenLastCalledWith(expect.objectContaining({ projects: projects(updated) }));
		const reloaded = new NativeWorkspaceHost(options);
		expect((await reloaded.runtimeConfiguration()).projects).toEqual(projects(updated));
		const cleared = await host.handle({ type: "project-update", projectId: project!.id, instructions: "" });
		expect(projects(cleared)[0]).not.toHaveProperty("instructions");
		expect(await readFile(file, "utf8")).not.toContain("Limit work to this project.");
	});

	it("ignores renderer-supplied picker paths and rejects unrelated or malformed requests", async () => {
		const { host, folder, selectFolder, core } = await fixture();
		for (const raw of [{ type: "provider-account-list" }, { type: "project-delete" }, { type: "project-update", projectId: "id", name: 42 }])
			expect(await host.handle(raw)).toEqual({ ok: false, error: "Invalid native workspace request." });
		expect(selectFolder).not.toHaveBeenCalled(); expect(core.stop).not.toHaveBeenCalled();
		const result = await host.handle({ type: "select-workspace-folder", path: "/", selectedWorkspacePath: homedir() });
		expect(projects(result)[0]?.path).toBe(await realpath(folder));
		expect(selectFolder).toHaveBeenCalledWith();
	});

	it.each(["/", homedir(), "relative-project"])("rejects an unsafe native picker result %s and restores Core", async path => {
		const { host, selectFolder, core, file } = await fixture(); selectFolder.mockResolvedValueOnce(path);
		await expect(host.handle({ type: "select-workspace-folder" })).rejects.toThrow();
		await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
		if (path !== "relative-project") expect(core.start).toHaveBeenCalledTimes(2);
		expect((await host.runtimeConfiguration()).workspaceRoots).toEqual([]);
	});

	it.each(["close", "cancel"])("%s resolves a pending picker and ignores its late selected path", async action => {
		const { host, folder, selectFolder, core, file } = await fixture();
		const picker = deferred<string | null>(); selectFolder.mockReturnValueOnce(picker.promise);
		const pending = host.handle({ type: "select-workspace-folder" });
		await vi.waitFor(() => expect(selectFolder).toHaveBeenCalledOnce());
		if (action === "close") await host.close(); else expect(host.cancelSelection()).toBe(true);
		expect(await pending).toMatchObject({ ok: true, cancelled: true });
		if (action === "cancel") await expect(host.handle({ type: "select-workspace-folder" })).rejects.toThrow("already open");
		picker.resolve(folder); await Promise.resolve();
		await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" }); expect(core.stop).not.toHaveBeenCalled();
		if (action === "close") expect((await host.handle({ type: "get-workspace-grants" })).ok).toBe(false);
		else expect((await host.handle({ type: "select-workspace-folder" })).ok).toBe(true);
	});

	it("does not open a deferred native picker after immediate shutdown and observes late picker failures", async () => {
		const first = await fixture();
		const pending = first.host.handle({ type: "select-workspace-folder" });
		await first.host.close();
		expect(await pending).toMatchObject({ cancelled: true }); expect(first.selectFolder).not.toHaveBeenCalled();
		const second = await fixture(); const picker = deferred<string | null>(); second.selectFolder.mockReturnValueOnce(picker.promise);
		const selecting = second.host.handle({ type: "select-workspace-folder" });
		await vi.waitFor(() => expect(second.selectFolder).toHaveBeenCalledOnce());
		await second.host.close(); expect(await selecting).toMatchObject({ cancelled: true });
		picker.reject(new Error("Late native picker failure")); await Promise.resolve();
		expect(second.core.stop).not.toHaveBeenCalled();
	});

	it("shutdown before the guarded store mutation cannot persist a pending selection", async () => {
		const { host, core, file } = await fixture();
		const stopping = deferred<void>(); core.stop.mockImplementationOnce(async () => stopping.promise);
		const pending = host.handle({ type: "select-workspace-folder" });
		const rejected = expect(pending).rejects.toThrow("shutting down");
		await vi.waitFor(() => expect(core.stop).toHaveBeenCalledOnce());
		const closing = host.close(); stopping.resolve(); await closing; await rejected;
		await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
		expect(core.start).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceRoots: [] }));
	});

	it("waits for a committed grant's Core restart during shutdown instead of reporting it cancelled", async () => {
		const { host, core, folder, file } = await fixture();
		const restarting = deferred<void>(); core.start.mockImplementationOnce(async () => restarting.promise);
		const pending = host.handle({ type: "select-workspace-folder" });
		await vi.waitFor(() => expect(core.start).toHaveBeenCalledTimes(2));
		expect(await readFile(file, "utf8")).toContain("selected-project");
		expect(host.cancelSelection()).toBe(false);
		let closed = false; const closing = host.close().then(() => { closed = true; });
		await Promise.resolve(); expect(closed).toBe(false);
		restarting.resolve(); await closing;
		expect(await pending).toMatchObject({ ok: true, selectedWorkspacePath: await realpath(folder) });
	});

	it("preserves a malformed native store and does not import grants from sibling profiles", async () => {
		const { host, root, file, core } = await fixture();
		const other = join(root, "other-profile"); await mkdir(other); await writeFile(join(other, "workspace-grants.json"), "[]");
		expect(projects(await host.handle({ type: "get-workspace-grants" }))).toEqual([]);
		const original = '{"preserve":"user-owned-invalid-store"}'; await writeFile(file, original);
		await expect(host.handle({ type: "get-workspace-grants" })).rejects.toThrow("must contain an array");
		expect(await readFile(file, "utf8")).toBe(original); expect(core.stop).not.toHaveBeenCalled();
	});
});
