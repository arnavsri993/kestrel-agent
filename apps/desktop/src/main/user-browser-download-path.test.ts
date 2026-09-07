import {
	mkdtempSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	defaultBrowserDownloadDirectory,
	isLegacyBrowserDownloadDirectory,
	legacyBrowserDownloadDirectory,
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

	it("recognizes only the normalized legacy path", () => {
		const downloadsDirectory = temporaryDirectory();
		const legacyDirectory = legacyBrowserDownloadDirectory(
			downloadsDirectory,
			"Kestrel",
		);
		expect(isLegacyBrowserDownloadDirectory(legacyDirectory, legacyDirectory)).toBe(
			true,
		);
		expect(
			isLegacyBrowserDownloadDirectory(legacyDirectory + "/", legacyDirectory),
		).toBe(true);
		expect(
			isLegacyBrowserDownloadDirectory(
				join(downloadsDirectory, "Other"),
				legacyDirectory,
			),
		).toBe(false);
	});
});
