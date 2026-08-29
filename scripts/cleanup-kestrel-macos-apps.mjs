#!/usr/bin/env node

import { cleanupDuplicateKestrelApps } from "./kestrel-macos-app-hygiene.mjs";

if (process.platform !== "darwin") {
	throw new Error("Kestrel macOS app cleanup only runs on macOS.");
}

const excludedPaths =
	process.argv.slice(2).map((argument) => argument.trim()).filter(Boolean) ||
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

if (result.moved.length === 0) {
	console.log(`No duplicate Kestrel apps found. Canonical app: ${result.canonicalApp}`);
} else {
	console.log(`Canonical Kestrel app: ${result.canonicalApp}`);
	for (const item of result.moved) {
		console.log(`Moved duplicate to Trash: ${item.from} -> ${item.to}`);
	}
}
