import assert from "node:assert/strict";

export const storeActionId = "ddkjiahejlhfcafbddmgiahcphecmpfh";

export function parseStoreVersion(value) {
  assert(typeof value === "string" && /^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}$/.test(value), "Store versions must use normalized Chrome version numbers.");
  const parts = value.split(".").map(Number);
  assert(parts.every(part => part <= 65535) && parts.some(part => part > 0), "Store version is outside Chrome's supported range.");
  return parts;
}
export function storeVersionIsNewer(left, right) {
  const a = parseStoreVersion(left), b = parseStoreVersion(right);
  for (let index = 0; index < 4; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}
// Chromium grants an extension access only to its own update channel.
export function storeActionUpgrade(check, before, installed) {
  return check?.extensionId === storeActionId && check.status === "update_available" &&
    check.checkSucceeded === true && installed?.id === storeActionId && installed.enabled === true &&
    installed.installType === "normal" && installed.version === check.reportedVersion &&
    storeVersionIsNewer(installed.version, before);
}
