import { afterEach, describe, expect, it } from "vitest";
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoExactExecutableRunning, validateRealKeychainCandidate } from "./native-real-keychain-candidate.mjs";

const roots = [];
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "kestrel-keychain-candidate-test-")));
	roots.push(root);
	const tempRoot = join(root, ".tmp");
	await mkdir(tempRoot, { mode: 0o700 });
	return { root, tempRoot };
}
async function candidate(tempRoot, name = "native-project-metadata-host", executableKind = "file") {
	const app = join(tempRoot, name, "Kestrel.app");
	const contents = join(app, "Contents");
	const macos = join(contents, "MacOS");
	await mkdir(macos, { recursive: true, mode: 0o700 });
	const executable = join(macos, "Kestrel");
	if (executableKind === "directory") await mkdir(executable);
	else if (executableKind === "symlink") await symlink(join(tempRoot, "external-executable"), executable);
	else await writeFile(executable, "fixture", { mode: executableKind === "nonexecuting" ? 0o600 : 0o700 });
	for (const path of [join(tempRoot, name), app, contents, macos]) await chmod(path, 0o700);
	return { app, contents, macos, executable };
}
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("real-Keychain candidate boundaries", () => {
	it("accepts a valid separately named direct build candidate", async () => {
		const { root, tempRoot } = await fixture();
		const valid = await candidate(tempRoot);
		expect(await validateRealKeychainCandidate(valid.app, { root })).toEqual({
			candidate: valid.app,
			executable: valid.executable,
			buildName: "native-project-metadata-host",
		});
	});

	it("rejects candidates outside repository .tmp, including canonical-style paths", async () => {
		const { root } = await fixture();
		await expect(validateRealKeychainCandidate(join(root, "outside", "Kestrel.app"), { root })).rejects.toThrow();
		await expect(validateRealKeychainCandidate("/Applications/Kestrel.app", { root })).rejects.toThrow();
		const valid = await candidate(join(root, ".tmp"));
		await expect(validateRealKeychainCandidate(`${root}/.tmp/ignored/../native-project-metadata-host/Kestrel.app`, { root })).rejects.toThrow(/canonical/);
		await expect(validateRealKeychainCandidate(valid.app.replace(root, "."), { root })).rejects.toThrow(/canonical/);
	});

	it("rejects relative and lexically noncanonical candidate paths", async () => {
		const { root, tempRoot } = await fixture();
		const valid = await candidate(tempRoot);
		for (const supplied of [".tmp/native-project-metadata-host/Kestrel.app", `${valid.app}/.`]) {
			await expect(validateRealKeychainCandidate(supplied, { root })).rejects.toThrow(/absolute and canonical/);
		}
	});

	it("rejects a symlinked .tmp root", async () => {
		const { root, tempRoot } = await fixture();
		await rm(tempRoot, { recursive: true });
		const target = join(root, "tmp-target");
		await mkdir(target, { mode: 0o700 });
		await symlink(target, tempRoot);
		const valid = await candidate(target);
		await expect(validateRealKeychainCandidate(valid.app, { root })).rejects.toThrow(/symlink/);
	});

	it.each(["Contents", "MacOS"]) ("rejects a valid-shape candidate with a symlinked %s component", async component => {
		const { root, tempRoot } = await fixture();
		const app = join(tempRoot, "symlink-component", "Kestrel.app");
		const external = join(root, `external-${component}`);
		const externalMacos = join(external, "MacOS");
		await mkdir(externalMacos, { recursive: true, mode: 0o700 });
		await writeFile(join(externalMacos, "Kestrel"), "fixture", { mode: 0o700 });
		await mkdir(join(tempRoot, "symlink-component"), { mode: 0o700 });
		await mkdir(app, { mode: 0o700 });
		if (component === "Contents") await symlink(external, join(app, "Contents"));
		else {
			await mkdir(join(app, "Contents"), { mode: 0o700 });
			await symlink(externalMacos, join(app, "Contents", "MacOS"));
		}
		await expect(validateRealKeychainCandidate(app, { root })).rejects.toThrow();
	});

	it("always rejects the protected default build name", async () => {
		const { root, tempRoot } = await fixture();
		const reserved = await candidate(tempRoot, "native-chromium-host");
		await expect(validateRealKeychainCandidate(reserved.app, { root })).rejects.toThrow(/reserved/);
	});

	it.each(["build", "app"]) ("rejects a group/world-writable %s directory", async target => {
		const { root, tempRoot } = await fixture();
		const valid = await candidate(tempRoot);
		const path = target === "build" ? join(tempRoot, "native-project-metadata-host") : valid.app;
		await chmod(path, 0o777);
		await expect(validateRealKeychainCandidate(valid.app, { root })).rejects.toThrow(/writable/);
	});

	it("rejects a group/world-writable executable", async () => {
		const { root, tempRoot } = await fixture();
		const valid = await candidate(tempRoot);
		await chmod(valid.executable, 0o777);
		await expect(validateRealKeychainCandidate(valid.app, { root })).rejects.toThrow(/non-writable/);
	});

	it("rejects an owner mismatch using the injected expected uid", async () => {
		const { root, tempRoot } = await fixture();
		const valid = await candidate(tempRoot);
		await expect(validateRealKeychainCandidate(valid.app, { root, uid: process.getuid() + 1 })).rejects.toThrow(/owned/);
	});

	it.each(["directory", "symlink", "nonexecuting"]) ("rejects a %s executable", async kind => {
		const { root, tempRoot } = await fixture();
		const valid = await candidate(tempRoot, `wrong-${kind}`, kind);
		await expect(validateRealKeychainCandidate(valid.app, { root })).rejects.toThrow();
	});

	it("rejects an executable with a hardlink alias", async () => {
		const { root, tempRoot } = await fixture();
		const valid = await candidate(tempRoot, "hardlinked");
		await link(valid.executable, join(tempRoot, "hardlinked", "executable-alias"));
		await expect(validateRealKeychainCandidate(valid.app, { root })).rejects.toThrow(/single-link/);
	});

	it("rejects control characters in the resolved candidate path", async () => {
		const { root, tempRoot } = await fixture();
		const valid = await candidate(tempRoot);
		await expect(validateRealKeychainCandidate(`${valid.app}\nforged-process-line`, { root })).rejects.toThrow(/control characters/);
	});
});

describe("exact running-executable guard", () => {
	it("matches only the complete comm path, including paths with spaces", () => {
		const executable = "/tmp/build with spaces/Kestrel.app/Contents/MacOS/Kestrel";
		const ps = () => `  201 ${executable}-suffix\n  202 /other/${executable}\n`;
		expect(() => assertNoExactExecutableRunning(executable, { ps })).not.toThrow();
		expect(() => assertNoExactExecutableRunning(executable, { ps: () => `  203 ${executable}\n` })).toThrow(/already running/);
	});

	it("fails closed when ps cannot provide a process list", () => {
		expect(() => assertNoExactExecutableRunning("/tmp/Kestrel", {
			ps: () => { throw new Error("ps failed"); },
		})).toThrow("ps failed");
	});
});
