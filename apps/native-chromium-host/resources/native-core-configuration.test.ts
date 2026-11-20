import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Native runtime modules are executed unchanged by bundled Node.
import { createNativeCoreConfiguration, NativeCoreConfigurationBusyError, NATIVE_CORE_CONFIGURATION_BUSY_MESSAGE, nativeHostSettingsErrorMessage } from "./native-core-configuration.mjs";

function fixture() {
	let running = false;
	let ownerCanRestore = true;
	const core = {
		get isReady() { return running; }, get hasProcess() { return running; },
		start: vi.fn(async (_config: unknown) => { running = true; }),
		stop: vi.fn(async (_options?: unknown) => { running = false; }),
	};
	const isBusy = vi.fn(() => false); let version = 1;
	const configuration = vi.fn(async () => ({ version: version++ }));
	const changed = vi.fn(async () => {});
	return { core, isBusy, configuration, changed, setRunning: (value: boolean) => { running = value; }, setOwnerCanRestore: (value: boolean) => { ownerCanRestore = value; }, controller: createNativeCoreConfiguration({ core, isBusy, configuration, changed, canRestoreCore: () => ownerCanRestore }) };
}
describe("native provider Core reconfiguration", () => {
	it("reserves an idle settings write without stopping Core or resolving new runtime credentials", async () => {
		const { controller, core, configuration } = fixture(); await controller.start();
		let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
		const writing = controller.withIdleMutation(async () => { await gate; return "saved"; });
		expect(controller.changing).toBe(true);
		await expect(controller.reconfigure(vi.fn())).rejects.toThrow(NATIVE_CORE_CONFIGURATION_BUSY_MESSAGE);
		expect(core.stop).not.toHaveBeenCalled();
		release(); expect(await writing).toBe("saved");
		expect(core.start).toHaveBeenCalledOnce(); expect(configuration).toHaveBeenCalledOnce();
	});
	it("refuses an active task and rolls back a cancelled settings write while retaining the same Core", async () => {
		const { controller, core, isBusy } = fixture(); await controller.start();
		isBusy.mockReturnValue(true); const write = vi.fn();
		await expect(controller.withIdleMutation(write)).rejects.toThrow(NATIVE_CORE_CONFIGURATION_BUSY_MESSAGE);
		expect(write).not.toHaveBeenCalled(); isBusy.mockReturnValue(false);
		const rollback = vi.fn(); let saved = false;
		await expect(controller.withIdleMutation(async () => { saved = true; }, rollback, () => { if (saved) throw new Error("cancelled"); })).rejects.toThrow("cancelled");
		expect(rollback).toHaveBeenCalledOnce(); expect(core.stop).not.toHaveBeenCalled();
		expect(controller.changing).toBe(false);
	});
	it("rejects a busy Core before stopping or persisting anything", async () => {
		const { controller, isBusy, core } = fixture(); const mutation = vi.fn(); isBusy.mockReturnValue(true);
		await expect(controller.reconfigure(mutation)).rejects.toThrow(NATIVE_CORE_CONFIGURATION_BUSY_MESSAGE);
		expect(core.stop).not.toHaveBeenCalled(); expect(mutation).not.toHaveBeenCalled();
	});
	it("locks concurrent changes and stops Core before a single mutation", async () => {
		const { controller, core, changed } = fixture(); await controller.start();
		let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
		const mutation = vi.fn(async () => { expect(core.stop).toHaveBeenCalledOnce(); await gate; return "saved"; });
		const pending = controller.reconfigure(mutation); expect(controller.changing).toBe(true);
		const second = vi.fn(); await expect(controller.reconfigure(second)).rejects.toThrow(NATIVE_CORE_CONFIGURATION_BUSY_MESSAGE); expect(second).not.toHaveBeenCalled();
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
	it("does not restart Core after shutdown begins during a simple pending mutation failure", async () => {
		const { controller, core, setOwnerCanRestore } = fixture(); await controller.start();
		let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
		const pending = controller.reconfigure(async () => { await gate; setOwnerCanRestore(false); throw new Error("mutation failed"); });
		release();
		await expect(pending).rejects.toThrow("Restart Kestrel");
		expect(core.start).toHaveBeenCalledOnce();
		expect(controller.requiresRestart).toBe(true);
	});
	it("rolls back settings but does not restart Core if shutdown begins during configuration preparation", async () => {
		const { controller, core, configuration, setOwnerCanRestore } = fixture(); await controller.start();
		let configCalls = 0;
		configuration.mockImplementation(async () => {
			configCalls++;
			if (configCalls > 0) {
				setOwnerCanRestore(false);
				return { version: 2 };
			}
			return { version: 1 };
		});
		const rollback = vi.fn(async () => {});
		await expect(controller.reconfigure(async () => "saved", rollback, undefined, () => true)).rejects.toThrow("Restart Kestrel");
		expect(rollback).toHaveBeenCalledOnce();
		expect(core.start).toHaveBeenCalledOnce();
		expect(controller.requiresRestart).toBe(true);
	});
	it.each([
		["simple reconfiguration", false],
		["transactional reconfiguration", true],
	] as const)("blocks all admission after an uncertain Core stop in %s", async (_label, transactional) => {
		const { controller, core, setRunning } = fixture(); await controller.start();
		core.stop.mockImplementationOnce(async () => {
			throw Object.assign(new Error("exit still pending"), { exitConfirmed: false });
		});
		const mutation = vi.fn(async () => "must-not-run");
		if (transactional)
			await expect(controller.reconfigure(mutation, vi.fn(async () => {}))).rejects.toThrow("Restart Kestrel");
		else
			await expect(controller.reconfigure(mutation)).rejects.toThrow("Restart Kestrel");
		setRunning(false); // Late old-process exit does not clear the fault.
		expect(mutation).not.toHaveBeenCalled();
		expect(controller.requiresRestart).toBe(true);
		await expect(controller.start()).rejects.toThrow("Restart Kestrel");
		await expect(controller.reconfigure(vi.fn())).rejects.toThrow("Restart Kestrel");
		await expect(controller.withIdleMutation(vi.fn())).rejects.toThrow("Restart Kestrel");
		await expect(controller.withStoppedCore(vi.fn())).rejects.toThrow("Restart Kestrel");
		expect(core.start).toHaveBeenCalledOnce();
		expect(core.stop).toHaveBeenCalledOnce();
	});

});

describe("native Core stopped maintenance", () => {
	it("reserves the controller synchronously and rejects competing maintenance", async () => {
		const { controller, core } = fixture(); await controller.start();
		let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
		const operation = vi.fn(async () => { await gate; return "backup"; });
		const pending = controller.withStoppedCore(operation);
		expect(controller.changing).toBe(true);
		await expect(controller.withStoppedCore(vi.fn())).rejects.toThrow(NATIVE_CORE_CONFIGURATION_BUSY_MESSAGE);
		release(); expect(await pending).toEqual({ completed: true, value: "backup", coreStatus: "ready" });
		expect(core.stop).toHaveBeenCalledWith({ requireCleanExit: true, gracefulTimeoutMs: 60000 });
	});

	it("does not stop or mutate for busy or already-aborted admission", async () => {
		const { controller, core, isBusy } = fixture(); await controller.start();
		const mutation = vi.fn(); isBusy.mockReturnValue(true);
		await expect(controller.withStoppedCore(mutation)).rejects.toThrow(NATIVE_CORE_CONFIGURATION_BUSY_MESSAGE);
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

describe("trusted native settings admission errors", () => {
	it.each(["reconfigure", "withIdleMutation", "withStoppedCore"])("%s reports only host-owned busy admission before stop or mutation", async method => {
		const { controller, core, isBusy } = fixture(); await controller.start();
		isBusy.mockReturnValue(true); const mutation = vi.fn();
		const failed = controller[method](mutation);
		await expect(failed).rejects.toBeInstanceOf(NativeCoreConfigurationBusyError);
		await expect(failed).rejects.toThrow(NATIVE_CORE_CONFIGURATION_BUSY_MESSAGE);
		expect(core.stop).not.toHaveBeenCalled(); expect(mutation).not.toHaveBeenCalled();
		expect(controller.changing).toBe(false);
	});
	it("preserves the starting and concurrent-change guards with trusted admission errors", async () => {
		const { controller, configuration, core } = fixture();
		let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
		configuration.mockImplementationOnce(async () => { await gate; return { version: 1 }; });
		const starting = controller.start(), mutation = vi.fn();
		await expect(controller.reconfigure(mutation)).rejects.toBeInstanceOf(NativeCoreConfigurationBusyError);
		expect(core.stop).not.toHaveBeenCalled(); expect(mutation).not.toHaveBeenCalled();
		release(); await starting;
		let finish!: () => void; const pending = new Promise<void>(resolve => { finish = resolve; });
		const changing = controller.withIdleMutation(async () => { await pending; });
		await expect(controller.reconfigure(mutation)).rejects.toBeInstanceOf(NativeCoreConfigurationBusyError);
		await expect(controller.start()).rejects.toBeInstanceOf(NativeCoreConfigurationBusyError);
		expect(core.stop).not.toHaveBeenCalled(); expect(mutation).not.toHaveBeenCalled();
		finish(); await changing;
	});
	it.each(["reconfigure", "withIdleMutation"])("%s does not pass nested busy errors through already-admitted mutation work", async method => {
		const { controller } = fixture(); await controller.start();
		const failed = controller[method](async () => { throw new NativeCoreConfigurationBusyError(); });
		await expect(failed).rejects.not.toBeInstanceOf(NativeCoreConfigurationBusyError);
		await expect(failed).rejects.toThrow("failed after admission");
	});
	const assertAdmittedFailure = (error: unknown, original: Error) => {
		expect(error).not.toBeInstanceOf(NativeCoreConfigurationBusyError);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).cause).toBe(original);
		expect(nativeHostSettingsErrorMessage(error, "remove-workspace-folder", "local static error"))
			.toBe("Kestrel settings could not be applied. Finish or cancel active tasks and check the native profile before retrying.");
	};
	it.each(["configuration", "core.start"])("masks busy raised after start admission by %s", async source => {
		const { controller, configuration, core } = fixture();
		const original = new NativeCoreConfigurationBusyError();
		if (source === "configuration") configuration.mockRejectedValueOnce(original);
		else core.start.mockRejectedValueOnce(original);
		const error = await controller.start().catch((failure: unknown) => failure);
		assertAdmittedFailure(error, original);
		expect(configuration).toHaveBeenCalledOnce();
		expect(core.start).toHaveBeenCalledTimes(source === "core.start" ? 1 : 0);
	});
	it.each([true, false])("masks a busy stop failure after stop invocation (exit confirmed: %s)", async confirmed => {
		const { controller, core, setRunning } = fixture(); await controller.start();
		const original = Object.assign(new NativeCoreConfigurationBusyError(), { exitConfirmed: confirmed });
		core.stop.mockImplementationOnce(async () => { if (confirmed) setRunning(false); throw original; });
		const operation = vi.fn(); const outcome = await controller.withStoppedCore(operation);
		expect(core.stop).toHaveBeenCalledOnce(); expect(operation).not.toHaveBeenCalled();
		expect(outcome.coreStatus).toBe(confirmed ? "ready" : "restart-required");
		assertAdmittedFailure(outcome.error, original);
	});
	it.each(["ready", "no-restore", "restart-failed"])("masks nested busy after stopped operation (%s)", async mode => {
		const { controller, core, setOwnerCanRestore, configuration } = fixture(); await controller.start();
		if (mode === "restart-failed") configuration.mockRejectedValueOnce(new Error("restart failed"));
		let nested: unknown;
		const operation = vi.fn(async () => {
			try { await controller.withIdleMutation(vi.fn()); } catch (error) { nested = error; }
			if (mode === "no-restore") setOwnerCanRestore(false);
			throw nested;
		});
		const outcome = await controller.withStoppedCore(operation);
		expect(core.stop).toHaveBeenCalledOnce(); expect(operation).toHaveBeenCalledOnce();
		expect(nested).toBeInstanceOf(NativeCoreConfigurationBusyError);
		expect(outcome.coreStatus).toBe(mode === "ready" ? "ready" : "restart-required");
		assertAdmittedFailure(outcome.error, nested as Error);
	});
	it("preserves ordinary error identity after an admitted start", async () => {
		const { controller, configuration } = fixture(); const original = new Error("nonbusy");
		configuration.mockRejectedValueOnce(original);
		await expect(controller.start()).rejects.toBe(original);
	});
	it("exposes only static text for the actual local class and masks strings, names, codes and secrets", () => {
		const generic = "Kestrel settings could not be applied. Finish or cancel active tasks and check the native profile before retrying.";
		const busy = new NativeCoreConfigurationBusyError(); busy.message = "synthetic-private-value";
		expect(nativeHostSettingsErrorMessage(busy, "remove-workspace-folder", "local static error")).toBe(NATIVE_CORE_CONFIGURATION_BUSY_MESSAGE);
		for (const error of [new Error("synthetic-private-value"), new Error(NATIVE_CORE_CONFIGURATION_BUSY_MESSAGE), Object.assign(new Error("synthetic-private-value"), { name: "NativeCoreConfigurationBusyError", code: "NATIVE_CORE_BUSY" }), NATIVE_CORE_CONFIGURATION_BUSY_MESSAGE, { name: "NativeCoreConfigurationBusyError", message: NATIVE_CORE_CONFIGURATION_BUSY_MESSAGE, code: "NATIVE_CORE_BUSY" }])
			expect(nativeHostSettingsErrorMessage(error, "remove-workspace-folder", "local static error")).toBe(generic);
	});
	it("preserves the existing local-model whitelist only for its two intended requests", () => {
		const local = "Local model setup timed out. Partial downloads may remain in Ollama.";
		for (const type of ["local-runtime-bootstrap", "local-model-pull"])
			expect(nativeHostSettingsErrorMessage(new Error(local), type, "local static error")).toBe(local);
		expect(nativeHostSettingsErrorMessage(new Error(local), "remove-workspace-folder", "local static error")).not.toBe(local);
		expect(nativeHostSettingsErrorMessage(new Error("synthetic-private-value"), "local-model-pull", "local static error")).not.toContain("synthetic-private-value");
	});
});
