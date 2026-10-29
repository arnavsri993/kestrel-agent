import { describe, expect, it, vi } from "vitest";
import { createNativeAutomation, sanitizeNativeAccessibility } from "./native-automation.mjs";

function fixture() {
	const tab = { id: 3, url: "https://example.test/?access_token=url-secret", title: "Example", discarded: false };
	const frame = { documentId: "document-1", documentLifecycle: "active", url: tab.url };
	const storage: Record<string, unknown> = {};
	const root = { backendNodeId: 1, nodeName: "#document", children: [{ backendNodeId: 2, nodeName: "BODY", attributes: [] as string[], children: [
		{ backendNodeId: 3, nodeName: "BUTTON", attributes: ["id", "save"], children: [] },
		{ backendNodeId: 4, nodeName: "INPUT", attributes: ["type", "password", "value", "fixture-input-secret"], children: [] },
		{ backendNodeId: 5, nodeName: "TEXTAREA", children: [{ backendNodeId: 6, nodeName: "#text" }] },
		{ backendNodeId: 7, nodeName: "DIV", attributes: ["data-private", ""], children: [{ backendNodeId: 8, nodeName: "#text" }] },
	] }] };
	const nodes = [{ nodeId: "1", role: { value: "button" }, name: { value: "Save" }, backendDOMNodeId: 3, description: "fixture-description-secret" },
		{ nodeId: "2", role: { value: "textbox" }, name: { value: "Password" }, value: { value: "fixture-input-secret" }, backendDOMNodeId: 4 },
		{ nodeId: "3", role: { value: "StaticText" }, name: { value: "fixture-textarea-secret" }, backendDOMNodeId: 6 },
		{ nodeId: "4", role: { value: "StaticText" }, name: { value: "fixture-private-secret" }, backendDOMNodeId: 8 },
	];
	const sendCommand = vi.fn(async (_owner: unknown, method: string) => {
		if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-1" } } };
		if (method === "DOM.getDocument") return { root };
		if (method === "Accessibility.getFullAXTree" || method === "Accessibility.getPartialAXTree") return { nodes };
		if (method === "Page.createIsolatedWorld") return { executionContextId: 17 };
		if (method === "DOM.resolveNode") return { object: { objectId: "resolved-node" } };
		if (method === "Runtime.callFunctionOn") return { result: { value: { ok: true, x: 40, y: 30 } } };
		if (["DOM.focus", "Input.insertText", "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Runtime.releaseObject"].includes(method)) return {};
		if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 800, clientHeight: 600, scale: 1, pageX: 0, pageY: 0 } };
		if (method === "DOM.getNodeForLocation") return { backendNodeId: 3 };
		throw new Error("Unexpected protocol command");
	});
	const chrome = { tabs: { get: vi.fn(async () => tab) }, webNavigation: { getFrame: vi.fn(async () => frame) }, storage: { session: { get: vi.fn(async (key: string) => ({ [key]: storage[key] })), set: vi.fn(async (value: object) => Object.assign(storage, value)) } }, debugger: { attach: vi.fn(async () => {}), detach: vi.fn(async () => {}), sendCommand } };
	const options = { invoke: async (api: Record<string, (...args: any[]) => unknown>, method: string, ...args: unknown[]) => api[method]!(...args), resolveTab: async () => tab };
	return { tab, frame, root, nodes, chrome, sendCommand, options, automation: createNativeAutomation(chrome, options) };
}
describe("native Chromium accessibility", () => {
	it("refuses ambiguous attributes and their descendants before observations or capture", async () => {
		const { automation, root, nodes, sendCommand } = fixture();
		root.children[0]!.attributes = [...Array.from({ length: 100 }, (_, i) => [`data-extra-${i}`, "x"]).flat(), "data-private", ""];
		const safe = sanitizeNativeAccessibility(root, nodes);
		expect(safe.accessibilityTree.nodes).toEqual([]);
		expect(safe).toMatchObject({ truncated: true, hasSensitive: true });
		await expect(automation.screenshot("tab-first", new AbortController().signal)).rejects.toThrow("ambiguous");
		expect(sendCommand.mock.calls.some(([, method]) => method === "Page.captureScreenshot")).toBe(false);
		root.children[0]!.attributes = ["aria-label", "a".repeat(4_096) + " password"];
		expect(sanitizeNativeAccessibility(root, nodes)).toMatchObject({ truncated: true, hasSensitive: true });
	});
	it("removes private and editable descendants and all AX value/source metadata", () => {
		const { root, nodes } = fixture(); const value = sanitizeNativeAccessibility(root, nodes);
		expect(value.accessibilityTree.nodes.map((node: any) => node.name.value)).toEqual(["Save", "Sensitive field"]);
		expect(JSON.stringify(value)).not.toContain("fixture-"); expect(value.hasSensitive).toBe(true);
	});
	it("allocates new refs across observations and worker replacement, then detaches its debugger", async () => {
		const { automation, chrome, options } = fixture();
		const first = await automation.snapshot("tab-first", new AbortController().signal);
		const second = await createNativeAutomation(chrome, options).snapshot("tab-first", new AbortController().signal);
		expect(first.interactive[0]?.ref).toBe("e1"); expect(second.interactive[0]?.ref).toBe("e201");
		expect(JSON.stringify(first)).not.toContain("url-secret"); expect(chrome.debugger.detach).toHaveBeenCalledTimes(2);
	});
	it("rejects protected pages before attaching", async () => {
		const { automation, tab, chrome } = fixture(); tab.url = "chrome-extension://private/index.html";
		await expect(automation.snapshot("tab-first", new AbortController().signal)).rejects.toThrow("HTTP(S)"); expect(chrome.debugger.attach).not.toHaveBeenCalled();
	});
	it("rejects same-URL navigation during capture and releases the debugger", async () => {
		const { automation, frame, sendCommand, chrome, nodes } = fixture();
		const original = sendCommand.getMockImplementation()!;
		sendCommand.mockImplementation(async (target, method) => { const result = await original(target, method); if (method === "Accessibility.getFullAXTree") frame.documentId = "replacement-document"; return result; });
		await expect(automation.snapshot("tab-first", new AbortController().signal)).rejects.toThrow("document changed");
		expect(chrome.debugger.detach).toHaveBeenCalledOnce(); expect(nodes).toHaveLength(4);
	});
	it("rejects cancellation before attachment and leaves other debuggers attached on attach failure", async () => {
		const { automation, chrome } = fixture(); const controller = new AbortController(); controller.abort();
		await expect(automation.snapshot("tab-first", controller.signal)).rejects.toThrow(); expect(chrome.debugger.attach).not.toHaveBeenCalled();
		chrome.debugger.attach.mockRejectedValueOnce(new Error("Another debugger is attached"));
		await expect(automation.snapshot("tab-first", new AbortController().signal)).rejects.toThrow("Another debugger"); expect(chrome.debugger.detach).not.toHaveBeenCalled();
	});
});


describe("native Chromium actions", () => {
	const signal = () => new AbortController().signal;
	it("clicks exactly the observed backend node using trusted input, then consumes refs", async () => {
		const { automation, sendCommand, chrome } = fixture();
		const snapshot = await automation.snapshot("tab-first", signal());
		await expect(automation.act("tab-first", { type: "click", target: snapshot.interactive[0].ref }, signal())).resolves.toEqual({ performed: true, trust: "untrusted_browser" });
		expect(sendCommand).toHaveBeenCalledWith({ tabId: 3 }, "DOM.resolveNode", { backendNodeId: 3, executionContextId: 17 });
		expect(sendCommand).toHaveBeenCalledWith({ tabId: 3 }, "Input.dispatchMouseEvent", expect.objectContaining({ type: "mousePressed", x: 40, y: 30, buttons: 1 }));
		expect(sendCommand).toHaveBeenCalledWith({ tabId: 3 }, "Input.dispatchMouseEvent", expect.objectContaining({ type: "mouseReleased", buttons: 0 }));
		await expect(automation.act("tab-first", { type: "click", target: snapshot.interactive[0].ref }, signal())).rejects.toThrow("fresh browser snapshot");
		expect(chrome.debugger.detach).toHaveBeenCalledTimes(3);
	});
	it("types into the observed node after focus confirmation without returning input values", async () => {
		const { automation, sendCommand, root, nodes } = fixture();
		root.children[0]!.children[0] = { backendNodeId: 3, nodeName: "INPUT", attributes: ["type", "text"], children: [] };
		nodes[0]!.role.value = "textbox";
		const snapshot = await automation.snapshot("tab-first", signal());
		const result = await automation.act("tab-first", { type: "type", target: snapshot.interactive[0].ref, text: "public fixture input" }, signal());
		expect(sendCommand).toHaveBeenCalledWith({ tabId: 3 }, "DOM.focus", { backendNodeId: 3 });
		expect(sendCommand).toHaveBeenCalledWith({ tabId: 3 }, "Input.insertText", { text: "public fixture input" });
		expect(JSON.stringify(result)).not.toContain("fixture input");
	});
	it("selects only through the immutable isolated-world helper and permits bounded wheel input", async () => {
		const { automation, sendCommand } = fixture();
		let snapshot = await automation.snapshot("tab-first", signal());
		await automation.act("tab-first", { type: "select", target: snapshot.interactive[0].ref, value: "us" }, signal());
		expect(sendCommand).toHaveBeenCalledWith({ tabId: 3 }, "Runtime.callFunctionOn", expect.objectContaining({ objectId: "resolved-node", arguments: [{ value: "select" }, { value: "us" }], returnByValue: true }));
		snapshot = await automation.snapshot("tab-first", signal());
		await automation.act("tab-first", { type: "scroll", x: 0, y: 300 }, signal());
		expect(sendCommand).toHaveBeenCalledWith({ tabId: 3 }, "Input.dispatchMouseEvent", { type: "mouseWheel", x: 400, y: 300, deltaX: 0, deltaY: 300, modifiers: 0 });
	});
	it("rejects stale refs, same-URL replacement documents, unsupported selectors and shortcuts", async () => {
		const { automation, frame, sendCommand } = fixture();
		const old = await automation.snapshot("tab-first", signal());
		await automation.snapshot("tab-first", signal());
		await expect(automation.act("tab-first", { type: "click", target: old.interactive[0].ref }, signal())).rejects.toThrow("stale");
		frame.documentId = "replacement";
		await expect(automation.act("tab-first", { type: "scroll", x: 0, y: 1 }, signal())).rejects.toThrow("stale");
		await expect(automation.act("tab-first", { type: "click", target: "#save" }, signal())).rejects.toThrow("snapshot");
		await expect(automation.act("tab-first", { type: "key", key: "Meta+L" }, signal())).rejects.toThrow("unsupported");
		expect(sendCommand.mock.calls.some(([, method]) => method.startsWith("Input."))).toBe(false);
	});
	it.each(["password", "data-private", "disabled"])("refuses a target changed to %s since observation", async attribute => {
		const { automation, root, sendCommand } = fixture();
		const snapshot = await automation.snapshot("tab-first", signal());
		root.children[0]!.children[0]!.attributes = attribute === "password" ? ["type", "password"] : [attribute, ""];
		await expect(automation.act("tab-first", { type: "click", target: snapshot.interactive[0].ref }, signal())).rejects.toThrow(/sensitive|private|disabled/);
		expect(sendCommand.mock.calls.some(([, method]) => method.startsWith("Input."))).toBe(false);
	});
	it("refuses fresh isolated privacy/focus failure and releases resolved objects", async () => {
		const { automation, sendCommand } = fixture();
		const snapshot = await automation.snapshot("tab-first", signal());
		const original = sendCommand.getMockImplementation()!;
		sendCommand.mockImplementation(async (target, method) => method === "Runtime.callFunctionOn" ? { result: { value: { ok: false, sensitive: true } } } : original(target, method));
		await expect(automation.act("tab-first", { type: "type", target: snapshot.interactive[0].ref, text: "never send" }, signal())).rejects.toThrow("sensitive");
		expect(sendCommand).toHaveBeenCalledWith({ tabId: 3 }, "Runtime.releaseObject", { objectId: "resolved-node" });
		expect(sendCommand.mock.calls.some(([, method]) => method.startsWith("Input."))).toBe(false);
	});
	it("refuses a protected navigation immediately before input and never sends cleanup as an extra click", async () => {
		const { automation, tab, sendCommand } = fixture();
		const snapshot = await automation.snapshot("tab-first", signal());
		const original = sendCommand.getMockImplementation()!;
		sendCommand.mockImplementation(async (target, method) => { const result = await original(target, method); if (method === "Runtime.callFunctionOn") tab.url = "chrome://settings/"; return result; });
		await expect(automation.act("tab-first", { type: "click", target: snapshot.interactive[0].ref }, signal())).rejects.toThrow("document changed");
		expect(sendCommand.mock.calls.some(([, method]) => method.startsWith("Input."))).toBe(false);
	});
	it("releases a stranded mouse press on timeout, detaches, and refuses action replay", async () => {
		const { chrome, options, sendCommand } = fixture();
		const automation = createNativeAutomation(chrome, { ...options, commandTimeoutMs: 15 });
		const snapshot = await automation.snapshot("tab-first", signal());
		const original = sendCommand.getMockImplementation()!;
		sendCommand.mockImplementation(async (target, method, params) => method === "Input.dispatchMouseEvent" && params?.type === "mousePressed" ? new Promise(() => {}) : original(target, method));
		await expect(automation.act("tab-first", { type: "click", target: snapshot.interactive[0].ref }, signal())).rejects.toThrow("timed out");
		expect(sendCommand).toHaveBeenCalledWith({ tabId: 3 }, "Input.dispatchMouseEvent", expect.objectContaining({ type: "mouseReleased" }));
		expect(chrome.debugger.detach).toHaveBeenCalledTimes(2);
		await expect(automation.act("tab-first", { type: "click", target: snapshot.interactive[0].ref }, signal())).rejects.toThrow("Another native operation");
	});
	it("cleans up a cancelled key-down with one key-up and no replay", async () => {
		const { automation, chrome, sendCommand } = fixture();
		await automation.snapshot("tab-first", signal());
		const original = sendCommand.getMockImplementation()!; const controller = new AbortController();
		sendCommand.mockImplementation(async (target, method, params) => {
			if (method === "Runtime.callFunctionOn" && params?.returnByValue === false) return { result: { objectId: "active-node" } };
			if (method === "Runtime.callFunctionOn" && params?.functionDeclaration?.includes("activeElement ===")) return { result: { value: true } };
			if (method === "DOM.describeNode") return { node: { backendNodeId: 3 } };
			if (method === "Input.dispatchKeyEvent" && params?.type === "keyDown") { controller.abort(new Error("cancelled input")); return {}; }
			return original(target, method);
		});
		await expect(automation.act("tab-first", { type: "key", key: "Enter" }, controller.signal)).rejects.toThrow("cancelled input");
		expect(sendCommand).toHaveBeenCalledWith({ tabId: 3 }, "Input.dispatchKeyEvent", expect.objectContaining({ type: "keyUp", key: "Enter" }));
		expect(sendCommand.mock.calls.filter(([, method, params]) => method === "Input.dispatchKeyEvent" && params?.type === "keyDown")).toHaveLength(1);
		expect(chrome.debugger.detach).toHaveBeenCalledTimes(2);
	});
	it("bounds attachment and detaches a late successful attach without stealing another debugger", async () => {
		const { chrome, options } = fixture(); let finish!: () => void;
		chrome.debugger.attach.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
		const automation = createNativeAutomation(chrome, { ...options, commandTimeoutMs: 10 });
		await expect(automation.snapshot("tab-first", signal())).rejects.toThrow("timed out");
		expect(chrome.debugger.detach).not.toHaveBeenCalled(); finish(); await new Promise(resolve => setTimeout(resolve, 0));
		expect(chrome.debugger.detach).toHaveBeenCalledOnce();
	});
	it("refuses screenshots when editable or private content can be visible", async () => {
		const { automation, sendCommand } = fixture();
		await expect(automation.screenshot("tab-first", signal())).rejects.toThrow("private, editable");
		expect(sendCommand.mock.calls.some(([, method]) => method === "Page.captureScreenshot")).toBe(false);
	});
	it("returns only a bounded validated PNG frame and refuses malformed dimensions", async () => {
		const { automation, root, sendCommand } = fixture();
		root.children[0]!.children = [root.children[0]!.children[0]!];
		const original = sendCommand.getMockImplementation()!;
		const header = Buffer.alloc(33); header.writeUInt32BE(0x89504e47, 0); header.writeUInt32BE(0x0d0a1a0a, 4); header.writeUInt32BE(13, 8); header.write("IHDR", 12); header.writeUInt32BE(800, 16); header.writeUInt32BE(600, 20);
		sendCommand.mockImplementation(async (target, method) => method === "Page.captureScreenshot" ? { data: header.toString("base64") } : original(target, method));
		await expect(automation.screenshot("tab-first", signal())).resolves.toEqual({ version: 1, encoding: "png", pngBase64: header.toString("base64"), width: 800, height: 600, trust: "untrusted_browser" });
		header.writeUInt32BE(801, 16);
		await expect(automation.screenshot("tab-first", signal())).rejects.toThrow("dimensions");
	});
});


describe("native action freshness boundaries", () => {
	it("refuses a node whose visible control identity changed", async () => {
		const { automation, nodes, sendCommand } = fixture(); const signal = new AbortController().signal;
		const snapshot = await automation.snapshot("tab-first", signal); nodes[0]!.name.value = "Delete account";
		await expect(automation.act("tab-first", { type: "click", target: snapshot.interactive[0].ref }, signal)).rejects.toThrow("control changed");
		expect(sendCommand.mock.calls.some(([, method]) => method.startsWith("Input."))).toBe(false);
	});
	it("expires observations after thirty seconds without dispatching input", async () => {
		const { automation, sendCommand } = fixture(); const signal = new AbortController().signal;
		const snapshot = await automation.snapshot("tab-first", signal);
		const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30_001);
		try { await expect(automation.act("tab-first", { type: "click", target: snapshot.interactive[0].ref }, signal)).rejects.toThrow("stale"); }
		finally { now.mockRestore(); }
		expect(sendCommand.mock.calls.some(([, method]) => method.startsWith("Input."))).toBe(false);
	});
	it("refuses an embedded cross-origin document in screenshots", async () => {
		const { automation, root, sendCommand } = fixture(); const signal = new AbortController().signal;
		root.children[0]!.children = [{ backendNodeId: 10, nodeName: "IFRAME", children: [] }];
		await expect(automation.screenshot("tab-first", signal)).rejects.toThrow("ambiguous");
		expect(sendCommand.mock.calls.some(([, method]) => method === "Page.captureScreenshot")).toBe(false);
	});
});


describe("native snapshot ref aliases", () => {
	it.each(["@", "ref="])("normalizes %s refs to the exact observed backend target", async prefix => {
		const { automation, sendCommand } = fixture(); const signal = new AbortController().signal;
		const snapshot = await automation.snapshot("tab-first", signal);
		await automation.act("tab-first", { type: "click", target: `${prefix}${snapshot.interactive[0].ref}` }, signal);
		expect(sendCommand).toHaveBeenCalledWith({ tabId: 3 }, "DOM.resolveNode", { backendNodeId: 3, executionContextId: 17 });
		expect(sendCommand.mock.calls.filter(([, method, params]) => method === "Input.dispatchMouseEvent" && params?.type === "mousePressed")).toHaveLength(1);
		await expect(automation.act("tab-first", { type: "click", target: `${prefix}${snapshot.interactive[0].ref}` }, signal)).rejects.toThrow("fresh browser snapshot");
	});
});
