import { mkdtemp, writeFile, truncate, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	MAX_ATTACHMENT_BYTES,
	fileAttachment,
	fileTabUrl,
	inspectFilePath,
	mediaTypeForPath,
	previewFile,
} from "./file-tabs";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("first-class file tabs", () => {
	it("inspects and previews bounded text files", async () => {
		const root = await mkdtemp(join(tmpdir(), "kestrel-file-tab-"));
		roots.push(root);
		const path = join(root, "notes.md");
		await writeFile(path, "# Local notes\n\nUse the active tab.");
		const file = await inspectFilePath(path);
		const preview = await previewFile("tab-00000000-0000-0000-0000-000000000000", file);

		expect(file).toMatchObject({
			name: "notes.md",
			extension: "md",
			mediaType: "text/markdown",
			status: "available",
		});
		expect(preview).toMatchObject({ kind: "text", text: "# Local notes\n\nUse the active tab." });
		expect(fileAttachment(file)).toMatchObject({
			path: file.path,
			source: "external",
		});
	});

	it("keeps unsupported and oversized files useful without attaching them", async () => {
		const root = await mkdtemp(join(tmpdir(), "kestrel-file-tab-"));
		roots.push(root);
		const path = join(root, "model.xyz");
		await writeFile(path, "");
		await truncate(path, MAX_ATTACHMENT_BYTES + 1);
		const file = await inspectFilePath(path);
		const preview = await previewFile("tab-00000000-0000-0000-0000-000000000000", file);

		expect(mediaTypeForPath(path)).toBe("application/octet-stream");
		expect(preview.kind).toBe("metadata");
		expect(fileAttachment(file)).toBeUndefined();
	});

	it("uses opaque tab URLs rather than exposing local paths", () => {
		expect(fileTabUrl("tab-00000000-0000-0000-0000-000000000000")).toBe(
			"kestrel://file/tab-00000000-0000-0000-0000-000000000000",
		);
	});
});
