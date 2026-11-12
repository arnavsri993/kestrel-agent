import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { browserStorageProtocolDiagnostic, browserStorageProtocolError, recordBrowserStorageDiagnostic, waitForBrowserStorageHome } from "./native-browser-storage-readiness.mjs";

const homeUrl = `chrome-extension://${"a".repeat(32)}/index.html`;
const home = targetId => ({ targetId, type: "page", url: homeUrl });
function fixture() {
 const f = { time: 0, targets: [home("first")], calls: [], operations: [], diagnostics: [], values: [], hook: () => {} };
 f.send = async (method, params) => {
  f.calls.push(method);
  const failure = f.hook(method, params);
  if (failure) throw failure;
  if (method === "Target.getTargets") return { targetInfos: [...f.targets] };
  if (method === "Target.attachToTarget") return { sessionId: "session" };
  if (method === "Runtime.evaluate") return { result: { value: f.values.length ? f.values.shift() : true } };
  throw Error("Unexpected command.");
 };
 f.protocolError = (method, code, message) => {
  const error = browserStorageProtocolError(method, { code, message });
  recordBrowserStorageDiagnostic(f.diagnostics, error);
  return error;
 };
 f.wait = (options = {}) => waitForBrowserStorageHome({
  homeUrl, send: f.send, now: () => f.time,
  sleep: async ms => { f.time += ms; },
  onOperation: operation => f.operations.push(operation),
  evaluateHome: async (target, onOperation) => {
   onOperation("attach");
   const { sessionId } = await f.send("Target.attachToTarget", { targetId: target.targetId });
   onOperation("bridge");
   const result = await f.send("Runtime.evaluate", { sessionId });
   assert(!result.exceptionDetails, "Target evaluation failed.");
   return result.result.value;
  }, ...options,
 });
 return f;
}

describe("cookie canary Home readiness", () => {
 it("re-enumerates and selects a replacement after the selected target disappears", async () => {
  const f = fixture();
  f.hook = (method, params) => {
   if (method === "Target.attachToTarget" && params.targetId === "first") {
    f.targets = [home("replacement")];
    return f.protocolError(method, -32602, "No target with given id found");
   }
  };
  expect((await f.wait()).targetId).toBe("replacement");
  expect(f.calls.filter(method => method === "Target.attachToTarget")).toHaveLength(2);
  expect(f.diagnostics).toEqual([{ method: "Target.attachToTarget", code: -32602, reason: "target-gone" }]);
 });

 it.each([
  [-32000, "Execution context was destroyed.", "context-destroyed"],
  [-32000, "Cannot find context with specified id", "context-destroyed"],
  [-32001, "Session with given id not found.", "session-gone"],
 ])("retries the allowlisted Runtime lifecycle failure %s %s", async (code, message, reason) => {
  const f = fixture(); let failed = false;
  f.hook = method => {
   if (method === "Runtime.evaluate" && !failed) { failed = true; return f.protocolError(method, code, message); }
  };
  expect(await f.wait()).toEqual(home("first"));
  expect(f.diagnostics[0].reason).toBe(reason);
  expect(f.calls.filter(method => method === "Target.getTargets")).toHaveLength(3);
 });

 it("confirms a successfully evaluated target is still live before returning it", async () => {
  const f = fixture(); let replaced = false;
  f.hook = method => {
   if (method === "Runtime.evaluate" && !replaced) { replaced = true; f.targets = [home("replacement")]; }
  };
  expect((await f.wait()).targetId).toBe("replacement");
 });

 it("requires strict true and reports only fixed Home suboperations", async () => {
  const f = fixture(); f.values = [1, "true", {}, false, true];
  expect(await f.wait()).toEqual(home("first"));
  expect(f.time).toBe(400);
  expect([...new Set(f.operations)]).toEqual(["enumerate", "attach", "bridge", "confirm"]);
 });

 it("does not accept another extension, route, fragment, or non-page target", async () => {
  const f = fixture();
  f.targets = [
   { ...home("other-extension"), url: homeUrl.replace("a".repeat(32), "b".repeat(32)) },
   { ...home("route"), url: `${homeUrl}?app=settings` },
   { ...home("fragment"), url: `${homeUrl}#home` },
   { ...home("worker"), type: "service_worker" },
  ];
  await expect(f.wait({ timeout: 250 })).rejects.toThrow("Timed out in recorded stage.");
  expect(f.time).toBe(250);
  expect(f.calls).not.toContain("Target.attachToTarget");
 });

 it("keeps one deadline despite repeated transient errors", async () => {
  const f = fixture();
  f.hook = method => method === "Runtime.evaluate" ? f.protocolError(method, -32000, "Execution context was destroyed.") : undefined;
  await expect(f.wait()).rejects.toThrow("Timed out in recorded stage.");
  expect(f.time).toBe(30000);
  expect(f.calls.filter(method => method === "Runtime.evaluate")).toHaveLength(300);
  expect(f.diagnostics).toHaveLength(32);
 });

 it("does not return readiness that arrived after the same deadline", async () => {
  const f = fixture();
  f.hook = method => { if (method === "Runtime.evaluate") f.time = 30000; };
  await expect(f.wait()).rejects.toThrow("Timed out in recorded stage.");
  expect(f.calls).toEqual(["Target.getTargets", "Target.attachToTarget", "Runtime.evaluate"]);
 });

 it.each(["CDP closed.", "CDP send failed.", "CDP command timeout.", "Target evaluation failed."])("fails fast on %s", async message => {
  const f = fixture(); const failure = Error(message);
  f.hook = method => method === "Runtime.evaluate" ? failure : undefined;
  await expect(f.wait()).rejects.toBe(failure);
  expect(f.time).toBe(0);
 });

 it("fails fast on assertions and Runtime exception details", async () => {
  const f = fixture();
  await expect(f.wait({ evaluateHome: () => { assert(false, "Target evaluation failed."); } })).rejects.toMatchObject({ code: "ERR_ASSERTION" });
  const g = fixture();
  const send = g.send;
  g.send = async (method, params) => method === "Runtime.evaluate" ? { exceptionDetails: { text: "private page content" } } : send(method, params);
  await expect(g.wait()).rejects.toMatchObject({ code: "ERR_ASSERTION" });
 });

 it.each([
  ["Runtime.evaluate", -32000, "Unknown failure"],
  ["Runtime.evaluate", -1, "Execution context was destroyed."],
  ["Target.getTargets", -32000, "Execution context was destroyed."],
  ["Target.attachToTarget", -32602, "No target with given id found at https://private.example/"],
 ])("fails fast on non-allowlisted protocol errors %s %s", async (method, code, message) => {
  const f = fixture(); const failure = f.protocolError(method, code, message);
  f.hook = actual => actual === "Runtime.evaluate" ? failure : undefined;
  await expect(f.wait()).rejects.toBe(failure);
  expect(f.time).toBe(0);
 });

 it("does not trust forged diagnostics on an ordinary error", async () => {
  const f = fixture(); const failure = Object.assign(Error("Execution context was destroyed."), { method: "Runtime.evaluate", code: -32000, reason: "context-destroyed" });
  await expect(f.wait({ evaluateHome: () => { throw failure; } })).rejects.toBe(failure);
 });
});

describe("bounded protocol diagnostics", () => {
 it("excludes raw URLs, messages, parameters, and payloads and normalizes methods/codes", () => {
  const raw = "https://private.example/secret?token=payload";
  const error = browserStorageProtocolError(raw, { code: raw, message: raw, data: { params: raw } });
  const diagnostics = [];
  for (let i = 0; i < 100; i++) recordBrowserStorageDiagnostic(diagnostics, error);
  expect(diagnostics).toHaveLength(32);
  expect(diagnostics[0]).toEqual({ method: "other", code: null, reason: "other" });
  expect(JSON.stringify({ diagnostics, error: { message: error.message, ...error } })).not.toContain(raw);
  const copy = browserStorageProtocolDiagnostic(error); copy.reason = "target-gone";
  expect(browserStorageProtocolDiagnostic(error).reason).toBe("other");
  recordBrowserStorageDiagnostic(diagnostics, Error(raw));
  expect(diagnostics).toHaveLength(32);
 });
});
