import { NATIVE_PLUGIN_REQUEST_TYPES } from "../../../desktop/src/main/native-plugin-requests.ts";
import { NATIVE_MEMORY_RECOVERY_REQUEST_TYPES } from "../../../desktop/src/main/native-memory-recovery-requests.ts";
import { NATIVE_DIAGNOSTIC_REQUEST_TYPES } from "../../../desktop/src/main/native-diagnostic-requests.ts";
import { NATIVE_LOCAL_BACKUP_REQUEST_TYPES } from "../../../desktop/src/main/native-local-backup-requests.ts";
import { NATIVE_PROVIDER_OPERATION_REQUEST_TYPES } from "../../../desktop/src/main/native-provider-operation-requests.ts";
export function isNativeFileRequest(type) {
 return NATIVE_MEMORY_RECOVERY_REQUEST_TYPES.has(type) || NATIVE_DIAGNOSTIC_REQUEST_TYPES.has(type) || NATIVE_LOCAL_BACKUP_REQUEST_TYPES.has(type);
}
export function isNativeCancellableRequest(type) {
 return NATIVE_PLUGIN_REQUEST_TYPES.has(type) || isNativeFileRequest(type) || NATIVE_PROVIDER_OPERATION_REQUEST_TYPES.has(type);
}
// Each renderer port owns only its own plugin and file requests.
export function createNativeRequestScope() {
 const active = new Set(); let closed = false;
 return {
  begin(request) {
   if (!isNativeCancellableRequest(request.type)) return { signal: undefined, done() {} };
   const controller = new AbortController();
   if (closed) controller.abort(); else active.add(controller);
   return { signal: controller.signal, done() { active.delete(controller); } };
  },
  close() { if (closed) return; closed = true; for (const controller of active) controller.abort(); active.clear(); },
 };
}
