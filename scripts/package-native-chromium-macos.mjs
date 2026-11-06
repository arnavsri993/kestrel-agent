#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildNativeChromiumHost } from "./build-native-chromium-host.mjs";
import { packageNativeChromiumArtifact } from "./native-package-stage.mjs";

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

const packaged = await packageNativeChromiumArtifact({
	root,
	destinationRoot,
	destinationApp,
	build: (output) => buildNativeChromiumHost({ output }),
	copy: (built, destination) => {
		const ditto = spawnSync(
			"/usr/bin/ditto",
			["--rsrc", "--extattr", "--acl", built, destination],
			{ stdio: "inherit" },
		);
		if (ditto.status !== 0) throw new Error("Could not copy the native Chromium package into release/.");
	},
});
console.log(`Packaged native Chromium Kestrel at ${packaged}.`);
if (releaseBuild) {
	console.log(
		"Release package is Developer ID–signed but not yet notarized. Run corepack pnpm notarize:mac:native.",
	);
} else {
	console.log(
		"Canonical Dock cutover still requires install:mac:native after parity gates, Developer ID signing, and notarization.",
	);
}
