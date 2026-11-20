import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ mode: "valid", spawns: [] as any[], signatureHook: undefined as (() => void) | undefined }));
vi.mock("node:child_process", () => ({
	execFile: (...args: any[]) => { const callback = args.at(-1); queueMicrotask(() => { state.signatureHook?.(); callback(null, "", ""); }); },
	spawn: (executable: string, args: string[], options: any) => {
		const child = new EventEmitter() as any;
		child.stdout = new PassThrough(); child.stderr = new PassThrough();
		let closed = false;
		const end = (code: number | null, signal: string | null) => { if (!closed) { closed = true; child.emit("close", code, signal); } };
		child.stdin = new Writable({
			write(frame, _encoding, callback) {
				const input = JSON.parse(frame.toString());
				queueMicrotask(() => {
					if (state.mode === "stall") return;
					let response = JSON.stringify({ requestId: state.mode === "wrong-id" ? "unmatched" : input.requestId, ok: true });
					if (state.mode === "oversized") response = "x".repeat(65538);
					if (state.mode === "malformed") response = "{malformed";
					if (state.mode === "multiple") response += "\n{}";
					child.stdout.write(response + "\n");
				});
				callback();
			},
			final(callback) { callback(); queueMicrotask(() => end(0, null)); },
		});
		child.kill = (signal: string) => { queueMicrotask(() => end(null, signal)); return true; };
		state.spawns.push({ executable, args, options, child }); return child;
	},
}));
import { NativeProfileExportWorker } from "./native-profile-export-worker";

const roots: string[] = [];
function fixture() {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "kestrel-export-worker-test-")); roots.push(root);
	const core = join(root, "Kestrel.app/Contents/Resources/agent-core"), executable = join(core, "node/bin/node"), entry = join(core, "service/host-profile-project-transfer.js"), home = join(root, "private");
	for (const dir of [join(core, "node/bin"), join(core, "service"), home]) mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(executable, "generated node fixture", { mode: 0o700 }); writeFileSync(entry, "generated worker fixture", { mode: 0o600 });
	return { executable, entry, home, signal: new AbortController().signal };
}
afterEach(() => { state.mode = "valid"; state.signatureHook = undefined; state.spawns.splice(0); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("private source-export worker client", () => {
	it("uses a minimal environment, correlates replies, clears caller key fields and confirms clean exit", async () => {
		const options = fixture(), worker = await NativeProfileExportWorker.open(options);
		const input = { sourceKeyBase64: Buffer.alloc(32, 21).toString("base64") };
		await expect(worker.request("plan-profile", input, options.signal)).resolves.toMatchObject({ ok: true });
		expect(input).toEqual({});
		expect(state.spawns[0].options.env).toEqual({ PATH: "/usr/bin:/bin", HOME: options.home });
		expect(state.spawns[0].args).toEqual([options.entry, "--protected-host-pipe"]);
		await expect(worker.close()).resolves.toEqual({ confirmed: true, clean: true });
	});
	it.each(["wrong-id", "oversized", "malformed", "multiple"])("rejects %s replies without accepting another request", async mode => {
		state.mode = mode; const options = fixture(), worker = await NativeProfileExportWorker.open(options);
		await expect(worker.request("plan-profile", {}, options.signal)).rejects.toThrow("could not complete");
		await expect(worker.request("plan-profile", {}, options.signal)).rejects.toThrow();
		expect((await worker.close()).confirmed).toBe(true);
	});
	it("cancels a pending request, clears keys and closes only its owned child", async () => {
		state.mode = "stall"; const options = fixture(), worker = await NativeProfileExportWorker.open(options), controller = new AbortController();
		const input = { destinationKeyBase64: Buffer.alloc(32, 22).toString("base64") };
		const pending = worker.request("apply-profile", input, controller.signal);
		controller.abort(); await expect(pending).rejects.toThrow(); expect(input).toEqual({});
		expect((await worker.close()).confirmed).toBe(true); expect(state.spawns).toHaveLength(1);
	});
	it("rejects unsafe or changed executable paths before spawning", async () => {
		const options = fixture(); chmodSync(options.executable, 0o722);
		await expect(NativeProfileExportWorker.open(options)).rejects.toThrow(); expect(state.spawns).toHaveLength(0);
		chmodSync(options.executable, 0o700); state.signatureHook = () => writeFileSync(options.entry, "changed after signature verification");
		await expect(NativeProfileExportWorker.open(options)).rejects.toThrow(); expect(state.spawns).toHaveLength(0);
	});
	it("refuses a non-packaged path and an already-cancelled operation", async () => {
		const options = fixture(), controller = new AbortController(); controller.abort();
		await expect(NativeProfileExportWorker.open({ ...options, signal: controller.signal })).rejects.toThrow();
		await expect(NativeProfileExportWorker.open({ ...options, entry: join(options.home, "worker.js") })).rejects.toThrow();
		expect(state.spawns).toHaveLength(0);
	});
});
