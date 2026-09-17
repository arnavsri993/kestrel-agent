import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareNativeChromiumRuntime } from "./prepare-native-chromium-runtime.mjs";
import { buildNativeChromiumWrapper } from "./build-native-chromium-wrapper.mjs";
import { buildNativeChromiumRenderer } from "./build-native-chromium-renderer.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = join(root, ".tmp");
const nativeHostRoot = join(root, "apps", "native-chromium-host");
const agentCoreSidecar = join(temporaryRoot, "agent-core-sidecar");
const helperVariants = [
	{ name: "Kestrel Helper", bundleSuffix: "" },
	{ name: "Kestrel Helper (Alerts)", bundleSuffix: ".alerts" },
	{ name: "Kestrel Helper (GPU)", bundleSuffix: ".gpu" },
	{ name: "Kestrel Helper (Plugin)", bundleSuffix: ".plugin" },
	{ name: "Kestrel Helper (Renderer)", bundleSuffix: ".renderer" },
];

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
		throw new Error("Native Chromium build output must stay in a dedicated .tmp path.");
}

function run(command, arguments_, options = {}) {
	execFileSync(command, arguments_, { cwd: root, stdio: "inherit", ...options });
}

function appPaths(rootPath) {
	const app = join(rootPath, "Kestrel.app");
	return {
		app,
		executable: join(app, "Contents", "MacOS", "Kestrel"),
		frameworks: join(app, "Contents", "Frameworks"),
		resources: join(app, "Contents", "Resources"),
	};
}

async function createHelperBundles({ helperExecutable, frameworks }) {
	const template = await readFile(join(nativeHostRoot, "build", "helper-Info.plist.in"), "utf8");
	for (const helper of helperVariants) {
		const app = join(frameworks, `${helper.name}.app`);
		const executable = join(app, "Contents", "MacOS", helper.name);
		const info = join(app, "Contents", "Info.plist");
		await mkdir(dirname(executable), { recursive: true });
		await copyFile(helperExecutable, executable);
		await chmod(executable, 0o755);
		await writeFile(
			info,
			template
				.replaceAll("__EXECUTABLE_NAME__", helper.name)
				.replaceAll("__BUNDLE_ID_SUFFIX__", helper.bundleSuffix),
		);
		run("/usr/bin/plutil", ["-lint", info]);
	}
}

export async function buildNativeChromiumHost({ output } = {}) {
	if (process.platform !== "darwin" || process.arch !== "arm64")
		throw new Error("The native Chromium host can only be built on Apple Silicon macOS.");
	const destination = resolve(
		output ?? argumentValue("--output") ?? join(temporaryRoot, "native-chromium-host"),
	);
	assertTemporaryPath(destination);
	const releaseBuild = process.argv.includes("--release");
	const signingIdentity =
		argumentValue("--codesign-identity") ?? process.env.KESTREL_NATIVE_CODESIGN_IDENTITY ?? "-";
	if (releaseBuild && signingIdentity === "-")
		throw new Error(
			"A named Developer ID signing identity is required for a native Chromium release build.",
		);
	const entitlements = join(
		nativeHostRoot,
		"build",
		releaseBuild ? "entitlements.mac.release.plist" : "entitlements.mac.dev.plist",
	);
	const runtime = await prepareNativeChromiumRuntime();
	const wrapper = await buildNativeChromiumWrapper({ runtime });
	const renderer = await buildNativeChromiumRenderer();
	// This is the same Electron-free Node Core runtime packaged in the current
	// desktop app. The native host never executes Electron's utility process.
	run(process.execPath, [join(root, "scripts", "prepare-agent-core-sidecar.mjs")]);
	if (!existsSync(join(agentCoreSidecar, "service", "index.js")))
		throw new Error("The standalone Agent Core sidecar was not prepared.");
	const staging = join(
		temporaryRoot,
		`native-chromium-host-stage-${process.pid}-${Date.now()}`,
	);
	assertTemporaryPath(staging);
	const paths = appPaths(staging);
	try {
		await mkdir(join(paths.app, "Contents", "MacOS"), { recursive: true });
		await mkdir(paths.frameworks, { recursive: true });
		await mkdir(paths.resources, { recursive: true });
		await copyFile(
			join(nativeHostRoot, "build", "Info.plist"),
			join(paths.app, "Contents", "Info.plist"),
		);
		await copyFile(join(runtime, "LICENSE.txt"), join(paths.resources, "CEF_LICENSE.txt"));
		run("/usr/bin/ditto", [
			"--rsrc",
			"--extattr",
			"--acl",
			agentCoreSidecar,
			join(paths.resources, "agent-core"),
		]);
		await copyFile(
			join(nativeHostRoot, "resources", "native-core-relay.mjs"),
			join(paths.resources, "native-core-relay.mjs"),
		);
		run("/usr/bin/ditto", [
			"--rsrc",
			"--extattr",
			"--acl",
			join(runtime, "Release", "Chromium Embedded Framework.framework"),
			join(paths.frameworks, "Chromium Embedded Framework.framework"),
		]);
		run("/usr/bin/ditto", [
			"--rsrc",
			"--extattr",
			"--acl",
			join(nativeHostRoot, "resources", "kestrel-shell"),
			join(paths.resources, "kestrel-shell"),
		]);
		run("/usr/bin/ditto", [
			"--rsrc",
			"--extattr",
			"--acl",
			renderer,
			join(paths.resources, "kestrel-renderer"),
		]);

		const compiler = "/Library/Developer/CommandLineTools/usr/bin/clang++";
		if (!existsSync(compiler)) throw new Error("clang++ is required to build the native Chromium host.");
		const sdkPath = execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], {
			encoding: "utf8",
		}).trim();
		if (!sdkPath) throw new Error("A macOS SDK is required to build the native Chromium host.");
		const compileFlags = [
			"-std=c++20",
			"-stdlib=libc++",
			// The distributed CEF framework and the CEF C++ wrapper are release
			// builds. Keep DCHECK-only ref-count state out of the host as well so
			// all translation units agree on the ref-counted object layout.
			"-DNDEBUG",
			"-fobjc-arc",
			"-arch",
			"arm64",
			"-mmacosx-version-min=13.0",
			"-isysroot",
			sdkPath,
			"-I",
			runtime,
		];
		const linkFlags = [
			wrapper,
			"-framework",
			"AppKit",
			"-framework",
			"Cocoa",
			"-framework",
			"IOSurface",
			"-Wl,-search_paths_first",
			"-Wl,-ObjC",
			"-Wl,-pie",
			"-Wl,-dead_strip",
			"-Wl,-rpath,@executable_path/../Frameworks",
		];
		run(compiler, [
			...compileFlags,
			"-F",
			paths.frameworks,
			join(nativeHostRoot, "src", "kestrel_native_host.mm"),
			join(nativeHostRoot, "src", "kestrel_chromium_app.cc"),
			"-o",
			paths.executable,
			...linkFlags,
		]);
		await chmod(paths.executable, 0o755);
		const helperExecutable = join(staging, "Kestrel Chromium Helper");
		run(compiler, [
			...compileFlags,
			"-DCEF_USE_SANDBOX",
			join(nativeHostRoot, "src", "kestrel_chromium_helper.cc"),
			join(nativeHostRoot, "src", "kestrel_chromium_app.cc"),
			"-o",
			helperExecutable,
			...linkFlags,
		]);
		await chmod(helperExecutable, 0o755);
		await createHelperBundles({ helperExecutable, frameworks: paths.frameworks });
		run("/usr/bin/plutil", ["-lint", join(paths.app, "Contents", "Info.plist")]);
		// Ad-hoc builds need development library-validation opt-out because macOS
		// cannot assign a Team ID without a signing identity. Release builds require
		// an actual Developer ID identity and use the stricter release entitlements.
		// Notarization remains a hard gate before replacement of /Applications/Kestrel.app.
		run("/usr/bin/codesign", [
			"--force",
			"--deep",
			"--sign",
			signingIdentity,
			"--options",
			"runtime",
			"--entitlements",
			entitlements,
			paths.app,
		]);
		run("/usr/bin/codesign", ["--verify", "--deep", "--strict", paths.app]);
		run("/usr/bin/lipo", ["-verify_arch", "arm64", paths.executable]);
		run("/usr/bin/lipo", ["-verify_arch", "arm64", helperExecutable]);
		await rm(destination, { recursive: true, force: true });
		await rename(staging, destination);
		console.log(
			`Built ${releaseBuild ? "release-signed" : "ad-hoc development"} native Chromium Kestrel host at ${appPaths(destination).app}.`,
		);
		return appPaths(destination).app;
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await buildNativeChromiumHost();
}
