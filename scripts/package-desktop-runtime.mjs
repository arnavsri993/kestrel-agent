#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Packages the selected desktop runtime. Chromium (native CEF) is the default
 * shipping path; Electron packaging remains available through
 * KESTREL_DESKTOP_RUNTIME=electron.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = (process.env.KESTREL_DESKTOP_RUNTIME ?? "chromium").toLowerCase();
const script =
	runtime === "electron"
		? "package:mac:electron"
		: runtime === "chromium" || runtime === "native"
			? "package:mac:native"
			: null;

if (!script) {
	console.error(
		`Unknown KESTREL_DESKTOP_RUNTIME=${runtime}. Use chromium (default) or electron.`,
	);
	process.exit(1);
}

if (runtime === "electron") {
	console.warn(
		"[kestrel] Packaging Electron is opt-in. Prefer Chromium (default) unless you need the legacy lane.",
	);
}

const result = spawnSync("corepack", ["pnpm", script], {
	stdio: "inherit",
	cwd: root,
	env: process.env,
});
process.exit(result.status ?? 1);
