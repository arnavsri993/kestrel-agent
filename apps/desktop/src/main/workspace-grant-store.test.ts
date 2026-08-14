import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceGrantStore } from "./workspace-grant-store";

const directories: string[] = [];

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
		const store = new WorkspaceGrantStore(filename);
		const added = await store.add(workspace);
		expect(added).toEqual([{ path: realpathSync(workspace), name: "project" }]);
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
		const store = new WorkspaceGrantStore(
			join(storage, "private", "workspace-grants.json"),
		);
		await store.add(available);
		await store.add(unavailable);
		rmSync(unavailable, { recursive: true });

		expect(await store.list()).toEqual([
			{ path: availablePath, name: "available" },
		]);
		expect(await store.statusList()).toEqual([
			{ path: availablePath, name: "available", available: true },
			{ path: unavailablePath, name: "unavailable", available: false },
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
			{ path: addedLaterPath, name: "added-later" },
		]);

		await store.remove(unavailablePath);
		expect(await store.configuredPaths()).toEqual([addedLaterPath]);
		expect(await store.statusList()).toEqual([
			{ path: addedLaterPath, name: "added-later", available: true },
		]);
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
