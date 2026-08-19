import { basename, join, relative, sep } from "node:path";
import { readdir, realpath, stat } from "node:fs/promises";
import { SelectedAttachmentSchema, type SelectedAttachment } from "@kestrel/shared-types";

const SKIP_DIRECTORIES = new Set([
	".git",
	"node_modules",
	"dist",
	"coverage",
	".next",
	".turbo",
	".cache",
]);
const MAX_FILES = 80;
const MAX_DEPTH = 4;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export async function listWorkspaceFiles(options: {
	workspaceRoot: string;
	query?: string;
	mediaTypeForPath(path: string): string;
}): Promise<SelectedAttachment[]> {
	const root = await realpath(options.workspaceRoot);
	const needle = options.query?.trim().toLowerCase() ?? "";
	const matches: SelectedAttachment[] = [];

	async function walk(directory: string, depth: number): Promise<void> {
		if (matches.length >= MAX_FILES || depth > MAX_DEPTH) return;
		let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			if (matches.length >= MAX_FILES) return;
			if (entry.name.startsWith(".")) continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (SKIP_DIRECTORIES.has(entry.name)) continue;
				await walk(path, depth + 1);
				continue;
			}
			if (!entry.isFile()) continue;
			const relativePath = relative(root, path).split(sep).join("/");
			if (
				needle &&
				!relativePath.toLowerCase().includes(needle) &&
				!entry.name.toLowerCase().includes(needle)
			)
				continue;
			try {
				const metadata = await stat(path);
				if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) continue;
				matches.push(
					SelectedAttachmentSchema.parse({
						path,
						name: basename(path),
						mediaType: options.mediaTypeForPath(path),
						size: metadata.size,
					}),
				);
			} catch {
				continue;
			}
		}
	}

	await walk(root, 0);
	return matches;
}
