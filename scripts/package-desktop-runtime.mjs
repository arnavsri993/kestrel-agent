#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Packages the selected desktop runtime. Chromium/CEF is the default product
 * path; Electron packaging remains available through KESTREL_DESKTOP_RUNTIME=electron.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = (process.env.KESTREL_DESKTOP_RUNTIME ?? "chromium").toLowerCase();
const script =
	runtime === "electron" ? "package:mac:dev:electron" : "package:mac:native";

if (runtime !== "chromium" && runtime !== "native" && runtime !== "electron") {
	console.error(
		`Unknown KESTREL_DESKTOP_RUNTIME=${runtime}. Use chromium or electron.`,
	);
	process.exit(1);
}

const result = spawnSync("corepack", ["pnpm", script], {
	stdio: "inherit",
	cwd: root,
	env: process.env,
});
process.exit(result.status ?? 1);
