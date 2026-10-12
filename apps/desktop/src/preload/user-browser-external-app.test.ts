import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXTERNAL_APP_CHANNEL, EXTERNAL_APP_EVENT, installExternalAppBridge, installExternalAppWindowOpen } from "./user-browser-external-app";

afterEach(() => vi.unstubAllGlobals());

function fixture(main = true, injectionFails = false, acknowledge = true) {
	const listeners = new Map<string, (event: any) => void>();
	const nativeOpen = vi.fn((..._args: unknown[]) => ({ native: true }));
	const postMessage = vi.fn();
	const win = { top: undefined as unknown, open: nativeOpen, postMessage, addEventListener: (name: string, handler: any) => listeners.set(name, handler) };
	win.top = win;
	vi.stubGlobal("window", win);
	vi.stubGlobal("location", { href: "https://teams.microsoft.com/join", origin: "https://teams.microsoft.com", protocol: "https:" });
	vi.stubGlobal("document", { hasFocus: () => true });
	const send = vi.fn();
	let ready!: (value: unknown) => void;
	const execute = vi.fn((func, args) => {
		if (injectionFails) throw new Error("Unsupported injection");
		// Exercise the serialized function as Electron does, with no preload scope.
		runInNewContext(`(${func.toString()})(...args)`, { window: win, location, args, Reflect });
	});
	installExternalAppBridge({ isMainFrame: main, send, onReady: listener => { ready = listener; }, execute });
	const documentId = send.mock.calls[0]?.[1].documentId;
	if (main && acknowledge) ready({ documentId, generation: 3 });
	const input = (event: object = {}) => listeners.get("mousedown")?.({ type: "mousedown", button: 0, isTrusted: true, ...event });
	const message = (event: object = {}) => listeners.get("message")?.({ source: win, origin: location.origin, data: { type: EXTERNAL_APP_EVENT, url: "msteams:/l/meetup-join/fixture/0" }, ...event });
	return { win, send, execute, listeners, nativeOpen, postMessage, input, message, ready, documentId };
}

describe("main-frame external app popup bridge", () => {
	it("serializes the actual window.open wrapper and preserves ordinary opens", () => {
		const f = fixture();
		expect(installExternalAppWindowOpen.toString()).not.toContain("__name");
		expect(f.win.open("https://example.test", "_blank")).toEqual({ native: true });
		expect(f.win.open("msteams:/l/meetup-join/fixture/0", "_blank")).toBeNull();
		expect(f.postMessage).toHaveBeenCalledWith({ type: EXTERNAL_APP_EVENT, url: "msteams:/l/meetup-join/fixture/0" }, location.origin);
		expect(f.nativeOpen).toHaveBeenCalledTimes(1);
	});
	it("requires trusted top-document input and consumes one request", () => {
		const f = fixture();
		f.message(); f.input({ isTrusted: false }); f.message();
		expect(f.send).toHaveBeenCalledTimes(1);
		f.input(); f.message(); f.message();
		expect(f.send.mock.calls.map(call => call[1].type)).toEqual(["ready", "capture", "request"]);
		expect(f.send).toHaveBeenLastCalledWith(EXTERNAL_APP_CHANNEL, expect.objectContaining({ generation: 3, documentId: f.documentId }));
	});
	it("rejects input before acknowledgement and a wrong nonce without retaining that input", () => {
		const f = fixture(true, false, false);
		f.input(); f.message();
		f.ready({ documentId: crypto.randomUUID(), generation: 3 });
		f.input(); f.message();
		expect(f.send).toHaveBeenCalledTimes(1);
		f.ready({ documentId: f.documentId, generation: 3 });
		f.message(); expect(f.send).toHaveBeenCalledTimes(1);
		f.input(); f.message();
		expect(f.send.mock.calls.map(call => call[1].type)).toEqual(["ready", "capture", "request"]);
	});
	it("requires a new acknowledgement and fresh input after a trusted BFCache restore", () => {
		const f = fixture(); f.input();
		f.listeners.get("pagehide")!({});
		f.ready({ documentId: f.documentId, generation: 3 }); // Delayed old ack while hidden.
		f.input(); f.message(); expect(f.send).toHaveBeenCalledTimes(2);
		f.listeners.get("pageshow")!({ isTrusted: true, persisted: true });
		const newDocumentId = f.send.mock.calls.at(-1)![1].documentId;
		expect(newDocumentId).not.toBe(f.documentId);
		f.ready({ documentId: f.documentId, generation: 3 });
		f.input(); f.message(); expect(f.send).toHaveBeenCalledTimes(3);
		f.ready({ documentId: newDocumentId, generation: 5 });
		f.ready({ documentId: newDocumentId, generation: 3 }); // Duplicate cannot roll generation back.
		f.message(); expect(f.send).toHaveBeenCalledTimes(3);
		f.input(); f.message();
		expect(f.send).toHaveBeenLastCalledWith(EXTERNAL_APP_CHANNEL, expect.objectContaining({ generation: 5, documentId: newDocumentId }));
	});
	it("does not re-register for synthetic, ordinary, or changed-URL pageshow", () => {
		const f = fixture(); f.listeners.get("pagehide")!({});
		const show = f.listeners.get("pageshow")!;
		show({ isTrusted: false, persisted: true });
		show({ isTrusted: true, persisted: false });
		location.href = "https://teams.microsoft.com/changed";
		show({ isTrusted: true, persisted: true });
		expect(f.send).toHaveBeenCalledTimes(1);
	});
	it("does not install in child frames or accept a child postMessage borrowing top input", () => {
		const child = fixture(false);
		expect(child.send).not.toHaveBeenCalled(); expect(child.execute).not.toHaveBeenCalled();
		const f = fixture(); f.input();
		f.message({ source: {} }); f.message({ origin: "https://foreign.example" });
		expect(f.send).toHaveBeenCalledTimes(2);
		// Even direct execution of the main-world installer cannot wrap a child.
		const childWindow = { top: {}, open: child.nativeOpen };
		runInNewContext(`(${installExternalAppWindowOpen.toString()})(eventName)`, { window: childWindow, location, eventName: EXTERNAL_APP_EVENT });
		expect(childWindow.open).toBe(child.nativeOpen);
	});
	it("rejects repeated/modifier keyboard input and expires document state on pagehide", () => {
		const f = fixture();
		const key = f.listeners.get("keydown")!;
		key({ type: "keydown", key: "Enter", isTrusted: true, repeat: true });
		key({ type: "keydown", key: " ", isTrusted: true, ctrlKey: true });
		f.message(); expect(f.send).toHaveBeenCalledTimes(1);
		key({ type: "keydown", key: "Enter", isTrusted: true });
		f.listeners.get("pagehide")!({}); f.message();
		expect(f.send).toHaveBeenCalledTimes(2);
	});
	it("fails closed when injection fails and rejects expired input", () => {
		const failed = fixture(true, true);
		expect(failed.win.open).toBe(failed.nativeOpen);
		const f = fixture();
		const time = vi.spyOn(Date, "now");
		time.mockReturnValue(1_000); f.input(); time.mockReturnValue(6_001); f.message();
		expect(f.send).toHaveBeenCalledTimes(2); time.mockRestore();
	});
});
