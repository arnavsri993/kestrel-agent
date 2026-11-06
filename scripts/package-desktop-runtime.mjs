#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Packages the selected desktop runtime. Electron remains the default shipping
 * path; Chromium packaging is available through KESTREL_DESKTOP_RUNTIME=chromium.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = (process.env.KESTREL_DESKTOP_RUNTIME ?? "electron").toLowerCase();
const script =
	runtime === "chromium" || runtime === "native"
		? "package:mac:native"
		: "package:mac:dev";

const result = spawnSync("corepack", ["pnpm", script], {
	stdio: "inherit",
	cwd: root,
	env: process.env,
});
process.exit(result.status ?? 1);
