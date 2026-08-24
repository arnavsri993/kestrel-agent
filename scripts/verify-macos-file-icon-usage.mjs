import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ALLOWED_PRODUCTION_FILE = "mac-file-icon-guard.ts";
const FILE_ICON_API_PATTERN = /\bgetFileIcon\b/;

async function productionTypeScriptFiles(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await productionTypeScriptFiles(path)));
		else if (
			entry.isFile() &&
			entry.name.endsWith(".ts") &&
			!entry.name.endsWith(".test.ts")
		)
			files.push(path);
	}
	return files;
}

export async function unexpectedFileIconCallers(mainSourceDirectory) {
	const files = await productionTypeScriptFiles(mainSourceDirectory);
	const failures = [];
	for (const path of files) {
		const relativePath = relative(mainSourceDirectory, path);
		if (relativePath === ALLOWED_PRODUCTION_FILE) continue;
		if (FILE_ICON_API_PATTERN.test(await readFile(path, "utf8")))
			failures.push(relativePath);
	}
	return failures.sort();
}

export async function verifyMacFileIconUsage(mainSourceDirectory) {
	const failures = await unexpectedFileIconCallers(mainSourceDirectory);
	if (failures.length === 0) return;
	throw new Error(
		"Direct Electron getFileIcon usage bypasses the macOS native-crash guard:\n" +
			failures.map((path) => `- ${path}`).join("\n"),
	);
}

const isMain =
	process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
	const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const mainSourceDirectory = resolve(
		repositoryRoot,
		"apps/desktop/src/main",
	);
	await verifyMacFileIconUsage(mainSourceDirectory);
	console.log("Verified guarded macOS file-icon usage.");
}
