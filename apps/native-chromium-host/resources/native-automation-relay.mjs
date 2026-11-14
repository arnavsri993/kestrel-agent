// Core-only isolated browser transport. The owner is the private parent process;
// no renderer or native-messaging socket may submit requests or responses here.
export function createNativeAutomationRelay({ validate, isUserRequest, writeOwner, writeCore }) {
  const pending = new Map();
  const byRequestId = new Map();
  let sequence = 0;
  let closed = false;
  let resetPending;
  let resetRequired = false;
  const maxBytes = 1024 * 1024;
  const validId = id => typeof id === "string" && id.length > 0 && id.length <= 200;
  const respond = (requestId, response) => writeCore({ type: "browser-backend-response", requestId, ...response });
  const send = message => {
    try {
      const frame = JSON.stringify(message);
      if (Buffer.byteLength(frame, "utf8") + 1 > maxBytes) return false;
      return writeOwner(frame) === true;
    } catch { return false; }
  };
  function take(id) {
    const request = pending.get(id);
    if (!request) return undefined;
    pending.delete(id); byRequestId.delete(request.requestId); clearTimeout(request.timer);
    return request;
  }
  function request(message) {
    if (!validId(message?.requestId)) return;
    const requestId = message.requestId;
    const previous = byRequestId.get(requestId);
    if (previous) {
      take(previous); send({ kind: "automation-cancel", id: previous });
      respond(requestId, { ok: false, error: "Duplicate native automation request was cancelled." });
      return;
    }
    let parsed;
    try { parsed = validate(message.request); } catch { parsed = { success: false }; }
    if (closed || resetRequired || !parsed.success || isUserRequest(parsed.data) || pending.size >= 16 || sequence >= Number.MAX_SAFE_INTEGER) {
      respond(requestId, { ok: false, error: "Native automation is unavailable or the request is invalid." }); return;
    }
    const id = `automation-${++sequence}`;
    const timer = setTimeout(() => {
      const item = take(id); if (!item) return;
      send({ kind: "automation-cancel", id });
      respond(item.requestId, { ok: false, error: "Native automation timed out. Check the outcome before retrying." });
    }, 30_000);
    pending.set(id, { requestId, timer }); byRequestId.set(requestId, id);
    if (!send({ kind: "automation-request", id, request: parsed.data })) {
      const item = take(id);
      if (item) respond(item.requestId, { ok: false, error: "Native automation owner is unavailable. Check the outcome before retrying." });
    }
  }
  function response(message) {
    if (!message || message.kind !== "automation-response" || typeof message.id !== "string" || !pending.has(message.id)) return;
    const item = take(message.id);
    let bounded = false;
    try { bounded = Buffer.byteLength(JSON.stringify(message), "utf8") + 1 <= maxBytes; } catch { /* Invalid frame. */ }
    if (!bounded) {
      respond(item.requestId, { ok: false, error: "Native automation owner returned an oversized response." }); return;
    }
    if (message.ok === true && Object.hasOwn(message, "result")) {
      respond(item.requestId, { ok: true, result: message.result });
    } else if (message.ok === false && typeof message.error === "string" && message.error.length) {
      respond(item.requestId, { ok: false, error: message.error.slice(0, 500) });
    } else respond(item.requestId, { ok: false, error: "Native automation owner returned an invalid response." });
  }
  function cancel(requestId) {
    const id = byRequestId.get(requestId);
    const item = id && take(id);
    if (!item) return;
    send({ kind: "automation-cancel", id });
    respond(item.requestId, { ok: false, error: "Native automation was cancelled. Check the outcome before retrying." });
  }
  function reset() {
    if (closed || resetPending || sequence >= Number.MAX_SAFE_INTEGER) return Promise.reject(new Error("Native automation reset is unavailable."));
    // Once reset is requested, keep dispatch blocked even on failure: an old
    // session may still exist until a later explicit reset succeeds.
    resetRequired = true;
    for (const id of [...pending.keys()]) {
      const item = take(id);
      send({ kind: "automation-cancel", id });
      respond(item.requestId, { ok: false, error: "Native automation was interrupted by reset. Check the outcome before retrying." });
    }
    if (closed) return Promise.reject(new Error("Native automation owner disconnected."));
    const id = `automation-${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!resetPending || resetPending.id !== id) return;
        resetPending = undefined;
        reject(new Error("Native automation reset timed out."));
      }, 10_000);
      resetPending = { id, timer, resolve, reject };
      if (!send({ kind: "automation-reset", id })) {
        clearTimeout(timer);
        resetPending = undefined;
        reject(new Error("Native automation reset could not reach its owner."));
      }
    });
  }
  function resetResponse(message) {
    if (!message || message.kind !== "automation-reset-response" || !resetPending || message.id !== resetPending.id) return;
    const current = resetPending;
    resetPending = undefined; clearTimeout(current.timer);
    if (message.ok === true) { resetRequired = false; current.resolve(); }
    else current.reject(new Error("Native automation reset failed."));
  }
  function close() {
    if (closed) return;
    closed = true;
    if (resetPending) {
      const current = resetPending; resetPending = undefined; clearTimeout(current.timer);
      current.reject(new Error("Native automation owner disconnected during reset."));
    }
    for (const id of [...pending.keys()]) {
      const item = take(id);
      send({ kind: "automation-cancel", id });
      respond(item.requestId, { ok: false, error: "Native automation owner disconnected. Check the outcome before retrying." });
    }
  }
  return { request, response, cancel, reset, resetResponse, close };
}
