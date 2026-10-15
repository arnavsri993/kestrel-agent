#!/usr/bin/env node

/**
 * Electron retirement is blocked until these native parity gates are accepted.
 * This script documents the hard checklist, verifies the Electron→native
 * transfer module is present, and runs its unit suite (Linux-safe). It exits
 * non-zero until KESTREL_ACCEPT_ELECTRON_RETIREMENT=1 is set by an explicit
 * human decision after every gate has live evidence.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const accepted = process.env.KESTREL_ACCEPT_ELECTRON_RETIREMENT === "1";
const gates = [
	"test:native-chromium-host",
	"test:native-chromium-core-relay",
	"test:native-desktop-shell",
	"test:native-extensions",
	"test:native-user-extensions",
	"test:native-durable-browser-library",
	"test:native-download-capture",
	"test:native-browser-backend",
	"test:native-isolated-automation",
	"test:native-credential-bootstrap",
	"test:packaged-native:arm64",
	"test:packaged-native-desktop-shell:arm64",
	"Keychain/credential bootstrap without prompt spam — profile-sealed proven; real Keychain gated on Developer ID + --kestrel-real-keychain",
	"Isolated automation sessions (create/navigate/snapshot/act) on CEF",
	"Developer ID signing + notarization — check:native-signing (package:mac:native:release + notarize:mac:native)",
	"test:electron-native-transfer — Electron→native dry-run/apply unit suite",
	"test:electron-native-transfer-cli — CLI dry-run/apply against a synthetic Electron profile (secrets rejected)",
	"Live dual-profile dry-run/apply of kestrel-electron transfer on a real Electron profile into an isolated native durable profile (no silent merge)",
	"On-screen verification of canonical Dock app on Chromium",
];

console.log("Electron retirement gates:");
for (const gate of gates) console.log(`- [ ] ${gate}`);

const transferModule = join(
	root,
	"packages/agent-core/src/electron-native-profile-transfer.ts",
);
const transferTest = join(
	root,
	"packages/agent-core/src/electron-native-profile-transfer.test.ts",
);
if (!existsSync(transferModule) || !existsSync(transferTest)) {
	console.error(
		"Electron→native transfer module or test is missing; retirement remains blocked.",
	);
	process.exit(1);
}

const transfer = spawnSync(
	"corepack",
	["pnpm", "test:electron-native-transfer"],
	{ cwd: root, encoding: "utf8", env: process.env },
);
if (transfer.status !== 0) {
	if (transfer.stdout) process.stdout.write(transfer.stdout);
	if (transfer.stderr) process.stderr.write(transfer.stderr);
	console.error(
		"test:electron-native-transfer failed; Electron retirement remains blocked.",
	);
	process.exit(transfer.status ?? 1);
}
console.log("Source gate: test:electron-native-transfer passed.");

const transferCli = spawnSync(
	"corepack",
	["pnpm", "test:electron-native-transfer-cli"],
	{ cwd: root, encoding: "utf8", env: process.env },
);
if (transferCli.status !== 0) {
	if (transferCli.stdout) process.stdout.write(transferCli.stdout);
	if (transferCli.stderr) process.stderr.write(transferCli.stderr);
	console.error(
		"test:electron-native-transfer-cli failed; Electron retirement remains blocked.",
	);
	process.exit(transferCli.status ?? 1);
}
console.log("Source gate: test:electron-native-transfer-cli passed.");

const productPath = spawnSync(
	"corepack",
	["pnpm", "verify:chromium-product-path"],
	{ cwd: root, encoding: "utf8", env: process.env },
);
if (productPath.status !== 0) {
	if (productPath.stdout) process.stdout.write(productPath.stdout);
	if (productPath.stderr) process.stderr.write(productPath.stderr);
	console.error(
		"verify:chromium-product-path failed; Electron retirement remains blocked.",
	);
	process.exit(productPath.status ?? 1);
}
console.log("Source gate: verify:chromium-product-path passed.");

if (!accepted) {
	console.error(
		"Electron packaging remains required. Set KESTREL_ACCEPT_ELECTRON_RETIREMENT=1 only after every gate above has live evidence.",
	);
	process.exit(1);
}

console.log(
	"Retirement acceptance recorded for this shell. Next: corepack pnpm retire:electron:dry-run, then corepack pnpm retire:electron, then verify the Chromium Dock app before merging the Electron-removal follow-up.",
);
