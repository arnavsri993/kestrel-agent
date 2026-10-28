import { createBrowserAdapter } from "./browser.mjs";
import { createNativeConnection } from "./native-connection.mjs";
import { trackNativePanels } from "./panel-state.mjs";
import { RendererRequestSchema } from "../../../../packages/shared-types/src/contracts.ts";

const ui = new Set();
const origin = new URL(chrome.runtime.getURL(""));
const emit = (channel, event) => { for (const port of ui) { try { port.postMessage({ kind: "event", channel, event }); } catch { ui.delete(port); } } };
const browser = createBrowserAdapter(chrome, { emit, uiUrl: chrome.runtime.getURL("index.html") });
const core = createNativeConnection({ runtime: chrome.runtime, emit });
trackNativePanels(chrome);
// Register synchronously so a cold startup wakes Chromium's existing worker.
chrome.runtime.onStartup.addListener(() => core.reconnect());
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
chrome.runtime.onConnect.addListener((port) => {
	const sender = port.sender;
	let url;
	try { url = new URL(sender?.url); } catch { port.disconnect(); return; }
	if (port.name !== "kestrel-ui" || sender.id !== chrome.runtime.id || url.protocol !== origin.protocol || url.host !== origin.host || url.pathname !== "/index.html" || (sender.frameId !== undefined && sender.frameId !== 0)) { port.disconnect(); return; }
	ui.add(port);
	port.onDisconnect.addListener(() => ui.delete(port));
	let count = 0;
	port.onMessage.addListener(async (message) => {
		if (message?.kind !== "request" || !Number.isSafeInteger(message.id) || ++count > 64 || JSON.stringify(message).length > 768 * 1024) { port.disconnect(); return; }
		let response;
		try {
			const parsed = RendererRequestSchema.safeParse(message.request);
			if (!parsed.success) throw new Error("Invalid Kestrel request.");
			response = browser.handles(parsed.data.type) ? await browser.request(parsed.data, sender) : await core.request(parsed.data);
		}
		catch (error) { response = { ok: false, error: error instanceof Error ? error.message : "Kestrel could not complete this request." }; }
		finally { --count; }
		try { port.postMessage({ kind: "response", id: message.id, response }); } catch { ui.delete(port); }
	});
});
