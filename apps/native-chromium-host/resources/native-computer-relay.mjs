const OPERATIONS = new Set([
	"native-computer-permissions",
	"native-computer-capture",
	"native-computer-context",
	"native-computer-act",
	"native-computer-open-settings",
]);
const validId = value => typeof value === "string" && /^native-computer-[0-9]{1,20}$/.test(value);

// Private Core <-> Chromium owner channel. This deliberately does not reuse
// BrowserBackendWire or the authenticated web renderer's request surface.
export function createNativeComputerRelay({ writeCore, writeOwner }) {
	const pending = new Set();
	let closed = false;
	function request(message) {
		const id = message?.requestId;
		const operation = message?.request?.operation;
		let bytes = Infinity;
		try { bytes = Buffer.byteLength(JSON.stringify(message.request), "utf8"); } catch { /* invalid */ }
		if (closed || !validId(id) || !message.request || !OPERATIONS.has(operation) || bytes > 700_000 || pending.has(id) || pending.size >= 4) {
			if (validId(id)) writeCore({ type: "native-computer-response", requestId: id, ok: false, error: "Native desktop request was invalid or unavailable." });
			return false;
		}
		pending.add(id);
		if (writeOwner({ kind: "native-computer-request", id, request: message.request }) !== true) {
			pending.delete(id);
			writeCore({ type: "native-computer-response", requestId: id, ok: false, error: "Native desktop owner is unavailable." });
			return false;
		}
		return true;
	}
	function cancel(message) {
		const id = message?.requestId;
		if (!validId(id) || !pending.delete(id)) return false;
		writeOwner({ kind: "native-computer-cancel", id });
		return true;
	}
	function response(message) {
		const id = message?.id;
		if (closed || !validId(id) || !pending.delete(id)) return false;
		let bounded = false;
		try { bounded = Buffer.byteLength(JSON.stringify(message), "utf8") <= 1_048_000; } catch { /* invalid */ }
		const ok = bounded && message.ok === true && Object.hasOwn(message, "result");
		const error = bounded && message.ok === false && typeof message.error === "string"
			? message.error.slice(0, 500)
			: "Native desktop owner returned an invalid response.";
		writeCore(ok
			? { type: "native-computer-response", requestId: id, ok: true, result: message.result }
			: { type: "native-computer-response", requestId: id, ok: false, error });
		return true;
	}
	function close() { closed = true; for (const id of pending) writeOwner({ kind: "native-computer-cancel", id }); pending.clear(); }
	return { request, cancel, response, close, get pendingCount() { return pending.size; } };
}
