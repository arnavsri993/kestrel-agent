import { execFileSync } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createVerifiedNativeCoreBackup, VerifiedNativeCoreBackupError, type VerifiedNativeCoreBackupOptions } from "./verified-native-core-backup";

const roots: string[] = [];
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "native-core-backup-test-"));
	roots.push(root);
	const source = join(root, "source");
	const destination = join(root, "destination");
	await mkdir(source, { mode: 0o700 });
	await mkdir(destination, { mode: 0o700 });
	await mkdir(join(source, "database"), { mode: 0o700 });
	await writeFile(join(source, "database", "kestrel.sqlite"), Buffer.from("fixture-db"), { mode: 0o600 });
	await mkdir(join(source, "memory"), { mode: 0o700 });
	await chmod(join(source, "memory"), 0o755);
	await writeFile(join(source, "memory", "notes.json"), Buffer.from("{\"kept\":true}\n"), { mode: 0o600 });
	await writeFile(join(source, "excluded-secret.txt"), Buffer.from("must not be copied"), { mode: 0o600 });
	const options: Omit<VerifiedNativeCoreBackupOptions, "publishDirectory"> = {
		sourceRoot: source,
		destinationParent: destination,
		forbiddenDestinationRoots: [],
		entries: ["database", "memory"],
		appVersion: "1.2.3-test",
	};
	const publishDirectory: VerifiedNativeCoreBackupOptions["publishDirectory"] = async (stagingPath, finalPath, identity) => {
		const [parent, stage] = await Promise.all([lstat(destination, { bigint: true }), lstat(stagingPath, { bigint: true })]);
		expect(parent.dev.toString()).toBe(identity.parentDev);
		expect(parent.ino.toString()).toBe(identity.parentIno);
		expect(stage.dev.toString()).toBe(identity.stagingDev);
		expect(stage.ino.toString()).toBe(identity.stagingIno);
		await rename(stagingPath, finalPath);
	};
	return { root, source, destination, options, publishDirectory };
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it("copies only selected entries, verifies hashes, and preserves the source", async () => {
	const f = await fixture();
	const result = await createVerifiedNativeCoreBackup({ ...f.options, publishDirectory: f.publishDirectory });
	expect(result).toMatchObject({ files: 2, bytes: 24, verified: true });
	expect(result.path.startsWith(`${await realpath(f.destination)}/`)).toBe(true);
	expect(await readFile(join(result.path, "database", "kestrel.sqlite"), "utf8")).toBe("fixture-db");
	expect(await readFile(join(result.path, "memory", "notes.json"), "utf8")).toBe('{"kept":true}\n');
	await expect(readFile(join(result.path, "excluded-secret.txt"))).rejects.toMatchObject({ code: "ENOENT" });
	const manifest = JSON.parse(await readFile(join(result.path, "kestrel-native-core-backup.json"), "utf8"));
	expect(manifest).toMatchObject({ format: "native-core-data", version: 1, appVersion: "1.2.3-test" });
	expect(manifest.sourceRootHash).toMatch(/^[a-f0-9]{64}$/);
	expect(JSON.stringify(manifest)).not.toContain(f.source);
	expect(manifest.limitations).toContain("does not claim restore readiness");
	expect((await readdir(f.source)).sort()).toEqual(["database", "excluded-secret.txt", "memory"]);
	expect(await readFile(join(f.source, "database", "kestrel.sqlite"), "utf8")).toBe("fixture-db");
});

it("allows absent optional entries and ignores excluded ephemeral trees", async () => {
	const f = await fixture();
	await mkdir(join(f.source, "runtime-cache"), { mode: 0o700 });
	await symlink(join(f.source, "missing-target"), join(f.source, "runtime-cache", "ephemeral-link"));
	const result = await createVerifiedNativeCoreBackup({
		...f.options,
		entries: ["database", "memory", "optional-settings"],
		publishDirectory: f.publishDirectory,
	});
	expect(result.files).toBe(2);
	expect(await readdir(result.path)).toEqual(["database", "kestrel-native-core-backup.json", "memory"]);
});

it("copies only explicitly allowed secure children and excludes the database key and unknown files", async () => {
	const f = await fixture();
	await mkdir(join(f.source, "secure"), { mode: 0o700 });
	await mkdir(join(f.source, "secure", "credentials"), { mode: 0o700 });
	await writeFile(join(f.source, "secure", "credentials", "provider.bin"), "protected-fixture", { mode: 0o600 });
	await writeFile(join(f.source, "secure", "database-key.bin"), "database-key-fixture", { mode: 0o600 });
	await writeFile(join(f.source, "secure", "unexpected.json"), "unknown-secure-fixture", { mode: 0o600 });
	await symlink(join(f.source, "missing-target"), join(f.source, "secure", "unexpected-link"));
	const result = await createVerifiedNativeCoreBackup({
		...f.options,
		entries: ["database", "memory", "secure"],
		selectedChildren: { secure: ["credentials"] },
		publishDirectory: f.publishDirectory,
	});
	const secureOutput = join(result.path, "secure");
	expect(await readFile(join(secureOutput, "credentials", "provider.bin"), "utf8")).toBe("protected-fixture");
	await expect(readFile(join(secureOutput, "database-key.bin"))).rejects.toMatchObject({ code: "ENOENT" });
	await expect(readFile(join(secureOutput, "unexpected.json"))).rejects.toMatchObject({ code: "ENOENT" });
	await expect(lstat(join(secureOutput, "unexpected-link"))).rejects.toMatchObject({ code: "ENOENT" });
	const manifest = JSON.parse(await readFile(join(result.path, "kestrel-native-core-backup.json"), "utf8"));
	expect(manifest.files.map((file: { path: string }) => file.path)).not.toContain("secure/database-key.bin");
});

it("rejects unsafe or duplicate selected-child configuration", async () => {
	const f = await fixture();
	for (const selectedChildren of [
		{ missingRoot: ["child"] },
		{ memory: ["../escape"] },
		{ memory: ["notes.json", "notes.json"] },
	]) {
		await expect(createVerifiedNativeCoreBackup({ ...f.options, selectedChildren, publishDirectory: f.publishDirectory }))
			.rejects.toBeInstanceOf(VerifiedNativeCoreBackupError);
	}
	expect(await readdir(f.destination)).toEqual([]);
});

it("cancels before work without creating a staging directory", async () => {
	const f = await fixture();
	const controller = new AbortController();
	controller.abort();
	await expect(createVerifiedNativeCoreBackup({ ...f.options, signal: controller.signal, publishDirectory: f.publishDirectory }))
		.rejects.toMatchObject({ name: "VerifiedNativeCoreBackupError", code: "cancelled" });
	expect(await readdir(f.destination)).toEqual([]);
});

it.each(["symlink", "hardlink", "special"] as const)("refuses %s inputs and leaves no published backup", async kind => {
	const f = await fixture();
	const dir = join(f.source, "memory");
	if (kind === "symlink") await symlink(join(dir, "notes.json"), join(dir, "alias"));
	if (kind === "hardlink") await link(join(dir, "notes.json"), join(dir, "alias"));
	if (kind === "special") execFileSync("mkfifo", [join(dir, "pipe")]);
	await expect(createVerifiedNativeCoreBackup({ ...f.options, publishDirectory: f.publishDirectory }))
		.rejects.toBeInstanceOf(VerifiedNativeCoreBackupError);
	expect(await readdir(f.destination)).toEqual([]);
});

it("rejects a destination inside a source or forbidden browser/profile root", async () => {
	const f = await fixture();
	await expect(createVerifiedNativeCoreBackup({
		...f.options,
		destinationParent: join(f.source, "memory"),
		publishDirectory: f.publishDirectory,
	})).rejects.toBeInstanceOf(VerifiedNativeCoreBackupError);
	await expect(createVerifiedNativeCoreBackup({
		...f.options,
		forbiddenDestinationRoots: [f.destination],
		publishDirectory: f.publishDirectory,
	})).rejects.toBeInstanceOf(VerifiedNativeCoreBackupError);
	expect(await readdir(f.destination)).toEqual([]);
});

it("allows a destination parent above the source when the published child is outside it", async () => {
	const f = await fixture();
	const publisher: VerifiedNativeCoreBackupOptions["publishDirectory"] = async (stage, final) => rename(stage, final);
	const result = await createVerifiedNativeCoreBackup({
		...f.options,
		destinationParent: f.root,
		publishDirectory: publisher,
	});
	expect(result.path.startsWith(`${await realpath(f.root)}/Kestrel-Native-Core-`)).toBe(true);
	expect(await readFile(join(result.path, "database", "kestrel.sqlite"), "utf8")).toBe("fixture-db");
});

it("preserves a private incomplete stage when publishing fails and preserves late committed output", async () => {
	const f = await fixture();
	await expect(createVerifiedNativeCoreBackup({ ...f.options, publishDirectory: async () => { throw new Error(f.source); } }))
		.rejects.toMatchObject({ name: "VerifiedNativeCoreBackupError", code: "unsafe" });
	const incomplete = (await readdir(f.destination)).filter(name => name.endsWith(".partial"));
	expect(incomplete).toHaveLength(1);
	expect((await lstat(join(f.destination, incomplete[0]!))).mode & 0o777).toBe(0o700);

	const controller = new AbortController();
	let committedPath = "";
	const result = await createVerifiedNativeCoreBackup({
		...f.options,
		signal: controller.signal,
		publishDirectory: async (stagingPath, finalPath) => {
			await rename(stagingPath, finalPath);
			committedPath = finalPath;
			controller.abort();
		},
	});
	expect(result.path).toBe(committedPath);
	expect(await lstat(committedPath)).toMatchObject({ isDirectory: expect.any(Function) });
	expect(await readFile(join(committedPath, "database", "kestrel.sqlite"), "utf8")).toBe("fixture-db");
});

it("preserves its private incomplete staging directory on mid-copy cancellation", async () => {
	const f = await fixture();
	const large = Buffer.alloc(64 * 1024 * 1024, 0x41);
	await writeFile(join(f.source, "memory", "large.bin"), large, { mode: 0o600 });
	let checks = 0;
	const signal = { get aborted() { return ++checks >= 18; } } as AbortSignal;
	await expect(createVerifiedNativeCoreBackup({ ...f.options, signal, publishDirectory: f.publishDirectory }))
		.rejects.toMatchObject({ name: "VerifiedNativeCoreBackupError", code: "cancelled" });
	const partial = (await readdir(f.destination)).filter(name => name.endsWith(".partial"));
	expect(partial).toHaveLength(1);
	expect((await lstat(join(f.destination, partial[0]!))).mode & 0o777).toBe(0o700);
});

it("preserves an uncertain published backup when the publisher reports post-rename sync failure", async () => {
	const f = await fixture();
	let finalPath = "";
	const publisher = async (stage: string, final: string) => {
		await rename(stage, final);
		finalPath = final;
		throw Object.assign(new Error("private native detail"), { code: "KESTREL_BACKUP_COMMITTED_SYNC_UNCERTAIN" });
	};
	await expect(createVerifiedNativeCoreBackup({ ...f.options, publishDirectory: publisher }))
		.rejects.toMatchObject({ name: "VerifiedNativeCoreBackupError", code: "committedSyncUncertain" });
	expect(await readFile(join(finalPath, "database", "kestrel.sqlite"), "utf8")).toBe("fixture-db");
	expect((await readdir(f.destination)).some(name => name.endsWith(".partial"))).toBe(false);
});

it("cancels promptly during final staged-file rehash and preserves the partial stage", async () => {
	const f = await fixture();
	const contents = Buffer.alloc(64 * 1024 * 1024, 0x41);
	await writeFile(join(f.source, "database", "kestrel.sqlite"), contents, { mode: 0o600 });
	let rehashChecks = 0;
	const signal = {
		get aborted() {
			for (const name of readdirSync(f.destination)) {
				if (!name.endsWith(".partial")) continue;
				try {
					if (statSync(join(f.destination, name, "kestrel-native-core-backup.json")).size > 100) return ++rehashChecks >= 12;
				} catch { /* Manifest is not ready yet. */ }
			}
			return false;
		},
	} as AbortSignal;
	await expect(createVerifiedNativeCoreBackup({ ...f.options, signal, publishDirectory: f.publishDirectory }))
		.rejects.toMatchObject({
			name: "VerifiedNativeCoreBackupError",
			code: "cancelled",
			message: expect.stringContaining("incomplete staging directory may remain"),
		});
	expect(rehashChecks).toBeGreaterThanOrEqual(12);
	const partial = (await readdir(f.destination)).filter(name => name.endsWith(".partial"));
	expect(partial).toHaveLength(1);
	expect(await lstat(join(f.destination, partial[0]!, "database", "kestrel.sqlite"))).toMatchObject({ size: contents.length });
	expect((await readdir(f.destination)).some(name => name.startsWith("Kestrel-Native-Core-"))).toBe(false);
});

it("detects a same-size staged edit after the original copy hash", async () => {
	const f = await fixture();
	const contents = Buffer.alloc(64 * 1024 * 1024, 0x41);
	await writeFile(join(f.source, "memory", "large.bin"), contents, { mode: 0o600 });
	let changed = false;
	const mutateWhenComplete = async () => {
		const deadline = Date.now() + 15_000;
		while (!changed && Date.now() < deadline) {
			for (const name of await readdir(f.destination)) {
				if (!name.endsWith(".partial")) continue;
				const path = join(f.destination, name, "memory", "large.bin");
				try {
					const stat = await lstat(path);
					if (stat.size === contents.length) {
						const file = await open(path, "r+");
						try { await file.write(Buffer.from([0x42]), 0, 1, 0); await file.sync(); } finally { await file.close(); }
						changed = true;
						return;
					}
				} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			}
			await new Promise(resolve => setTimeout(resolve, 1));
		}
	};
	const mutator = mutateWhenComplete();
	await expect(createVerifiedNativeCoreBackup({ ...f.options, publishDirectory: f.publishDirectory }))
		.rejects.toBeInstanceOf(VerifiedNativeCoreBackupError);
	await mutator;
	expect(changed).toBe(true);
	expect((await readdir(f.destination)).some(name => name.endsWith(".partial"))).toBe(true);
});

it("rejects an existing final destination through the mandatory publisher boundary", async () => {
	const f = await fixture();
	const overwrite = async (_stage: string, finalPath: string) => {
		await mkdir(finalPath, { mode: 0o700 });
		throw new Error("no-replace publication refused");
	};
	await expect(createVerifiedNativeCoreBackup({ ...f.options, publishDirectory: overwrite })).rejects.toBeInstanceOf(VerifiedNativeCoreBackupError);
	expect((await readdir(f.destination)).some(name => name.endsWith(".partial"))).toBe(true);
});
