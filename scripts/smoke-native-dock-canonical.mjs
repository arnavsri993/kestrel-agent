#!/usr/bin/env node

/**
 * Canonical Dock cutover evidence for native Chromium:
 * install into an isolated Applications root as Kestrel.app and prove the
 * installed bundle is Electron-free. Does not touch the real /Applications.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(
	process.env.KESTREL_NATIVE_TEST_APP ??
		join(root, "release", "native-mac-arm64", "Kestrel.app"),
);

assert.ok(existsSync(source), `Native app missing at ${source}`);

const installRoot = mkdtempSync(join(tmpdir(), "kestrel-dock-canonical-"));
try {
	const install = spawnSync(
		process.execPath,
		[join(root, "scripts", "install-native-chromium-macos.mjs"), source],
		{
			encoding: "utf8",
			env: {
				...process.env,
				KESTREL_MACOS_INSTALL_ROOT: installRoot,
				KESTREL_INSTALL_NATIVE_CANONICAL: "1",
			},
		},
	);
	assert.equal(
		install.status,
		0,
		`canonical install failed:\n${install.stdout || ""}\n${install.stderr || ""}`,
	);

	const installed = join(installRoot, "Kestrel.app");
	assert.ok(existsSync(installed), `Expected canonical app at ${installed}`);
	assert.ok(
		!existsSync(join(installRoot, "Kestrel Native.app")),
		"Canonical cutover must install Kestrel.app, not the side-by-side name",
	);

	const bundleCheck = spawnSync(
		process.execPath,
		[join(root, "scripts", "smoke-native-zero-electron-bundle.mjs")],
		{
			encoding: "utf8",
			env: {
				...process.env,
				KESTREL_NATIVE_TEST_APP: installed,
			},
		},
	);
	process.stdout.write(bundleCheck.stdout || "");
	process.stderr.write(bundleCheck.stderr || "");
	assert.equal(bundleCheck.status, 0, "installed Dock app still contains Electron");

	console.log(
		`verify:dock-canonical ok — installed Electron-free Kestrel.app under ${installRoot}`,
	);
} finally {
	rmSync(installRoot, { recursive: true, force: true });
}
