import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
	unexpectedFileIconCallers,
	verifyMacFileIconUsage,
} from "./verify-macos-file-icon-usage.mjs";

const temporaryDirectories = [];

async function sourceDirectory(files) {
	const directory = await mkdtemp(join(tmpdir(), "kestrel-file-icon-usage-"));
	temporaryDirectories.push(directory);
	for (const [path, source] of Object.entries(files)) {
		const target = join(directory, path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, source, "utf8");
	}
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) =>
			rm(directory, { recursive: true, force: true }),
		),
	);
});

describe("macOS file icon usage verification", () => {
	it("allows the centralized guard and ignores test doubles", async () => {
		const directory = await sourceDirectory({
			"mac-file-icon-guard.ts": "api.getFileIcon(path, options);",
			"mac-file-icon-guard.test.ts": "fake.getFileIcon(path);",
			"index.ts": "export const ready = true;",
		});

		await expect(verifyMacFileIconUsage(directory)).resolves.toBeUndefined();
	});

	it("rejects direct production callers anywhere in the main process", async () => {
		const directory = await sourceDirectory({
			"mac-file-icon-guard.ts": "api.getFileIcon(path, options);",
			"nested/startup.ts":
				'await app.getFileIcon(process.execPath, { size: "large" });',
		});

		await expect(unexpectedFileIconCallers(directory)).resolves.toEqual([
			"nested/startup.ts",
		]);
		await expect(verifyMacFileIconUsage(directory)).rejects.toThrow(
			"nested/startup.ts",
		);
	});
});
