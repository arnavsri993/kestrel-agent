import { access, mkdir, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = join(root, ".tmp");
const desktopRequire = createRequire(
	join(root, "apps", "desktop", "package.json"),
);
const { build } = desktopRequire("vite");
const { createRendererViteConfig } = await import(
	"../apps/desktop/renderer.vite.config.mjs"
);

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
		relativePath.startsWith(".." + sep) ||
		resolve(path) === temporary
	)
		throw new Error("Native Chromium renderer output must stay in a dedicated .tmp path.");
}

async function assertFile(path, description) {
	try {
		await access(path);
	} catch {
		throw new Error(
			"Native Chromium renderer is missing " + description + ": " + path,
		);
	}
}

export async function buildNativeChromiumRenderer({ output } = {}) {
	const destination = resolve(
		output ??
			argumentValue("--output") ??
			join(temporaryRoot, "native-chromium-renderer"),
	);
	assertTemporaryPath(destination);
	await mkdir(temporaryRoot, { recursive: true });
	const staging = join(
		temporaryRoot,
		"native-chromium-renderer-stage-" + process.pid + "-" + Date.now(),
	);
	assertTemporaryPath(staging);
	try {
		const rendererConfig = createRendererViteConfig({ outDir: staging });
		await build({
			configFile: false,
			...rendererConfig,
			build: {
				...rendererConfig.build,
				emptyOutDir: true,
			},
		});
		await assertFile(join(staging, "index.html"), "the existing Kestrel renderer");
		await assertFile(join(staging, "assets"), "the Kestrel renderer assets");
		await rm(destination, { recursive: true, force: true });
		await rename(staging, destination);
		console.log(
			"Built existing Kestrel renderer for the native Chromium host at " +
				destination +
				".",
		);
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	}
	return destination;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await buildNativeChromiumRenderer();
}
