import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DESKTOP_PRELOAD_ENTRIES = ["index.cjs", "userBrowser.cjs"];

export function relativeRequireSpecifiers(source) {
	const matches = source.matchAll(
		/\brequire\s*\(\s*(["'])(\.\.?\/[^"']+)\1\s*\)/g,
	);
	return [...matches].map((match) => match[2]);
}

export async function verifyStandalonePreloadBundles(
	preloadDirectory,
	entries = DESKTOP_PRELOAD_ENTRIES,
) {
	const failures = [];
	for (const entry of entries) {
		const source = await readFile(resolve(preloadDirectory, entry), "utf8");
		for (const specifier of relativeRequireSpecifiers(source)) {
			failures.push(`${entry}: require(${JSON.stringify(specifier)})`);
		}
	}

	if (failures.length > 0) {
		throw new Error(
			"Sandboxed Electron preloads must be standalone; relative requires cannot be loaded:\n" +
				failures.map((failure) => `- ${failure}`).join("\n"),
		);
	}
}

const isMain =
	process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
	const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const preloadDirectory = resolve(
		repositoryRoot,
		"apps/desktop/out/preload",
	);
	await verifyStandalonePreloadBundles(preloadDirectory);
	console.log("Verified standalone desktop preload bundles.");
}
