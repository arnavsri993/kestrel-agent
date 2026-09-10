const { execFileSync, spawnSync } = require("node:child_process");
const {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	statSync,
} = require("node:fs");
const { join, relative } = require("node:path");

// This runtime is intentionally an upstream Node distribution rather than the
// Electron executable in NODE_MODE. The latter would retain Electron in the
// production Agent Core process boundary.
const NODE_RUNTIME_VERSION = "22.23.2";
const NODE_RUNTIME_ARCHIVE = `node-v${NODE_RUNTIME_VERSION}-darwin-arm64.tar.gz`;
const NODE_RUNTIME_SHA256 =
	"61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6";
const NODE_RUNTIME_URL = `https://nodejs.org/dist/v${NODE_RUNTIME_VERSION}/${NODE_RUNTIME_ARCHIVE}`;

function sidecarRoot(appPath) {
	return join(appPath, "Contents", "Resources", "agent-core");
}

function sidecarPaths(appPath) {
	const root = sidecarRoot(appPath);
	return {
		root,
		node: join(root, "node", "bin", "node"),
		entry: join(root, "service", "index.js"),
		manifest: join(root, "runtime-manifest.json"),
		license: join(root, "NODE_LICENSE"),
	};
}

function assertRegularFile(path, label) {
	if (!existsSync(path) || !statSync(path).isFile())
		throw new Error(`Agent Core sidecar ${label} is missing: ${path}`);
}

function assertNoSymlinks(root) {
	const visit = (path) => {
		const metadata = lstatSync(path);
		if (metadata.isSymbolicLink())
			throw new Error(`Agent Core sidecar must not contain symlinks: ${path}`);
		if (!metadata.isDirectory()) return;
		for (const name of readdirSync(path)) visit(join(path, name));
	};
	visit(root);
}

function runtimeInfo(nodePath) {
	const output = execFileSync(
		nodePath,
		[
			"-p",
			"JSON.stringify({ node: process.versions.node, electron: process.versions.electron ?? null, arch: process.arch, platform: process.platform })",
		],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	).trim();
	try {
		return JSON.parse(output);
	} catch {
		throw new Error(`Agent Core sidecar Node returned invalid runtime data: ${output}`);
	}
}

function assertStandaloneNode(nodePath) {
	const info = runtimeInfo(nodePath);
	if (info.node !== NODE_RUNTIME_VERSION)
		throw new Error(
			`Agent Core sidecar Node is ${info.node}; expected ${NODE_RUNTIME_VERSION}.`,
		);
	if (info.electron !== null)
		throw new Error("Agent Core sidecar must not report an Electron runtime.");
	if (info.arch !== "arm64" || info.platform !== "darwin")
		throw new Error(
			`Agent Core sidecar must run as darwin arm64; received ${info.platform} ${info.arch}.`,
		);
	return info;
}

function assertManifest(manifestPath) {
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (error) {
		throw new Error(
			`Agent Core sidecar manifest is unreadable: ${
				error instanceof Error ? error.message : "unknown error"
			}`,
		);
	}
	if (
		manifest.node?.version !== NODE_RUNTIME_VERSION ||
		manifest.node?.archive !== NODE_RUNTIME_ARCHIVE ||
		manifest.node?.sha256 !== NODE_RUNTIME_SHA256 ||
		manifest.node?.source !== NODE_RUNTIME_URL
	)
		throw new Error("Agent Core sidecar manifest does not match the pinned Node runtime.");
	return manifest;
}

function relativeToSidecar(appPath, path) {
	return relative(sidecarRoot(appPath), path).split("\\").join("/");
}

function collectMachOBinaries(root) {
	const binaries = [];
	const visit = (path) => {
		const metadata = lstatSync(path);
		if (metadata.isDirectory()) {
			for (const name of readdirSync(path).sort()) visit(join(path, name));
			return;
		}
		if (
			!metadata.isFile() ||
			!(metadata.mode & 0o111 || path.endsWith(".node") || path.endsWith(".dylib"))
		)
			return;
		try {
			execFileSync("/usr/bin/lipo", ["-info", path], {
			stdio: ["ignore", "ignore", "ignore"],
		});
			binaries.push(path);
		} catch {
			// Executable JavaScript and shell helper files are not code-signed Mach-O.
		}
	};
	visit(root);
	return binaries;
}

function assertNodeEntitlements(nodePath) {
	const result = spawnSync(
		"/usr/bin/codesign",
		["-d", "--entitlements", "-", nodePath],
		{ encoding: "utf8" },
	);
	if (result.status !== 0)
		throw new Error(
			`Could not inspect Agent Core sidecar Node entitlements: ${(result.stderr ?? "").trim()}`,
		);
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	for (const entitlement of [
		"com.apple.security.cs.allow-jit",
		"com.apple.security.cs.allow-unsigned-executable-memory",
		"com.apple.security.cs.disable-library-validation",
	]) {
		if (!output.includes(entitlement))
			throw new Error(
				`Agent Core sidecar Node is missing required entitlement ${entitlement}.`,
			);
	}
}

function verifyAgentCoreSidecar(appPath, { verifySignature = false } = {}) {
	const paths = sidecarPaths(appPath);
	if (!existsSync(paths.root))
		throw new Error(`Packaged Agent Core sidecar is missing: ${paths.root}`);
	assertNoSymlinks(paths.root);
	assertRegularFile(paths.node, "Node executable");
	assertRegularFile(paths.entry, "service entry");
	assertRegularFile(paths.manifest, "runtime manifest");
	assertRegularFile(paths.license, "Node license");
	const manifest = assertManifest(paths.manifest);
	const info = assertStandaloneNode(paths.node);
	if (verifySignature) {
		for (const path of collectMachOBinaries(paths.root)) {
			execFileSync("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", path], {
				stdio: "inherit",
			});
		}
		assertNodeEntitlements(paths.node);
	}
	return {
		root: paths.root,
		node: relativeToSidecar(appPath, paths.node),
		entry: relativeToSidecar(appPath, paths.entry),
		manifest,
		info,
	};
}

module.exports = {
	NODE_RUNTIME_ARCHIVE,
	NODE_RUNTIME_SHA256,
	NODE_RUNTIME_URL,
	NODE_RUNTIME_VERSION,
	assertNoSymlinks,
	assertStandaloneNode,
	collectMachOBinaries,
	sidecarPaths,
	verifyAgentCoreSidecar,
};
