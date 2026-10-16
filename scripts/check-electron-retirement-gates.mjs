#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Electron retirement is blocked until these native parity gates are accepted.
 * Acceptance cannot override a failing extension compatibility check against
 * the exact app candidate. The remaining product gates still need live proof.
 */
const accepted = process.env.KESTREL_ACCEPT_ELECTRON_RETIREMENT === "1";
const gates = [
	"test:native-chromium-host",
	"test:native-chromium-core-relay",
	"test:native-core-durability",
	"test:native-extensions",
	"test:native-user-extensions",
	"test:native-extension-parity (required, cannot be bypassed by acceptance)",
	"test:native-durable-browser-library",
	"test:native-download-capture",
	"test:native-browser-backend",
	"test:native-isolated-automation",
	"test:native-credential-bootstrap",
	"test:packaged-native:arm64",
	"Keychain/credential bootstrap without prompt spam — profile-sealed proven; real Keychain gated on Developer ID + --kestrel-real-keychain",
	"Isolated automation sessions (create/navigate/snapshot/act) on CEF",
	"Existing UI, onboarding, provider sign-in, local models, agents, tools, approvals, files, settings, autofill and restart recovery on native Chromium",
	"Developer ID signing + notarization — check:native-signing (package:mac:native:release + notarize:mac:native)",
	"Explicit Electron→native profile transfer design (see docs/desktop-runtime-migration.md)",
	"On-screen verification of canonical Dock app on Chromium",
];

console.log("Electron retirement gates:");
for (const gate of gates) console.log(`- [ ] ${gate}`);

if (!accepted) {
	console.error(
		"Electron packaging remains required. Set KESTREL_ACCEPT_ELECTRON_RETIREMENT=1 only after every gate above has live evidence.",
	);
	process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidate = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (!candidate || !existsSync(join(candidate, "Contents/MacOS/Kestrel"))) {
	console.error("Retirement requires an explicit built Kestrel.app candidate; acceptance alone is insufficient. No app was installed.");
	process.exit(1);
}

const parity = spawnSync(process.execPath, [
	join(root, "scripts/smoke-native-user-extensions.mjs"), "--require-extension-parity",
], {
	cwd: root,
	stdio: "inherit",
	timeout: 120_000,
	env: { ...process.env, KESTREL_NATIVE_TEST_APP: candidate },
});
if (parity.status !== 0) {
	console.error("Native Chrome extension parity has not passed. Electron remains required; no app was installed.");
	process.exit(parity.status ?? 1);
}

console.log(
	"Retirement acceptance recorded for this shell. Remove Electron packages only in a dedicated follow-up PR with that evidence attached.",
);
