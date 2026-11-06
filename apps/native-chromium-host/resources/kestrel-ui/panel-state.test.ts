import { expect, it } from "vitest";
import { OPEN_PANELS_KEY, trackNativePanels } from "./panel-state.mjs";

it("tracks actual native panel visibility independently across windows", async () => {
	const stored: Record<string, unknown> = {};
	const callbacks: Record<string, (value: any) => void> = {};
	const event = (name: string) => ({ addListener: (callback: (value: any) => void) => { callbacks[name] = callback; } });
	const tracker = trackNativePanels({
		storage: { session: { get: async (key: string) => ({ [key]: stored[key] }), set: async (value: Record<string, unknown>) => { Object.assign(stored, value); } } },
		sidePanel: { onOpened: event("opened"), onClosed: event("closed") },
		windows: { onRemoved: event("removed") },
	});
	callbacks.opened({ windowId: 7 });
	callbacks.opened({ windowId: 9 });
	callbacks.closed({ windowId: 7 });
	await tracker.settled();
	expect(stored[OPEN_PANELS_KEY]).toEqual({ 9: true });
	callbacks.opened({ windowId: 7 });
	callbacks.removed(9);
	callbacks.closed({ windowId: -1 });
	await tracker.settled();
	expect(stored[OPEN_PANELS_KEY]).toEqual({ 7: true });
});
