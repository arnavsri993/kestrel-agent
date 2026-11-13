import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareNativeChromiumRuntime } from "./prepare-native-chromium-runtime.mjs";
import { buildNativeChromiumWrapper } from "./build-native-chromium-wrapper.mjs";
import { buildNativeChromiumRenderer } from "./build-native-chromium-renderer.mjs";
import { buildNativeExtensionService } from "./build-native-extension-service.mjs";
import { buildNativeUi } from "./build-native-ui.mjs";
import { compileNativeLocalVaultCrypto, nativeLocalVaultLinkFlags } from "./build-native-local-vault.mjs";
import { validateNativeVaultCefRuntime } from "./native-vault-cef-runtime.mjs";
import { sealPackagedVaultRecord } from "./native-vault-bundle-record.mjs";
import { selectNativeVaultRuntime } from "./native-vault-runtime-selection.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = join(root, ".tmp");
const nativeHostRoot = join(root, "apps", "native-chromium-host");
const agentCoreSidecar = join(temporaryRoot, "agent-core-sidecar");
const pinnedNode = createRequire(import.meta.url)("../apps/desktop/build/agent-core-sidecar.cjs");
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

export function nativeChromiumBuildModeCompileFlag(releaseBuild) {
	if (typeof releaseBuild !== "boolean")
		throw new TypeError("Native Chromium build mode must be an explicit boolean.");
	return `-DKESTREL_NATIVE_RELEASE_BUILD=${releaseBuild ? "1" : "0"}`;
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

export async function buildNativeChromiumHost({ output, vaultCefRuntime } = {}) {
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
	// --output selects the final app only. These imported builders also have
	// standalone CLIs; pass their own paths so they cannot consume the host's
	// flag and overwrite one another's runtime and renderer artifacts.
	const selectedVaultRuntime = selectNativeVaultRuntime({ explicit: vaultCefRuntime });
	if (releaseBuild && !selectedVaultRuntime)
		throw new Error("A release requires --vault-cef-runtime naming a reviewed local vault-enabled CEF distribution. Stock CEF is for disposable development fixtures only.");
	let runtime;
	let vaultRuntimeEvidence;
	if (selectedVaultRuntime) {
		const reviewed = await validateNativeVaultCefRuntime({ runtime: selectedVaultRuntime });
		// The wrapper builder mutates its runtime cache. Preserve the original
		// reviewed distribution and revalidate this dedicated local staging copy.
		await mkdir(temporaryRoot, { recursive: true });
		runtime = await mkdtemp(join(temporaryRoot, "native-vault-cef-runtime-"));
		run("/usr/bin/ditto", ["--rsrc", "--extattr", "--acl", reviewed.runtime, runtime]);
		vaultRuntimeEvidence = await validateNativeVaultCefRuntime({ runtime });
		if (vaultRuntimeEvidence.frameworkSha256 !== reviewed.frameworkSha256)
			throw new Error("Custom CEF changed while staging. No app was built.");
	} else {
		runtime = await prepareNativeChromiumRuntime({ output: join(temporaryRoot, "native-chromium-runtime") });
	}
	const wrapper = await buildNativeChromiumWrapper({ runtime });
	const renderer = await buildNativeChromiumRenderer({ output: join(temporaryRoot, "native-chromium-renderer") });
	const extensions = await buildNativeExtensionService();
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
		await copyFile(join(root, "apps/desktop/build/icon.icns"), join(paths.resources, "AppIcon.icns"));
		if (vaultRuntimeEvidence) {
			const { apiVersion, frameworkSha256, cefVersion, chromiumVersion, pins, patches } = vaultRuntimeEvidence;
			await writeFile(join(paths.resources, "native-vault-engine.json"), JSON.stringify({
				apiVersion, frameworkSha256, cefVersion, chromiumVersion, pins, patches,
				sourceProvenance: "builder-attestation-not-independent-proof", runtimeBehaviorVerified: false,
			}, null, 2) + "\n");
		}
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
		await copyFile(
			join(nativeHostRoot, "resources", "native-core-profile.mjs"),
			join(paths.resources, "native-core-profile.mjs"),
		);
		await copyFile(join(extensions, "native-extension-service.mjs"),
			join(paths.resources, "native-extension-service.mjs"));
		await buildNativeUi({ renderer, resources: paths.resources });
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
			nativeChromiumBuildModeCompileFlag(releaseBuild),
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
			"AVFoundation",
			"-framework",
			"Cocoa",
			"-framework",
			"ImageIO",
			"-framework",
			"IOSurface",
			"-framework",
			"ScreenCaptureKit",
			"-framework",
			"ApplicationServices",
			"-framework",
			"Security",
			"-framework",
			"LocalAuthentication",
			"-framework",
			"ServiceManagement",
			"-Wl,-search_paths_first",
			"-Wl,-ObjC",
			"-Wl,-pie",
			"-Wl,-dead_strip",
			"-Wl,-rpath,@executable_path/../Frameworks",
		];
		const vaultCrypto = compileNativeLocalVaultCrypto(join(staging, "local-vault-crypto.o"));
		const vaultLinkFlags = nativeLocalVaultLinkFlags();
		run(compiler, ["-std=c++20", "-O2", "-Wall", "-Wextra", "-Werror", "-arch", "arm64", "-mmacosx-version-min=13.0", "-isysroot", sdkPath,
			join(nativeHostRoot, "src", "kestrel_local_vault_crypto_helper.cc"), vaultCrypto,
			...vaultLinkFlags, "-o", join(paths.app, "Contents/MacOS/Kestrel Vault")]);
		run("/usr/bin/codesign", ["--force", "--sign", signingIdentity, "--options", "runtime",
			join(paths.app, "Contents/MacOS/Kestrel Vault")]);
		run(compiler, [
			...compileFlags,
			"-F",
			paths.frameworks,
			join(nativeHostRoot, "src", "kestrel_native_host.mm"),
			join(nativeHostRoot, "src", "kestrel_chromium_desktop.mm"),
			join(nativeHostRoot, "src", "kestrel_native_run_loop_dispatch.mm"),
			join(nativeHostRoot, "src", "kestrel_profile_reservation.cc"),
			join(nativeHostRoot, "src", "native_isolated_automation.mm"),
			join(nativeHostRoot, "src", "native_isolated_downloads.mm"),
			join(nativeHostRoot, "src", "native_computer_use.mm"),
			join(nativeHostRoot, "src", "kestrel_chrome_window_mac.mm"),
			join(nativeHostRoot, "src", "kestrel_private_chrome_pipe.mm"),
			join(nativeHostRoot, "src", "kestrel_live_extension_control.mm"),
			join(nativeHostRoot, "src", "kestrel_native_credentials.mm"),
			join(nativeHostRoot, "src", "kestrel_native_core_keychain.mm"),
			join(nativeHostRoot, "src", "kestrel_local_vault.mm"),
			join(nativeHostRoot, "src", "kestrel_browser_local_vault.mm"),
			join(nativeHostRoot, "src", "kestrel_local_vault_crypto_process.mm"),
			vaultCrypto,
			join(nativeHostRoot, "src", "kestrel_native_core_key_dispatch.mm"),
			join(nativeHostRoot, "src", "kestrel_native_profile_transfer.mm"),
			join(nativeHostRoot, "src", "kestrel_native_prepared_profiles.mm"),
			join(nativeHostRoot, "src", "kestrel_legacy_core_key.cc"),
			join(nativeHostRoot, "src", "kestrel_legacy_keychain.mm"),
			join(nativeHostRoot, "src", "kestrel_durable_browser_library.cc"),
			join(nativeHostRoot, "src", "kestrel_chromium_app.cc"),
			"-o",
			paths.executable,
			...linkFlags,
			...vaultLinkFlags,
		]);
		await chmod(paths.executable, 0o755);
		run(compiler, ["-std=c++20", "-O2", "-Wall", "-Wextra", "-Werror", "-arch", "arm64", "-mmacosx-version-min=13.0", "-isysroot", sdkPath,
			join(nativeHostRoot, "src", "kestrel_native_messaging.cc"), "-o", join(paths.app, "Contents/MacOS/Kestrel Native Bridge")]);
		// Use the headers from the same checksum-verified archive as the bundled
		// Node runtime. A developer's Homebrew installation is not a build input.
		const nodeHeaders = process.env.KESTREL_NODE_HEADERS ?? join(staging, `node-v${pinnedNode.NODE_RUNTIME_VERSION}-darwin-arm64`, "include/node");
		if (!process.env.KESTREL_NODE_HEADERS) run("/usr/bin/tar", ["-xzf", join(temporaryRoot, "agent-core-sidecar-cache", pinnedNode.NODE_RUNTIME_ARCHIVE),
			"-C", staging, `node-v${pinnedNode.NODE_RUNTIME_VERSION}-darwin-arm64/include/node`]);
		if (!existsSync(join(nodeHeaders, "node_api.h"))) throw new Error("Node N-API headers are required to compile the native peer inspector (KESTREL_NODE_HEADERS).");
		run(compiler, ["-std=c++20", "-O2", "-Wall", "-Wextra", "-Werror", "-arch", "arm64", "-mmacosx-version-min=13.0", "-isysroot", sdkPath,
			"-bundle", "-undefined", "dynamic_lookup", "-I", nodeHeaders,
			join(nativeHostRoot, "src", "kestrel_native_peer.cc"),
			join(nativeHostRoot, "src", "kestrel_backup_publication.cc"), "-o", join(paths.resources, "native-peer.node")]);
		if (!process.env.KESTREL_NODE_HEADERS) await rm(join(staging, `node-v${pinnedNode.NODE_RUNTIME_VERSION}-darwin-arm64`), { recursive: true });
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
		if (vaultRuntimeEvidence) {
			const record = JSON.parse(await readFile(join(paths.resources, "native-vault-engine.json"), "utf8"));
			await sealPackagedVaultRecord({ app: paths.app, record, signOuter: () => run("/usr/bin/codesign", [
				"--force", "--sign", signingIdentity, "--options", "runtime", "--entitlements", entitlements, paths.app,
			]) });
		}
		run("/usr/bin/codesign", ["--verify", "--deep", "--strict", paths.app]);
		run("/usr/bin/lipo", [paths.executable, "-verify_arch", "arm64"]);
		run("/usr/bin/lipo", [helperExecutable, "-verify_arch", "arm64"]);
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
