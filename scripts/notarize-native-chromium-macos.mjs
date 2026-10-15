#!/usr/bin/env node

/**
 * Notarize a Developer ID–signed native Chromium Kestrel.app with notarytool,
 * staple the ticket, then re-run the signing evidence gate.
 *
 * Requires:
 * - App already signed with Developer ID Application (package:mac:native:release)
 * - NOTARYTOOL_PROFILE / KESTREL_NOTARY_PROFILE, or
 *   APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appPath = resolve(
	process.argv[2] ?? join(root, "release", "native-mac-arm64", "Kestrel.app"),
);

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		stdio: options.capture ? "pipe" : "inherit",
		encoding: "utf8",
		env: options.env ?? process.env,
	});
	if (result.status !== 0) {
		const detail = options.capture
			? `${result.stderr || ""}${result.stdout || ""}`.trim()
			: "";
		throw new Error(
			`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : "."}`,
		);
	}
	return result;
}

if (!existsSync(appPath)) {
	throw new Error(
		`Native app missing at ${appPath}. Run corepack pnpm package:mac:native:release first.`,
	);
}

const authority = run(
	"/usr/bin/codesign",
	["-dv", "--verbose=2", appPath],
	{ capture: true },
);
const authorityText = `${authority.stdout ?? ""}\n${authority.stderr ?? ""}`;
if (!/Authority=Developer ID Application:/.test(authorityText)) {
	throw new Error(
		"Refusing to notarize: app is not signed with Developer ID Application. Use package:mac:native:release with KESTREL_NATIVE_CODESIGN_IDENTITY.",
	);
}

const profile =
	process.env.NOTARYTOOL_PROFILE?.trim() ||
	process.env.KESTREL_NOTARY_PROFILE?.trim() ||
	"";
const appleId = process.env.APPLE_ID?.trim() || "";
const applePassword = process.env.APPLE_APP_SPECIFIC_PASSWORD?.trim() || "";
const teamId = process.env.APPLE_TEAM_ID?.trim() || "";

if (!profile && !(appleId && applePassword && teamId)) {
	throw new Error(
		"Notarization credentials missing. Set NOTARYTOOL_PROFILE (or KESTREL_NOTARY_PROFILE), or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID.",
	);
}

const work = mkdtempSync(join(tmpdir(), "kestrel-native-notarize-"));
const zipPath = join(work, "Kestrel.zip");
try {
	console.log(`Zipping ${appPath} for notarytool…`);
	run("/usr/bin/ditto", ["-c", "-k", "--keepParent", appPath, zipPath]);

	const submitArgs = ["notarytool", "submit", zipPath, "--wait"];
	if (profile) {
		submitArgs.push("--keychain-profile", profile);
	} else {
		submitArgs.push("--apple-id", appleId, "--password", applePassword, "--team-id", teamId);
	}
	console.log("Submitting to Apple notary service…");
	run("/usr/bin/xcrun", submitArgs);

	console.log("Stapling notarization ticket…");
	run("/usr/bin/xcrun", ["stapler", "staple", appPath]);
	run("/usr/bin/xcrun", ["stapler", "validate", appPath]);
} finally {
	rmSync(work, { recursive: true, force: true });
}

console.log("Re-running signing evidence gate…");
run(process.execPath, [join(root, "scripts", "check-native-signing.mjs"), appPath]);
console.log(`Notarized native Chromium package ready at ${appPath}.`);
