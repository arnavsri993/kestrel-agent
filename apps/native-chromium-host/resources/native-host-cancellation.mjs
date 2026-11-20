// A lost renderer cancels only its own explicitly cancellable host operation.
// Agent tasks and unrelated host operations retain their existing lifecycle.
export function cancelNativeHostOnClientLoss(id, request, writeCore) {
  if (request?.cancellable === true && typeof id === "string" && /^ui-[1-9][0-9]*$/.test(id)) {
    writeCore({ type: "host-cancel", id });
    return true;
  }
  return false;
}
export function cancelNativeHostByUiRequest(pending, socket, uiId, writeCore) {
  if (typeof uiId !== "string" || !/^native-[1-9][0-9]*$/.test(uiId)) return false;
  for (const [id, request] of pending) {
    if (request.socket === socket && request.uiId === uiId && request.cancellable === true)
      return cancelNativeHostOnClientLoss(id, request, writeCore);
  }
  return false;
}
