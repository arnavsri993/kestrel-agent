// This relay accepts requests from Core only. First-party renderer messages
// cannot manufacture backend responses or invoke this private dispatch path.
export function createNativeBrowserRelay({ validate, writeCore, send, currentOwner }) {
	const pending = new Map();
	let sequence = 0;
	const respond = (requestId, response) => writeCore({ type: "browser-backend-response", requestId, ...response });
	function request(message) {
		const parsed = validate(message.request);
		const owner = currentOwner();
		if (typeof message.requestId !== "string" || !message.requestId || message.requestId.length > 200) return;
		if (!parsed.success || !owner || pending.size >= 16) {
			respond(message.requestId, { ok: false, error: "Kestrel's native browser connection is unavailable or the request is invalid." });
			return;
		}
		const id = `core-browser-${++sequence}`;
		const timeout = setTimeout(() => {
			pending.delete(id);
			send(owner, { kind: "browser-backend-cancel", id });
			respond(message.requestId, { ok: false, error: "Native browser request timed out. Its outcome must be checked before retrying." });
		}, 30_000);
		pending.set(id, { owner, requestId: message.requestId, timeout });
		send(owner, { kind: "browser-backend-request", id, request: parsed.data });
	}
	function response(owner, message) {
		const request = pending.get(message.id);
		if (!request || request.owner !== owner) return;
		pending.delete(message.id);
		clearTimeout(request.timeout);
		respond(request.requestId, message.ok === true ? { ok: true, result: message.result } : {
			ok: false, error: typeof message.error === "string" ? message.error.slice(0, 500) : "Native browser request failed.",
		});
	}
	function cancel(requestId) {
		for (const [id, request] of pending) if (request.requestId === requestId) {
			pending.delete(id);
			clearTimeout(request.timeout);
			send(request.owner, { kind: "browser-backend-cancel", id });
		}
	}
	function disconnect(owner) {
		for (const [id, request] of pending) if (request.owner === owner) {
			pending.delete(id);
			clearTimeout(request.timeout);
			respond(request.requestId, { ok: false, error: "The native browser disconnected. Its outcome must be checked before retrying." });
		}
	}
	return { request, response, cancel, disconnect };
}
