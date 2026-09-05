import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	defaultBrowserDownloadDirectory,
	isLegacyBrowserDownloadDirectory,
	legacyBrowserDownloadDirectory,
	removeLegacyBrowserDownloadDirectory,
} from "./user-browser-download-path";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "kestrel-download-path-"));
	temporaryDirectories.push(directory);
	return directory;
}

describe("browser download directories", () => {
	it("uses the user's Downloads root as the default destination", () => {
		const downloadsDirectory = temporaryDirectory();
		expect(defaultBrowserDownloadDirectory(downloadsDirectory)).toBe(
			downloadsDirectory,
		);
	});

	it("removes the legacy product folder and everything inside it", async () => {
		const downloadsDirectory = temporaryDirectory();
		const legacyDirectory = legacyBrowserDownloadDirectory(
			downloadsDirectory,
			"Kestrel",
		);
		mkdirSync(join(legacyDirectory, "nested"), { recursive: true });
		writeFileSync(join(legacyDirectory, "nested", "old-download.txt"), "old");

		expect(
			await removeLegacyBrowserDownloadDirectory(downloadsDirectory, "Kestrel"),
		).toBe(true);
		expect(existsSync(legacyDirectory)).toBe(false);
	});

	it("does not follow a symlink named like the legacy folder", async () => {
		const downloadsDirectory = temporaryDirectory();
		const outsideDirectory = temporaryDirectory();
		const legacyDirectory = legacyBrowserDownloadDirectory(
			downloadsDirectory,
			"Kestrel",
		);
		writeFileSync(join(outsideDirectory, "keep.txt"), "keep");
		symlinkSync(outsideDirectory, legacyDirectory, "dir");

		expect(
			await removeLegacyBrowserDownloadDirectory(downloadsDirectory, "Kestrel"),
		).toBe(false);
		expect(existsSync(join(outsideDirectory, "keep.txt"))).toBe(true);
		expect(isLegacyBrowserDownloadDirectory(legacyDirectory, legacyDirectory)).toBe(
			true,
		);
	});
});
