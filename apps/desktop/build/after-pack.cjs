const { execFileSync } = require("node:child_process");
const {
	chmodSync,
	existsSync,
	mkdirSync,
	rmSync,
	copyFileSync,
	writeFileSync,
} = require("node:fs");
const { join } = require("node:path");
const { auditPackagedMacApp } = require("../../../scripts/macos-architecture-audit.cjs");

exports.default = async function architectureAudit(context) {
	if (process.platform !== "darwin") return;
	const appPath = join(
		context.appOutDir,
		`${context.packager.appInfo.productFilename}.app`,
	);
	installAskKestrelService(appPath);
	auditPackagedMacApp(appPath);

	const lsregister =
		"/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
	const noindexFile = join(context.outDir, ".metadata_never_index");
	if (!existsSync(noindexFile)) {
		try {
			writeFileSync(noindexFile, "");
		} catch {
			/* Best effort Spotlight indexing exclusion */
		}
	}
	if (existsSync(lsregister)) {
		try {
			execFileSync(lsregister, ["-u", appPath], { stdio: "ignore" });
		} catch {
			/* Best effort LaunchServices unregister */
		}
	}
};

function installAskKestrelService(appPath) {
	const serviceSource = join(__dirname, "macos", "AskKestrelService");
	const serviceRoot = join(
		appPath,
		"Contents",
		"Resources",
		"Ask Kestrel.app",
	);
	const executablePath = join(serviceRoot, "Contents", "MacOS", "Ask Kestrel");
	const infoPath = join(serviceSource, "Info.plist");
	const swiftSource = join(serviceSource, "main.swift");
	if (!existsSync(infoPath) || !existsSync(swiftSource))
		throw new Error("Ask Kestrel macOS Service sources are missing.");
	const swiftc = "/usr/bin/swiftc";
	if (!existsSync(swiftc))
		throw new Error(
			"swiftc is required to package the native Ask Kestrel macOS Service.",
		);
	rmSync(serviceRoot, { recursive: true, force: true });
	mkdirSync(join(serviceRoot, "Contents", "MacOS"), { recursive: true });
	mkdirSync(join(serviceRoot, "Contents", "Resources"), { recursive: true });
	copyFileSync(infoPath, join(serviceRoot, "Contents", "Info.plist"));
	execFileSync(
		swiftc,
		[
			"-O",
			"-target",
			"arm64-apple-macos13.0",
			"-framework",
			"AppKit",
			"-o",
			executablePath,
			swiftSource,
		],
		{ stdio: "inherit" },
	);
	chmodSync(executablePath, 0o755);
}
