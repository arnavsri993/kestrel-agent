import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNativeDialogRelay } from "./native-dialog-relay.mjs";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
function harness() {
  const writeOwner = vi.fn((_line: string) => true), writeCore = vi.fn();
  const relay = createNativeDialogRelay({ writeOwner, writeCore });
  const frames = () => writeOwner.mock.calls.map(([line]) => JSON.parse(line));
  const request = (n: number, extra = {}) => relay.request({ type: "native-dialog-request", requestId: `native-dialog-${n}`, operation: "select-workspace-folder", ...extra });
  return { relay, writeOwner, writeCore, frames, request };
}
it("only sends a fixed picker request and returns the exact matching private selection", () => {
  const h = harness(); h.request(1);
  expect(h.frames()).toEqual([{ kind: "host-request", id: "dialog-1", request: { type: "select-workspace-folder" } }]);
  expect(h.relay.response({ kind: "host-response", id: "host-1", response: { ok: true, selectedWorkspacePath: "/wrong" } })).toBe(false);
  expect(h.writeCore).not.toHaveBeenCalled();
  expect(h.relay.response({ kind: "host-response", id: "dialog-1", response: { ok: true, selectedWorkspacePath: "/chosen/folder" } })).toBe(true);
  expect(h.writeCore).toHaveBeenCalledExactlyOnceWith({ type: "native-dialog-response", requestId: "native-dialog-1", response: { ok: true, selectedWorkspacePath: "/chosen/folder" } });
});
it("rejects other operations, supplied paths, repeated ids, and a second concurrent picker", () => {
  const h = harness();
  h.request(1, { operation: "arbitrary" });
  h.request(2, { path: "/injected" });
  h.request(3);
  h.request(4);
  expect(h.frames()).toHaveLength(1);
  h.request(3);
  expect(h.frames().at(-1)).toEqual({ kind: "dialog-cancel", id: "dialog-1" });
  h.relay.response({ kind: "host-response", id: "dialog-1", response: { ok: true, selectedWorkspacePath: "/late" } });
  expect(h.writeCore.mock.calls.map(([m]) => [m.requestId, m.response.ok])).toEqual([
    ["native-dialog-1", false], ["native-dialog-2", false], ["native-dialog-4", false], ["native-dialog-3", false],
  ]);
  expect(JSON.stringify(h.writeCore.mock.calls)).not.toContain("/injected");
});
it("returns picker cancellation and sanitizes malformed or failed owner responses", () => {
  const h = harness(); h.request(1);
  h.relay.response({ kind: "host-response", id: "dialog-1", response: { ok: true, cancelled: true } });
  expect(h.writeCore.mock.calls.at(-1)?.[0]).toMatchObject({ response: { ok: true, cancelled: true } });
  h.request(2);
  h.relay.response({ kind: "host-response", id: "dialog-2", response: { ok: false, error: "private /secret" } });
  h.request(3);
  h.relay.response({ kind: "host-response", id: "dialog-3", response: { ok: true, selectedWorkspacePath: "/secret", cancelled: true } });
  h.request(4);
  h.relay.response({ kind: "host-response", id: "dialog-4", response: { ok: true, selectedWorkspacePath: "relative" } });
  expect(JSON.stringify(h.writeCore.mock.calls)).not.toContain("/secret");
  expect(h.writeCore.mock.calls.slice(1).every(([message]) => message.response.ok === false)).toBe(true);
});
it("settles owner write failures, cancel, late replies and shutdown once", () => {
  const h = harness(); h.writeOwner.mockImplementationOnce(() => false); h.request(1);
  h.relay.response({ kind: "host-response", id: "dialog-1", response: { ok: true, selectedWorkspacePath: "/late" } });
  h.request(2); h.relay.cancel("native-dialog-2"); h.relay.cancel("native-dialog-2");
  h.relay.response({ kind: "host-response", id: "dialog-2", response: { ok: true, selectedWorkspacePath: "/late" } });
  h.request(3); h.relay.close(); h.relay.close(); h.request(4);
  expect(h.frames().filter(x => x.kind === "dialog-cancel")).toEqual([{ kind: "dialog-cancel", id: "dialog-2" }, { kind: "dialog-cancel", id: "dialog-3" }]);
  expect(h.writeCore.mock.calls.map(([m]) => m.requestId)).toEqual(["native-dialog-1", "native-dialog-2", "native-dialog-3", "native-dialog-4"]);
  expect(JSON.stringify(h.writeCore.mock.calls)).not.toContain("/late");
});
it("cancels at ten minutes and ignores old responses when a new picker opens", async () => {
  const h = harness(); h.request(1);
  await vi.advanceTimersByTimeAsync(600_000);
  expect(h.frames().at(-1)).toEqual({ kind: "dialog-cancel", id: "dialog-1" });
  h.request(2);
  h.relay.response({ kind: "host-response", id: "dialog-1", response: { ok: true, selectedWorkspacePath: "/late" } });
  h.relay.response({ kind: "host-response", id: "dialog-2", response: { ok: true, cancelled: true } });
  expect(h.writeCore.mock.calls.map(([m]) => m.requestId)).toEqual(["native-dialog-1", "native-dialog-2"]);
  expect(JSON.stringify(h.writeCore.mock.calls)).not.toContain("/late");
});
