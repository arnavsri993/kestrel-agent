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
 *
 * Pass --release (or use package:mac:native:release) to require a named
 * Developer ID Application identity via KESTREL_NATIVE_CODESIGN_IDENTITY.
 * Notarization is a separate step: notarize:mac:native.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destinationRoot = join(root, "release", "native-mac-arm64");
const destinationApp = join(destinationRoot, "Kestrel.app");
const releaseBuild = process.argv.includes("--release");

if (process.platform !== "darwin" || process.arch !== "arm64") {
	throw new Error("Native Chromium packaging requires Apple Silicon macOS.");
}

if (releaseBuild) {
	const identity = process.env.KESTREL_NATIVE_CODESIGN_IDENTITY?.trim() || "";
	if (!identity || identity === "-") {
		throw new Error(
			"package:mac:native:release requires KESTREL_NATIVE_CODESIGN_IDENTITY set to a Developer ID Application identity.",
		);
	}
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
if (releaseBuild) {
	console.log(
		"Release package is Developer ID–signed but not yet notarized. Run corepack pnpm notarize:mac:native.",
	);
} else {
	console.log(
		"Canonical Dock cutover still requires install:mac:native after parity gates, Developer ID signing, and notarization.",
	);
}
