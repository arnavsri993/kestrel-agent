import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectIdForPath, WorkspaceGrantStore } from "./workspace-grant-store";

const directories: string[] = [];
const NOW = "2026-09-03T00:00:00.000Z";

function project(path: string, name: string, order: number) {
	return {
		id: projectIdForPath(path),
		path,
		name,
		createdAt: NOW,
		updatedAt: NOW,
		order,
	};
}

afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("workspace grant store", () => {
	it("persists canonical explicit directories with owner-only permissions and supports revocation", async () => {
		const storage = mkdtempSync(join(tmpdir(), "kestrel-grants-"));
		directories.push(storage);
		const workspace = join(storage, "project");
		mkdirSync(workspace);
		const filename = join(storage, "private", "workspace-grants.json");
		const store = new WorkspaceGrantStore(filename, () => NOW);
		const added = await store.add(workspace);
		expect(added).toEqual([project(realpathSync(workspace), "project", 0)]);
		expect(statSync(filename).mode & 0o777).toBe(0o600);
		expect(readFileSync(filename, "utf8")).toContain("project");
		expect(await store.remove(workspace)).toEqual([]);
	});

	it("rejects broad filesystem and home-directory grants", async () => {
		const storage = mkdtempSync(join(tmpdir(), "kestrel-grants-"));
		directories.push(storage);
		const store = new WorkspaceGrantStore(
			join(storage, "workspace-grants.json"),
		);
		await expect(store.add("/")).rejects.toThrow("whole filesystem volume");
		await expect(store.add(homedir())).rejects.toThrow("entire home directory");
	});

	it("preserves unavailable grants while other grants are added or removed", async () => {
		const storage = mkdtempSync(join(tmpdir(), "kestrel-grants-"));
		directories.push(storage);
		const available = join(storage, "available");
		const unavailable = join(storage, "unavailable");
		const addedLater = join(storage, "added-later");
		mkdirSync(available);
		mkdirSync(unavailable);
		mkdirSync(addedLater);
		const availablePath = realpathSync(available);
		const unavailablePath = realpathSync(unavailable);
		const addedLaterPath = realpathSync(addedLater);
		const availableProject = project(availablePath, "available", 0);
		const unavailableProject = project(unavailablePath, "unavailable", 1);
		const addedLaterProject = project(addedLaterPath, "added-later", 2);
		const store = new WorkspaceGrantStore(
			join(storage, "private", "workspace-grants.json"),
			() => NOW,
		);
		await store.add(available);
		await store.add(unavailable);
		rmSync(unavailable, { recursive: true });

		expect(await store.list()).toEqual([availableProject]);
		expect(await store.statusList()).toEqual([
			{ ...availableProject, available: true },
			{ ...unavailableProject, available: false },
		]);
		expect(await store.configuredPaths()).toEqual([
			availablePath,
			unavailablePath,
		]);

		await store.add(addedLater);
		expect(await store.configuredPaths()).toEqual([
			availablePath,
			unavailablePath,
			addedLaterPath,
		]);

		await store.remove(available);
		expect(await store.configuredPaths()).toEqual([
			unavailablePath,
			addedLaterPath,
		]);
		expect(await store.list()).toEqual([
			{ ...addedLaterProject, order: 1 },
		]);

		await store.remove(unavailablePath);
		expect(await store.configuredPaths()).toEqual([addedLaterPath]);
		expect(await store.statusList()).toEqual([
			{ ...addedLaterProject, order: 0, available: true },
		]);
	});

	it("migrates legacy metadata once and canonicalizes existing project paths", async () => {
		const storage = mkdtempSync(join(tmpdir(), "kestrel-grants-"));
		directories.push(storage);
		const workspace = join(storage, "workspace");
		const alias = join(storage, "workspace-alias");
		const filename = join(storage, "private", "workspace-grants.json");
		mkdirSync(workspace);
		mkdirSync(join(storage, "private"));
		symlinkSync(workspace, alias, "dir");
		writeFileSync(
			filename,
			JSON.stringify([
				{
					path: alias,
					name: "Legacy workspace",
					id: "legacy-project",
					order: 4,
				},
			]),
		);
		const store = new WorkspaceGrantStore(filename, () => NOW);
		const canonical = realpathSync(workspace);
		const expected = {
			id: "legacy-project",
			path: canonical,
			name: "Legacy workspace",
			createdAt: "1970-01-01T00:00:00.000Z",
			updatedAt: "1970-01-01T00:00:00.000Z",
			order: 0,
		};

		expect(await store.projects()).toEqual([expected]);
		const persisted = readFileSync(filename, "utf8");
		expect(JSON.parse(persisted)).toEqual([expected]);
		expect(await store.projects()).toEqual([expected]);
		expect(readFileSync(filename, "utf8")).toBe(persisted);
	});

	it("keeps valid paths from malformed legacy entries and drops unsafe entries", async () => {
		const storage = mkdtempSync(join(tmpdir(), "kestrel-grants-"));
		directories.push(storage);
		const workspace = join(storage, "workspace");
		const missing = join(storage, "missing");
		const filename = join(storage, "workspace-grants.json");
		mkdirSync(workspace);
		writeFileSync(
			filename,
			JSON.stringify([
				{
					path: workspace,
					name: 42,
					instructions: { unexpected: true },
					createdAt: "not-a-date",
					updatedAt: null,
					order: "first",
				},
				{ path: missing, name: "Missing project", id: 7 },
				{ path: 42, name: "Unaddressable" },
				{ path: "/", name: "Unsafe" },
			]),
		);
		const store = new WorkspaceGrantStore(filename, () => NOW);
		const projects = await store.projects();

		expect(projects).toEqual([
			{
				...project(realpathSync(workspace), "workspace", 0),
				createdAt: "1970-01-01T00:00:00.000Z",
				updatedAt: "1970-01-01T00:00:00.000Z",
			},
			{
				...project(missing, "Missing project", 1),
				createdAt: "1970-01-01T00:00:00.000Z",
				updatedAt: "1970-01-01T00:00:00.000Z",
			},
		]);
		expect(await store.statusList()).toEqual([
			{
				...project(realpathSync(workspace), "workspace", 0),
				createdAt: "1970-01-01T00:00:00.000Z",
				updatedAt: "1970-01-01T00:00:00.000Z",
				available: true,
			},
			{
				...project(missing, "Missing project", 1),
				createdAt: "1970-01-01T00:00:00.000Z",
				updatedAt: "1970-01-01T00:00:00.000Z",
				available: false,
			},
		]);
	});

	it("deduplicates canonical paths and repairs duplicate project IDs", async () => {
		const storage = mkdtempSync(join(tmpdir(), "kestrel-grants-"));
		directories.push(storage);
		const first = join(storage, "first");
		const second = join(storage, "second");
		const filename = join(storage, "workspace-grants.json");
		mkdirSync(first);
		mkdirSync(second);
		writeFileSync(
			filename,
			JSON.stringify([
				{ path: first, name: "First", id: "shared" },
				{ path: join(first, "."), name: "Duplicate path", id: "other" },
				{ path: second, name: "Second", id: "shared" },
			]),
		);
		const store = new WorkspaceGrantStore(filename, () => NOW);
		const firstPath = realpathSync(first);
		const secondPath = realpathSync(second);

		expect(await store.projects()).toEqual([
			{
				id: "shared",
				path: firstPath,
				name: "First",
				createdAt: "1970-01-01T00:00:00.000Z",
				updatedAt: "1970-01-01T00:00:00.000Z",
				order: 0,
			},
			{
				...project(secondPath, "Second", 1),
				createdAt: "1970-01-01T00:00:00.000Z",
				updatedAt: "1970-01-01T00:00:00.000Z",
			},
		]);
	});

	it("allows project instructions to be cleared without leaving stale metadata", async () => {
		const storage = mkdtempSync(join(tmpdir(), "kestrel-grants-"));
		directories.push(storage);
		const workspace = join(storage, "workspace");
		mkdirSync(workspace);
		let now = NOW;
		const store = new WorkspaceGrantStore(
			join(storage, "workspace-grants.json"),
			() => now,
		);
		const [created] = await store.add(workspace);
		if (!created) throw new Error("Project fixture was not created.");
		now = "2026-09-03T00:01:00.000Z";
		expect(
			await store.update(created.id, {
				name: "Renamed",
				instructions: "Use concise answers.",
			}),
		).toEqual([
				{
					...created,
					name: "Renamed",
					instructions: "Use concise answers.",
					updatedAt: now,
					available: true,
				},
			]);

		now = "2026-09-03T00:02:00.000Z";
		const cleared = await store.update(created.id, { instructions: "" });
		expect(cleared[0]).not.toHaveProperty("instructions");
		expect(cleared[0]).toMatchObject({ name: "Renamed", updatedAt: now });
		expect(readFileSync(join(storage, "workspace-grants.json"), "utf8")).not.toContain(
			"Use concise answers.",
		);
	});

	it("does not overwrite a malformed top-level store", async () => {
		const storage = mkdtempSync(join(tmpdir(), "kestrel-grants-"));
		directories.push(storage);
		const filename = join(storage, "workspace-grants.json");
		writeFileSync(filename, JSON.stringify({ projects: [] }));
		const store = new WorkspaceGrantStore(filename, () => NOW);

		await expect(store.projects()).rejects.toThrow("must contain an array");
		expect(readFileSync(filename, "utf8")).toBe('{"projects":[]}');
	});

	it("serializes concurrent mutations from separate store instances", async () => {
		const storage = mkdtempSync(join(tmpdir(), "kestrel-grants-"));
		directories.push(storage);
		const first = join(storage, "first");
		const second = join(storage, "second");
		const filename = join(storage, "private", "workspace-grants.json");
		mkdirSync(first);
		mkdirSync(second);
		const firstStore = new WorkspaceGrantStore(filename);
		const secondStore = new WorkspaceGrantStore(filename);

		await Promise.all([firstStore.add(first), secondStore.add(second)]);

		expect(await firstStore.configuredPaths()).toEqual([
			realpathSync(first),
			realpathSync(second),
		]);
	});
});
