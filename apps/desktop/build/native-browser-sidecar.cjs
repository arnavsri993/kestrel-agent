const { execFileSync, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const {
	closeSync, existsSync, lstatSync, openSync, readFileSync, readSync,
	readdirSync, realpathSync, statSync,
} = require("node:fs");
const { join, relative, resolve, sep } = require("node:path");
const { verifyAgentCoreSidecar } = require("./agent-core-sidecar.cjs");

// Keep these aligned with scripts/prepare-native-chromium-runtime.mjs. The
// preparer checks the imported pin before accepting the upstream runtime.
const CEF_VERSION = "152.0.6+g708dc14+chromium-152.0.7977.83";
const CEF_SHA256 = "3477a3287955da77f7b604e01c9e6fe10a2e1eab26b8d39b9ea1d5a9df944e72";
const HELPER_NAMES = [
	"Kestrel Helper", "Kestrel Helper (Alerts)", "Kestrel Helper (GPU)",
	"Kestrel Helper (Plugin)", "Kestrel Helper (Renderer)",
];

function sourceProvenance(repositoryRoot) {
	const sources = {};
	const visit = (path) => {
		const metadata = lstatSync(path);
		if (metadata.isSymbolicLink()) throw new Error(`Native browser source must not be a symlink: ${path}`);
		if (metadata.isDirectory()) {
			for (const name of readdirSync(path).sort()) visit(join(path, name));
		} else if (metadata.isFile()) {
			sources[relative(repositoryRoot, path).split(sep).join("/")] = hashFile(path);
		}
	};
	for (const path of ["apps/native-chromium-host", "apps/desktop/src/renderer",
		"scripts/build-native-chromium-host.mjs", "scripts/build-native-chromium-wrapper.mjs",
		"scripts/build-native-chromium-renderer.mjs", "scripts/prepare-native-chromium-runtime.mjs"])
		visit(join(repositoryRoot, path));
	return { sources, sourceDigest: createHash("sha256").update(JSON.stringify(sources)).digest("hex") };
}

function hashFile(path) {
	const hash = createHash("sha256");
	const descriptor = openSync(path, "r");
	const buffer = Buffer.alloc(1024 * 1024);
	try {
		let length;
		while ((length = readSync(descriptor, buffer, 0, buffer.length, null)) > 0)
			hash.update(buffer.subarray(0, length));
	} finally {
		closeSync(descriptor);
	}
	return hash.digest("hex");
}

function nativeBrowserPaths(root) {
	const app = join(root, "Kestrel.app");
	const frameworks = join(app, "Contents", "Frameworks");
	return {
		root, app,
		manifest: join(root, "runtime-manifest.json"),
		executable: join(app, "Contents", "MacOS", "Kestrel"),
		framework: join(frameworks, "Chromium Embedded Framework.framework"),
		helperApps: HELPER_NAMES.map((name) => join(frameworks, `${name}.app`)),
		helperExecutables: HELPER_NAMES.map((name) =>
			join(frameworks, `${name}.app`, "Contents", "MacOS", name)),
	};
}

function assertContainedTree(root) {
	if (lstatSync(root).isSymbolicLink())
		throw new Error(`Native browser sidecar root must not be a symlink: ${root}`);
	const resolvedRoot = realpathSync(root);
	const visit = (path) => {
		const name = path.split(sep).at(-1);
		if (/electron.*\.framework$/i.test(name))
			throw new Error(`Native browser must not contain an Electron framework: ${path}`);
		const metadata = lstatSync(path);
		if (metadata.isSymbolicLink()) {
			const target = relative(resolvedRoot, realpathSync(path));
			if (target === ".." || target.startsWith(`..${sep}`))
				throw new Error(`Native browser symlink escapes its bundle: ${path}`);
			return;
		}
		if (metadata.isDirectory())
			for (const child of readdirSync(path)) visit(join(path, child));
	};
	visit(root);
}

function signatureEvidence(path) {
	const result = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", path], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`Native browser signature evidence is unavailable: ${path}`);
	return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function verifyNativeBrowserRoot(root, { verifySignature = true } = {}) {
	const paths = nativeBrowserPaths(root);
	if (!existsSync(paths.manifest))
		throw new Error(`Native browser sidecar manifest is missing: ${paths.manifest}`);
	const manifest = JSON.parse(readFileSync(paths.manifest, "utf8"));
	const archive = `cef_binary_${CEF_VERSION}_macosarm64.tar.bz2`;
	if (manifest.format !== 1 || manifest.cef?.version !== CEF_VERSION ||
		manifest.cef?.sha256 !== CEF_SHA256 || manifest.cef?.platform !== "macosarm64" ||
		manifest.cef?.archive !== archive ||
		manifest.cef?.source !== `https://cef-builds.spotifycdn.com/${encodeURIComponent(archive)}` ||
		manifest.helperSandbox !== "CefScopedSandboxContext.Initialize")
		throw new Error("Native browser provenance does not match the pinned CEF sandbox build.");
	if (!manifest.sources || Object.keys(manifest.sources).length === 0 ||
		Object.values(manifest.sources).some((digest) => !/^[a-f0-9]{64}$/.test(digest)) ||
		manifest.sourceDigest !== createHash("sha256").update(JSON.stringify(manifest.sources)).digest("hex"))
		throw new Error("Native browser source provenance is missing or inconsistent.");
	assertContainedTree(root);
	const info = join(paths.app, "Contents", "Info.plist");
	for (const [key, expected] of [["LSUIElement", "true"], ["CFBundleDisplayName", "Kestrel Browser"]]) {
		const actual = execFileSync("/usr/bin/plutil", ["-extract", key, "raw", info], { encoding: "utf8" }).trim();
		if (actual !== expected) throw new Error(`Native browser ${key} must be ${expected}; received ${actual}.`);
	}
	const binaries = [paths.executable, ...paths.helperExecutables,
		join(paths.framework, "Chromium Embedded Framework")];
	for (const binary of binaries) {
		if (!existsSync(binary) || !statSync(binary).isFile())
			throw new Error(`Native browser binary is missing: ${binary}`);
		const key = relative(root, binary).split(sep).join("/");
		if (manifest.binaries?.[key] !== hashFile(binary))
			throw new Error(`Native browser binary differs from the prepared build: ${binary}`);
		const architecture = execFileSync("/usr/bin/lipo", ["-archs", binary], { encoding: "utf8" }).trim();
		if (architecture !== "arm64") throw new Error(`Native browser binary must be arm64: ${binary}`);
		// otool treats parentheses in CEF helper names as archive-member syntax.
		const libraries = execFileSync("/usr/bin/dyld_info", ["-dependents", binary], { encoding: "utf8" });
		if (/Electron Framework|Electron\.framework/i.test(libraries))
			throw new Error(`Native browser binary links Electron: ${binary}`);
	}
	for (const helper of paths.helperExecutables) {
		const symbols = execFileSync("/usr/bin/nm", [helper], { encoding: "utf8" });
		if (!symbols.includes("CefScopedSandboxContext10Initialize"))
			throw new Error(`Native browser helper lacks the CEF sandbox initializer: ${helper}`);
	}
	if (verifySignature) {
		for (const target of [paths.framework, ...paths.helperApps, paths.app])
			execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", target], { stdio: "inherit" });
		for (const target of [paths.app, ...paths.helperApps]) {
			if (!/flags=.*\([^)]*runtime/.test(signatureEvidence(target)))
				throw new Error(`Native browser executable lacks hardened runtime signing: ${target}`);
		}
	}
	verifyAgentCoreSidecar(paths.app, { verifySignature });
	// Loading SQLite with the bundled Node catches Electron-ABI rebuild leakage.
	const coreRoot = join(paths.app, "Contents", "Resources", "agent-core");
	execFileSync(join(coreRoot, "node", "bin", "node"), ["-e",
		"const Database = require(process.argv[1]); const db = new Database(':memory:'); if (db.prepare('select 1 as value').get().value !== 1) process.exit(1); db.close();",
		join(coreRoot, "service", "node_modules", "better-sqlite3")], { stdio: "inherit" });
	return paths;
}

function verifyNativeBrowserSidecar(appPath, { verifyOuterIdentity = true, ...options } = {}) {
	const paths = verifyNativeBrowserRoot(join(resolve(appPath), "Contents", "Resources", "native-browser"), options);
	if (verifyOuterIdentity) {
		const outerSignature = signatureEvidence(appPath);
		const outerTeam = outerSignature.match(/^TeamIdentifier=(.+)$/m)?.[1];
		if (outerTeam && outerTeam !== "not set") {
			for (const target of [paths.app, paths.framework, ...paths.helperApps]) {
				if (signatureEvidence(target).match(/^TeamIdentifier=(.+)$/m)?.[1] !== outerTeam)
					throw new Error(`Native browser must use the desktop app's signing team: ${target}`);
			}
		}
	}
	return paths;
}

module.exports = { CEF_VERSION, CEF_SHA256, hashFile, nativeBrowserPaths, sourceProvenance,
	verifyNativeBrowserRoot, verifyNativeBrowserSidecar };
