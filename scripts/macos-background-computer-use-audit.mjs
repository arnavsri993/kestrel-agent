import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const NATIVE_ADDON_NAME = "background-computer-use.node";
const NATIVE_ADDON_RELATIVE_PATH = join(
	"Contents",
	"Resources",
	"app.asar.unpacked",
	"out",
	"native",
	NATIVE_ADDON_NAME,
);
const MAX_NATIVE_DEPENDENCIES = new Set([
	"/usr/lib/",
	"/System/Library/",
	"/System/iOSSupport/",
]);

function run(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8" });
	if (result.status !== 0) {
		const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
		throw new Error(
			`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : "."}`,
		);
	}
	return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function readPlistValue(appPath, key) {
	return run("/usr/bin/plutil", [
		"-extract",
		key,
		"raw",
		join(appPath, "Contents", "Info.plist"),
	]).trim();
}

export function packagedBackgroundComputerUseAddonPath(appPath) {
	const absoluteAppPath = resolve(appPath);
	const candidates = [
		join(absoluteAppPath, NATIVE_ADDON_RELATIVE_PATH),
		join(
			absoluteAppPath,
			"Contents",
			"Resources",
			"app.asar.unpacked",
			"native",
			NATIVE_ADDON_NAME,
		),
	];
	const existing = candidates.filter((candidate) => existsSync(candidate));
	if (existing.length !== 1)
		throw new Error(
			`Expected exactly one unpacked background computer-use addon; found ${existing.length}: ${existing.join(", ") || "none"}.`,
		);
	return existing[0];
}

function assertOnlyArm64(binaryPath) {
	const architectures = run("/usr/bin/lipo", ["-archs", binaryPath]).trim();
	if (architectures !== "arm64")
		throw new Error(
			`Background computer-use addon must be arm64-only; received ${architectures || "unknown"}.`,
		);
}

function assertSystemOnlyDependencies(binaryPath) {
	const output = run("/usr/bin/otool", ["-L", binaryPath]);
	const dependencies = output
		.split(/\r?\n/)
		.slice(1)
		.map((line) => line.trim().split(" (")[0])
		.filter(Boolean);
	for (const dependency of dependencies) {
		if ([...MAX_NATIVE_DEPENDENCIES].some((prefix) => dependency.startsWith(prefix)))
			continue;
		throw new Error(
			`Background computer-use addon has an external runtime dependency: ${dependency}.`,
		);
	}
	return dependencies;
}

function assertNoSiblingInstall(bundlePath) {
	const parent = dirname(bundlePath);
	let siblings = [];
	try {
		siblings = readdirSync(parent, { withFileTypes: true })
			.filter(
				(entry) =>
					entry.isDirectory() &&
					entry.name.endsWith(".app") &&
					entry.name !== basename(bundlePath) &&
					/^Kestrel(?:[- ]|\.)/i.test(entry.name),
			)
	} catch {
		// The containing directory is already validated by the caller.
	}
	if (siblings.length > 0)
		throw new Error(
			`Packaged output contains duplicate Kestrel app bundles: ${siblings
				.map((entry) => entry.name)
				.join(", ")}.`,
		);
}

/**
 * Verify the native addon as it exists in the packaged app. This intentionally
 * does not grant or prompt for TCC permissions: the packaged-app smoke test
 * asks the canonical app for its non-prompting status separately.
 */
export function auditPackagedBackgroundComputerUse(
	appPath,
	{ expectedBundleId } = {},
) {
	if (process.platform !== "darwin")
		throw new Error("The background computer-use package audit only runs on macOS.");
	const absoluteAppPath = resolve(appPath);
	if (!absoluteAppPath.endsWith(".app") || !existsSync(absoluteAppPath))
		throw new Error(`Packaged app not found: ${absoluteAppPath}`);
	assertNoSiblingInstall(absoluteAppPath);
	const bundleId = readPlistValue(absoluteAppPath, "CFBundleIdentifier");
	if (expectedBundleId && bundleId !== expectedBundleId)
		throw new Error(
			`Packaged app TCC identity is ${bundleId}; expected ${expectedBundleId}.`,
		);

	const addonPath = packagedBackgroundComputerUseAddonPath(absoluteAppPath);
	const mode = statSync(addonPath).mode;
	if ((mode & 0o111) === 0)
		throw new Error(`Packaged background computer-use addon is not executable: ${addonPath}`);
	assertOnlyArm64(addonPath);
	const dependencies = assertSystemOnlyDependencies(addonPath);
	run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", addonPath]);
	const signature = run("/usr/bin/codesign", ["-dv", "--verbose=4", addonPath]);
	if (!/Identifier=/.test(signature) || !/Signature=/.test(signature))
		throw new Error("Packaged background computer-use addon has no usable code signature.");

	const requireNative = createRequire(import.meta.url);
	let backend;
	try {
		backend = requireNative(addonPath);
		const health = backend?.health?.();
		if (health?.status !== "healthy" || health?.protocolVersion !== 1)
			throw new Error("The packaged background computer-use health handshake was invalid.");
		const capabilities = backend?.capabilities?.();
		if (
			capabilities?.protocolVersion !== 1 ||
			capabilities?.backgroundSafeOnly !== true ||
			capabilities?.targetedEvents !== false
		)
			throw new Error("The packaged background computer-use capability handshake was invalid.");
		const shutdown = backend?.shutdown?.();
		if (shutdown?.shutdown !== true)
			throw new Error("The packaged background computer-use shutdown handshake was invalid.");
	} catch (cause) {
		throw new Error(
			`Packaged background computer-use handshake failed: ${
				cause instanceof Error ? cause.message : String(cause)
			}`,
		);
	}

	return {
		appPath: absoluteAppPath,
		bundleId,
		addonPath,
		architecture: "arm64",
		executable: true,
		dependencies,
		signed: true,
		health: "healthy",
		protocolVersion: 1,
		backgroundSafeOnly: true,
		targetedEvents: false,
		shutdown: "clean",
		tccIdentity: bundleId,
	};
}

export function auditPackagedForegroundComputerInput(appPath) {
	if (process.platform !== "darwin")
		throw new Error("The foreground input package audit only runs on macOS.");
	const absoluteAppPath = resolve(appPath);
	const addonPath = join(absoluteAppPath, "Contents", "Resources", "app.asar.unpacked",
		"out", "native", "foreground-computer-input.node");
	if (!existsSync(addonPath) || (statSync(addonPath).mode & 0o111) === 0)
		throw new Error(`Packaged foreground input bridge is missing or not executable: ${addonPath}`);
	assertOnlyArm64(addonPath);
	const dependencies = assertSystemOnlyDependencies(addonPath);
	run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", addonPath]);
	const requireNative = createRequire(import.meta.url);
	const backend = requireNative(addonPath);
	if (typeof backend?.performForegroundInput !== "function" ||
		typeof backend?.cancelForegroundInput !== "function" ||
		typeof backend?.preflightEventAccess !== "function" ||
		typeof backend.preflightEventAccess() !== "boolean")
		throw new Error("Packaged foreground input bridge does not export its bounded action and cancellation methods.");
	return { addonPath, architecture: "arm64", signed: true, dependencies, bridge: "healthy" };
}
