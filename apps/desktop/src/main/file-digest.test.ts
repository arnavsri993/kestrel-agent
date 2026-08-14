import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileDigest } from "./file-digest";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("file digest", () => {
	it("hashes large files without changing the digest contract", async () => {
		const directory = mkdtempSync(join(tmpdir(), "kestrel-file-digest-"));
		directories.push(directory);
		const contents = Buffer.alloc(2_000_000, 0x61);
		const path = join(directory, "large.bin");
		writeFileSync(path, contents);

		const expected = createHash("sha256").update(contents).digest("hex");
		await expect(fileDigest(path)).resolves.toBe(expected);
	});
});
