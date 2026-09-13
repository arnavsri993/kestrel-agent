import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import type { SelectedAttachment } from "@kestrel/shared-types";

const MAX_PASTED_TEXT_BYTES = 1_000_000;

export class PastedTextAttachmentStore {
	private readonly paths = new Set<string>();
	private preparePromise: Promise<void> | null = null;

	constructor(private readonly root: string) {}

	private async prepare(): Promise<void> {
		if (!this.preparePromise) {
			this.preparePromise = mkdir(this.root, { recursive: true, mode: 0o700 })
				.then(() => undefined)
				.catch((error) => {
					this.preparePromise = null;
					throw error;
				});
		}
		await this.preparePromise;
	}

	async create(text: string): Promise<SelectedAttachment> {
		const size = Buffer.byteLength(text, "utf8");
		if (!text || size > MAX_PASTED_TEXT_BYTES)
			throw new Error("Pasted text attachments must contain 1 byte to 1 MB.");
		await this.prepare();
		const name = `pasted-text-${randomUUID()}.txt`;
		const path = join(this.root, name);
		await writeFile(path, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
		this.paths.add(path);
		return { path, name, mediaType: "text/plain", size, source: "external" };
	}

	async owns(path: string): Promise<boolean> {
		if (!this.paths.has(path)) return false;
		try {
			const [realRoot, realPath, metadata] = await Promise.all([
				realpath(this.root),
				realpath(path),
				lstat(path),
			]);
			return (
				realPath.startsWith(`${realRoot}${sep}`) &&
				metadata.isFile() &&
				!metadata.isSymbolicLink() &&
				metadata.size <= MAX_PASTED_TEXT_BYTES
			);
		} catch {
			return false;
		}
	}

	async remove(path: string): Promise<void> {
		if (!this.paths.delete(path)) return;
		await rm(path, { force: true });
	}

	async dispose(): Promise<void> {
		this.paths.clear();
		await rm(this.root, { recursive: true, force: true });
	}
}
