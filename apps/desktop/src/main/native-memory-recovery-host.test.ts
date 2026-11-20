import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoreRequest, RendererResponse } from "@kestrel/shared-types";
import { NativeMemoryRecoveryHost, NATIVE_MEMORY_RECOVERY_REQUEST_TYPES } from "./native-memory-recovery-host";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, open: vi.fn(actual.open) };
});

const preview = {
	planId: "f78a6d7f-37f2-4a02-a12c-095b636db93d", scopeName: "Test knowledge",
	newRecords: 2, existingRecords: 1, expiresAt: "2027-01-01T00:00:00.000Z",
};
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}
const roots: string[] = [];
const hosts: NativeMemoryRecoveryHost[] = [];
async function fixture() {
	const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "kestrel-memory-host-")));
	roots.push(root);
	const path = join(root, "test.kestrel-memory");
	const core = vi.fn(async (request: CoreRequest): Promise<RendererResponse> => request.type === "memory-recovery-export"
		? { ok: true, memoryRecoveryData: "encrypted-test-fixture" }
		: { ok: true, memoryRecoveryPreview: preview });
	const picker = vi.fn(async (_operation: "save" | "open", _signal: AbortSignal): Promise<string | null> => path);
	const host = new NativeMemoryRecoveryHost({ coreRequest: core, selectFile: picker });
	hosts.push(host);
	return { root, path, core, picker, host };
}
const save = { type: "memory-recovery-save-file", sessionId: "fixture-session" };
const read = { type: "memory-recovery-open-file", sessionId: "fixture-session" };
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(hosts.splice(0).map(host => host.close()));
	vi.mocked(fs.open).mockImplementation((await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open);
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("NativeMemoryRecoveryHost", () => {
	it("exposes only native save/open requests and strictly rejects caller paths, blobs, and invalid sessions", async () => {
		const { host, core, picker } = await fixture();
		expect([...NATIVE_MEMORY_RECOVERY_REQUEST_TYPES].sort()).toEqual([read.type, save.type].sort());
		for (const request of [null, {}, { ...save, sessionId: "" }, { ...save, path: "/tmp/injected" }, { ...read, encoded: "injected" }, { ...save, type: "memory-recovery-export" }]) {
			expect(await host.handle(request)).toEqual({ ok: false, error: "Invalid knowledge recovery request." });
		}
		expect(core).not.toHaveBeenCalled();
		expect(picker).not.toHaveBeenCalled();
	});

	it("writes a private durable encrypted backup and never returns ciphertext or paths", async () => {
		const { host, path, core, picker } = await fixture();
		const originalOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
		const synced: string[] = [];
		vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
			const handle = await originalOpen(...args);
			const sync = handle.sync.bind(handle);
			handle.sync = async () => { await sync(); synced.push(String(args[0])); };
			return handle;
		});
		expect(await host.handle(save)).toEqual({ ok: true });
		expect(core).toHaveBeenCalledExactlyOnceWith({ type: "memory-recovery-export", sessionId: save.sessionId });
		expect(picker).toHaveBeenCalledWith("save", expect.any(AbortSignal));
		expect(await fs.readFile(path, "utf8")).toBe("encrypted-test-fixture");
		expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
		expect(synced).toEqual([await fs.realpath(path), await fs.realpath(join(path, ".."))]);
	});

	it("keeps existing destinations and symlink targets untouched", async () => {
		const { host, path, root } = await fixture();
		await fs.writeFile(path, "existing");
		expect(await host.handle(save)).toMatchObject({ ok: false });
		expect(await fs.readFile(path, "utf8")).toBe("existing");
		await fs.unlink(path);
		const target = join(root, "target");
		await fs.writeFile(target, "target");
		await fs.symlink(target, path);
		expect(await host.handle(save)).toMatchObject({ ok: false });
		expect(await fs.readFile(target, "utf8")).toBe("target");
		expect((await fs.lstat(path)).isSymbolicLink()).toBe(true);
	});

	it("cancels both panels without touching files or asking core to preview", async () => {
		const { host, picker, core, path } = await fixture();
		picker.mockResolvedValue(null);
		expect(await host.handle(save)).toEqual({ ok: true, cancelled: true });
		expect(await host.handle(read)).toEqual({ ok: true, cancelled: true });
		expect(core).toHaveBeenCalledTimes(1);
		await expect(fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("checks UTF-8 byte length of core exports before showing a panel and sanitizes core errors", async () => {
		const { host, core, picker } = await fixture();
		for (const response of [
			{ ok: true, memoryRecoveryData: "" },
			{ ok: true, memoryRecoveryData: "é".repeat(8_000_001) },
			{ ok: true, memoryRecoveryData: 123 },
			{ ok: false, error: "/private/secret-path ciphertext secret" },
		]) {
			core.mockResolvedValueOnce(response as RendererResponse);
			const result = await host.handle(save);
			expect(result).toEqual({ ok: false, error: "A valid encrypted knowledge backup is unavailable." });
		}
		expect(picker).not.toHaveBeenCalled();
	});

	it("rejects invalid panel paths before filesystem access", async () => {
		const { host, picker } = await fixture();
		for (const path of ["relative.kestrel-memory", "/tmp/bad\nname", `/tmp/${"x".repeat(4096)}`, ""]) {
			picker.mockResolvedValueOnce(path);
			expect(await host.handle(save)).toEqual({ ok: false, error: "The selected backup location is invalid." });
		}
	});

	it("resolves parent aliases and refuses final symlinks while opening", async () => {
		const { host, path, root, picker, core } = await fixture();
		await fs.writeFile(path, "encrypted-test-fixture");
		const alias = join(root, "alias");
		await fs.symlink(root, alias);
		picker.mockResolvedValueOnce(join(alias, "test.kestrel-memory"));
		expect(await host.handle(read)).toEqual({ ok: true, memoryRecoveryPreview: preview });
		const link = join(root, "final.kestrel-memory");
		await fs.symlink(path, link);
		picker.mockResolvedValueOnce(link);
		expect(await host.handle(read)).toMatchObject({ ok: false });
		expect(core).toHaveBeenCalledTimes(1);
	});

	it("privately previews exactly read UTF-8 and returns only validated preview metadata", async () => {
		const { host, path, core } = await fixture();
		await fs.writeFile(path, "encrypted é fixture");
		core.mockResolvedValueOnce({ ok: true, memoryRecoveryPreview: { ...preview, encoded: "secret", path }, memoryRecoveryData: "secret", answer: path } as RendererResponse);
		expect(await host.handle(read)).toEqual({ ok: true, memoryRecoveryPreview: preview });
		expect(core).toHaveBeenCalledExactlyOnceWith({ type: "memory-recovery-preview", sessionId: read.sessionId, encoded: "encrypted é fixture" });
		for (const response of [{ ok: true }, { ok: true, memoryRecoveryPreview: { ...preview, newRecords: -1 } }, { ok: false, error: path }]) {
			core.mockResolvedValueOnce(response as RendererResponse);
			const result = await host.handle(read);
			expect(result.ok).toBe(false);
			expect(JSON.stringify(result)).not.toContain(path);
		}
	});

	it("handles short reads and preserves the exact UTF-8 text including a leading BOM", async () => {
		const { host, path, core } = await fixture();
		const encoded = "\ufeffencrypted é fixture";
		await fs.writeFile(path, encoded);
		const originalOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
		let reads = 0;
		vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
			const handle = await originalOpen(...args);
			if (args[0] === path) {
				const originalRead = handle.read.bind(handle);
				handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
					reads++;
					return originalRead(buffer, offset, Math.min(length, 2), position);
				}) as typeof handle.read;
			}
			return handle;
		});
		expect(await host.handle(read)).toEqual({ ok: true, memoryRecoveryPreview: preview });
		expect(reads).toBeGreaterThan(2);
		expect(core).toHaveBeenCalledExactlyOnceWith({ type: "memory-recovery-preview", sessionId: read.sessionId, encoded });
	});

	it("rejects empty, oversized, malformed UTF-8, directories, and hardlinked backups without preview", async () => {
		const { host, path, root, picker, core } = await fixture();
		await fs.writeFile(path, "");
		expect(await host.handle(read)).toMatchObject({ ok: false });
		const handle = await fs.open(path, "w");
		await handle.truncate(16_000_001);
		await handle.close();
		expect(await host.handle(read)).toMatchObject({ ok: false });
		await fs.writeFile(path, Buffer.from([0x61, 0xff, 0x62]));
		expect(await host.handle(read)).toEqual({ ok: false, error: "The backup is not valid UTF-8 data." });
		picker.mockResolvedValueOnce(root);
		expect(await host.handle(read)).toMatchObject({ ok: false });
		await fs.writeFile(path, "encrypted");
		await fs.link(path, join(root, "hardlink"));
		expect(await host.handle(read)).toMatchObject({ ok: false });
		expect(core).not.toHaveBeenCalled();
	});

	it("admits one operation synchronously and aborts a pending panel, ignoring late paths", async () => {
		const { host, path, picker, core } = await fixture();
		const pending = deferred<string | null>();
		const started = deferred<AbortSignal>();
		picker.mockImplementationOnce((_operation, signal) => { started.resolve(signal); return pending.promise; });
		const first = host.handle(save);
		expect(await host.handle(read)).toMatchObject({ ok: false, error: expect.stringContaining("already in progress") });
		const signal = await started.promise;
		await host.close();
		expect(signal.aborted).toBe(true);
		expect(await first).toEqual({ ok: true, cancelled: true });
		pending.resolve(path);
		await Promise.resolve();
		await expect(fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
		expect(core).toHaveBeenCalledTimes(1);
		expect(await host.handle(save)).toMatchObject({ ok: false, error: expect.stringContaining("closed") });
	});

	it("closes promptly while core is pending and never opens a panel for its late export", async () => {
		const { host, core, picker } = await fixture();
		const pending = deferred<RendererResponse>();
		const started = deferred<void>();
		core.mockImplementationOnce(() => { started.resolve(); return pending.promise; });
		const operation = host.handle(save);
		await started.promise;
		await host.close();
		expect(await operation).toEqual({ ok: true, cancelled: true });
		pending.resolve({ ok: true, memoryRecoveryData: "late encrypted fixture" });
		await Promise.resolve();
		expect(picker).not.toHaveBeenCalled();
	});

	it("aborts only the disconnected request and ignores a late panel path, then admits a fresh request", async () => {
		const { host, picker, path } = await fixture();
		const pending = deferred<string | null>();
		const started = deferred<AbortSignal>();
		const disconnected = new AbortController();
		picker.mockImplementationOnce((_operation, signal) => { started.resolve(signal); return pending.promise; });
		const operation = host.handle(save, disconnected.signal);
		const panelSignal = await started.promise;
		disconnected.abort();
		expect(await operation).toEqual({ ok: true, cancelled: true });
		expect(panelSignal.aborted).toBe(true);
		pending.resolve(path);
		await Promise.resolve();
		await expect(fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
		picker.mockResolvedValueOnce(null);
		expect(await host.handle(save)).toEqual({ ok: true, cancelled: true });
	});

	it("does not start an already aborted request", async () => {
		const { host, core, picker } = await fixture();
		const disconnected = new AbortController();
		disconnected.abort();
		expect(await host.handle(save, disconnected.signal)).toEqual({ ok: true, cancelled: true });
		expect(core).not.toHaveBeenCalled();
		expect(picker).not.toHaveBeenCalled();
	});

	it("does not write after close races with pending exclusive file creation and preserves the empty file", async () => {
		const { host, path } = await fixture();
		const originalOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
		const started = deferred<void>();
		const finish = deferred<void>();
		let fileClosed = false;
		let writes = 0;
		vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
			const handle = await originalOpen(...args);
			if (args[0] === path) {
				const originalClose = handle.close.bind(handle);
				handle.close = async () => { await originalClose(); fileClosed = true; };
				handle.write = (async () => { writes++; throw new Error("unexpected write"); }) as typeof handle.write;
				started.resolve();
				await finish.promise;
			}
			return handle;
		});
		const operation = host.handle(save);
		await started.promise;
		let closed = false;
		const closing = host.close().then(() => { closed = true; });
		await Promise.resolve();
		expect(closed).toBe(false);
		finish.resolve();
		await closing;
		expect(fileClosed).toBe(true);
		expect(writes).toBe(0);
		expect(await operation).toMatchObject({ ok: false, error: expect.stringContaining("preserved and may be incomplete") });
		expect(await fs.readFile(path, "utf8")).toBe("");
	});

	it("detects mutation during a multi-read operation and keeps the changed user file", async () => {
		const { host, path, core } = await fixture();
		await fs.writeFile(path, "encrypted fixture");
		const originalOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
		vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
			const handle = await originalOpen(...args);
			if (args[0] === path && typeof args[1] === "number" && !(args[1] & constants.O_WRONLY)) {
				const originalRead = handle.read.bind(handle);
				let first = true;
				handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
					const result = await originalRead(...readArgs);
					if (first) { first = false; await fs.appendFile(path, " changed"); }
					return result;
				}) as typeof handle.read;
			}
			return handle;
		});
		expect(await host.handle(read)).toEqual({ ok: false, error: "The backup changed while being read. Choose it again." });
		expect(await fs.readFile(path, "utf8")).toContain("changed");
		expect(core).not.toHaveBeenCalled();
	});

	it("preserves a partially written file and waits for its owned write and handle cleanup on close", async () => {
		const { host, path } = await fixture();
		const originalOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
		const started = deferred<void>();
		const finish = deferred<void>();
		let fileClosed = false;
		vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
			const handle = await originalOpen(...args);
			if (args[0] === path) {
				const originalWrite = handle.write.bind(handle);
				const originalClose = handle.close.bind(handle);
				handle.write = (async () => {
					await originalWrite(Buffer.from("partial"), 0, 7, 0);
					started.resolve();
					await finish.promise;
					throw new Error("disk-full private-path");
				}) as typeof handle.write;
				handle.close = async () => { await originalClose(); fileClosed = true; };
			}
			return handle;
		});
		const operation = host.handle(save);
		await started.promise;
		let closed = false;
		const closing = host.close().then(() => { closed = true; });
		await Promise.resolve();
		expect(closed).toBe(false);
		finish.resolve();
		await closing;
		expect(fileClosed).toBe(true);
		expect(await operation).toMatchObject({ ok: false, error: expect.stringContaining("preserved and may be incomplete") });
		expect(await fs.readFile(path, "utf8")).toBe("partial");
	});
});
