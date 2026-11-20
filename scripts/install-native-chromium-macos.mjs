#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { candidateDigest } from "./native-retirement-evidence.mjs";
import { assertNoRunningCanonicalKestrel } from "./native-install-processes.mjs";
import { installNativeBundleTransaction, rollbackNativeBundleTransaction } from "./native-install-transaction.mjs";
import { isKestrelBundle, plistValue, supportedBundleIdentifiers } from "./kestrel-macos-app-hygiene.mjs";
import { macosAppRuntime } from "./macos-app-runtime.mjs";
import { waitForNativeCanonicalAcceptance } from "./native-canonical-acceptance.mjs";

/**
 * Checks signing and every pre-cutover gate before a recoverable replacement.
 * Commits only after fresh canonical observations and the full retirement check.
 * Retains the exact previous bundle and a private journal for explicit recovery.
 * Never closes apps, changes profiles or scans unrelated bundles.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installRoot = resolve(process.env.KESTREL_MACOS_INSTALL_ROOT ?? "/Applications");
const target = join(installRoot, "Kestrel.app");

function requireKestrelBundle(path, native = false) {
	const identifier = plistValue(path, "CFBundleIdentifier");
	if (!isKestrelBundle(path) || !supportedBundleIdentifiers.has(identifier))
		throw new Error(`Refusing an unrecognized Kestrel bundle: ${path}`);
	if (native && macosAppRuntime(path, identifier) !== "native")
		throw new Error("The native installer requires an unambiguous native Chromium bundle.");
}

function checkCandidate(path) {
	requireKestrelBundle(path, true);
	for (const script of ["check-native-signing.mjs", "check-native-cutover-prerequisites.mjs"]) {
		const result = spawnSync(process.execPath, [join(root, "scripts", script), path], { stdio: "inherit" });
		if (result.status !== 0) throw new Error(`Native install validation failed in ${script}.`);
	}
}

function registerCanonical(path) {
	requireKestrelBundle(path);
	execFileSync("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", path], { stdio: "pipe" });
}

if (process.argv[2] === "--rollback") {
	if (process.env.KESTREL_ROLLBACK_NATIVE_CANONICAL !== "1" || !process.argv[3])
		throw new Error("Explicit rollback acceptance and the retained transaction.json path are required. No app was replaced.");
	if (process.platform !== "darwin") throw new Error("Native app rollback requires macOS.");
	const result = await rollbackNativeBundleTransaction({
		transactionPath: resolve(process.argv[3]), target,
		beforeReplace: assertNoRunningCanonicalKestrel, register: registerCanonical,
	});
	console.log(`Restored the previous canonical Kestrel bundle at ${result.destination}. User profiles were not changed.`);
	process.exit(0);
}

const source = resolve(process.argv[2] ?? join(root, "release", "native-mac-arm64", "Kestrel.app"));
if (process.env.KESTREL_INSTALL_NATIVE_CANONICAL !== "1") {
	throw new Error("Native cutover is not accepted. No app was installed. Verify the retirement gates before replacing /Applications/Kestrel.app; use dev:desktop:chromium for isolated development.");
}

if (!existsSync(source)) {
	throw new Error(
		`Native Chromium package missing at ${source}. Run corepack pnpm package:mac:native first.`,
	);
}

// Keep readiness/signing refusal before any installer filesystem mutation.
for (const script of ["check-native-signing.mjs", "check-native-cutover-prerequisites.mjs"]) {
	const checked = spawnSync(process.execPath, [join(root, "scripts", script), source], { stdio: "inherit" });
	if (checked.status !== 0) process.exit(checked.status ?? 1);
}
if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Native installation requires Apple Silicon macOS.");
requireKestrelBundle(source, true);
requireKestrelBundle(target);
const expectedCandidateSha256 = await candidateDigest(source);
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => abort.abort(Error("Canonical verification interrupted; retirement was not accepted.")));
const result = await installNativeBundleTransaction({
	source, target, expectedCandidateSha256,
	signal: abort.signal,
	copy: (from, to) => execFileSync("/usr/bin/ditto", ["--rsrc", "--extattr", "--acl", from, to], { stdio: "pipe" }),
	validate: checkCandidate,
	beforeReplace: assertNoRunningCanonicalKestrel,
	register: registerCanonical,
	verifyInstalled: async transaction => {
		console.log(JSON.stringify({ kind: "native-canonical-verification-required", ...transaction,
			deadlineMinutes: 10, instructions: "Exercise the canonical Dock app, inspect the visible workflow, close only that test-owned instance, and record fresh transaction-bound observations in the retirement manifest. Static validation is not on-screen acceptance." }));
		await waitForNativeCanonicalAcceptance({ target, transaction, manifestPath: resolve(process.env.KESTREL_NATIVE_RETIREMENT_EVIDENCE) }, { signal: abort.signal });
		checkCandidate(target);
		const full = spawnSync(process.execPath, [join(root, "scripts/check-electron-retirement-gates.mjs"), target], { stdio: "inherit" });
		if (full.status !== 0) throw Error("Full retirement acceptance failed after canonical verification.");
		abort.signal.throwIfAborted();
	},
	onPrepared: ({ transactionPath }) => console.log(`Prepared recovery journal: ${transactionPath}`),
});
console.log(`Installed and verified the native bundle at ${result.destination}.`);
console.log(`Previous bundle retained at ${result.backupPath}.`);
console.log(`Recovery journal: ${result.transactionPath}`);
console.log("Canonical observations and the full retirement check passed before transaction commit. Review the supporting artifacts; user profiles were not changed.");
