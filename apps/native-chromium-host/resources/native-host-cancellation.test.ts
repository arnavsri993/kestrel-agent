import { expect, it, vi } from "vitest";
import { cancelNativeHostByUiRequest, cancelNativeHostOnClientLoss } from "./native-host-cancellation.mjs";
it("cancels only the lost socket's cancellable host request and never a normal agent task", () => {
 const write=vi.fn();
 expect(cancelNativeHostOnClientLoss("ui-7",{cancellable:true},write)).toBe(true);
 expect(cancelNativeHostOnClientLoss("ui-8",{cancellable:false},write)).toBe(false);
 expect(cancelNativeHostOnClientLoss("ui-9",{},write)).toBe(false);
 expect(cancelNativeHostOnClientLoss("host-10",{cancellable:true},write)).toBe(false);
 expect(write.mock.calls).toEqual([[{type:"host-cancel",id:"ui-7"}]]);
});

it("cancels a matching native host request only for the same socket and UI request id", () => {
 const firstSocket = {};
 const secondSocket = {};
 const pending = new Map([
  ["ui-1", { socket: firstSocket, uiId: "native-1", cancellable: true }],
  ["ui-2", { socket: secondSocket, uiId: "native-1", cancellable: true }],
  ["ui-3", { socket: firstSocket, uiId: "native-2", cancellable: true }],
  ["ui-4", { socket: firstSocket, uiId: "native-1", cancellable: false }],
 ]);
 const write = vi.fn();

 expect(cancelNativeHostByUiRequest(pending, secondSocket, "native-1", write)).toBe(true);
 expect(write.mock.calls).toEqual([[{ type: "host-cancel", id: "ui-2" }]]);

 write.mockClear();
 expect(cancelNativeHostByUiRequest(pending, firstSocket, "native-2", write)).toBe(true);
 expect(write.mock.calls).toEqual([[{ type: "host-cancel", id: "ui-3" }]]);

 write.mockClear();
 expect(cancelNativeHostByUiRequest(pending, firstSocket, "native-1", write)).toBe(true);
 expect(write.mock.calls).toEqual([[{ type: "host-cancel", id: "ui-1" }]]);

 write.mockClear();
 expect(cancelNativeHostByUiRequest(pending, firstSocket, "native-4", write)).toBe(false);
 expect(cancelNativeHostByUiRequest(pending, firstSocket, "bad-id", write)).toBe(false);
 expect(write).not.toHaveBeenCalled();
});
