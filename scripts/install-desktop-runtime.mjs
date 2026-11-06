#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Installs the selected desktop runtime. Electron remains the default Dock app.
 * Native Chromium replaces the same app only after parity acceptance and live
 * Developer ID signing / notarization checks.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = (process.env.KESTREL_DESKTOP_RUNTIME ?? "electron").toLowerCase();

if (runtime === "chromium" || runtime === "native") {
	const pack = spawnSync("corepack", ["pnpm", "package:mac:native"], {
		stdio: "inherit",
		cwd: root,
		env: process.env,
	});
	if (pack.status !== 0) process.exit(pack.status ?? 1);
	const install = spawnSync(
		process.execPath,
		[join(root, "scripts", "install-native-chromium-macos.mjs")],
		{ stdio: "inherit", cwd: root, env: process.env },
	);
	process.exit(install.status ?? 1);
}

const result = spawnSync("corepack", ["pnpm", "install:mac:dev"], {
	stdio: "inherit",
	cwd: root,
	env: process.env,
});
process.exit(result.status ?? 1);
