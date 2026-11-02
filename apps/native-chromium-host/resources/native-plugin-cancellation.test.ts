import { expect, it, vi } from "vitest";
import { cancelPluginByUiRequest, cancelPluginOnClientLoss } from "./native-plugin-cancellation.mjs";
it("cancels only the lost socket's plugin request and never a normal agent task", () => {
 const write=vi.fn();
 expect(cancelPluginOnClientLoss("ui-7",{plugin:true},write)).toBe(true);
 expect(cancelPluginOnClientLoss("ui-8",{plugin:false},write)).toBe(false);
 expect(cancelPluginOnClientLoss("ui-9",{},write)).toBe(false);
 expect(cancelPluginOnClientLoss("host-10",{plugin:true},write)).toBe(false);
 expect(write.mock.calls).toEqual([[{type:"host-cancel",id:"ui-7"}]]);
});

it("cancels a matching plugin request only for the same socket and UI request id", () => {
 const firstSocket = {};
 const secondSocket = {};
 const pending = new Map([
  ["ui-1", { socket: firstSocket, uiId: "native-1", plugin: true }],
  ["ui-2", { socket: secondSocket, uiId: "native-1", plugin: true }],
  ["ui-3", { socket: firstSocket, uiId: "native-2", plugin: true }],
  ["ui-4", { socket: firstSocket, uiId: "native-1", plugin: false }],
 ]);
 const write = vi.fn();

 expect(cancelPluginByUiRequest(pending, secondSocket, "native-1", write)).toBe(true);
 expect(write.mock.calls).toEqual([[{ type: "host-cancel", id: "ui-2" }]]);

 write.mockClear();
 expect(cancelPluginByUiRequest(pending, firstSocket, "native-2", write)).toBe(true);
 expect(write.mock.calls).toEqual([[{ type: "host-cancel", id: "ui-3" }]]);

 write.mockClear();
 expect(cancelPluginByUiRequest(pending, firstSocket, "native-1", write)).toBe(true);
 expect(write.mock.calls).toEqual([[{ type: "host-cancel", id: "ui-1" }]]);

 write.mockClear();
 expect(cancelPluginByUiRequest(pending, firstSocket, "native-4", write)).toBe(false);
 expect(cancelPluginByUiRequest(pending, firstSocket, "bad-id", write)).toBe(false);
 expect(write).not.toHaveBeenCalled();
});
