import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Native runtime modules are executed unchanged by bundled Node.
import { createNativeCoreConfiguration } from "./native-core-configuration.mjs";

function fixture() {
	let running = false;
	const core = {
		get isReady() { return running; }, get hasProcess() { return running; },
		start: vi.fn(async (_config: unknown) => { running = true; }),
		stop: vi.fn(async (_options?: unknown) => { running = false; }),
	};
	const isBusy = vi.fn(() => false); let version = 1;
	const configuration = vi.fn(async () => ({ version: version++ }));
	const changed = vi.fn(async () => {});
	return { core, isBusy, configuration, changed, setRunning: (value: boolean) => { running = value; }, controller: createNativeCoreConfiguration({ core, isBusy, configuration, changed }) };
}
describe("native provider Core reconfiguration", () => {
	it("rejects a busy Core before stopping or persisting anything", async () => {
		const { controller, isBusy, core } = fixture(); const mutation = vi.fn(); isBusy.mockReturnValue(true);
		await expect(controller.reconfigure(mutation)).rejects.toThrow("active task");
		expect(core.stop).not.toHaveBeenCalled(); expect(mutation).not.toHaveBeenCalled();
	});
	it("locks concurrent changes and stops Core before a single mutation", async () => {
		const { controller, core, changed } = fixture(); await controller.start();
		let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
		const mutation = vi.fn(async () => { expect(core.stop).toHaveBeenCalledOnce(); await gate; return "saved"; });
		const pending = controller.reconfigure(mutation); expect(controller.changing).toBe(true);
		const second = vi.fn(); await expect(controller.reconfigure(second)).rejects.toThrow("active task"); expect(second).not.toHaveBeenCalled();
		release(); expect(await pending).toBe("saved"); expect(core.start).toHaveBeenLastCalledWith({ version: 2 });
		expect(changed).toHaveBeenCalledOnce(); expect(controller.changing).toBe(false);
	});
	it("restores the previous running configuration when mutation validation fails", async () => {
		const { controller, core } = fixture(); await controller.start();
		await expect(controller.reconfigure(async () => { throw new Error("Invalid account"); })).rejects.toThrow("Invalid account");
		expect(core.start).toHaveBeenLastCalledWith({ version: 1 }); expect(controller.changing).toBe(false);
	});
	it("does not replay a saved mutation when restart fails", async () => {
		const { controller, core } = fixture(); await controller.start(); core.start.mockRejectedValueOnce(new Error("private startup error"));
		const mutation = vi.fn(async () => "saved");
		await expect(controller.reconfigure(mutation)).rejects.toThrow("settings were preserved");
		expect(mutation).toHaveBeenCalledOnce(); expect(core.start).toHaveBeenCalledTimes(2);
	});
	it("rolls back a committed preference when post-restart validation fails", async () => {
		const { controller, core } = fixture(); await controller.start();
		const rollback = vi.fn(async () => {});
		await expect(controller.reconfigure(async () => "saved", rollback, () => { throw new Error("cancelled"); }, () => true)).rejects.toThrow("cancelled");
		expect(rollback).toHaveBeenCalledOnce();
		expect(core.stop).toHaveBeenCalledTimes(2);
		expect(core.start).toHaveBeenLastCalledWith({ version: 1 });
	});
	it("restores files without restarting Core during shutdown", async () => {
		const { controller, core } = fixture(); await controller.start();
		const rollback = vi.fn(async () => {});
		await expect(controller.reconfigure(async () => { throw new Error("cancelled"); }, rollback, () => {}, () => false)).rejects.toThrow("cancelled");
		expect(rollback).toHaveBeenCalledOnce(); expect(core.start).toHaveBeenCalledOnce();
	});

});

describe("native Core stopped maintenance", () => {
	it("reserves the controller synchronously and rejects competing maintenance", async () => {
		const { controller, core } = fixture(); await controller.start();
		let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
		const operation = vi.fn(async () => { await gate; return "backup"; });
		const pending = controller.withStoppedCore(operation);
		expect(controller.changing).toBe(true);
		await expect(controller.withStoppedCore(vi.fn())).rejects.toThrow("active task");
		release(); expect(await pending).toEqual({ completed: true, value: "backup", coreStatus: "ready" });
		expect(core.stop).toHaveBeenCalledWith({ requireCleanExit: true, gracefulTimeoutMs: 60000 });
	});

	it("does not stop or mutate for busy or already-aborted admission", async () => {
		const { controller, core, isBusy } = fixture(); await controller.start();
		const mutation = vi.fn(); isBusy.mockReturnValue(true);
		await expect(controller.withStoppedCore(mutation)).rejects.toThrow("active task");
		isBusy.mockReturnValue(false);
		const abort = new AbortController(); abort.abort();
		expect(await controller.withStoppedCore(mutation, { signal: abort.signal })).toMatchObject({ completed: false, coreStatus: "ready" });
		expect(core.stop).not.toHaveBeenCalled(); expect(mutation).not.toHaveBeenCalled();
	});

	it("runs after a confirmed clean stop and restarts from fresh configuration", async () => {
		const { controller, core, configuration, changed } = fixture(); await controller.start();
		const operation = vi.fn(async () => "preserved");
		expect(await controller.withStoppedCore(operation)).toEqual({ completed: true, value: "preserved", coreStatus: "ready" });
		expect(operation).toHaveBeenCalledOnce(); expect(configuration).toHaveBeenCalledTimes(2);
		expect(core.start).toHaveBeenLastCalledWith({ version: 2 }); expect(changed).toHaveBeenCalledOnce();
	});

	it("gates uncertain old-owner exits and blocks subsequent reconfiguration", async () => {
		const { controller, core } = fixture(); await controller.start();
		core.stop.mockImplementationOnce(async () => { throw Object.assign(new Error("still exiting"), { exitConfirmed: false }); });
		const operation = vi.fn();
		const result = await controller.withStoppedCore(operation);
		expect(result).toMatchObject({ completed: false, coreStatus: "restart-required" });
		expect(operation).not.toHaveBeenCalled(); expect(core.start).toHaveBeenCalledOnce();
		expect(controller.requiresRestart).toBe(true);
		await expect(controller.reconfigure(vi.fn())).rejects.toThrow("Restart Kestrel");
		await expect(controller.withStoppedCore(vi.fn())).rejects.toThrow("Restart Kestrel");
	});

	it("restarts after a confirmed forced-stop failure without running the operation", async () => {
		const { controller, core, setRunning } = fixture(); await controller.start();
		core.stop.mockImplementationOnce(async () => { setRunning(false); throw Object.assign(new Error("forced"), { exitConfirmed: true }); });
		const operation = vi.fn();
		expect(await controller.withStoppedCore(operation)).toMatchObject({ completed: false, coreStatus: "ready" });
		expect(operation).not.toHaveBeenCalled(); expect(core.start).toHaveBeenCalledTimes(2);
	});

	it("restarts after operation failure and cancellation", async () => {
		const { controller, core } = fixture(); await controller.start();
		const failure = new Error("backup failed");
		expect(await controller.withStoppedCore(async () => { throw failure; })).toEqual({ completed: false, error: failure, coreStatus: "ready" });
		const abort = new AbortController();
		const cancelled = await controller.withStoppedCore(async () => { abort.abort(); throw Object.assign(new Error("cancelled"), { name: "AbortError" }); }, { signal: abort.signal });
		expect(cancelled).toMatchObject({ completed: false, coreStatus: "ready" });
		expect(core.start).toHaveBeenCalledTimes(3);
	});

	it("retains a committed result when cancellation arrives after the operation", async () => {
		const { controller } = fixture(); await controller.start(); const abort = new AbortController();
		const result = await controller.withStoppedCore(async () => { abort.abort(); return "committed"; }, { signal: abort.signal });
		expect(result).toEqual({ completed: true, value: "committed", coreStatus: "ready" });
	});

	it("retains successful work when Core restart fails", async () => {
		const { controller, core } = fixture(); await controller.start();
		core.start.mockRejectedValueOnce(new Error("startup failed"));
		expect(await controller.withStoppedCore(async () => "saved")).toEqual({ completed: true, value: "saved", coreStatus: "restart-required" });
		expect(controller.requiresRestart).toBe(true);
	});

	it("does not resurrect Core when the owner begins shutting down", async () => {
		const { controller, core } = fixture(); await controller.start();
		expect(await controller.withStoppedCore(async () => "saved", { shouldRestoreCore: () => false })).toEqual({ completed: true, value: "saved", coreStatus: "restart-required" });
		expect(core.start).toHaveBeenCalledOnce(); expect(core.stop).toHaveBeenCalledOnce();
	});
	it("fails closed when the owner cannot determine whether Core should restart", async () => {
		const { controller, core } = fixture(); await controller.start();
		expect(await controller.withStoppedCore(async () => "saved", { shouldRestoreCore: () => { throw new Error("owner is closing"); } }))
			.toEqual({ completed: true, value: "saved", coreStatus: "restart-required" });
		expect(core.start).toHaveBeenCalledOnce();
	});
});
