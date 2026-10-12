import { expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(), off: vi.fn(), send: vi.fn() }));
vi.mock("electron", () => ({ ipcRenderer: ipc }));
import { createRendererBridge } from "@kestrel/shared-types";
import { electronRendererTransport } from "./electron-renderer-transport";

it("adapts Electron IPC and readiness to the shared validated bridge", async () => {
	ipc.invoke.mockResolvedValue({ ok: true });
	const bridge = createRendererBridge(electronRendererTransport);
	await expect(bridge.request({ type: "snapshot" })).resolves.toEqual({ ok: true });
	expect(ipc.invoke).toHaveBeenCalledWith("kestrel:request", { type: "snapshot" });
	const callback = vi.fn();
	const dispose = bridge.onWindowFocus(callback);
	expect(ipc.on).toHaveBeenCalledWith("kestrel:window-focus", expect.any(Function));
	expect(ipc.send).toHaveBeenCalledWith("kestrel:window-focus-ready");
	const listener = ipc.on.mock.calls[0]![1];
	listener({}, { focused: true });
	listener({}, true);
	expect(callback).toHaveBeenCalledExactlyOnceWith(true);
	dispose();
	dispose();
	listener({}, false);
	expect(ipc.off).toHaveBeenCalledExactlyOnceWith("kestrel:window-focus", listener);
	expect(callback).toHaveBeenCalledOnce();
});
