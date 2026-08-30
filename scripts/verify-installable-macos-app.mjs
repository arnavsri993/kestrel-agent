#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { auditPackagedMacApp } from "./macos-architecture-audit.cjs";

const appArgument = process.argv[2];
if (process.platform !== "darwin")
	throw new Error("The macOS installable app verifier only runs on macOS.");
if (!appArgument) throw new Error("Pass the packaged .app path to verify.");

const appPath = resolve(process.cwd(), appArgument);
if (
	!appPath.endsWith(".app") ||
	!existsSync(appPath) ||
	!statSync(appPath).isDirectory()
)
	throw new Error(`Packaged app not found: ${appPath}`);

const infoPath = join(appPath, "Contents", "Info.plist");
const readPlistValue = (key) => {
	const result = spawnSync("/usr/bin/plutil", ["-extract", key, "raw", infoPath], {
		encoding: "utf8",
	});
	if (result.status !== 0)
		throw new Error(`Could not read ${key} from ${infoPath}.`);
	return result.stdout.trim();
};

for (const [key, expected] of [
	["CFBundleIdentifier", "com.kestrel.desktop"],
	["CFBundleName", "Kestrel"],
	["LSMinimumSystemVersion", "13.0.0"],
	["LSEnvironment.KESTREL_RELEASE_CHANNEL", "stable"],
]) {
	const actual = readPlistValue(key);
	if (actual !== expected)
		throw new Error(`${key} is ${actual}; expected ${expected}.`);
}

const version = readPlistValue("CFBundleShortVersionString");
if (!/^\d+\.\d+\.\d+$/.test(version))
	throw new Error(`Installable app version is not stable semver: ${version}.`);

const releaseDirectory = resolve(appPath, "../..");
for (const extension of ["dmg", "zip"]) {
	const artifactPath = join(
		releaseDirectory,
		`Kestrel-Apple-Silicon-${version}.${extension}`,
	);
	if (
		!existsSync(artifactPath) ||
		!statSync(artifactPath).isFile() ||
		statSync(artifactPath).size <= 0
	)
		throw new Error(`Installable ${extension.toUpperCase()} is missing: ${artifactPath}.`);
}

const updateConfigPath = join(
	appPath,
	"Contents",
	"Resources",
	"app-update.yml",
);
if (!existsSync(updateConfigPath))
	throw new Error(`Packaged update configuration is missing: ${updateConfigPath}.`);
const updateConfig = readFileSync(updateConfigPath, "utf8");
for (const marker of [
	"provider: github",
	"owner: arnavsri993",
	"repo: kestrel-agent",
	"releaseType: release",
	"channel: latest",
]) {
	if (!updateConfig.includes(marker))
		throw new Error(`Packaged update configuration is missing ${marker}.`);
}

const executablePath = join(appPath, "Contents", "MacOS", "Kestrel");
const architecture = spawnSync("/usr/bin/lipo", ["-archs", executablePath], {
	encoding: "utf8",
});
if (architecture.status !== 0 || architecture.stdout.trim() !== "arm64")
	throw new Error(
		`Installable app architecture must be arm64; received ${architecture.stdout.trim() || "unknown"}.`,
	);

const signature = spawnSync(
	"/usr/bin/codesign",
	["--verify", "--deep", "--strict", "--verbose=2", appPath],
	{ encoding: "utf8", stdio: "inherit" },
);
if (signature.status !== 0)
	throw new Error(`codesign verification failed for ${appPath}.`);

auditPackagedMacApp(appPath);
console.log(`Verified local installable Kestrel app: ${appPath}`);
