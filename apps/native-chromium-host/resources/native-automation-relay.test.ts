import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserBackendWireRequestSchema, isUserBrowserBackendWireRequest } from "../../core-service/src/browser-backend-wire";
import { createNativeAutomationRelay } from "./native-automation-relay.mjs";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
function harness() {
  const writeOwner = vi.fn(() => true), writeCore = vi.fn();
  const relay = createNativeAutomationRelay({ validate: (value: unknown) => BrowserBackendWireRequestSchema.safeParse(value), isUserRequest: isUserBrowserBackendWireRequest, writeOwner, writeCore });
  const frames = () => writeOwner.mock.calls.map(([line]) => JSON.parse(line));
  const request = (requestId: string, request: unknown = { operation: "snapshot", sessionId: "session" }) => relay.request({ requestId, request });
  return { relay, writeOwner, writeCore, frames, request };
}
it("dispatches only validated isolated requests and routes matching private response to Core", () => {
  const h = harness();
  h.request("one", { operation: "create", allowedOrigins: ["https://example.com"] });
  expect(h.frames()).toEqual([{ kind: "automation-request", id: "automation-1", request: { operation: "create", allowedOrigins: ["https://example.com"] } }]);
  h.relay.response({ kind: "automation-response", id: "host-1", ok: true, result: "forged" });
  h.relay.response({ kind: "browser-backend-response", id: "automation-1", ok: true, result: "forged" });
  expect(h.writeCore).not.toHaveBeenCalled();
  h.relay.response({ kind: "automation-response", id: "automation-1", ok: true, result: { sessionId: "s" } });
  expect(h.writeCore).toHaveBeenCalledExactlyOnceWith({ type: "browser-backend-response", requestId: "one", ok: true, result: { sessionId: "s" } });
});
it("rejects visible operations, malformed actions, and unbounded ids without sending to the owner", () => {
  const h = harness();
  h.request("visible", { operation: "visible-tabs" });
  h.request("raw-js", { operation: "act", sessionId: "s", action: { type: "evaluate", script: "alert(1)" } });
  h.request("x".repeat(201));
  expect(h.writeOwner).not.toHaveBeenCalled();
  expect(h.writeCore).toHaveBeenCalledTimes(2);
  expect(h.writeCore.mock.calls.every(([message]) => message.ok === false)).toBe(true);
});
it("bounds pending requests, and duplicate ids cancel the original instead of aliasing", () => {
  const h = harness();
  for (let i = 0; i < 17; i++) h.request(`r${i}`);
  expect(h.frames()).toHaveLength(16);
  expect(h.writeCore.mock.calls.at(-1)?.[0]).toMatchObject({ requestId: "r16", ok: false });
  h.request("r0");
  expect(h.frames().at(-1)).toEqual({ kind: "automation-cancel", id: "automation-1" });
  h.relay.response({ kind: "automation-response", id: "automation-1", ok: true, result: "late" });
  expect(h.writeCore.mock.calls.at(-1)?.[0]).toMatchObject({ requestId: "r0", ok: false });
});
it("settles cancellation and deadlines, ignores late results, never replays", async () => {
  const h = harness();
  h.request("cancel"); h.relay.cancel("cancel");
  expect(h.frames().at(-1)).toEqual({ kind: "automation-cancel", id: "automation-1" });
  h.relay.response({ kind: "automation-response", id: "automation-1", ok: true, result: "late" });
  h.request("timeout");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.frames().at(-1)).toEqual({ kind: "automation-cancel", id: "automation-2" });
  h.relay.response({ kind: "automation-response", id: "automation-2", ok: true, result: "late" });
  expect(h.writeCore.mock.calls.map(([message]) => message.requestId)).toEqual(["cancel", "timeout"]);
  expect(h.frames().filter(frame => frame.kind === "automation-request")).toHaveLength(2);
});
it("fails closed on owner write failure, bad response, shutdown and oversized frames", () => {
  const h = harness();
  h.writeOwner.mockImplementationOnce(() => false);
  h.request("write-failed");
  h.relay.response({ kind: "automation-response", id: "automation-1", ok: true, result: 1 });
  h.request("invalid-response"); h.relay.response({ kind: "automation-response", id: "automation-2", ok: true });
  h.request("oversized"); h.relay.response({ kind: "automation-response", id: "automation-3", ok: true, result: "é".repeat(600_000) });
  h.request("shutdown"); h.relay.close(); h.relay.close();
  h.relay.response({ kind: "automation-response", id: "automation-4", ok: true, result: 1 });
  h.request("after-close");
  expect(h.writeCore.mock.calls.map(([message]) => [message.requestId, message.ok])).toEqual([
    ["write-failed", false], ["invalid-response", false], ["oversized", false], ["shutdown", false], ["after-close", false],
  ]);
  expect(h.frames().at(-1)).toEqual({ kind: "automation-cancel", id: "automation-4" });
});

it("cancels pending actions and waits for the exact owner reset acknowledgement", async () => {
  const h = harness();
  h.request("first"); h.request("second");
  const barrier = h.relay.reset();
  let settled = false;
  void barrier.then(() => { settled = true; });
  expect(h.frames().slice(2)).toEqual([
    { kind: "automation-cancel", id: "automation-1" },
    { kind: "automation-cancel", id: "automation-2" },
    { kind: "automation-reset", id: "automation-3" },
  ]);
  expect(h.writeCore.mock.calls.map(([message]) => [message.requestId, message.ok])).toEqual([["first", false], ["second", false]]);
  h.request("blocked");
  expect(h.writeCore.mock.calls.at(-1)?.[0]).toMatchObject({ requestId: "blocked", ok: false });
  h.relay.response({ kind: "automation-response", id: "automation-1", ok: true, result: "old" });
  h.relay.resetResponse({ kind: "automation-reset-response", id: "automation-2", ok: true });
  await Promise.resolve(); expect(settled).toBe(false);
  h.relay.resetResponse({ kind: "automation-reset-response", id: "automation-3", ok: true });
  await barrier; expect(settled).toBe(true);
  h.request("new");
  expect(h.frames().at(-1)).toMatchObject({ kind: "automation-request", id: "automation-4" });
  expect(h.writeCore.mock.calls.map(([message]) => message.requestId)).toEqual(["first", "second", "blocked"]);
});
it("times out within ten seconds and remains closed to new actions until a fresh acknowledged reset", async () => {
  const h = harness();
  const timedOut = h.relay.reset();
  const assertion = expect(timedOut).rejects.toThrow(/timed out/);
  await vi.advanceTimersByTimeAsync(10_000); await assertion;
  h.relay.resetResponse({ kind: "automation-reset-response", id: "automation-1", ok: true });
  h.request("blocked-after-timeout");
  expect(h.writeCore.mock.calls.at(-1)?.[0]).toMatchObject({ requestId: "blocked-after-timeout", ok: false });
  const retry = h.relay.reset();
  h.relay.resetResponse({ kind: "automation-reset-response", id: "automation-1", ok: true });
  h.relay.resetResponse({ kind: "automation-reset-response", id: "automation-2", ok: true });
  await retry;
  h.request("after-cleanup");
  expect(h.frames().at(-1)).toMatchObject({ kind: "automation-request", id: "automation-3" });
});
it("rejects reset on owner failure, negative acknowledgement, concurrent reset, or shutdown", async () => {
  const h = harness();
  h.writeOwner.mockImplementationOnce(() => false);
  await expect(h.relay.reset()).rejects.toThrow(/could not reach/);
  h.request("blocked-after-write-failure");
  expect(h.writeCore.mock.calls.at(-1)?.[0]).toMatchObject({ ok: false });
  const failed = h.relay.reset();
  await expect(h.relay.reset()).rejects.toThrow(/unavailable/);
  h.relay.resetResponse({ kind: "automation-reset-response", id: "automation-2", ok: false });
  await expect(failed).rejects.toThrow(/failed/);
  const closed = h.relay.reset();
  h.relay.close();
  await expect(closed).rejects.toThrow(/disconnected/);
  h.relay.resetResponse({ kind: "automation-reset-response", id: "automation-3", ok: true });
  await expect(h.relay.reset()).rejects.toThrow(/unavailable/);
});
