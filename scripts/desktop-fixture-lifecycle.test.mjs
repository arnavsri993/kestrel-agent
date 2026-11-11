import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withDesktopFixture } from "./desktop-fixture-lifecycle.mjs";

const roots = [];
const children = [];
const pending = () => new Promise(() => {});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "kestrel-fixture-lifecycle-"));
	roots.push(root);
	const child = Object.assign(new EventEmitter(), {
		pid: 123,
		exitCode: null,
		signalCode: null,
	});
	const exit = (code = 0, signal = null) => {
		child.exitCode = code;
		child.signalCode = signal;
		child.emit("exit", code, signal);
	};
	child.kill = vi.fn(() => {
		exit(null, "SIGKILL");
		return true;
	});
	const application = {
		process: () => child,
		close: vi.fn(async () => exit()),
	};
	const options = {
		root,
		launch: async () => application,
		run: vi.fn(async () => {}),
		closeTimeoutMs: 100,
		killTimeoutMs: 50,
	};
	return { root, child, application, options, exit };
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
	vi.useRealTimers();
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
		}
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("disposable desktop fixture lifecycle", () => {
	it("waits for both close and child exit before deleting fixture files", async () => {
		const f = fixture();
		f.application.close.mockImplementation(() => new Promise((resolve) => {
			setTimeout(f.exit, 10);
			setTimeout(resolve, 20);
		}));
		const done = withDesktopFixture(f.options);
		await vi.advanceTimersByTimeAsync(15);
		expect(existsSync(f.root)).toBe(true);
		await vi.advanceTimersByTimeAsync(5);
		await done;
		expect(existsSync(f.root)).toBe(false);
		expect(f.child.kill).not.toHaveBeenCalled();
		expect(f.child.listenerCount("exit")).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("observes an exit during assertions before close begins", async () => {
		const f = fixture();
		f.options.run = async () => f.exit();
		f.application.close.mockResolvedValue();
		await withDesktopFixture(f.options);
		expect(f.child.kill).not.toHaveBeenCalled();
		expect(existsSync(f.root)).toBe(false);
	});

	it("handles an already-exited child without waiting for another event", async () => {
		const f = fixture();
		f.exit();
		f.application.close.mockResolvedValue();
		await withDesktopFixture(f.options);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(["close never settles", "close resolves without exit"])("fails and kills only the captured child when %s", async (mode) => {
		const f = fixture();
		f.application.close.mockImplementation(mode === "close never settles" ? pending : async () => {});
		const result = withDesktopFixture(f.options).catch((error) => error);
		await vi.advanceTimersByTimeAsync(100);
		const error = await result;
		expect(error.errors[0].message).toContain("teardown did not complete within 100ms");
		expect(f.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
		expect(existsSync(f.root)).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("fails a stuck close even after the child has exited, without signalling it", async () => {
		const f = fixture();
		f.options.run = async () => f.exit();
		f.application.close.mockImplementation(pending);
		const result = withDesktopFixture(f.options).catch((error) => error);
		await vi.advanceTimersByTimeAsync(100);
		expect((await result).errors[0].message).toContain("teardown did not complete");
		expect(f.child.kill).not.toHaveBeenCalled();
		expect(existsSync(f.root)).toBe(true);
	});

	it("fails on abnormal early exit rather than treating any exit as success", async () => {
		const f = fixture();
		f.exit(null, "SIGTERM");
		f.application.close.mockResolvedValue();
		await expect(withDesktopFixture(f.options)).rejects.toMatchObject({
			errors: [expect.objectContaining({ message: expect.stringContaining("exited abnormally") }), expect.any(Error)],
		});
		expect(f.child.kill).not.toHaveBeenCalled();
		expect(existsSync(f.root)).toBe(true);
	});

	it("keeps a rejected close as the failure even if forced cleanup succeeds", async () => {
		const f = fixture();
		const failure = new Error("close rejected");
		f.application.close.mockRejectedValue(failure);
		await expect(withDesktopFixture(f.options)).rejects.toMatchObject({ cause: failure });
		expect(f.child.kill).toHaveBeenCalledOnce();
		expect(existsSync(f.root)).toBe(true);
	});

	it("preserves the original assertion error when graceful cleanup succeeds", async () => {
		const f = fixture();
		const failure = new Error("assertion failed");
		f.options.run = async () => { throw failure; };
		await expect(withDesktopFixture(f.options)).rejects.toBe(failure);
		expect(f.application.close).toHaveBeenCalledOnce();
		expect(existsSync(f.root)).toBe(false);
	});

	it("lists the assertion first when both assertions and teardown fail", async () => {
		const f = fixture();
		const failure = new Error("assertion failed");
		f.options.run = async () => { throw failure; };
		f.application.close.mockImplementation(pending);
		const result = withDesktopFixture(f.options).catch((error) => error);
		await vi.advanceTimersByTimeAsync(100);
		const error = await result;
		expect(error.cause).toBe(failure);
		expect(error.errors[0]).toBe(failure);
		expect(error.errors[1].message).toContain("teardown did not complete");
	});

	it("bounds failed forced cleanup and retains files when exit cannot be confirmed", async () => {
		const f = fixture();
		f.application.close.mockImplementation(pending);
		f.child.kill.mockImplementation(() => { f.child.emit("error", new Error("EPERM")); return false; });
		const result = withDesktopFixture(f.options).catch((error) => error);
		await vi.advanceTimersByTimeAsync(150);
		const error = await result;
		expect(error.errors.map((entry) => entry.message).join("\n")).toContain("exit was not confirmed within 50ms");
		expect(error.errors.at(-1).message).toContain(f.root);
		expect(existsSync(f.root)).toBe(true);
		expect(f.child.listenerCount("exit")).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("handles a late close rejection after the timeout", async () => {
		const f = fixture();
		let rejectClose;
		f.application.close.mockImplementation(() => new Promise((_, reject) => { rejectClose = reject; }));
		const result = withDesktopFixture(f.options).catch((error) => error);
		await vi.advanceTimersByTimeAsync(100);
		expect(await result).toBeInstanceOf(AggregateError);
		rejectClose(new Error("late close rejection"));
		await vi.advanceTimersByTimeAsync(0);
	});

	it("retains launch diagnostics without replacing the launch error", async () => {
		const f = fixture();
		const failure = new Error("launch failed");
		f.options.launch = async () => { throw failure; };
		await expect(withDesktopFixture(f.options)).rejects.toMatchObject({ cause: failure, message: expect.stringContaining(f.root) });
		expect(existsSync(f.root)).toBe(true);
		expect(f.options.run).not.toHaveBeenCalled();
	});

	it("terminates a real owned child while leaving an unrelated child alive", async () => {
		vi.useRealTimers();
		const f = fixture();
		const start = async () => {
			const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
			children.push(child);
			await once(child, "spawn");
			return child;
		};
		const owned = await start();
		const unrelated = await start();
		f.options.launch = async () => ({ process: () => owned, close: pending });
		await expect(withDesktopFixture(f.options)).rejects.toBeInstanceOf(AggregateError);
		expect(owned.signalCode).toBe("SIGKILL");
		expect(unrelated.exitCode).toBe(null);
		expect(unrelated.signalCode).toBe(null);
		expect(unrelated.kill(0)).toBe(true);
		expect(existsSync(f.root)).toBe(true);
	});
});
