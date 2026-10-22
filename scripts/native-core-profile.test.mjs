import { afterEach, describe, expect, it } from "vitest";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNativeCoreProfile } from "../apps/native-chromium-host/resources/native-core-profile.mjs";

const profiles = [];
async function profile() {
	const root = await mkdtemp(join(tmpdir(), "kestrel-native-core-profile-test-"));
	profiles.push(root);
	return root;
}
afterEach(async () => {
	await Promise.all(profiles.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native Core profile ownership", () => {
	it("keeps the same durable key and database path after closing", async () => {
		const root = await profile();
		const first = await openNativeCoreProfile(root, { durable: true });
		await writeFile(first.databasePath, "encrypted database fixture");
		const key = first.encryptionKeyBase64;
		await first.close();
		const second = await openNativeCoreProfile(root, { durable: true });
		expect(second.databasePath).toBe(first.databasePath);
		expect(second.encryptionKeyBase64).toBe(key);
		expect(Buffer.from(key, "base64")).toHaveLength(32);
		expect((await lstat(join(first.root, "database.key"))).mode & 0o777).toBe(0o600);
		expect((await lstat(second.root)).mode & 0o777).toBe(0o700);
		await second.close();
		expect(await readFile(first.databasePath, "utf8")).toBe("encrypted database fixture");
	});

	it("cleans only its own disposable directory", async () => {
		const root = await profile();
		await writeFile(join(root, "preserved.txt"), "keep");
		const first = await openNativeCoreProfile(root);
		const second = await openNativeCoreProfile(root);
		expect(first.root).not.toBe(second.root);
		expect(first.encryptionKeyBase64).not.toBe(second.encryptionKeyBase64);
		await first.close();
		await expect(lstat(first.root)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await lstat(second.root)).isDirectory()).toBe(true);
		expect(await readFile(join(root, "preserved.txt"), "utf8")).toBe("keep");
		await second.close();
	});

	it("refuses to rotate a missing key over existing data", async () => {
		const root = await profile();
		const opened = await openNativeCoreProfile(root, { durable: true });
		await writeFile(opened.databasePath, "preserve me");
		await rm(join(opened.root, "database.key"));
		await expect(openNativeCoreProfile(root, { durable: true })).rejects.toThrow(/key is missing/);
		expect(await readFile(opened.databasePath, "utf8")).toBe("preserve me");
		await expect(lstat(join(opened.root, "database.key"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each(["symlink", "hardlink", "public", "truncated"])("rejects a %s key without altering it", async (kind) => {
		const root = await profile();
		const opened = await openNativeCoreProfile(root, { durable: true });
		const key = join(opened.root, "database.key");
		const before = await readFile(key);
		if (kind === "symlink") {
			await rm(key);
			const target = join(root, "external-key");
			await writeFile(target, before, { mode: 0o600 });
			await symlink(target, key);
		} else if (kind === "hardlink") {
			await link(key, join(root, "linked-key"));
		} else if (kind === "public") {
			await chmod(key, 0o644);
		} else {
			await writeFile(key, "invalid");
		}
		await expect(openNativeCoreProfile(root, { durable: true })).rejects.toThrow();
		expect(await readFile(key)).toEqual(kind === "truncated" ? Buffer.from("invalid") : before);
	});

	it("rejects linked profile subdirectories and linked databases", async () => {
		const root = await profile();
		const outside = join(root, "outside");
		await mkdir(outside, { mode: 0o700 });
		await symlink(outside, join(root, "native-core"));
		await expect(openNativeCoreProfile(root, { durable: true })).rejects.toThrow(/private directory/);
		await rm(join(root, "native-core"));
		const opened = await openNativeCoreProfile(root, { durable: true });
		const externalDb = join(outside, "db");
		await writeFile(externalDb, "untouched");
		await symlink(externalDb, opened.databasePath);
		await expect(openNativeCoreProfile(root, { durable: true })).rejects.toThrow(/regular files/);
		expect(await readFile(externalDb, "utf8")).toBe("untouched");
	});
});
