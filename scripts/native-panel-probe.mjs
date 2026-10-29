import assert from "node:assert/strict";

// CEF reports its Chrome side panel as an "other" target, outside Playwright's
// Page inventory. Read that exact disposable candidate target for visible UI
// assertions; never discover another browser or use a normal user's profile.
export async function nativePanelProbe(endpoint, extensionOrigin) {
	const address = new URL(endpoint); assert.equal(address.hostname, "127.0.0.1");
	const targets = await (await fetch(`http://127.0.0.1:${address.port}/json/list`)).json();
	const target = targets.find(target => target.url === `${extensionOrigin}/index.html?surface=panel`);
	assert(target?.webSocketDebuggerUrl, "The actual native Kestrel companion target is missing.");
	assert.equal(new URL(target.webSocketDebuggerUrl).host, address.host);
	const socket = new WebSocket(target.webSocketDebuggerUrl); let sequence = 0; const pending = new Map();
	await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
	socket.addEventListener("message", event => {
		const value = JSON.parse(event.data); const request = pending.get(value.id); if (!request) return;
		pending.delete(value.id); clearTimeout(request.timer);
		if (value.error) request.reject(new Error(value.error.message)); else request.resolve(value.result);
	});
	socket.addEventListener("close", () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Native companion target closed.")); } pending.clear(); });
	function send(method, params) {
		return new Promise((resolve, reject) => {
			const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error("Native companion observation timed out.")); }, 10_000);
			pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
		});
	}
	return {
		id: target.id,
		async text() { const result = await send("Runtime.evaluate", { expression: "document.body.innerText", returnByValue: true }); return result.result.value; },
		async screenshot() { const result = await send("Page.captureScreenshot", { format: "png" }); return Buffer.from(result.data, "base64"); },
		close() { socket.close(); },
	};
}
