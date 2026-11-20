// Only the private native desktop host can enter this path. Renderer requests
// cannot manufacture field authority or submit arbitrary codes for insertion.
export function createNativeLoginCodeRelay({ validate, validateResult, writeCore, send, currentOwner }) {
	const pending = new Map();
	let sequence = 0;
	const fail = requestId => writeCore({ type: "native-login-code-response", requestId, ok: false, error: "The verification field is unavailable. Check the page before retrying." });
	function request(message) {
		if (typeof message.requestId !== "string" || !/^native-login-code-[1-9][0-9]{0,15}$/.test(message.requestId)) return;
		const parsed = validate(message.request), owner = currentOwner();
		if (!parsed.success || !owner || pending.size >= 16 || [...pending.values()].some(value => value.requestId === message.requestId)) { fail(message.requestId); return; }
		const id = `login-code-${++sequence}`;
		const timeout = setTimeout(() => {
			pending.delete(id); send(owner, { kind: "native-login-code-cancel", id }); fail(message.requestId);
		}, 15_000);
		timeout.unref?.();
		pending.set(id, { owner, requestId: message.requestId, operation: parsed.data.operation, timeout });
		send(owner, { kind: "native-login-code-request", id, request: parsed.data });
	}
	function response(owner, message) {
		const request = pending.get(message.id);
		if (!request || request.owner !== owner) return;
		pending.delete(message.id); clearTimeout(request.timeout);
		const result = message.ok === true ? validateResult(request.operation, message.result) : { success: false };
		if (result.success) writeCore({ type: "native-login-code-response", requestId: request.requestId, ok: true, result: result.data });
		else fail(request.requestId);
	}
	function cancel(requestId) {
		for (const [id, request] of pending) if (request.requestId === requestId) {
			pending.delete(id); clearTimeout(request.timeout); send(request.owner, { kind: "native-login-code-cancel", id });
		}
	}
	function disconnect(owner) {
		for (const [id, request] of pending) if (request.owner === owner) {
			pending.delete(id); clearTimeout(request.timeout); fail(request.requestId);
		}
	}
	return { request, response, cancel, disconnect };
}
