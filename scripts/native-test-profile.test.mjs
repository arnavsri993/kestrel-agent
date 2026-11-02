import { afterEach, describe, expect, it } from "vitest";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markDisposableNativeTestProfile, validateDisposableNativeTestProfile } from "./native-test-profile.mjs";

const roots = [];
async function profile() {
	const root = await mkdtemp(join(tmpdir(), "kestrel-native-test-marker-"));
	roots.push(root);
	return realpath(root);
}
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("disposable native test profile marker", () => {
	it("creates a private marker once for a fresh temporary profile", async () => {
		const root = await profile();
		await markDisposableNativeTestProfile(root);
		const marker = join(root, ".kestrel-native-test-profile-v1");
		expect(await readFile(marker, "utf8")).toBe("native-test-profile-v1\n");
		expect((await lstat(marker)).mode & 0o777).toBe(0o600);
		const testKey = await stat(join(root, ".kestrel-native-test-core-key-v1"));
		expect(testKey.size).toBe(32);
		expect(testKey.mode & 0o777).toBe(0o600);
		await expect(markDisposableNativeTestProfile(root)).rejects.toThrow();
		expect(await validateDisposableNativeTestProfile(root)).toBe(root);
	});

	it("rejects linked profile roots", async () => {
		const root = await profile();
		const link = join(root, "linked");
		await symlink(root, link);
		await expect(markDisposableNativeTestProfile(link)).rejects.toThrow(/fresh owned private temporary profile/);
	});

	it.each(["marker", "key-permissions", "linked-key"])("rejects a retained profile with invalid %s", async invalid => {
		const root = await profile(); await markDisposableNativeTestProfile(root);
		const key = join(root, ".kestrel-native-test-core-key-v1");
		if (invalid === "marker") await writeFile(join(root, ".kestrel-native-test-profile-v1"), "invalid-test-profile-v1\n");
		else if (invalid === "key-permissions") await chmod(key, 0o644);
		else { await rm(key); await symlink(join(root, ".kestrel-native-test-profile-v1"), key); }
		await expect(validateDisposableNativeTestProfile(root)).rejects.toThrow(/fixture marker|fixture.*metadata/);
	});
});
