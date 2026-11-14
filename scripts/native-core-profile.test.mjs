import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNativeCoreProfile } from "../apps/native-chromium-host/resources/native-core-profile.mjs";

const profiles = [];
async function profile() {
	const root = await mkdtemp(join(tmpdir(), "kestrel-native-core-profile-test-"));
	profiles.push(root);
	return realpath(root);
}
const key = () => randomBytes(32).toString("base64");
afterEach(async () => {
	await Promise.all(profiles.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native Core profile ownership", () => {
	it("uses the same host-supplied durable key after close without writing a key file", async () => {
		const root = await profile();
		const protectedKeyBase64 = key();
		const first = await openNativeCoreProfile(root, { durable: true, protectedKeyBase64 });
		await writeFile(first.databasePath, "encrypted database fixture");
		await first.close();
		const second = await openNativeCoreProfile(root, { durable: true, protectedKeyBase64 });
		expect(second.databasePath).toBe(first.databasePath);
		expect(second.encryptionKeyBase64).toBe(protectedKeyBase64);
		expect((await lstat(second.root)).mode & 0o777).toBe(0o700);
		await expect(lstat(join(first.root, "database.key"))).rejects.toMatchObject({ code: "ENOENT" });
		await second.close();
		expect(await readFile(first.databasePath, "utf8")).toBe("encrypted database fixture");
	});

	it("requires a valid host key for durable profiles and preserves data on failure", async () => {
		const root = await profile();
		await expect(openNativeCoreProfile(root, { durable: true })).rejects.toThrow(/trusted host/);
		await expect(openNativeCoreProfile(root, { durable: true, protectedKeyBase64: "short" })).rejects.toThrow(/malformed/);
		expect(await lstat(join(root, "native-core")).catch(() => undefined)).toBeUndefined();
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

	it("does not create a new durable key over an existing database", async () => {
		const root = await profile();
		const opened = await openNativeCoreProfile(root, { durable: true, protectedKeyBase64: key() });
		await writeFile(opened.databasePath, "preserve me");
		await expect(openNativeCoreProfile(root, { durable: true })).rejects.toThrow(/trusted host/);
		expect(await readFile(opened.databasePath, "utf8")).toBe("preserve me");
	});

	it.each(["symlink", "public", "truncated"])("rejects a legacy %s key without altering it", async (kind) => {
		const root = await profile();
		const opened = await openNativeCoreProfile(root, { durable: true, protectedKeyBase64: key() });
		const keyPath = join(opened.root, "database.key");
		const fixture = Buffer.from("legacy-key-fixture");
		if (kind === "symlink") {
			const target = join(root, "external-key");
			await writeFile(target, fixture, { mode: 0o600 });
			await symlink(target, keyPath);
		} else if (kind === "public") {
			await writeFile(keyPath, fixture, { mode: 0o644 });
		} else {
			await writeFile(keyPath, "invalid");
		}
		await expect(openNativeCoreProfile(root, { durable: true, protectedKeyBase64: key() })).rejects.toThrow(/legacy file-backed key/);
		if (kind === "symlink") expect(await readFile(join(root, "external-key"))).toEqual(fixture);
		else expect(await readFile(keyPath)).toEqual(kind === "truncated" ? Buffer.from("invalid") : fixture);
	});

	it("rejects linked profile subdirectories and linked databases", async () => {
		const root = await profile();
		const outside = join(root, "outside");
		await mkdir(outside, { mode: 0o700 });
		await symlink(outside, join(root, "native-core"));
		await expect(openNativeCoreProfile(root, { durable: true, protectedKeyBase64: key() })).rejects.toThrow(/private directory/);
		await rm(join(root, "native-core"));
		const opened = await openNativeCoreProfile(root, { durable: true, protectedKeyBase64: key() });
		const externalDb = join(outside, "db");
		await writeFile(externalDb, "untouched");
		await symlink(externalDb, opened.databasePath);
		await expect(openNativeCoreProfile(root, { durable: true, protectedKeyBase64: key() })).rejects.toThrow(/regular files/);
		expect(await readFile(externalDb, "utf8")).toBe("untouched");
	});
});
