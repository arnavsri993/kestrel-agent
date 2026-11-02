import { NATIVE_PLUGIN_REQUEST_TYPES } from "../../../desktop/src/main/native-plugin-requests.ts";
// Each renderer port owns only its own plugin request cancellation signals.
export function createPluginPortScope() {
 const active = new Set(); let closed = false;
 return {
  begin(request) {
   if (!NATIVE_PLUGIN_REQUEST_TYPES.has(request.type)) return { signal: undefined, done() {} };
   const controller = new AbortController();
   if (closed) controller.abort(); else active.add(controller);
   return { signal: controller.signal, done() { active.delete(controller); } };
  },
  close() { if (closed) return; closed = true; for (const controller of active) controller.abort(); active.clear(); },
 };
}
