import { mkdir, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = join(root, ".tmp");
const desktopRequire = createRequire(join(root, "apps", "desktop", "package.json"));
const viteRequire = createRequire(desktopRequire.resolve("vite/package.json"));
const { build } = viteRequire("esbuild");

function assertTemporaryPath(path) {
	const relativePath = relative(temporaryRoot, path);
	if (
		!relativePath ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		resolve(path) === temporaryRoot
	)
		throw new Error("Native extension service output must stay in a dedicated .tmp path.");
}

export async function buildNativeExtensionService({ output } = {}) {
	const destination = resolve(output ?? join(temporaryRoot, "native-extension-service"));
	assertTemporaryPath(destination);
	const staging = join(temporaryRoot, `native-extension-service-stage-${process.pid}-${Date.now()}`);
	await mkdir(staging, { recursive: true });
	try {
		const result = await build({
			entryPoints: [join(root, "apps", "native-chromium-host", "resources", "native-extension-service.ts")],
			outfile: join(staging, "native-extension-service.mjs"),
			bundle: true,
			platform: "node",
			target: "node22",
			format: "esm",
			metafile: true,
			// Node builtins remain native. Everything else, including the shared
			// request schema, is bundled; Electron is forbidden even transitively.
			plugins: [
				{
					name: "forbid-electron",
					setup(builder) {
						builder.onResolve(
							{ filter: /^(?:node:)?electron(?:\/|$)/ },
							() => ({ errors: [{ text: "The native extension service must not import Electron." }] }),
						);
					},
				},
			],
		});
		for (const outputFile of Object.values(result.metafile.outputs)) {
			for (const dependency of outputFile.imports) {
				if (dependency.external && !dependency.path.startsWith("node:"))
					throw new Error(`Native extension service left an unbundled dependency: ${dependency.path}`);
			}
		}
		await rm(destination, { recursive: true, force: true });
		await rename(staging, destination);
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	}
	return destination;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const outputIndex = process.argv.indexOf("--output");
	const destination = await buildNativeExtensionService({
		output: outputIndex === -1 ? undefined : process.argv[outputIndex + 1],
	});
	console.log(`Built Node-only native extension service at ${destination}.`);
}
