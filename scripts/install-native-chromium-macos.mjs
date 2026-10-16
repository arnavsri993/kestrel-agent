#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Updates the one canonical Kestrel app only after cutover acceptance and live
 * signing checks. Never leave a second installed Kestrel Native.app behind.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(
	process.argv[2] ?? join(root, "release", "native-mac-arm64", "Kestrel.app"),
);
const installRoot = resolve(process.env.KESTREL_MACOS_INSTALL_ROOT ?? "/Applications");
if (process.env.KESTREL_INSTALL_NATIVE_CANONICAL !== "1") {
	throw new Error("Native cutover is not accepted. No app was installed. Verify the retirement gates before replacing /Applications/Kestrel.app; use dev:desktop:chromium for isolated development.");
}

if (!existsSync(source)) {
	throw new Error(
		`Native Chromium package missing at ${source}. Run corepack pnpm package:mac:native first.`,
	);
}

for (const [script, args] of [
	["check-electron-retirement-gates.mjs", []],
	["check-native-signing.mjs", [source]],
]) {
	const checked = spawnSync(process.execPath, [join(root, "scripts", script), ...args], { stdio: "inherit" });
	if (checked.status !== 0) process.exit(checked.status ?? 1);
}

const result = spawnSync(
	process.execPath,
	[join(root, "scripts", "install-development-macos-app.mjs"), source],
	{ stdio: "inherit", env: { ...process.env, KESTREL_MACOS_INSTALL_ROOT: installRoot } },
);
process.exit(result.status ?? 1);
