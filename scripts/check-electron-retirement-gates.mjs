#!/usr/bin/env node

/**
 * Electron retirement is blocked until these native parity gates are accepted.
 * This script documents the hard checklist; it exits non-zero until
 * KESTREL_ACCEPT_ELECTRON_RETIREMENT=1 is set by an explicit human decision.
 *
 * Feature-level Electron↔CEF status lives in
 * docs/electron-chromium-parity-matrix.json (see check:electron-chromium-parity).
 */
const accepted = process.env.KESTREL_ACCEPT_ELECTRON_RETIREMENT === "1";
const gates = [
	"check:electron-chromium-parity (matrix consistent with wire schema + CEF handlers)",
	"test:native-chromium-host",
	"test:native-chromium-core-relay",
	"test:native-extensions",
	"test:native-user-extensions",
	"test:native-durable-browser-library",
	"test:native-download-capture",
	"test:native-browser-backend (includes visible-context/snapshot/act/screenshot)",
	"test:native-isolated-automation",
	"test:native-credential-bootstrap",
	"test:packaged-native:arm64",
	"Keychain/credential bootstrap without prompt spam — profile-sealed proven; real Keychain gated on Developer ID + --kestrel-real-keychain",
	"Isolated automation sessions (create/navigate/snapshot/act) on CEF",
	"Missing CEF backend ops closed or explicitly deferred with product sign-off: visible-autofill, auth-handoff, desktop-screenshot, desktop-act",
	"Native single-instance / durable-profile lock + kestrel:// deep-link handlers",
	"Developer ID signing + notarization — check:native-signing (package:mac:native:release + notarize:mac:native)",
	"Explicit Electron→native profile transfer design (see docs/desktop-runtime-migration.md) with live dry-run/apply evidence",
	"On-screen verification of canonical Dock app on Chromium",
];

console.log("Electron retirement gates:");
for (const gate of gates) console.log(`- [ ] ${gate}`);
console.log(
	"See docs/electron-chromium-parity-matrix.json for the full feature matrix and prioritized remediation.",
);

if (!accepted) {
	console.error(
		"Electron packaging remains required. Set KESTREL_ACCEPT_ELECTRON_RETIREMENT=1 only after every gate above has live evidence.",
	);
	process.exit(1);
}

console.log(
	"Retirement acceptance recorded for this shell. Remove Electron packages only in a dedicated follow-up PR with that evidence attached.",
);
