import { execFile, execFileSync } from "node:child_process";
import { cpus } from "node:os";
import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CEF_PLATFORM,
	CEF_VERSION,
	prepareNativeChromiumRuntime,
} from "./prepare-native-chromium-runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = join(root, ".tmp");
const compiler = "/Library/Developer/CommandLineTools/usr/bin/clang++";

function assertTemporaryPath(path) {
	const temporary = resolve(temporaryRoot);
	const relativePath = relative(temporary, path);
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		resolve(path) === temporary
	)
		throw new Error("Native Chromium wrapper output must stay in a dedicated .tmp path.");
}

function run(command, arguments_, options = {}) {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = execFile(command, arguments_, { cwd: root, ...options }, (error) => {
			if (error) rejectPromise(error);
			else resolvePromise();
		});
		child.stdout?.pipe(process.stdout);
		child.stderr?.pipe(process.stderr);
	});
}

async function sourceFiles(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(async (entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return sourceFiles(path);
			return entry.isFile() && /\.(cc|mm)$/.test(entry.name) ? [path] : [];
		}),
	);
	return files.flat().sort();
}

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function wrapperManifest({ sourcePaths }) {
	return {
		format: 1,
		cef: { version: CEF_VERSION, platform: CEF_PLATFORM },
		wrapper: {
			compiler: "apple-clang-cxx20",
			minMacOS: "13.0",
			sourcePaths: sourcePaths.map((path) => path.replaceAll("\\", "/")),
		},
	};
}

export async function buildNativeChromiumWrapper({ runtime } = {}) {
	if (process.platform !== "darwin" || process.arch !== "arm64")
		throw new Error("The native Chromium wrapper can only be built on Apple Silicon macOS.");
	if (!(await exists(compiler)))
		throw new Error("clang++ is required to build the CEF C++ wrapper.");

	const runtimePath = resolve(runtime ?? (await prepareNativeChromiumRuntime()));
	assertTemporaryPath(runtimePath);
	const sourceRoot = join(runtimePath, "libcef_dll");
	const archive = join(runtimePath, "Release", "libcef_dll_wrapper.a");
	const manifestPath = join(runtimePath, "Release", "libcef_dll_wrapper.manifest.json");
	const sdkPath = execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], {
		encoding: "utf8",
	}).trim();
	if (!sdkPath) throw new Error("A macOS SDK is required to build the CEF C++ wrapper.");

	const sources = await sourceFiles(sourceRoot);
	if (sources.length < 100)
		throw new Error(`CEF C++ wrapper source set was incomplete (${sources.length} files).`);
	const relativeSources = sources.map((path) => relative(runtimePath, path));
	const expectedManifest = wrapperManifest({ sourcePaths: relativeSources });
	if ((await exists(archive)) && (await exists(manifestPath))) {
		try {
			const existingManifest = JSON.parse(await readFile(manifestPath, "utf8"));
			if (JSON.stringify(existingManifest) === JSON.stringify(expectedManifest)) return archive;
		} catch {
			// Rebuild an incomplete or hand-modified staging artifact.
		}
	}

	const buildRoot = join(runtimePath, "build-libcef-dll-wrapper");
	await rm(buildRoot, { recursive: true, force: true });
	await mkdir(buildRoot, { recursive: true });
	const objectPaths = sources.map((source) =>
		join(buildRoot, `${relative(sourceRoot, source).replaceAll(sep, "__")}.o`),
	);
	const flags = [
		"-std=c++20",
		"-stdlib=libc++",
		"-fno-exceptions",
		"-fno-rtti",
		"-fno-threadsafe-statics",
		"-fobjc-call-cxx-cdtors",
		"-fno-strict-aliasing",
		"-fstack-protector",
		"-funwind-tables",
		"-fvisibility=hidden",
		"-fvisibility-inlines-hidden",
		"-Wall",
		"-Werror",
		"-Wextra",
		"-Wendif-labels",
		"-Wnewline-eof",
		"-Wno-missing-field-initializers",
		"-Wno-unused-parameter",
		"-Wno-narrowing",
		"-Wno-undefined-var-template",
		"-Wsign-compare",
		"-O3",
		"-arch",
		"arm64",
		"-mmacosx-version-min=13.0",
		"-isysroot",
		sdkPath,
		"-D__STDC_CONSTANT_MACROS",
		"-D__STDC_FORMAT_MACROS",
		"-DNDEBUG",
		"-DWRAPPING_CEF_SHARED",
		"-I",
		runtimePath,
	];
	let next = 0;
	const workers = Array.from({ length: Math.min(6, cpus().length, sources.length) }, async () => {
		while (next < sources.length) {
			const index = next++;
			await run(compiler, [...flags, "-c", sources[index], "-o", objectPaths[index]]);
		}
	});
	try {
		await Promise.all(workers);
		execFileSync("/usr/bin/libtool", ["-static", "-o", archive, ...objectPaths], {
			cwd: root,
			stdio: "inherit",
		});
		execFileSync("/usr/bin/ranlib", [archive], { cwd: root, stdio: "inherit" });
		execFileSync("/usr/bin/lipo", ["-verify_arch", "arm64", archive], {
			cwd: root,
			stdio: "inherit",
		});
		await writeFile(manifestPath, `${JSON.stringify(expectedManifest, null, "\t")}\n`);
	} finally {
		await rm(buildRoot, { recursive: true, force: true });
	}
	return archive;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const archive = await buildNativeChromiumWrapper();
	console.log(`Built CEF C++ wrapper at ${archive}.`);
}
