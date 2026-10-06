import { execFileSync } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CEF_VERSION, CEF_SHA256, CEF_PLATFORM, CEF_ARCHIVE, CEF_URL } from "./prepare-native-chromium-runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const sidecar = require("../apps/desktop/build/native-browser-sidecar.cjs");
if (process.platform !== "darwin" || process.arch !== "arm64")
	throw new Error("The native browser sidecar requires Apple Silicon macOS.");
if (sidecar.CEF_VERSION !== CEF_VERSION || sidecar.CEF_SHA256 !== CEF_SHA256)
	throw new Error("Native browser verifier pins must match the native CEF runtime pins.");

// Always rebuild current source before electron-builder mutates workspace
// native dependencies to the Electron ABI. No cached-app override is accepted.
const buildArguments = [join(root, "scripts", "build-native-chromium-host.mjs"), "--browser-sidecar"];
if (process.argv.includes("--release")) buildArguments.push("--release");
const provenance = sidecar.sourceProvenance(root);
execFileSync(process.execPath, buildArguments, { cwd: root, stdio: "inherit" });
if (sidecar.sourceProvenance(root).sourceDigest !== provenance.sourceDigest)
	throw new Error("Native browser sources changed during the build; prepare the sidecar again.");
const temporaryRoot = join(root, ".tmp");
const destination = join(temporaryRoot, "native-browser-sidecar");
const staging = join(temporaryRoot, `native-browser-sidecar-stage-${process.pid}-${Date.now()}`);
try {
	await mkdir(staging, { recursive: true });
	execFileSync("/usr/bin/ditto", ["--rsrc", "--extattr", "--acl",
		join(temporaryRoot, "native-chromium-host", "Kestrel.app"), join(staging, "Kestrel.app")],
		{ stdio: "inherit" });
	const paths = sidecar.nativeBrowserPaths(staging);
	const binaries = {};
	for (const path of [paths.executable, ...paths.helperExecutables,
		join(paths.framework, "Chromium Embedded Framework")])
		binaries[relative(staging, path).split(sep).join("/")] = sidecar.hashFile(path);
	await writeFile(paths.manifest, `${JSON.stringify({
		format: 1,
		cef: { version: CEF_VERSION, platform: CEF_PLATFORM, archive: CEF_ARCHIVE,
			sha256: CEF_SHA256, source: CEF_URL },
		helperSandbox: "CefScopedSandboxContext.Initialize",
		...provenance,
		binaries,
	}, null, 2)}\n`);
	sidecar.verifyNativeBrowserRoot(staging);
	await rm(destination, { recursive: true, force: true });
	await rename(staging, destination);
	console.log(`Prepared bundled native extension browser at ${destination}.`);
} catch (error) {
	await rm(staging, { recursive: true, force: true });
	throw error;
}
