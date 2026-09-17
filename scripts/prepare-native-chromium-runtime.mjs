import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	access,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = join(root, ".tmp");

// CEF's own maintained binary distribution is the native Chromium runtime used
// for the real host. Keep this pin and checksum explicit so a release build
// never silently follows a browser binary from PATH or an unverified mirror.
// CEF 152 includes CEF's maintained GCM-disable patch. That prevents the
// background registration traffic emitted by older CEF builds even when the
// host requests Chromium's background-networking flags.
export const CEF_VERSION = "152.0.6+g708dc14+chromium-152.0.7977.83";
export const CEF_PLATFORM = "macosarm64";
export const CEF_ARCHIVE = `cef_binary_${CEF_VERSION}_${CEF_PLATFORM}.tar.bz2`;
export const CEF_SHA256 =
	"3477a3287955da77f7b604e01c9e6fe10a2e1eab26b8d39b9ea1d5a9df944e72";
export const CEF_URL = `https://cef-builds.spotifycdn.com/${encodeURIComponent(
	CEF_ARCHIVE,
)}`;

function argumentValue(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

function assertTemporaryPath(path) {
	const temporary = resolve(temporaryRoot);
	const relativePath = relative(temporary, path);
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		resolve(path) === temporary
	)
		throw new Error("Native Chromium staging must stay in a dedicated .tmp path.");
}

function hash(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

async function downloadArchive(cachePath) {
	if (existsSync(cachePath)) {
		const cached = await readFile(cachePath);
		if (hash(cached) === CEF_SHA256) return;
		await rm(cachePath, { force: true });
	}
	const response = await fetch(CEF_URL.trim(), { redirect: "error" });
	if (!response.ok)
		throw new Error(
			`Could not download pinned CEF runtime (${response.status} ${response.statusText}).`,
		);
	const bytes = Buffer.from(await response.arrayBuffer());
	if (hash(bytes) !== CEF_SHA256)
		throw new Error("Downloaded CEF runtime checksum did not match the pinned SHA-256.");
	await writeFile(cachePath, bytes, { mode: 0o644 });
}

function run(command, arguments_, options = {}) {
	execFileSync(command, arguments_, { cwd: root, stdio: "inherit", ...options });
}

async function assertFile(path, description) {
	try {
		await access(path);
	} catch {
		throw new Error(`CEF runtime is missing ${description}: ${path}`);
	}
}

export async function prepareNativeChromiumRuntime({ output } = {}) {
	if (process.platform !== "darwin" || process.arch !== "arm64")
		throw new Error("The native Chromium runtime can only be prepared on Apple Silicon macOS.");
	const destination = resolve(
		output ?? argumentValue("--output") ?? join(temporaryRoot, "native-chromium-runtime"),
	);
	assertTemporaryPath(destination);
	await mkdir(temporaryRoot, { recursive: true });

	const cacheDirectory = join(temporaryRoot, "native-chromium-runtime-cache");
	const archivePath = join(cacheDirectory, CEF_ARCHIVE);
	await mkdir(cacheDirectory, { recursive: true });
	await downloadArchive(archivePath);

	const staging = join(
		temporaryRoot,
		`native-chromium-runtime-stage-${process.pid}-${Date.now()}`,
	);
	assertTemporaryPath(staging);
	const archiveRoot = `cef_binary_${CEF_VERSION}_${CEF_PLATFORM}`;
	try {
		await mkdir(staging, { recursive: true });
		run("/usr/bin/tar", [
			"-xjf",
			archivePath,
			"-C",
			staging,
			"--strip-components",
			"1",
			`${archiveRoot}/Release`,
			`${archiveRoot}/include`,
			`${archiveRoot}/libcef_dll`,
			`${archiveRoot}/cmake`,
			`${archiveRoot}/LICENSE.txt`,
		]);
		await assertFile(
			join(
				staging,
				"Release",
				"Chromium Embedded Framework.framework",
				"Chromium Embedded Framework",
			),
			"the arm64 Chromium framework",
		);
		await assertFile(join(staging, "include", "cef_app.h"), "CEF headers");
		await assertFile(
			join(staging, "libcef_dll", "CMakeLists.txt"),
			"CEF C++ wrapper sources",
		);
		await assertFile(
			join(staging, "cmake", "cef_macros.cmake"),
			"CEF macOS helper-bundle build metadata",
		);
		await assertFile(join(staging, "LICENSE.txt"), "CEF license");
		await writeFile(
			join(staging, "runtime-manifest.json"),
			`${JSON.stringify(
				{
					format: 1,
					cef: {
						version: CEF_VERSION,
						platform: CEF_PLATFORM,
						archive: CEF_ARCHIVE,
						sha256: CEF_SHA256,
						source: CEF_URL.trim(),
						license: "LICENSE.txt",
					},
				},
				null,
				2,
			)}\n`,
		);
		await rm(destination, { recursive: true, force: true });
		await rename(staging, destination);
		console.log(`Prepared native Chromium runtime at ${destination}.`);
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	}
	return destination;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await prepareNativeChromiumRuntime();
}
