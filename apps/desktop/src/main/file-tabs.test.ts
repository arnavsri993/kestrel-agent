import { chmod, mkdir, mkdtemp, writeFile, truncate, rm } from "node:fs/promises";
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

	it.each(["deleted", "parent replaced"])("explains a %s file without exposing filesystem errors", async (change) => {
		const root = await mkdtemp(join(tmpdir(), "kestrel-file-tab-"));
		roots.push(root);
		const parent = join(root, "folder");
		await mkdir(parent);
		const path = join(parent, "notes.txt");
		await writeFile(path, "Local notes");
		const file = await inspectFilePath(path);
		await rm(parent, { recursive: true });
		if (change === "parent replaced") await writeFile(parent, "Not a folder");
		const preview = await previewFile("tab-00000000-0000-0000-0000-000000000000", file);
		expect(preview.kind).toBe("metadata");
		expect(preview.detail).toContain("original location");
		expect(preview.detail).not.toMatch(/ENOENT|ENOTDIR|realpath/);
		expect(preview.detail).not.toContain(root);
	});

	it("distinguishes an unreadable file from a missing file and recovers after permission repair", async () => {
		const root = await mkdtemp(join(tmpdir(), "kestrel-file-tab-"));
		roots.push(root);
		const path = join(root, "notes.txt");
		await writeFile(path, "Local notes");
		const file = await inspectFilePath(path);
		await chmod(path, 0);
		try {
			const preview = await previewFile("tab-00000000-0000-0000-0000-000000000000", file);
			expect(preview.kind).toBe("metadata");
			expect(preview.detail).toContain("permissions");
			expect(preview.detail).not.toMatch(/no longer|EACCES|EPERM/);
			expect(preview.detail).not.toContain(root);
		} finally { await chmod(path, 0o600); }
		expect(await previewFile("tab-00000000-0000-0000-0000-000000000000", file))
			.toMatchObject({ kind: "text", text: "Local notes" });
	});

	it("does not call other preview failures missing files", async () => {
		const root = await mkdtemp(join(tmpdir(), "kestrel-file-tab-"));
		roots.push(root);
		const path = join(root, "notes.txt");
		await writeFile(path, "Local notes");
		const file = await inspectFilePath(path);
		await rm(path);
		await mkdir(path);
		const preview = await previewFile("tab-00000000-0000-0000-0000-000000000000", file);
		expect(preview.kind).toBe("metadata");
		expect(preview.detail).toContain("could not be prepared");
		expect(preview.detail).not.toMatch(/no longer|not a regular file/);
	});
});
