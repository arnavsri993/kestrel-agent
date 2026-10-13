#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildNativeChromiumHost } from "./build-native-chromium-host.mjs";

/**
 * Packages the native CEF host into release/native-mac-arm64/Kestrel.app.
 * This does not replace /Applications/Kestrel.app; use install:mac:native with
 * an explicit confirmation env when a reviewed cutover is intended.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destinationRoot = join(root, "release", "native-mac-arm64");
const destinationApp = join(destinationRoot, "Kestrel.app");

if (process.platform !== "darwin" || process.arch !== "arm64") {
	throw new Error("Native Chromium packaging requires Apple Silicon macOS.");
}

const built = await buildNativeChromiumHost();
await mkdir(destinationRoot, { recursive: true });
await rm(destinationApp, { recursive: true, force: true });
const ditto = spawnSync(
	"/usr/bin/ditto",
	["--rsrc", "--extattr", "--acl", built, destinationApp],
	{ stdio: "inherit" },
);
if (ditto.status !== 0)
	throw new Error("Could not copy the native Chromium package into release/.");
console.log(`Packaged native Chromium Kestrel at ${destinationApp}.`);
console.log(
	"Canonical Dock cutover still requires install:mac:native after parity gates.",
);
