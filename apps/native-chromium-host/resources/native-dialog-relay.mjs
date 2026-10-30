import { isAbsolute } from "node:path";

// Only the Core sideband can initiate a picker. Native renderer messages never
// receive a direct dispatch path to this relay or its private parent responses.
export function createNativeDialogRelay({ writeOwner, writeCore }) {
  let pending;
  let sequence = 0;
  let lastCoreSequence = 0;
  let closed = false;
  const MAX_FRAME = 1024 * 1024;
  const failed = "The native file or folder picker is unavailable.";
  const validPath = path => typeof path === "string" && path.length > 0 && path.length <= 4096 && isAbsolute(path) && !/[\u0000-\u001f\u007f]/.test(path);
  function send(message) {
    try {
      const line = JSON.stringify(message);
      return Buffer.byteLength(line, "utf8") + 1 <= MAX_FRAME && writeOwner(line) === true;
    } catch { return false; }
  }
  function respond(requestId, response) { writeCore({ type: "native-dialog-response", requestId, response }); }
  function take() {
    const item = pending;
    if (item) { pending = undefined; clearTimeout(item.timer); }
    return item;
  }
  function request(message) {
    const id = message?.requestId;
    const match = typeof id === "string" && id.length <= 100 && /^native-dialog-([1-9][0-9]{0,15})$/.exec(id);
    if (!match) return;
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number) || number <= lastCoreSequence) {
      // A duplicate must not resolve the original request with a different
      // selection. Stop the old panel and settle the shared id once.
      if (pending?.requestId === id) { const old = take(); send({ kind: "dialog-cancel", id: old.id }); }
      respond(id, { ok: false, error: failed }); return;
    }
    lastCoreSequence = number;
    const folder = message.operation === "select-workspace-folder";
    const files = message.operation === "select-context-files";
    const allowedKeys = folder ? ["type", "requestId", "operation"] : ["type", "requestId", "operation", "workspaceRoot"];
    if (closed || pending || sequence >= Number.MAX_SAFE_INTEGER || message.type !== "native-dialog-request" ||
        (!folder && !files) || (files && !validPath(message.workspaceRoot)) || Object.keys(message).some(key => !allowedKeys.includes(key))) {
      respond(id, { ok: false, error: failed }); return;
    }
    const privateId = `dialog-${++sequence}`;
    const timer = setTimeout(() => {
      const item = take(); if (!item) return;
      send({ kind: "dialog-cancel", id: item.id });
      respond(item.requestId, { ok: false, error: "The native file or folder picker timed out." });
    }, 10 * 60_000);
    pending = { id: privateId, requestId: id, operation: message.operation, timer };
    const request = folder ? { type: "select-workspace-folder" } : { type: "select-context-files", workspaceRoot: message.workspaceRoot };
    if (!send({ kind: "host-request", id: privateId, request })) {
      const item = take(); if (item) respond(item.requestId, { ok: false, error: failed });
    }
  }
  function response(message) {
    if (!message || message.kind !== "host-response" || !pending || message.id !== pending.id) return false;
    const item = take();
    const value = message.response;
    const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
    if (Object.keys(message).some(key => !["kind", "id", "response"].includes(key))) {
      respond(item.requestId, { ok: false, error: failed });
    } else if (value?.ok === true && value.cancelled === true && keys.length === 2 && keys.includes("ok") && keys.includes("cancelled")) {
      respond(item.requestId, { ok: true, cancelled: true });
    } else if (item.operation === "select-workspace-folder" && value?.ok === true && validPath(value.selectedWorkspacePath) &&
        keys.length === 2 && keys.includes("ok") && keys.includes("selectedWorkspacePath")) {
      respond(item.requestId, { ok: true, selectedWorkspacePath: value.selectedWorkspacePath });
    } else if (item.operation === "select-context-files" && value?.ok === true && Array.isArray(value.selectedContextPaths) &&
        value.selectedContextPaths.length > 0 && value.selectedContextPaths.length <= 8 && value.selectedContextPaths.every(validPath) &&
        new Set(value.selectedContextPaths).size === value.selectedContextPaths.length &&
        keys.length === 2 && keys.includes("ok") && keys.includes("selectedContextPaths")) {
      respond(item.requestId, { ok: true, selectedContextPaths: [...value.selectedContextPaths] });
    } else respond(item.requestId, { ok: false, error: failed });
    return true;
  }
  function cancel(requestId) {
    if (!pending || pending.requestId !== requestId) return;
    const item = take(); send({ kind: "dialog-cancel", id: item.id });
    respond(item.requestId, { ok: false, error: "The native file or folder picker was cancelled." });
  }
  function close() {
    if (closed) return;
    closed = true;
    if (pending) {
      const item = take(); send({ kind: "dialog-cancel", id: item.id });
      respond(item.requestId, { ok: false, error: failed });
    }
  }
  return { request, response, cancel, close };
}
