#!/usr/bin/env node

/**
 * Wrap release/native-mac-arm64/Kestrel.app into a distributable DMG + ZIP for
 * the Chromium product release path (no electron-builder), then write
 * latest-mac.yml for the public update feed.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeNativeLatestMac } from "./write-native-latest-mac.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(
	readFileSync(join(root, "apps/desktop/package.json"), "utf8"),
).version;
const appPath = resolve(
	process.argv[2] ?? join(root, "release", "native-mac-arm64", "Kestrel.app"),
);
const releaseRoot = resolve(process.argv[3] ?? join(root, "release"));
const volumeName = "Kestrel";
const dmgName = `Kestrel-Apple-Silicon-${version}.dmg`;
const zipName = `Kestrel-Apple-Silicon-${version}.zip`;
const dmgPath = join(releaseRoot, dmgName);
const zipPath = join(releaseRoot, zipName);
const stagingDmg = join(releaseRoot, `.${dmgName}.rw.dmg`);

if (process.platform !== "darwin") {
	throw new Error("Native Chromium DMG packaging requires macOS.");
}
if (!existsSync(appPath)) {
	throw new Error(
		`Native app missing at ${appPath}. Run corepack pnpm package:mac:native[:release] first.`,
	);
}

function run(command, args) {
	const result = spawnSync(command, args, { stdio: "inherit" });
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed.`);
	}
}

rmSync(dmgPath, { force: true });
rmSync(zipPath, { force: true });
rmSync(stagingDmg, { force: true });

run("/usr/bin/ditto", ["-c", "-k", "--keepParent", appPath, zipPath]);

run("/usr/bin/hdiutil", [
	"create",
	"-volname",
	volumeName,
	"-srcfolder",
	appPath,
	"-ov",
	"-format",
	"UDRW",
	stagingDmg,
]);
run("/usr/bin/hdiutil", [
	"convert",
	stagingDmg,
	"-format",
	"UDZO",
	"-imagekey",
	"zlib-level=9",
	"-o",
	dmgPath,
]);
rmSync(stagingDmg, { force: true });

const latestMac = writeNativeLatestMac({ releaseRoot, version });

console.log(`Packaged native Chromium DMG at ${dmgPath}`);
console.log(`Packaged native Chromium ZIP at ${zipPath}`);
console.log(`Wrote native Chromium updater feed at ${latestMac}`);
