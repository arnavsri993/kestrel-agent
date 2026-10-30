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
it("forwards only the bounded private context picker root and its matching file selections", () => {
  const h = harness(); h.request(1, { operation: "select-context-files", workspaceRoot: "/granted/project" });
  expect(h.frames()).toEqual([{ kind: "host-request", id: "dialog-1", request: { type: "select-context-files", workspaceRoot: "/granted/project" } }]);
  expect(h.relay.response({ kind: "host-response", id: "dialog-1", response: { ok: true, selectedContextPaths: ["/granted/project/notes.txt"] } })).toBe(true);
  expect(h.writeCore).toHaveBeenCalledExactlyOnceWith({ type: "native-dialog-response", requestId: "native-dialog-1", response: { ok: true, selectedContextPaths: ["/granted/project/notes.txt"] } });
});
it("rejects malformed roots and renderer-injected selection fields before opening a context picker", () => {
  const h = harness(); let n = 0;
  for (const workspaceRoot of [undefined, "relative", "/bad\0root", "/bad\nroot", "/" + "x".repeat(4096), 12])
    h.request(++n, { operation: "select-context-files", workspaceRoot });
  h.request(++n, { operation: "select-context-files", workspaceRoot: "/granted/project", selectedContextPaths: ["/injected"] });
  h.request(++n, { workspaceRoot: "/injected" });
  expect(h.frames()).toEqual([]);
  expect(h.writeCore.mock.calls).toHaveLength(n);
  expect(h.writeCore.mock.calls.every(([message]) => !message.response.ok)).toBe(true);
});
it("rejects wrong-kind, malformed, duplicate or excess context selections without disclosing them", () => {
  const h = harness(); let n = 0;
  const invalid = [
    { ok: true, selectedWorkspacePath: "/private" },
    { ok: true, selectedContextPaths: [] },
    { ok: true, selectedContextPaths: ["relative"] },
    { ok: true, selectedContextPaths: ["/private\0file"] },
    { ok: true, selectedContextPaths: ["/private\nfile"] },
    { ok: true, selectedContextPaths: Array(9).fill("/private") },
    { ok: true, selectedContextPaths: ["/private", "/private"] },
    { ok: true, selectedContextPaths: ["/private"], cancelled: true },
    { ok: true, selectedContextPaths: ["/private"], injected: true },
    { ok: false, error: "secret /private" },
  ];
  for (const response of invalid) {
    h.request(++n, { operation: "select-context-files", workspaceRoot: "/granted" });
    h.relay.response({ kind: "host-response", id: `dialog-${n}`, response });
  }
  expect(h.writeCore.mock.calls.every(([message]) => !message.response.ok)).toBe(true);
  expect(JSON.stringify(h.writeCore.mock.calls)).not.toContain("/private");
});
it("serializes folder and file pickers and rejects cross-operation private replies", () => {
  const h = harness(); h.request(1, { operation: "select-context-files", workspaceRoot: "/granted" });
  h.request(2);
  expect(h.frames()).toHaveLength(1);
  h.relay.response({ kind: "host-response", id: "dialog-1", response: { ok: true, selectedWorkspacePath: "/wrong" } });
  h.request(3);
  h.relay.response({ kind: "host-response", id: "dialog-2", response: { ok: true, selectedContextPaths: ["/wrong"] } });
  expect(h.writeCore.mock.calls.every(([message]) => !message.response.ok)).toBe(true);
});
it("cancels context pickers on timeout, explicit cancel and close and ignores late selections", async () => {
  const h = harness();
  h.request(1, { operation: "select-context-files", workspaceRoot: "/granted" });
  await vi.advanceTimersByTimeAsync(600_000);
  h.relay.response({ kind: "host-response", id: "dialog-1", response: { ok: true, selectedContextPaths: ["/late"] } });
  h.request(2, { operation: "select-context-files", workspaceRoot: "/granted" }); h.relay.cancel("native-dialog-2");
  h.relay.response({ kind: "host-response", id: "dialog-2", response: { ok: true, selectedContextPaths: ["/late"] } });
  h.request(3, { operation: "select-context-files", workspaceRoot: "/granted" }); h.relay.close();
  h.relay.response({ kind: "host-response", id: "dialog-3", response: { ok: true, selectedContextPaths: ["/late"] } });
  expect(h.frames().filter(frame => frame.kind === "dialog-cancel")).toHaveLength(3);
  expect(h.writeCore.mock.calls.map(([message]) => message.requestId)).toEqual(["native-dialog-1", "native-dialog-2", "native-dialog-3"]);
  expect(JSON.stringify(h.writeCore.mock.calls)).not.toContain("/late");
});
it("returns a real context picker cancellation and rejects unexpected response-envelope keys", () => {
  const h = harness(); h.request(1, { operation: "select-context-files", workspaceRoot: "/granted" });
  h.relay.response({ kind: "host-response", id: "dialog-1", response: { ok: true, cancelled: true } });
  expect(h.writeCore.mock.calls[0]?.[0]).toMatchObject({ response: { ok: true, cancelled: true } });
  h.request(2, { operation: "select-context-files", workspaceRoot: "/granted" });
  h.relay.response({ kind: "host-response", id: "dialog-2", response: { ok: true, selectedContextPaths: ["/private"] }, injected: true });
  expect(h.writeCore.mock.calls[1]?.[0]).toMatchObject({ response: { ok: false } });
  expect(JSON.stringify(h.writeCore.mock.calls)).not.toContain("/private");
});
