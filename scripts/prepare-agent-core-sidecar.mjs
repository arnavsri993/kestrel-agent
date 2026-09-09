import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmod,
	copyFile,
	cp,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, platform } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = join(root, ".tmp");
const sidecar = require("../apps/desktop/build/agent-core-sidecar.cjs");

function argumentValue(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

function assertTemporaryPath(path) {
	const relativePath = relative(temporaryRoot, path);
	if (
		relativePath === "" ||
		relativePath.startsWith(`..${sep}`) ||
		relativePath === ".." ||
		resolve(path) === temporaryRoot
	)
		throw new Error("Agent Core sidecar staging must be a dedicated path under .tmp.");
}

function hash(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

async function downloadNodeArchive(cachePath) {
	if (existsSync(cachePath)) {
		const cached = await readFile(cachePath);
		if (hash(cached) === sidecar.NODE_RUNTIME_SHA256) return;
		await rm(cachePath, { force: true });
	}
	const response = await fetch(sidecar.NODE_RUNTIME_URL, { redirect: "error" });
	if (!response.ok)
		throw new Error(
			`Could not download the pinned Node runtime (${response.status} ${response.statusText}).`,
		);
	const bytes = Buffer.from(await response.arrayBuffer());
	if (hash(bytes) !== sidecar.NODE_RUNTIME_SHA256)
		throw new Error("Downloaded Node runtime checksum did not match the pinned SHA-256.");
	await writeFile(cachePath, bytes, { mode: 0o644 });
}

function run(command, arguments_, options = {}) {
	execFileSync(command, arguments_, { cwd: root, stdio: "inherit", ...options });
}

async function copyDereferenced(source, destination) {
	await cp(source, destination, {
		recursive: true,
		dereference: true,
		preserveTimestamps: true,
	});
}

function packageDirectoryFor(entryPath) {
	let candidate = dirname(entryPath);
	while (candidate !== dirname(candidate)) {
		if (existsSync(join(candidate, "package.json"))) return candidate;
		candidate = dirname(candidate);
	}
	throw new Error(`Could not locate package.json for ${entryPath}.`);
}

function linkedPackageDirectory(specifier, resolveFrom) {
	let candidate = dirname(resolveFrom);
	while (candidate !== dirname(candidate)) {
		const packageDirectory = join(
			candidate,
			"node_modules",
			...specifier.split("/"),
		);
		if (existsSync(join(packageDirectory, "package.json"))) return packageDirectory;
		candidate = dirname(candidate);
	}
	return undefined;
}

async function copyRuntimePackage({
	specifier,
	resolveFrom,
	destinationModules,
	copied,
}) {
	const sourceRequire = createRequire(resolveFrom);
	let sourceDirectory;
	try {
		sourceDirectory = packageDirectoryFor(sourceRequire.resolve(specifier));
	} catch (error) {
		sourceDirectory = linkedPackageDirectory(specifier, resolveFrom);
		if (!sourceDirectory)
			throw new Error(
				`Could not resolve production sidecar dependency ${specifier}: ${
					error instanceof Error ? error.message : "unknown error"
				}`,
			);
	}
	const source = await realpath(sourceDirectory);
	const destination = join(destinationModules, ...specifier.split("/"));
	const copyKey = `${source}\u0000${destination}`;
	if (copied.has(copyKey)) return;
	copied.add(copyKey);
	await copyDereferenced(source, destination);
	const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
	const dependencies = {
		...(manifest.dependencies ?? {}),
		...(manifest.optionalDependencies ?? {}),
	};
	for (const dependency of Object.keys(dependencies).sort()) {
		try {
			await copyRuntimePackage({
				specifier: dependency,
				resolveFrom: join(source, "package.json"),
				destinationModules: join(destination, "node_modules"),
				copied,
			});
		} catch (error) {
			// Optional packages for other operating systems are intentionally absent
			// from an arm64 macOS runtime. Required dependencies must still fail.
			if (Object.hasOwn(manifest.optionalDependencies ?? {}, dependency)) continue;
			throw error;
		}
	}
}

async function copyRuntimeDependencies(service) {
	const destinationModules = join(service, "node_modules");
	const copied = new Set();
	const corePackage = join(root, "apps", "core-service", "package.json");
	for (const specifier of ["better-sqlite3", "sharp"])
		await copyRuntimePackage({
			specifier,
			resolveFrom: corePackage,
			destinationModules,
			copied,
		});
	await retainAppleSiliconPrebuilds(service);
}

async function retainAppleSiliconPrebuilds(service) {
	const prebuilds = join(
		service,
		"node_modules",
		"better-sqlite3",
		"prebuilds",
	);
	const required = "darwin-arm64.node";
	if (!existsSync(join(prebuilds, required)))
		throw new Error(
			"better-sqlite3 did not provide the required Node darwin-arm64 prebuild.",
		);
	for (const name of await readdir(prebuilds)) {
		if (name !== required) await rm(join(prebuilds, name), { force: true });
	}
}

async function prepare() {
	if (platform() !== "darwin" || arch() !== "arm64")
		throw new Error("The production Agent Core sidecar can only be prepared on Apple Silicon macOS.");
	const requestedOutput = argumentValue("--output");
	const output = resolve(
		requestedOutput ?? join(temporaryRoot, "agent-core-sidecar"),
	);
	assertTemporaryPath(output);
	await mkdir(temporaryRoot, { recursive: true });

	// Build the Electron-free core first. Its build rejects Electron imports.
	const coreDirectory = join(root, "apps", "core-service");
	run(process.execPath, [join(coreDirectory, "build.mjs")], { cwd: coreDirectory });
	const coreOutput = join(coreDirectory, "out");
	if (!existsSync(join(coreOutput, "index.js")))
		throw new Error("Standalone Agent Core build did not produce out/index.js.");

	const cacheDirectory = join(temporaryRoot, "agent-core-sidecar-cache");
	const archivePath = join(cacheDirectory, sidecar.NODE_RUNTIME_ARCHIVE);
	await mkdir(cacheDirectory, { recursive: true });
	await downloadNodeArchive(archivePath);

	const staging = join(
		temporaryRoot,
		`agent-core-sidecar-stage-${process.pid}-${Date.now()}`,
	);
	const archiveRoot = join(staging, "archive");
	const service = join(staging, "service");
	try {
		await mkdir(archiveRoot, { recursive: true });
		run("/usr/bin/tar", ["-xzf", archivePath, "-C", archiveRoot]);
		const nodeRoot = join(
			archiveRoot,
			`node-v${sidecar.NODE_RUNTIME_VERSION}-darwin-arm64`,
		);
		const nodeSource = join(nodeRoot, "bin", "node");
		const licenseSource = join(nodeRoot, "LICENSE");
		if (!existsSync(nodeSource) || !existsSync(licenseSource))
			throw new Error("Pinned Node archive did not contain its executable and license.");

		await mkdir(join(staging, "node", "bin"), { recursive: true });
		await copyFile(nodeSource, join(staging, "node", "bin", "node"));
		await chmod(join(staging, "node", "bin", "node"), 0o755);
		await copyFile(licenseSource, join(staging, "NODE_LICENSE"));
		await copyDereferenced(coreOutput, service);

		// The esbuild core deliberately leaves native modules external. Assemble a
		// small, fully physical dependency tree from Node-compatible workspace
		// modules, never electron-builder's Electron-ABI rebuild output.
		await copyRuntimeDependencies(service);
		await rm(archiveRoot, { recursive: true, force: true });
		await writeFile(
			join(staging, "runtime-manifest.json"),
			`${JSON.stringify(
				{
					format: 1,
					node: {
						version: sidecar.NODE_RUNTIME_VERSION,
						archive: sidecar.NODE_RUNTIME_ARCHIVE,
						sha256: sidecar.NODE_RUNTIME_SHA256,
						source: sidecar.NODE_RUNTIME_URL,
					},
					service: { entry: "service/index.js" },
				},
				null,
				2,
			)}\n`,
		);
		sidecar.assertNoSymlinks(staging);
		sidecar.assertStandaloneNode(join(staging, "node", "bin", "node"));
		await rm(output, { recursive: true, force: true });
		await rename(staging, output);
		console.log(`Prepared standalone Agent Core sidecar at ${output}.`);
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	} finally {
		await rm(archiveRoot, { recursive: true, force: true }).catch(() => {});
	}
}

await prepare();
