#!/usr/bin/env node

/**
 * Electron retirement checklist.
 *
 * Linux-safe source gates always run. Native CEF / Dock gates run when
 * KESTREL_NATIVE_TEST_APP (or the default packaged app) exists. Package
 * removal still requires KESTREL_ACCEPT_ELECTRON_RETIREMENT=1 after the
 * runnable Chromium product path has live evidence. Developer ID signing /
 * notarization remains a release cutover gate for real /Applications installs,
 * not a blocker for removing Electron from the product manifests once CI has
 * proven the Chromium shell.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const accepted = process.env.KESTREL_ACCEPT_ELECTRON_RETIREMENT === "1";
const nativeApp = resolve(
	process.env.KESTREL_NATIVE_TEST_APP ??
		join(root, "release", "native-mac-arm64", "Kestrel.app"),
);

const sourceGates = [
	{
		id: "test:electron-native-transfer",
		command: ["corepack", "pnpm", "test:electron-native-transfer"],
	},
	{
		id: "test:electron-native-transfer-cli",
		command: ["corepack", "pnpm", "test:electron-native-transfer-cli"],
	},
	{
		id: "verify:chromium-product-path",
		command: ["corepack", "pnpm", "verify:chromium-product-path"],
	},
];

const nativeGates = [
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
	"test:native-zero-electron-bundle",
	"test:native-dock-canonical",
];

const releaseCutoverGates = [
	"Developer ID signing + notarization — check:native-signing (package:mac:native:release + notarize:mac:native)",
	"Live dual-profile dry-run/apply against a real user Electron profile into an isolated native durable profile (synthetic CLI fixture already covered)",
];

console.log("Electron retirement gates:");
for (const gate of sourceGates) console.log(`- [source] ${gate.id}`);
for (const gate of nativeGates) console.log(`- [native] ${gate}`);
for (const gate of releaseCutoverGates) console.log(`- [release-cutover] ${gate}`);

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

function runGate(label, command) {
	const result = spawnSync(command[0], command.slice(1), {
		cwd: root,
		encoding: "utf8",
		env: process.env,
	});
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	if (result.status !== 0) {
		console.error(`${label} failed; Electron retirement remains blocked.`);
		process.exit(result.status ?? 1);
	}
	console.log(`Gate passed: ${label}`);
}

for (const gate of sourceGates) {
	runGate(gate.id, gate.command);
}

if (existsSync(nativeApp)) {
	process.env.KESTREL_NATIVE_TEST_APP = nativeApp;
	for (const gate of nativeGates) {
		runGate(gate, ["corepack", "pnpm", gate]);
	}
} else if (process.env.KESTREL_REQUIRE_NATIVE_RETIREMENT_GATES === "1") {
	console.error(
		`Native app missing at ${nativeApp}; set KESTREL_NATIVE_TEST_APP or package the native host.`,
	);
	process.exit(1);
} else {
	console.log(
		`Native app not present at ${nativeApp}; skipping live CEF/Dock gates (CI must prove them before merge).`,
	);
}

console.log("Release cutover gates remain operator-owned:");
for (const gate of releaseCutoverGates) console.log(`- [ ] ${gate}`);

if (!accepted) {
	console.error(
		"Electron packaging remains in-tree. Set KESTREL_ACCEPT_ELECTRON_RETIREMENT=1 only after Chromium product-path CI (native retirement-gate + packaged Dock/bundle smokes) is green.",
	);
	process.exit(1);
}

console.log(
	"Retirement acceptance recorded for this shell. Next: corepack pnpm retire:electron:dry-run, then corepack pnpm retire:electron, then verify:zero-electron.",
);
