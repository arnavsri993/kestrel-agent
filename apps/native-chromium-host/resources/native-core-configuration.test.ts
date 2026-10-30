import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Native runtime modules are executed unchanged by bundled Node.
import { createNativeCoreConfiguration } from "./native-core-configuration.mjs";

function fixture() {
	const core = { start: vi.fn(async (_config: unknown) => {}), stop: vi.fn(async () => {}) };
	const isBusy = vi.fn(() => false); let version = 1;
	const configuration = vi.fn(async () => ({ version: version++ }));
	const changed = vi.fn(async () => {});
	return { core, isBusy, configuration, changed, controller: createNativeCoreConfiguration({ core, isBusy, configuration, changed }) };
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
});
