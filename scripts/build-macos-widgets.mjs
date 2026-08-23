import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const widgetRoot = join(repositoryRoot, "apps", "desktop", "macos-widgets");
const sourcePath = join(widgetRoot, "Sources", "KestrelWidgets.swift");
const infoPlistPath = join(widgetRoot, "Info.plist");
const entitlementsPath = join(widgetRoot, "entitlements.plist");

function commandOutput(command, args) {
	return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function toolPath(tool) {
	return commandOutput("xcrun", ["--sdk", "macosx", "--find", tool]);
}

function sdkPath() {
	return commandOutput("xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
}

function extensionInfoPlist(appPath) {
	const appInfoPlist = join(appPath, "Contents", "Info.plist");
	let shortVersion = "0.1.0";
	let bundleVersion = "1";
	try {
		shortVersion = commandOutput("plutil", [
			"-extract",
			"CFBundleShortVersionString",
			"raw",
			"-o",
			"-",
			appInfoPlist,
		]);
		bundleVersion = commandOutput("plutil", [
			"-extract",
			"CFBundleVersion",
			"raw",
			"-o",
			"-",
			appInfoPlist,
		]);
	} catch {
		// A local fixture app may not have a complete Electron Info.plist.
	}
	return readFileSync(infoPlistPath, "utf8")
		.replace("<string>0.1.0</string>", `<string>${shortVersion}</string>`)
		.replace("<string>1</string>", `<string>${bundleVersion}</string>`);
}

function architectureTarget(architecture) {
	return architecture === "x64" || architecture === "x86_64"
		? "x86_64"
		: "arm64";
}

/**
 * Build and embed the native WidgetKit extension in an Electron app bundle.
 * The extension is deliberately compiled with the system Swift toolchain so
 * packaging does not require a generated Xcode project or a new JS runtime.
 */
export function buildMacOSWidgets({
	appPath,
	architecture = process.arch,
	signIdentity = "-",
} = {}) {
	if (process.platform !== "darwin")
		throw new Error("Kestrel macOS widgets can only be built on macOS.");
	if (!appPath) throw new Error("An Electron app path is required.");
	const absoluteAppPath = resolve(appPath);
	const appexPath = join(
		absoluteAppPath,
		"Contents",
		"PlugIns",
		"KestrelWidgets.appex",
	);
	const temporaryRoot = mkdtempSync(join(tmpdir(), "kestrel-widgets-"));
	const compiledBinary = join(temporaryRoot, "KestrelWidgets");
	const extensionMacOSPath = join(appexPath, "Contents", "MacOS");
	const extensionInfoPath = join(appexPath, "Contents", "Info.plist");

	try {
		const swiftc = toolPath("swiftc");
		const sdk = sdkPath();
		mkdirSync(join(absoluteAppPath, "Contents", "PlugIns"), {
			recursive: true,
		});
		rmSync(appexPath, { recursive: true, force: true });
		mkdirSync(extensionMacOSPath, { recursive: true });

		execFileSync(
			swiftc,
			[
				"-target",
				`${architectureTarget(architecture)}-apple-macos13.0`,
				"-sdk",
				sdk,
				"-module-name",
				"KestrelWidgets",
				"-parse-as-library",
				"-application-extension",
				"-o",
				compiledBinary,
				sourcePath,
				"-framework",
				"SwiftUI",
				"-framework",
				"WidgetKit",
				"-framework",
				"Foundation",
			],
			{
				stdio: "inherit",
				env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: "13.0" },
			},
		);
		copyFileSync(compiledBinary, join(extensionMacOSPath, "KestrelWidgets"));
		writeFileSync(extensionInfoPath, extensionInfoPlist(absoluteAppPath));

		// The ad-hoc development identity is valid for local widget testing. A
		// distribution identity is supplied by electron-builder when configured;
		// the parent app is signed after this hook, so the nested extension is
		// ready for its final bundle signature.
		execFileSync(
			"codesign",
			[
				"--force",
				"--sign",
				signIdentity || "-",
				"--entitlements",
				entitlementsPath,
				appexPath,
			],
			{ stdio: "inherit" },
		);
		execFileSync(
			"codesign",
			["--verify", "--strict", "--verbose=2", appexPath],
			{ stdio: "inherit" },
		);
		return appexPath;
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true });
	}
}

function cliValue(args, name) {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	if (process.platform !== "darwin") {
		console.error("Skipping macOS widgets: this build is not running on macOS.");
		process.exit(0);
	}
	const args = process.argv.slice(2);
	const appPath = cliValue(args, "--app-path");
	if (!appPath) {
		console.error("Usage: node scripts/build-macos-widgets.mjs --app-path <Kestrel.app>");
		process.exit(2);
	}
	buildMacOSWidgets({
		appPath,
		architecture: cliValue(args, "--arch") ?? process.arch,
		signIdentity:
			cliValue(args, "--identity") ?? process.env.KESTREL_MACOS_WIDGETS_IDENTITY ?? "-",
	});
	console.log(`Embedded KestrelWidgets.appex in ${resolve(appPath)}`);
}
