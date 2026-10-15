#!/usr/bin/env node

/**
 * Final Electron package removal for the Chromium product path.
 *
 * Refuse unless KESTREL_ACCEPT_ELECTRON_RETIREMENT=1. Even then, this only
 * rewrites package manifests and runtime selectors — it does not notarize,
 * migrate profiles, or replace /Applications/Kestrel.app.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
const accepted = process.env.KESTREL_ACCEPT_ELECTRON_RETIREMENT === "1";

if (!accepted) {
	console.error(
		"Refusing to remove Electron packages. Set KESTREL_ACCEPT_ELECTRON_RETIREMENT=1 only after every retirement gate has live evidence (see check:electron-retirement).",
	);
	process.exit(1);
}

const gates = spawnSync(
	process.execPath,
	[join(root, "scripts", "check-electron-retirement-gates.mjs")],
	{ cwd: root, encoding: "utf8", env: process.env },
);
process.stdout.write(gates.stdout ?? "");
process.stderr.write(gates.stderr ?? "");
if (gates.status !== 0) {
	console.error("Retirement gates still blocked; Electron packages were not removed.");
	process.exit(gates.status ?? 1);
}

const desktopPackagePath = join(root, "apps/desktop/package.json");
const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, "utf8"));
const removed = [];
for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
	const bag = desktopPackage[section];
	if (!bag) continue;
	for (const name of ["electron", "electron-builder", "electron-vite", "electron-updater"]) {
		if (name in bag) {
			removed.push(`${section}.${name}@${bag[name]}`);
			delete bag[name];
		}
	}
}

const runtimeSelectors = [
	join(root, "scripts/dev-desktop-runtime.mjs"),
	join(root, "scripts/package-desktop-runtime.mjs"),
	join(root, "scripts/install-desktop-runtime.mjs"),
];

const rootPackagePath = join(root, "package.json");
const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8"));
const rootScripts = rootPackage.scripts ?? {};
const rootScriptsToRemove = Object.keys(rootScripts).filter(
	(name) =>
		name.endsWith(":electron") ||
		/KESTREL_DESKTOP_RUNTIME=electron/.test(rootScripts[name]),
);
for (const name of rootScriptsToRemove) {
	removed.push(`package.json scripts.${name}`);
}

console.log("Electron packages and opt-in scripts to remove:");
for (const item of removed) console.log(`- ${item}`);
if (removed.length === 0) console.log("- (already absent)");

console.log("Runtime selectors that must default to chromium:");
for (const path of runtimeSelectors) console.log(`- ${path}`);

if (dryRun) {
	console.log("Dry run only. Re-run without --dry-run to rewrite manifests.");
	process.exit(0);
}

writeFileSync(
	desktopPackagePath,
	`${JSON.stringify(desktopPackage, null, 2)}\n`,
	"utf8",
);

for (const path of runtimeSelectors) {
	const source = readFileSync(path, "utf8");
	if (!source.includes('KESTREL_DESKTOP_RUNTIME ?? "chromium"')) {
		throw new Error(
			`${path} must already default to chromium before Electron packages are removed.`,
		);
	}
}

for (const name of rootScriptsToRemove) {
	delete rootScripts[name];
}
writeFileSync(rootPackagePath, `${JSON.stringify(rootPackage, null, 2)}\n`, "utf8");

console.log(
	"Electron packages removed from apps/desktop/package.json and Electron opt-in root scripts deleted. Runtime selectors already default to chromium. Run corepack pnpm install, rebuild native packaging, and verify the Dock app before claiming 0% Electron.",
);
