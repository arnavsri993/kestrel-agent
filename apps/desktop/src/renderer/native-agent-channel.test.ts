import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeAgentChannel } from "./native-agent-channel";

class Bus {
	readonly ports = new Set<Port>();
	port() { const port = new Port(this); this.ports.add(port); return port; }
}
class Port {
	readonly listeners = new Set<(event: { data: unknown }) => void>();
	constructor(private bus: Bus) {}
	postMessage(data: unknown) { for (const port of this.bus.ports) if (port !== this) for (const listener of port.listeners) listener({ data: structuredClone(data) }); }
	addEventListener(_type: "message", callback: (event: { data: unknown }) => void) { this.listeners.add(callback); }
	removeEventListener(_type: "message", callback: (event: { data: unknown }) => void) { this.listeners.delete(callback); }
	close() { this.bus.ports.delete(this); }
}
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.useRealTimers(); });
function client(bus: Bus, windowId: number, panel: boolean) {
	const value = createNativeAgentChannel({ channel: bus.port(), windowId, panel, timeoutMs: 1000 }); cleanup.push(() => value.close()); return value;
}
const action = { type: "new-agent" as const, prompt: "Native task", focusTarget: "prompt" as const };
describe("native agent panel channel", () => {
	it("routes a Home task only to the panel in its own window", async () => {
		const bus = new Bus(); const home = client(bus, 1, false); const panel = client(bus, 1, true); const other = client(bus, 2, true);
		const accepted = vi.fn(); const rejected = vi.fn(); panel.subscribe(accepted); other.subscribe(rejected);
		await home.send(action); expect(accepted).toHaveBeenCalledExactlyOnceWith(action); expect(rejected).not.toHaveBeenCalled();
	});
	it("keeps a bounded request while the panel mounts and acknowledges it after acceptance", async () => {
		const bus = new Bus(); const home = client(bus, 1, false); const panel = client(bus, 1, true); const handler = vi.fn();
		const sent = home.send(action); panel.subscribe(handler); await sent; expect(handler).toHaveBeenCalledOnce();
	});
	it("rejects a busy panel without replaying the new task", async () => {
		const bus = new Bus(); const home = client(bus, 1, false); const panel = client(bus, 1, true);
		const handler = vi.fn(() => { throw new Error("Task running"); }); panel.subscribe(handler);
		await expect(home.send(action)).rejects.toThrow("Check the current task"); expect(handler).toHaveBeenCalledOnce();
	});
	it("rejects close and timeout without replaying into a later panel", async () => {
		vi.useFakeTimers(); const bus = new Bus(); const home = client(bus, 1, false);
		const sent = expect(home.send(action)).rejects.toThrow("Check the current task"); await vi.advanceTimersByTimeAsync(1000); await sent;
		const handler = vi.fn(); client(bus, 1, true).subscribe(handler); await Promise.resolve(); expect(handler).not.toHaveBeenCalled();
		const closed = expect(home.send(action)).rejects.toThrow("Check the current task"); home.close(); await closed;
	});
	it("rejects invalid payloads and duplicate task dispatch", async () => {
		const bus = new Bus(); const port = bus.port(); const panel = client(bus, 1, true); const handler = vi.fn(); panel.subscribe(handler);
		const id = crypto.randomUUID(); const message = { kind: "agent-action", windowId: 1, id, action };
		port.postMessage(message); port.postMessage(message); await Promise.resolve(); await Promise.resolve();
		expect(handler).toHaveBeenCalledOnce();
		port.postMessage({ ...message, id: crypto.randomUUID(), action: { ...action, unexpected: "must not cross" } });
		expect(handler).toHaveBeenCalledOnce(); port.close();
	});
	it("continues after many completed tasks while keeping overload bounded", async () => {
		const bus = new Bus(); const home = client(bus, 1, false); const panel = client(bus, 1, true); const handler = vi.fn(); panel.subscribe(handler);
		for (let i = 0; i < 140; i++) await home.send(action);
		expect(handler).toHaveBeenCalledTimes(140);
		await expect(home.send({ ...action, prompt: "x".repeat(500_001) })).rejects.toThrow("Check the current task");
	});
});
