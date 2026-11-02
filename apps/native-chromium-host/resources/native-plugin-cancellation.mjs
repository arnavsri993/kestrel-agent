// A lost renderer must cancel only its own in-flight native plugin mutation.
// Agent tasks and unrelated host operations retain their existing lifecycle.
export function cancelPluginOnClientLoss(id, request, writeCore) {
  if (request?.plugin === true && typeof id === "string" && /^ui-[1-9][0-9]*$/.test(id)) {
    writeCore({ type: "host-cancel", id });
    return true;
  }
  return false;
}
export function cancelPluginByUiRequest(pending, socket, uiId, writeCore) {
  if (typeof uiId !== "string" || !/^native-[1-9][0-9]*$/.test(uiId)) return false;
  for (const [id, request] of pending) {
    if (request.socket === socket && request.uiId === uiId && request.plugin === true)
      return cancelPluginOnClientLoss(id, request, writeCore);
  }
  return false;
}
