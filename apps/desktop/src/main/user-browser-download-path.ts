import { lstat, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

function downloadsRoot(downloadsDirectory: string): string {
	if (!isAbsolute(downloadsDirectory))
		throw new Error("The Downloads directory must be an absolute path.");
	return resolve(downloadsDirectory);
}

export function defaultBrowserDownloadDirectory(
	downloadsDirectory: string,
): string {
	return downloadsRoot(downloadsDirectory);
}

export function legacyBrowserDownloadDirectory(
	downloadsDirectory: string,
	productName: string,
): string {
	const name = productName.trim();
	if (!name || name === "." || name === ".." || /[\\/]/.test(name))
		throw new Error("The legacy download folder name is invalid.");
	return join(downloadsRoot(downloadsDirectory), name);
}

export function isLegacyBrowserDownloadDirectory(
	candidate: string,
	legacyDirectory: string,
): boolean {
	const normalized = candidate.trim();
	return (
		isAbsolute(normalized) && resolve(normalized) === resolve(legacyDirectory)
	);
}

export async function removeLegacyBrowserDownloadDirectory(
	downloadsDirectory: string,
	productName: string,
): Promise<boolean> {
	const legacyDirectory = legacyBrowserDownloadDirectory(
		downloadsDirectory,
		productName,
	);
	let metadata: Awaited<ReturnType<typeof lstat>>;
	try {
		metadata = await lstat(legacyDirectory);
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw cause;
	}
	if (metadata.isSymbolicLink() || !metadata.isDirectory()) return false;
	await rm(legacyDirectory, { recursive: true, force: true });
	return true;
}
