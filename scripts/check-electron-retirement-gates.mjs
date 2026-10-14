#!/usr/bin/env node

/**
 * Electron retirement is blocked until these native parity gates are accepted.
 * This script documents the hard checklist; it exits non-zero until
 * KESTREL_ACCEPT_ELECTRON_RETIREMENT=1 is set by an explicit human decision.
 */
const accepted = process.env.KESTREL_ACCEPT_ELECTRON_RETIREMENT === "1";
const gates = [
	"test:native-chromium-host",
	"test:native-chromium-core-relay",
	"test:native-extensions",
	"test:native-user-extensions",
	"test:native-durable-browser-library",
	"test:native-download-capture",
	"test:native-browser-backend",
	"test:native-isolated-automation",
	"test:packaged-native:arm64",
	"Keychain/credential bootstrap without prompt spam",
	"Isolated automation sessions (create/navigate/snapshot/act) on CEF — create/navigate/snapshot/close proven; act still open",
	"Developer ID signing + notarization",
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

console.log(
	"Retirement acceptance recorded for this shell. Remove Electron packages only in a dedicated follow-up PR with that evidence attached.",
);
