#!/usr/bin/env node

/**
 * Build a Developer ID Installer–signed MDM PKG that installs
 * release/native-mac-arm64/Kestrel.app into /Applications (no electron-builder).
 */
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(
	readFileSync(join(root, "apps/desktop/package.json"), "utf8"),
).version;
const appPath = resolve(
	process.argv[2] ?? join(root, "release", "native-mac-arm64", "Kestrel.app"),
);
const releaseRoot = resolve(process.argv[3] ?? join(root, "release"));
const pkgName = `Kestrel-Apple-Silicon-${version}.pkg`;
const pkgPath = join(releaseRoot, pkgName);
const identifier = "com.kestrel.desktop";
const installerIdentity =
	process.env.KESTREL_NATIVE_INSTALLER_IDENTITY?.trim() ||
	process.env.CSC_INSTALLER_NAME?.trim() ||
	"";

if (process.platform !== "darwin") {
	throw new Error("Native Chromium PKG packaging requires macOS.");
}
if (!existsSync(appPath)) {
	throw new Error(
		`Native app missing at ${appPath}. Run corepack pnpm package:mac:native[:release] first.`,
	);
}
if (!installerIdentity) {
	throw new Error(
		"Set KESTREL_NATIVE_INSTALLER_IDENTITY (or CSC_INSTALLER_NAME) to a Developer ID Installer identity.",
	);
}

function run(command, args) {
	const result = spawnSync(command, args, { stdio: "inherit" });
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed.`);
	}
}

const stage = mkdtempSync(join(tmpdir(), "kestrel-native-pkg-"));
const payloadRoot = join(stage, "payload");
const applications = join(payloadRoot, "Applications");
const componentPkg = join(stage, "Kestrel-component.pkg");
try {
	mkdirSync(applications, { recursive: true });
	run("/usr/bin/ditto", [
		"--rsrc",
		"--extattr",
		"--acl",
		appPath,
		join(applications, "Kestrel.app"),
	]);
	rmSync(pkgPath, { force: true });
	run("/usr/bin/pkgbuild", [
		"--root",
		payloadRoot,
		"--install-location",
		"/",
		"--identifier",
		identifier,
		"--version",
		version,
		componentPkg,
	]);
	run("/usr/bin/productbuild", [
		"--package",
		componentPkg,
		"--sign",
		installerIdentity,
		pkgPath,
	]);
	run("/usr/bin/pkgutil", ["--check-signature", pkgPath]);
} finally {
	rmSync(stage, { recursive: true, force: true });
}

console.log(`Packaged native Chromium MDM PKG at ${pkgPath}`);
