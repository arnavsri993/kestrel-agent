import { afterEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it.each([false, true])("preserves the canonical app when native acceptance/signing is missing (accepted=%s)", async (accepted) => {
	const root = await mkdtemp(join(tmpdir(), "kestrel-native-install-test-"));
	roots.push(root);
	const candidate = join(root, "candidate", "Kestrel.app");
	const canonical = join(root, "Applications", "Kestrel.app");
	await mkdir(candidate, { recursive: true });
	await mkdir(canonical, { recursive: true });
	await writeFile(join(canonical, "preserved.txt"), "working installed app");
	const result = spawnSync(process.execPath, [resolve("scripts/install-native-chromium-macos.mjs"), candidate], {
		encoding: "utf8",
		timeout: 20_000,
		env: {
			...process.env,
			KESTREL_MACOS_INSTALL_ROOT: join(root, "Applications"),
			KESTREL_INSTALL_NATIVE_CANONICAL: accepted ? "1" : "0",
			KESTREL_ACCEPT_ELECTRON_RETIREMENT: accepted ? "1" : "0",
			NOTARYTOOL_PROFILE: "", KESTREL_NOTARY_PROFILE: "",
			APPLE_ID: "", APPLE_APP_SPECIFIC_PASSWORD: "", APPLE_TEAM_ID: "",
		},
	});
	expect(result.status).not.toBe(0);
	expect(await readFile(join(canonical, "preserved.txt"), "utf8")).toBe("working installed app");
	expect(existsSync(join(root, "Applications", "Kestrel Native.app"))).toBe(false);
	expect(`${result.stdout}${result.stderr}`).toMatch(accepted ? /Signing.*blockers/s : /No app was installed/);
});
