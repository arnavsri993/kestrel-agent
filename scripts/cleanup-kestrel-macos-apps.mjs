#!/usr/bin/env node

import { cleanupDuplicateKestrelApps } from "./kestrel-macos-app-hygiene.mjs";
import { enterDeploymentLock } from "./macos-deployment-lock.mjs";
import { markDirectoryUnindexed } from "./kestrel-macos-app-hygiene.mjs";
import { resolve } from "node:path";

// Packaging workers never trash another worker's build artifact. Canonical
// installation performs shared cleanup while holding the deployment lock.
if (process.argv.includes("--build-only")) {
  markDirectoryUnindexed(resolve(import.meta.dirname, "../release"));
  process.exit(0);
}

const assertLock = enterDeploymentLock(import.meta.filename,
  process.env.KESTREL_MACOS_INSTALL_ROOT ?? "/Applications", { operation: "cleanup" });
assertLock();

if (process.platform !== "darwin") {
	throw new Error("Kestrel macOS app cleanup only runs on macOS.");
}

const excludedPaths =
	process.argv.slice(2).filter((argument, index, arguments_) =>
    argument !== "--deployment-lock-token" && arguments_[index - 1] !== "--deployment-lock-token")
    .map((argument) => argument.trim()).filter(Boolean) ||
	[];
const result = cleanupDuplicateKestrelApps({
	excludedPaths: [
		...excludedPaths,
		process.env.KESTREL_MACOS_KEEP_APP,
	].filter(Boolean),
});

if (result.marked.length > 0) {
	console.log("Excluded build trees from Spotlight indexing:");
	for (const directory of result.marked) console.log(`  ${directory}`);
}

for (const directory of result.removedStaging) {
	console.log(`Removed stale Kestrel install staging directory: ${directory}`);
}

if (result.moved.length === 0) {
	console.log(`No duplicate Kestrel apps found. Canonical app: ${result.canonicalApp}`);
} else {
	console.log(`Canonical Kestrel app: ${result.canonicalApp}`);
	for (const item of result.moved) {
		console.log(`Moved duplicate to Trash: ${item.from} -> ${item.to}`);
	}
}
