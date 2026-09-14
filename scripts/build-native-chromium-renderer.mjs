import { randomBytes } from "node:crypto";
import { access, mkdir, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = join(root, ".tmp");
const rendererSource = join(root, "apps", "desktop", "src", "renderer");
const desktopRequire = createRequire(
	join(root, "apps", "desktop", "package.json"),
);
const react = desktopRequire("@vitejs/plugin-react").default;
const { build } = desktopRequire("vite");

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
	const cspNonce = randomBytes(16).toString("base64");
	try {
		await build({
			root: rendererSource,
			base: "./",
			plugins: [
				react(),
				{
					name: "kestrel-native-chromium-csp-nonce",
					transformIndexHtml(html) {
						return html.replaceAll(
							"__KESTREL_RENDERER_CSP_NONCE__",
							cspNonce,
						);
					},
				},
			],
			html: { cspNonce },
			build: {
				emptyOutDir: true,
				outDir: staging,
				target: "es2022",
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
