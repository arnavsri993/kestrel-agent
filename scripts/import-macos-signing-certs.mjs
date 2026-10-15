#!/usr/bin/env node

/**
 * Import Developer ID Application + Installer .p12 secrets (CSC_LINK /
 * CSC_INSTALLER_LINK) into a temporary keychain for native Chromium release
 * signing. Prints and optionally writes GITHUB_ENV identity variables.
 *
 * Never logs certificate passwords or raw p12 bytes.
 */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		stdio: options.capture ? "pipe" : "inherit",
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

function requireEnv(name) {
	const value = process.env[name]?.trim() || "";
	if (!value) throw new Error(`${name} is required.`);
	return value;
}

function importP12(work, keychain, p12Base64, password, pathLabel) {
	const p12Path = join(work, `${pathLabel}.p12`);
	writeFileSync(p12Path, Buffer.from(p12Base64, "base64"));
	run(
		"/usr/bin/security",
		[
			"import",
			p12Path,
			"-k",
			keychain,
			"-P",
			password,
			"-T",
			"/usr/bin/codesign",
			"-T",
			"/usr/bin/productbuild",
			"-T",
			"/usr/bin/pkgbuild",
			"-T",
			"/usr/bin/security",
		],
		{ capture: true },
	);
	rmSync(p12Path, { force: true });
}

function findIdentity(pattern, { codesigning = false } = {}) {
	const args = codesigning
		? ["find-identity", "-v", "-p", "codesigning"]
		: ["find-identity", "-v"];
	const listed = run("/usr/bin/security", args, { capture: true });
	const text = `${listed.stdout ?? ""}\n${listed.stderr ?? ""}`;
	const match = text.match(new RegExp(`"(${pattern}: [^"]+)"`));
	if (!match) {
		throw new Error(`Could not find a "${pattern}" identity after import.`);
	}
	return match[1];
}

if (process.platform !== "darwin") {
	throw new Error("macOS signing certificate import requires macOS.");
}

const applicationLink = requireEnv("CSC_LINK");
const applicationPassword = requireEnv("CSC_KEY_PASSWORD");
const installerLink = requireEnv("CSC_INSTALLER_LINK");
const installerPassword = requireEnv("CSC_INSTALLER_KEY_PASSWORD");

const work = mkdtempSync(join(tmpdir(), "kestrel-signing-"));
const keychain = join(work, "kestrel-release.keychain-db");
const keychainPassword = randomBytes(24).toString("hex");

const existingKeychains = (
	run("/usr/bin/security", ["list-keychains", "-d", "user"], {
		capture: true,
	}).stdout || ""
)
	.split("\n")
	.map((line) => line.trim().replace(/^"|"$/g, ""))
	.filter(Boolean);

run("/usr/bin/security", ["create-keychain", "-p", keychainPassword, keychain]);
run("/usr/bin/security", ["set-keychain-settings", "-lut", "21600", keychain]);
run("/usr/bin/security", ["unlock-keychain", "-p", keychainPassword, keychain]);
run("/usr/bin/security", [
	"list-keychains",
	"-d",
	"user",
	"-s",
	keychain,
	...existingKeychains.filter((path) => path !== keychain),
]);

importP12(work, keychain, applicationLink, applicationPassword, "application");
importP12(work, keychain, installerLink, installerPassword, "installer");

run("/usr/bin/security", [
	"set-key-partition-list",
	"-S",
	"apple-tool:,apple:,codesign:",
	"-s",
	"-k",
	keychainPassword,
	keychain,
]);

const applicationIdentity = findIdentity("Developer ID Application", {
	codesigning: true,
});
const installerIdentity = findIdentity("Developer ID Installer");

const exports = [
	`KESTREL_NATIVE_CODESIGN_IDENTITY=${applicationIdentity}`,
	`KESTREL_NATIVE_INSTALLER_IDENTITY=${installerIdentity}`,
	`CSC_NAME=${applicationIdentity}`,
	`CSC_INSTALLER_NAME=${installerIdentity}`,
];
for (const line of exports) console.log(line);

const githubEnv = process.env.GITHUB_ENV?.trim();
if (githubEnv) {
	appendFileSync(githubEnv, `${exports.join("\n")}\n`);
	console.log(`Wrote signing identities to ${dirname(githubEnv)}/GITHUB_ENV`);
}
