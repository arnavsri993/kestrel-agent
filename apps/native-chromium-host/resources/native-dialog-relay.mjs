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
    const folder = ["select-workspace-folder", "select-plugin-bundle"].includes(message.operation);
    const publisher = message.operation === "select-plugin-publisher";
    const files = message.operation === "select-context-files";
    const backupFolder = message.operation === "select-local-backup-folder";
    const revealBackupFolder = message.operation === "reveal-local-backup-folder";
    const recovery = ["save-memory-recovery-file", "open-memory-recovery-file"].includes(message.operation);
    const diagnostic = message.operation === "save-diagnostic-report";
    const allowedKeys = files ? ["type", "requestId", "operation", "workspaceRoot"]
      : revealBackupFolder ? ["type", "requestId", "operation", "backupPath"]
        : ["type", "requestId", "operation"];
    if (closed || pending || sequence >= Number.MAX_SAFE_INTEGER || message.type !== "native-dialog-request" ||
        (!folder && !files && !publisher && !backupFolder && !revealBackupFolder && !recovery && !diagnostic) ||
        (files && !validPath(message.workspaceRoot)) || (revealBackupFolder && !validPath(message.backupPath)) ||
        Object.keys(message).some(key => !allowedKeys.includes(key))) {
      respond(id, { ok: false, error: failed }); return;
    }
    const privateId = `dialog-${++sequence}`;
    const timer = setTimeout(() => {
      const item = take(); if (!item) return;
      send({ kind: "dialog-cancel", id: item.id });
      respond(item.requestId, { ok: false, error: "The native file or folder picker timed out." });
    }, 10 * 60_000);
    pending = { id: privateId, requestId: id, operation: message.operation, timer };
    const request = files ? { type: "select-context-files", workspaceRoot: message.workspaceRoot }
      : revealBackupFolder ? { type: "reveal-local-backup-folder", backupPath: message.backupPath }
        : { type: message.operation };
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
    } else if (["select-workspace-folder", "select-plugin-bundle"].includes(item.operation) && value?.ok === true && validPath(value.selectedWorkspacePath) &&
        keys.length === 2 && keys.includes("ok") && keys.includes("selectedWorkspacePath")) {
      respond(item.requestId, { ok: true, selectedWorkspacePath: value.selectedWorkspacePath });
    } else if (item.operation === "select-local-backup-folder" && value?.ok === true &&
        (value.selectedBackupPath === null || validPath(value.selectedBackupPath)) &&
        keys.length === 2 && keys.includes("ok") && keys.includes("selectedBackupPath")) {
      respond(item.requestId, { ok: true, selectedBackupPath: value.selectedBackupPath });
    } else if (item.operation === "reveal-local-backup-folder" && value?.ok === true && value.revealed === true &&
        keys.length === 2 && keys.includes("ok") && keys.includes("revealed")) {
      respond(item.requestId, { ok: true, revealed: true });
    } else if (["save-memory-recovery-file", "open-memory-recovery-file"].includes(item.operation) && value?.ok === true && validPath(value.selectedRecoveryPath) &&
        keys.length === 2 && keys.includes("ok") && keys.includes("selectedRecoveryPath")) {
      respond(item.requestId, { ok: true, selectedRecoveryPath: value.selectedRecoveryPath });
    } else if (item.operation === "save-diagnostic-report" && value?.ok === true && validPath(value.selectedDiagnosticPath) &&
        keys.length === 2 && keys.includes("ok") && keys.includes("selectedDiagnosticPath")) {
      respond(item.requestId, { ok: true, selectedDiagnosticPath: value.selectedDiagnosticPath });
    } else if (["select-context-files", "select-plugin-publisher"].includes(item.operation) && value?.ok === true && Array.isArray(value.selectedContextPaths) &&
        value.selectedContextPaths.length > 0 && value.selectedContextPaths.length <= (item.operation === "select-plugin-publisher" ? 1 : 8) && value.selectedContextPaths.every(validPath) &&
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
