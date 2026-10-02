import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { verifyBackgroundComputerUseSafety } from "./verify-background-computer-use-safety.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeDirectory = join(root, "apps/desktop/native");
const packagedDirectory = join(root, "apps/desktop/out/native");
const targets = [
	{
		name: "background-computer-use",
		required: true,
		frameworks: [
			"ApplicationServices",
			"AppKit",
			"CoreGraphics",
			"CoreImage",
			"CoreMedia",
			"CoreVideo",
			"Foundation",
			"ImageIO",
			"ScreenCaptureKit",
		],
	},
	{
		name: "foreground-computer-input",
		required: true,
		frameworks: [
			"ApplicationServices",
			"AppKit",
			"Carbon",
			"CoreGraphics",
			"Foundation",
		],
	},
];

if (process.platform !== "darwin") {
	console.log("Skipping the macOS background computer-use bridge on non-macOS.");
	process.exit(0);
}

if (process.arch !== "arm64" && process.env.npm_config_arch !== "arm64") {
	console.log("Skipping the arm64 macOS computer-use bridges on this architecture.");
	process.exit(0);
}
verifyBackgroundComputerUseSafety(root);

const desktopPackage = JSON.parse(
	readFileSync(join(root, "apps/desktop/package.json"), "utf8"),
);
const electronVersion = desktopPackage.devDependencies?.electron;
if (typeof electronVersion !== "string" || electronVersion.length === 0)
	throw new Error("The desktop Electron version is missing from apps/desktop/package.json.");
const electronInclude = join(homedir(), ".electron-gyp", electronVersion, "include", "node");
// These addons use only Node-API v8, whose ABI is stable across Node and
// Electron. The first desktop build in a clean CI checkout may run before
// electron-rebuild has downloaded Electron's headers.
const hostNodeInclude = join(dirname(dirname(process.execPath)), "include", "node");
const nodeInclude = process.env.ELECTRON_GYP_INCLUDE ??
	(existsSync(join(electronInclude, "node_api.h")) ? electronInclude : hostNodeInclude);
if (!existsSync(join(nodeInclude, "node_api.h")))
	throw new Error(`Node-API headers are missing: ${nodeInclude}`);
if (nodeInclude === hostNodeInclude)
	console.log(`Using host Node-API headers for the native bridges: ${nodeInclude}`);
const sdk = execFileSync("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"], {
	encoding: "utf8",
}).trim();
const deploymentTarget = process.env.MACOSX_DEPLOYMENT_TARGET ?? "13.0";

mkdirSync(nativeDirectory, { recursive: true });
mkdirSync(packagedDirectory, { recursive: true });

for (const target of targets) {
	const source = join(nativeDirectory, `${target.name}.mm`);
	if (!existsSync(source)) {
		if (target.required) throw new Error(`Native source is missing: ${source}`);
		console.log(`Skipping optional native bridge because its source is absent: ${source}`);
		continue;
	}
	const sourceOutput = join(nativeDirectory, `${target.name}.node`);
	const packagedOutput = join(packagedDirectory, `${target.name}.node`);
	const frameworks = target.frameworks.flatMap((framework) => ["-framework", framework]);
	execFileSync("/usr/bin/clang++", [
		"-std=c++17",
		"-fobjc-arc",
		"-fvisibility=hidden",
		"-DNAPI_VERSION=8",
		"-arch", "arm64",
		`-mmacosx-version-min=${deploymentTarget}`,
		"-isysroot", sdk,
		"-I", nodeInclude,
		"-bundle",
		"-undefined", "dynamic_lookup",
		"-o", sourceOutput,
		source,
		...frameworks,
	], { stdio: "inherit" });

	copyFileSync(sourceOutput, packagedOutput);
	if ((statSync(sourceOutput).mode & 0o111) === 0)
		throw new Error(`The ${target.name} native bridge is not executable.`);
	console.log(`Built arm64 ${target.name} bridge: ${sourceOutput}`);
	console.log(`Copied packaged bridge: ${packagedOutput}`);
}
