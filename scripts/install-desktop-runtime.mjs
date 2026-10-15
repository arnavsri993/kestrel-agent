#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Installs the selected desktop runtime. Chromium (native CEF) is the default
 * Dock app path. Electron remains available through
 * KESTREL_DESKTOP_RUNTIME=electron. Profiles are never merged or deleted.
 *
 * Canonical /Applications/Kestrel.app install is the Chromium happy path
 * (KESTREL_INSTALL_NATIVE_CANONICAL defaults to 1). Set it to 0 for a
 * side-by-side Kestrel Native.app install.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = (process.env.KESTREL_DESKTOP_RUNTIME ?? "chromium").toLowerCase();

if (runtime === "chromium" || runtime === "native") {
	const env = { ...process.env };
	if (env.KESTREL_INSTALL_NATIVE_CANONICAL === undefined) {
		env.KESTREL_INSTALL_NATIVE_CANONICAL = "1";
	}
	const pack = spawnSync("corepack", ["pnpm", "package:mac:native"], {
		stdio: "inherit",
		cwd: root,
		env,
	});
	if (pack.status !== 0) process.exit(pack.status ?? 1);
	const install = spawnSync(
		process.execPath,
		[join(root, "scripts", "install-native-chromium-macos.mjs")],
		{ stdio: "inherit", cwd: root, env },
	);
	process.exit(install.status ?? 1);
}

if (runtime === "electron") {
	console.warn(
		"[kestrel] Installing Electron is opt-in. Prefer Chromium (default) unless you need the legacy lane.",
	);
	const result = spawnSync("corepack", ["pnpm", "install:mac:electron"], {
		stdio: "inherit",
		cwd: root,
		env: process.env,
	});
	process.exit(result.status ?? 1);
}

console.error(
	`Unknown KESTREL_DESKTOP_RUNTIME=${runtime}. Use chromium (default) or electron.`,
);
process.exit(1);
