import { setTimeout as delay } from "node:timers/promises";

const protocolDiagnostics = new WeakMap();
const methods = new Set(["Target.getTargets", "Target.attachToTarget", "Target.detachFromTarget", "Runtime.evaluate", "Browser.getBrowserCommandLine"]);
const transientMethods = new Set(["Target.attachToTarget", "Runtime.evaluate"]);

// Keep protocol text and payloads out of errors and receipts. Only exact known
// lifecycle failures, on the relevant method and code, authorize a read retry.
export function browserStorageProtocolError(method, response) {
 const safeMethod = methods.has(method) ? method : "other";
 const code = Number.isSafeInteger(response?.code) ? response.code : null;
 let reason = "other";
 if (safeMethod === "Target.attachToTarget" && code === -32602 && response?.message === "No target with given id found") reason = "target-gone";
 if (safeMethod === "Runtime.evaluate" && code === -32001 && response?.message === "Session with given id not found.") reason = "session-gone";
 if (safeMethod === "Runtime.evaluate" && code === -32000 && ["Execution context was destroyed.", "Cannot find context with specified id"].includes(response?.message)) reason = "context-destroyed";
 const error = Error("CDP command failed.");
 protocolDiagnostics.set(error, Object.freeze({ method: safeMethod, code, reason }));
 return error;
}

export function browserStorageProtocolDiagnostic(error) {
 const diagnostic = protocolDiagnostics.get(error);
 return diagnostic ? { ...diagnostic } : undefined;
}

export function recordBrowserStorageDiagnostic(diagnostics, error) {
 const diagnostic = browserStorageProtocolDiagnostic(error);
 if (diagnostic && diagnostics.length < 32) diagnostics.push(diagnostic);
}

export async function waitForBrowserStorageHome({ send, evaluateHome, homeUrl, checkInterrupt = () => {}, onOperation = () => {}, now = Date.now, sleep = delay, timeout = 30000 }) {
 if (!/^chrome-extension:\/\/[a-p]{32}\/index\.html$/.test(homeUrl)) throw Error("Invalid first-party Home URL.");
 const deadline = now() + timeout;
 while (now() < deadline) {
  checkInterrupt();
  onOperation("enumerate");
  const { targetInfos } = await send("Target.getTargets");
  const home = targetInfos.find(target => target.type === "page" && target.url === homeUrl);
  if (home && now() < deadline) {
   let ready = false;
   try { ready = await evaluateHome(home, onOperation); }
   catch (error) {
    const diagnostic = protocolDiagnostics.get(error);
    if (!diagnostic || !transientMethods.has(diagnostic.method) || diagnostic.reason === "other") throw error;
   }
   if (ready === true && now() < deadline) {
    onOperation("confirm");
    const current = await send("Target.getTargets");
    if (now() < deadline && current.targetInfos.some(target => target.type === "page" && target.url === homeUrl && target.targetId === home.targetId)) return home;
   }
  }
  checkInterrupt();
  const remaining = deadline - now();
  if (remaining > 0) await sleep(Math.min(100, remaining));
 }
 throw Error("Timed out in recorded stage.");
}
