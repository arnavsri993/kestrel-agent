import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RendererResponse, SelectedAttachment } from "@kestrel/shared-types";
import { NativeContextAttachmentHost, NATIVE_CONTEXT_ATTACHMENT_REQUEST_TYPES } from "./native-context-attachments";
import { mediaTypeForPath } from "./file-tabs";

const roots: string[] = [];
const hosts: NativeContextAttachmentHost[] = [];
afterEach(async () => {
	await Promise.all(hosts.splice(0).map(host => host.close()));
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "kestrel-native-context-")); roots.push(root);
	const profile = join(root, "native-core"); await mkdir(profile, { mode: 0o700 });
	const project = join(root, "project"); await mkdir(project);
	const workspaceRoots = vi.fn(async () => [await realpath(project)]);
	const selectFiles = vi.fn(async (_root: string, _signal: AbortSignal): Promise<string[] | null> => null);
	const host = new NativeContextAttachmentHost({ root: profile, workspaceRoots, selectFiles }); hosts.push(host);
	return { root, profile, project, workspaceRoots, selectFiles, host };
}

function attachment(response: RendererResponse): SelectedAttachment {
	if (!response.ok || !("selectedAttachments" in response) || !response.selectedAttachments[0]) throw new Error("Expected a paste attachment.");
	return response.selectedAttachments[0];
}

function run(attachments: SelectedAttachment[]) {
	return { type: "runtime-run-agent", sessionId: "session", message: "Read these files", model: "auto", providerIds: ["auto"], attachments };
}

async function workspaceFile(project: string, name = "notes.md", size = 5): Promise<SelectedAttachment> {
	const path = join(project, name); await writeFile(path, "hello"); await truncate(path, size);
	return { path: await realpath(path), name, mediaType: mediaTypeForPath(path), size };
}

describe("native context attachment host", () => {
	it("exposes only the bounded native context request set", async () => {
		const { host } = await fixture();
		expect([...NATIVE_CONTEXT_ATTACHMENT_REQUEST_TYPES]).toEqual(["list-workspace-files", "create-pasted-text-attachment", "remove-pasted-text-attachment", "select-context-files"]);
		for (const raw of [{ type: "browser-create-tab" }, { type: "create-pasted-text-attachment", text: "" }, { type: "remove-pasted-text-attachment" }])
			expect(await host.handle(raw)).toEqual({ ok: false, error: "Invalid native attachment request." });
	});

	it("returns canonical granted search results and skips links, dependencies, hidden and oversized files", async () => {
		const { root, project, host } = await fixture();
		const expected = await workspaceFile(project);
		await workspaceFile(project, ".hidden.md");
		await workspaceFile(project, "large.md", 10 * 1024 * 1024 + 1);
		await mkdir(join(project, "node_modules")); await workspaceFile(join(project, "node_modules"));
		const outside = await workspaceFile(root, "private.md"); await symlink(outside.path, join(project, "linked.md"));
		const alias = join(root, "project-alias"); await symlink(project, alias);
		const response = await host.handle({ type: "list-workspace-files", workspaceRoot: alias, query: ".md" });
		expect(response).toEqual({ ok: true, workspaceFiles: [expected] });
		await expect(host.assertRequestAttachments(run([expected]))).resolves.toBeUndefined();
		await expect(host.assertRequestAttachments(run([outside]))).rejects.toThrow("escapes");
	});

	it("denies arbitrary roots and roots whose grants were revoked", async () => {
		const { root, project, workspaceRoots, host } = await fixture();
		await workspaceFile(project);
		await expect(host.handle({ type: "list-workspace-files", workspaceRoot: root })).rejects.toThrow("currently granted");
		workspaceRoots.mockResolvedValue([]);
		await expect(host.handle({ type: "list-workspace-files", workspaceRoot: project })).rejects.toThrow("currently granted");
	});

	it("rechecks access after search and before returning any file metadata", async () => {
		const { project, workspaceRoots, host } = await fixture();
		await workspaceFile(project);
		workspaceRoots.mockResolvedValueOnce([await realpath(project)]).mockResolvedValue([]);
		await expect(host.handle({ type: "list-workspace-files", workspaceRoot: project })).rejects.toThrow("currently granted");
	});

	it("rejects an arbitrary external path even when it is inside a granted workspace", async () => {
		const { project, host } = await fixture();
		const forged = { ...await workspaceFile(project), source: "external" as const };
		await expect(host.assertRequestAttachments(run([forged]))).rejects.toThrow("only sends external");
		await expect(host.handle({ type: "remove-pasted-text-attachment", path: forged.path })).rejects.toThrow("only sends external");
		expect(await readFile(forged.path, "utf8")).toBe("hello");
	});

	it("creates private owned paste files, sends them without a workspace, and revokes ownership on removal", async () => {
		const { profile, workspaceRoots, host } = await fixture(); workspaceRoots.mockResolvedValue([]);
		const paste = attachment(await host.handle({ type: "create-pasted-text-attachment", text: "Private context" }));
		expect(paste).toMatchObject({ name: basename(paste.path), mediaType: "text/plain", source: "external", size: 15 });
		expect(dirname(dirname(paste.path))).toBe(await realpath(profile));
		expect((await lstat(dirname(paste.path))).mode & 0o777).toBe(0o700);
		expect((await lstat(paste.path)).mode & 0o777).toBe(0o600);
		await expect(host.assertRequestAttachments(run([paste]))).resolves.toBeUndefined();
		expect(workspaceRoots).not.toHaveBeenCalled();
		expect(await host.handle({ type: "remove-pasted-text-attachment", path: paste.path })).toEqual({ ok: true });
		await expect(lstat(paste.path)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(host.assertRequestAttachments(run([paste]))).rejects.toThrow("only sends external");
	});

	it("never adopts another host or profile's generated paste path", async () => {
		const first = await fixture(), other = await fixture();
		const paste = attachment(await first.host.handle({ type: "create-pasted-text-attachment", text: "first profile" }));
		const restarted = new NativeContextAttachmentHost({ root: first.profile, workspaceRoots: first.workspaceRoots }); hosts.push(restarted);
		for (const host of [other.host, restarted]) {
			await expect(host.assertRequestAttachments(run([paste]))).rejects.toThrow("only sends external");
			await expect(host.handle({ type: "remove-pasted-text-attachment", path: paste.path })).rejects.toThrow("only sends external");
		}
		expect(await readFile(paste.path, "utf8")).toBe("first profile");
	});

	it("rejects unregistered files and forged metadata inside its own private paste directory", async () => {
		const { host } = await fixture();
		const paste = attachment(await host.handle({ type: "create-pasted-text-attachment", text: "original" }));
		const forged = { ...paste, path: join(dirname(paste.path), "not-generated.txt") };
		await writeFile(forged.path, "original", { mode: 0o600 });
		await expect(host.assertRequestAttachments(run([forged]))).rejects.toThrow("only sends external");
		await expect(host.assertRequestAttachments(run([{ ...paste, size: 0 }]))).rejects.toThrow("only sends external");
	});

	it.each(["symlink", "replacement", "hardlink", "public", "metadata"])("rejects a paste with altered ownership or identity: %s", async change => {
		const { host, project } = await fixture();
		const paste = attachment(await host.handle({ type: "create-pasted-text-attachment", text: "original" }));
		if (change === "symlink") {
			const other = await workspaceFile(project); await rm(paste.path); await symlink(other.path, paste.path);
		} else if (change === "replacement") {
			const replacement = join(dirname(paste.path), "replacement"); await writeFile(replacement, "original", { mode: 0o600 });
			await rm(paste.path); await link(replacement, paste.path); await rm(replacement);
		} else if (change === "hardlink") await link(paste.path, join(project, "linked.txt"));
		else if (change === "public") await chmod(paste.path, 0o644);
		else paste.mediaType = "image/png";
		await expect(host.assertRequestAttachments(run([paste]))).rejects.toThrow("only sends external");
	});

	it("enforces eight attachments, actual 10 MB per file and 25 MB per message", async () => {
		const { project, host } = await fixture();
		const file = await workspaceFile(project);
		await expect(host.assertRequestAttachments(run(Array(9).fill(file)))).rejects.toThrow();
		const large = await workspaceFile(project, "large.txt", 10 * 1024 * 1024 + 1);
		await expect(host.assertRequestAttachments(run([{ ...large, size: 1 }]))).rejects.toThrow("10 MB");
		const full = await workspaceFile(project, "full.txt", 10 * 1024 * 1024);
		await expect(host.assertRequestAttachments(run([full, full, full]))).rejects.toThrow("25 MB");
	});

	it("rejects workspace symlink escapes and grants revoked during send validation", async () => {
		const { root, project, workspaceRoots, host } = await fixture();
		const outside = await workspaceFile(root);
		const linked = { ...outside, path: join(project, "link.txt") }; await symlink(outside.path, linked.path);
		await expect(host.assertRequestAttachments(run([linked]))).rejects.toThrow("escapes");
		const valid = await workspaceFile(project);
		workspaceRoots.mockResolvedValueOnce([await realpath(project)]).mockResolvedValue([]);
		await expect(host.assertRequestAttachments(run([valid]))).rejects.toThrow("access changed");
	});

	it("checks actual workspace attachment size and media type before forwarding", async () => {
		const { project, host } = await fixture();
		const file = await workspaceFile(project);
		await expect(host.assertRequestAttachments(run([{ ...file, size: 0 }]))).rejects.toThrow("metadata changed");
		await expect(host.assertRequestAttachments(run([{ ...file, mediaType: "image/png" }]))).rejects.toThrow("metadata changed");
	});

	it("rejects a public or linked profile without creating attachment directories", async () => {
		const { root, profile, host } = await fixture();
		await chmod(profile, 0o755);
		await expect(host.handle({ type: "create-pasted-text-attachment", text: "context" })).rejects.toThrow("private profile");
		expect(await readdir(profile)).toEqual([]);
		await chmod(profile, 0o700);
		const alias = join(root, "linked-profile"); await symlink(profile, alias);
		const linked = new NativeContextAttachmentHost({ root: alias, workspaceRoots: async () => [] }); hosts.push(linked);
		await expect(linked.handle({ type: "create-pasted-text-attachment", text: "context" })).rejects.toThrow("private profile");
	});

	it("closes once, deletes only its own generated directory, and rejects later operations", async () => {
		const { profile, project, host } = await fixture();
		const keep = await workspaceFile(project);
		await writeFile(join(profile, "keep.json"), "existing profile data");
		const paste = attachment(await host.handle({ type: "create-pasted-text-attachment", text: "temporary" }));
		await Promise.all([host.close(), host.close()]);
		await expect(lstat(dirname(paste.path))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(join(profile, "keep.json"), "utf8")).toBe("existing profile data");
		expect(await readFile(keep.path, "utf8")).toBe("hello");
		await expect(host.handle({ type: "create-pasted-text-attachment", text: "late" })).rejects.toThrow("shutting down");
		await expect(host.assertRequestAttachments(run([paste]))).rejects.toThrow("shutting down");
	});

	it("refuses a replaced private directory and preserves its replacement during cleanup", async () => {
		const { host } = await fixture();
		const paste = attachment(await host.handle({ type: "create-pasted-text-attachment", text: "temporary" }));
		const directory = dirname(paste.path);
		await rename(directory, `${directory}-moved`);
		await mkdir(directory, { mode: 0o700 });
		const keep = join(directory, "keep.txt"); await writeFile(keep, "not owned by this launch");
		await expect(host.handle({ type: "create-pasted-text-attachment", text: "late" })).rejects.toThrow("directory changed");
		await expect(host.close()).rejects.toThrow("Cleanup preserved");
		expect(await readFile(keep, "utf8")).toBe("not owned by this launch");
		hosts.splice(hosts.indexOf(host), 1);
	});

	it("cancels a waiting grant lookup on close and observes a late callback failure", async () => {
		const { project, workspaceRoots, host } = await fixture();
		const grants = deferred<string[]>(); workspaceRoots.mockReturnValue(grants.promise);
		const search = host.handle({ type: "list-workspace-files", workspaceRoot: project });
		const rejected = expect(search).rejects.toThrow("shutting down");
		await vi.waitFor(() => expect(workspaceRoots).toHaveBeenCalledOnce());
		await host.close(); await rejected;
		grants.reject(new Error("late lookup")); await Promise.resolve();
	});

	it("suppresses concurrent pending creates on immediate close without leaving directories", async () => {
		const { profile, host } = await fixture();
		const creating = Promise.allSettled(Array.from({ length: 8 }, () => host.handle({ type: "create-pasted-text-attachment", text: "pending" })));
		await host.close();
		expect((await creating).every(result => result.status === "rejected")).toBe(true);
		expect(await readdir(profile)).toEqual([]);
	});

	it("bounds outstanding requests and cancels them without waiting for grant callbacks", async () => {
		const { project, workspaceRoots, host } = await fixture();
		const grants = deferred<string[]>(); workspaceRoots.mockReturnValue(grants.promise);
		const searches = Promise.allSettled(Array.from({ length: 64 }, () => host.handle({ type: "list-workspace-files", workspaceRoot: project })));
		await expect(host.handle({ type: "list-workspace-files", workspaceRoot: project })).rejects.toThrow("too many pending");
		await host.close();
		expect((await searches).every(result => result.status === "rejected")).toBe(true);
		grants.resolve([project]);
	});

	it("permits attachment-free Core operations and validates their schema", async () => {
		const { host } = await fixture();
		await expect(host.assertRequestAttachments({ type: "snapshot" })).resolves.toBeUndefined();
		await expect(host.assertRequestAttachments({ type: "runtime-resume-agent", runId: "run", approvalDecision: "approved" })).resolves.toBeUndefined();
		await expect(host.assertRequestAttachments({ type: "runtime-run-agent" })).rejects.toThrow();
	});

	it("opens only the trusted picker after checking the exact current canonical grant", async () => {
		const { root, project, workspaceRoots, selectFiles, host } = await fixture();
		const file = await workspaceFile(project);
		selectFiles.mockResolvedValueOnce([file.path]);
		const alias = join(root, "project-alias"); await symlink(project, alias);
		expect(await host.handle({ type: "select-context-files", workspaceRoot: alias, selectedContextPaths: ["/injected"] })).toEqual({ ok: true, selectedAttachments: [file] });
		expect(selectFiles).toHaveBeenCalledExactlyOnceWith(await realpath(project), expect.any(AbortSignal));
		await expect(host.assertRequestAttachments(run([file]))).resolves.toBeUndefined();
		workspaceRoots.mockResolvedValue([]);
		await expect(host.handle({ type: "select-context-files", workspaceRoot: project })).rejects.toThrow("currently granted");
		expect(selectFiles).toHaveBeenCalledOnce();
	});

	it("does not open a picker for a renderer-supplied ungranted root or attestation", async () => {
		const { root, selectFiles, host } = await fixture();
		await expect(host.handle({ type: "select-context-files", workspaceRoot: root, selectedContextPaths: ["/injected"] })).rejects.toThrow("currently granted");
		expect(selectFiles).not.toHaveBeenCalled();
	});

	it("requires a native picker and returns cancellation without adding attachments", async () => {
		const { profile, project, workspaceRoots, host } = await fixture();
		expect(await host.handle({ type: "select-context-files", workspaceRoot: project })).toEqual({ ok: true, cancelled: true, selectedAttachments: [] });
		const unavailable = new NativeContextAttachmentHost({ root: profile, workspaceRoots }); hosts.push(unavailable);
		await expect(unavailable.handle({ type: "select-context-files", workspaceRoot: project })).rejects.toThrow("picker is unavailable");
	});

	it("validates the entire native selection before attesting paths and never upgrades outside files", async () => {
		const { root, project, selectFiles, host } = await fixture();
		const file = await workspaceFile(project);
		const outside = await workspaceFile(root, "outside.txt");
		selectFiles.mockResolvedValueOnce([file.path, outside.path]);
		await expect(host.handle({ type: "select-context-files", workspaceRoot: project })).rejects.toThrow("inside the selected task workspace");
		await expect(host.assertRequestAttachments(run([{ ...outside, source: "external" }]))).rejects.toThrow("only sends external");
		const linked = join(project, "escape.txt"); await symlink(outside.path, linked);
		selectFiles.mockResolvedValueOnce([linked]);
		await expect(host.handle({ type: "select-context-files", workspaceRoot: project })).rejects.toThrow("inside the selected task workspace");
	});

	it("limits trusted native selections to eight distinct regular files of at most 10 MB", async () => {
		const { project, selectFiles, host } = await fixture();
		const file = await workspaceFile(project);
		const large = await workspaceFile(project, "large.txt", 10 * 1024 * 1024 + 1);
		for (const paths of [[], Array(9).fill(file.path), [file.path, file.path], [project], [large.path], ["relative"], ["/bad\0path"]]) {
			selectFiles.mockResolvedValueOnce(paths);
			await expect(host.handle({ type: "select-context-files", workspaceRoot: project })).rejects.toThrow();
		}
	});

	it("keeps a single picker pending and rechecks grants after its selection", async () => {
		const { project, workspaceRoots, selectFiles, host } = await fixture();
		const file = await workspaceFile(project);
		const picker = deferred<string[] | null>(); selectFiles.mockReturnValueOnce(picker.promise);
		const selecting = host.handle({ type: "select-context-files", workspaceRoot: project });
		await vi.waitFor(() => expect(selectFiles).toHaveBeenCalledOnce());
		await expect(host.handle({ type: "select-context-files", workspaceRoot: project })).rejects.toThrow("already open");
		workspaceRoots.mockResolvedValue([]); picker.resolve([file.path]);
		await expect(selecting).rejects.toThrow("currently granted");
		await expect(host.assertRequestAttachments(run([file]))).rejects.toThrow("escapes");
	});

	it("aborts the native picker on close and ignores its late selected paths", async () => {
		const { project, selectFiles, host } = await fixture();
		const file = await workspaceFile(project);
		const picker = deferred<string[] | null>(); selectFiles.mockReturnValueOnce(picker.promise);
		const selecting = host.handle({ type: "select-context-files", workspaceRoot: project });
		const rejected = expect(selecting).rejects.toThrow("shutting down");
		await vi.waitFor(() => expect(selectFiles).toHaveBeenCalledOnce());
		const signal = selectFiles.mock.calls[0]![1];
		await host.close(); await rejected;
		expect(signal.aborted).toBe(true);
		picker.resolve([file.path]); await Promise.resolve();
		expect(await readFile(file.path, "utf8")).toBe("hello");
	});

	it("rejects a replaced selected file and external relabeling of a workspace selection", async () => {
		const { project, selectFiles, host } = await fixture();
		const file = await workspaceFile(project);
		selectFiles.mockResolvedValueOnce([file.path]);
		await host.handle({ type: "select-context-files", workspaceRoot: project });
		await expect(host.assertRequestAttachments(run([{ ...file, source: "external" }]))).rejects.toThrow("only sends external");
		await rename(file.path, `${file.path}-original`); await writeFile(file.path, "hello");
		await expect(host.assertRequestAttachments(run([file]))).rejects.toThrow("selected attachment changed");
	});
});
