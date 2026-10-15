#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Installs the selected desktop runtime. Chromium is the default product path
 * and replaces `/Applications/Kestrel.app` (canonical Dock app). Electron
 * remains available via KESTREL_DESKTOP_RUNTIME=electron or
 * `pnpm install:mac:dev:electron`.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = (process.env.KESTREL_DESKTOP_RUNTIME ?? "chromium").toLowerCase();

if (runtime === "electron") {
	console.warn(
		"[deprecated] Electron install path. Prefer `pnpm install:mac:dev` (Chromium).",
	);
	const result = spawnSync("corepack", ["pnpm", "install:mac:dev:electron"], {
		stdio: "inherit",
		cwd: root,
		env: process.env,
	});
	process.exit(result.status ?? 1);
}

if (runtime !== "chromium" && runtime !== "native") {
	console.error(
		`Unknown KESTREL_DESKTOP_RUNTIME=${runtime}. Use chromium or electron.`,
	);
	process.exit(1);
}

const pack = spawnSync("corepack", ["pnpm", "package:mac:native"], {
	stdio: "inherit",
	cwd: root,
	env: process.env,
});
if (pack.status !== 0) process.exit(pack.status ?? 1);

const install = spawnSync(
	process.execPath,
	[join(root, "scripts", "install-native-chromium-macos.mjs")],
	{
		stdio: "inherit",
		cwd: root,
		env: {
			...process.env,
			// Primary product path owns the canonical Dock app.
			KESTREL_INSTALL_NATIVE_CANONICAL:
				process.env.KESTREL_INSTALL_NATIVE_CANONICAL ?? "1",
		},
	},
);
process.exit(install.status ?? 1);
