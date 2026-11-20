#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopRuntimeInstallPlan } from "./desktop-runtime-install-plan.mjs";

/**
 * Installs the selected desktop runtime. Electron remains the default Dock app.
 * Native Chromium replaces the same app only after parity acceptance and live
 * Developer ID signing / notarization checks.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let plan;
try {
	plan = desktopRuntimeInstallPlan({ root, argv: process.argv.slice(2) });
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

const result = spawnSync(plan.command, plan.args, {
	stdio: "inherit",
	cwd: root,
	env: process.env,
});
process.exit(result.status ?? 1);
