import { chmodSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PastedTextAttachmentStore } from "./pasted-text-attachment-store";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PastedTextAttachmentStore", () => {
	it("creates private bounded text files and removes them", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-paste-test-"));
		roots.push(root);
		const store = new PastedTextAttachmentStore(join(root, "attachments"));
		const attachment = await store.create("private paste");
		expect(lstatSync(attachment.path).mode & 0o777).toBe(0o600);
		expect(await store.owns(attachment.path)).toBe(true);
		await store.remove(attachment.path);
		expect(await store.owns(attachment.path)).toBe(false);
	});

	it("rejects oversized content, unregistered files, and replaced symlinks", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-paste-test-"));
		roots.push(root);
		const store = new PastedTextAttachmentStore(join(root, "attachments"));
		await expect(store.create("x".repeat(1_000_001))).rejects.toThrow("1 MB");
		const attachment = await store.create("registered");
		const forged = join(root, "forged.txt");
		writeFileSync(forged, "forged");
		expect(await store.owns(forged)).toBe(false);
		rmSync(attachment.path);
		symlinkSync(forged, attachment.path);
		expect(await store.owns(attachment.path)).toBe(false);
		chmodSync(forged, 0o600);
	});

	it("keeps concurrent attachments in one private process directory", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-paste-test-"));
		roots.push(root);
		const store = new PastedTextAttachmentStore(join(root, "attachments"));
		const attachments = await Promise.all([
			store.create("first"),
			store.create("second"),
		]);
		expect(await Promise.all(attachments.map(({ path }) => store.owns(path)))).toEqual([
			true,
			true,
		]);
	});
});
