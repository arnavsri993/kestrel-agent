#!/usr/bin/env node

/**
 * Evidence gate for native Chromium Developer ID signing + notarization.
 *
 * Exit 0 only when a named Developer ID Application identity is present, the
 * packaged native app is signed with that class of identity (not ad-hoc), and
 * Gatekeeper/stapler accept the app as notarized.
 *
 * Use --readiness to print blockers without requiring a packaged app yet.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readinessOnly = process.argv.includes("--readiness");
const appPath = resolve(
	process.argv.find((arg) => arg.endsWith(".app")) ??
		process.env.KESTREL_NATIVE_TEST_APP ??
		join(root, "release", "native-mac-arm64", "Kestrel.app"),
);

const blockers = [];

function run(command, args) {
	return spawnSync(command, args, { encoding: "utf8" });
}

function listDeveloperIdIdentities() {
	const result = run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]);
	const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
	const identities = [];
	for (const line of text.split("\n")) {
		const match = line.match(/"(Developer ID Application: [^"]+)"/);
		if (match) identities.push(match[1]);
	}
	return identities;
}

const configuredIdentity =
	process.env.KESTREL_NATIVE_CODESIGN_IDENTITY?.trim() ||
	process.env.CSC_NAME?.trim() ||
	"";
const identities = listDeveloperIdIdentities();

console.log("Native Chromium signing / notarization check");
console.log(`- App: ${appPath}`);
console.log(
	`- Configured identity: ${configuredIdentity || "(unset; use KESTREL_NATIVE_CODESIGN_IDENTITY)"}`,
);
console.log(
	`- Keychain Developer ID Application identities: ${
		identities.length ? identities.join("; ") : "(none)"
	}`,
);

if (identities.length === 0) {
	blockers.push(
		"No Developer ID Application identity in the login keychain. Import the certificate before a release-signed native build.",
	);
} else if (
	configuredIdentity &&
	configuredIdentity !== "-" &&
	!identities.includes(configuredIdentity)
) {
	blockers.push(
		`KESTREL_NATIVE_CODESIGN_IDENTITY is set to "${configuredIdentity}" but that identity is not available.`,
	);
}

const hasNotaryAuth =
	Boolean(process.env.NOTARYTOOL_PROFILE?.trim()) ||
	Boolean(process.env.KESTREL_NOTARY_PROFILE?.trim()) ||
	(Boolean(process.env.APPLE_ID?.trim()) &&
		Boolean(process.env.APPLE_APP_SPECIFIC_PASSWORD?.trim()) &&
		Boolean(process.env.APPLE_TEAM_ID?.trim()));

if (!hasNotaryAuth) {
	blockers.push(
		"Notarization credentials missing. Set NOTARYTOOL_PROFILE (or KESTREL_NOTARY_PROFILE), or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID.",
	);
} else {
	console.log("- Notarization credentials: present");
}

if (!readinessOnly) {
	if (!existsSync(appPath)) {
		blockers.push(
			`Packaged native app missing at ${appPath}. Run corepack pnpm package:mac:native:release after a Developer ID identity is available.`,
		);
	} else {
		const verify = run("/usr/bin/codesign", [
			"--verify",
			"--deep",
			"--strict",
			"--verbose=2",
			appPath,
		]);
		if (verify.status !== 0) {
			blockers.push(
				`codesign --verify failed:\n${verify.stderr || verify.stdout || "(no detail)"}`,
			);
		} else {
			const details = run("/usr/bin/codesign", ["-dv", "--verbose=2", appPath]);
			const detailText = `${details.stdout ?? ""}\n${details.stderr ?? ""}`;
			console.log("- codesign --verify: ok");
			if (/Authority=Developer ID Application:/.test(detailText)) {
				console.log("- Signature authority: Developer ID Application");
			} else if (/Signature=adhoc|Authority=\(unavailable\)|flags=0x2\(adhoc\)/.test(detailText)) {
				blockers.push(
					"Packaged app is ad-hoc signed. Rebuild with --release and KESTREL_NATIVE_CODESIGN_IDENTITY set to a Developer ID Application identity.",
				);
			} else {
				blockers.push(
					"Packaged app is not signed with Developer ID Application. Inspect codesign -dv output and resign for release.",
				);
			}
		}

		const staple = run("/usr/bin/xcrun", ["stapler", "validate", appPath]);
		if (staple.status !== 0) {
			blockers.push(
				`stapler validate failed (app not notarized/stapled). Run corepack pnpm notarize:mac:native.\n${
					staple.stderr || staple.stdout || ""
				}`.trim(),
			);
		} else {
			console.log("- stapler validate: ok");
		}

		const assess = run("/usr/bin/spctl", [
			"--assess",
			"--type",
			"execute",
			"--verbose=2",
			appPath,
		]);
		if (assess.status !== 0) {
			blockers.push(
				`spctl --assess failed:\n${assess.stderr || assess.stdout || "(no detail)"}`,
			);
		} else {
			console.log("- spctl --assess: ok");
		}
	}
}

if (blockers.length > 0) {
	console.error("\nSigning / notarization blockers:");
	for (const blocker of blockers) console.error(`- ${blocker}`);
	console.error(
		"\nElectron retirement remains blocked until Developer ID signing + notarization have live evidence on the native Chromium package.",
	);
	process.exit(1);
}

console.log(
	readinessOnly
		? "\nReadiness: Developer ID identity and notarization credentials are available."
		: "\nLive evidence: native Chromium package is Developer ID–signed and notarized.",
);
