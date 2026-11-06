import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startCoreService } from "./service";
import type { CoreParentPort } from "./transport";

describe("Core service bootstrap", () => {
	it("rejects raw invalid pending metadata before opening or creating a database", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-invalid-bootstrap-"));
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const existing = join(root, "existing.sqlite");
			const missing = join(root, "missing.sqlite");
			const sentinel = Buffer.from("existing generated fixture");
			writeFileSync(existing, sentinel);
			const project = { id: "overlap" };
			for (const databasePath of [existing, missing]) {
				for (const pendingProjectIds of ["abc", ["same", "same"], ["overlap"]]) {
					let receive!: (event: { data: unknown }) => void;
					let resolve!: (value: unknown) => void;
					const posted = new Promise<unknown>(done => { resolve = done; });
					const port: CoreParentPort = { on: (_event, listener) => { receive = listener; }, postMessage: resolve };
					startCoreService(port);
					receive({ data: { type: "bootstrap", config: { databasePath, encryptionKeyBase64: Buffer.alloc(32).toString("base64"), projects: [project], pendingProjectIds } } });
					expect(await posted).toMatchObject({ type: "start-error" });
					expect(readFileSync(existing)).toEqual(sentinel);
					expect(existsSync(missing)).toBe(false);
					expect(existsSync(`${existing}-wal`)).toBe(false);
					expect(existsSync(`${missing}-wal`)).toBe(false);
				}
			}
		} finally {
			errorLog.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
