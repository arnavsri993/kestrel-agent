import { describe, expect, it, vi } from "vitest";
import { createBrowserAdapter } from "./browser.mjs";
import { NATIVE_IMPORTED_HISTORY_KEY } from "./history-transfer.mjs";
import { UserBrowserEventSchema, UserBrowserStateSchema } from "../../../../packages/shared-types/src/contracts";
const extensionId = "a".repeat(32), uiUrl = `chrome-extension://${extensionId}/index.html`, sender = { id: extensionId, url: uiUrl };
const source = { format: "kestrel-history", version: 1, entries: [{ url: "https://example.com/Original", title: "Original", visitedAt: "2020-01-01T00:00:00Z" }] };
function fixture() {
 const storage: any = {}, session: any = {}; let native: any[] = [];
 const removedListeners: ((details: any) => void)[] = [];
 const visitedListeners: (() => void)[] = [];
 const visited = () => { for (const listener of visitedListeners) listener(); };
 const removed = (details: any) => { for (const listener of removedListeners) listener(details); };
 const method = (fn: any) => (...args: any[]) => { const cb = args.pop(); const result = fn(...args); cb(result); return Promise.resolve(result); };
 const area = (value: any) => ({ get: method((key: string) => ({ [key]: value[key] })), set: vi.fn(method((next: any) => Object.assign(value, next))) });
 const chrome: any = { runtime: { id: extensionId }, storage: { local: area(storage), session: area(session) }, tabs: { query: method(() => [{ id: 1, active: true, windowId: 1, url: uiUrl, title: "Kestrel" }]) }, windows: { getLastFocused: method(() => ({ id: 1 })) }, history: { search: method(() => native), deleteAll: vi.fn(method(() => { native = []; removed({ allHistory: true, urls: [] }); })), onVisited: { addListener: (listener: () => void) => visitedListeners.push(listener) }, onVisitRemoved: { addListener: (listener: (details: any) => void) => removedListeners.push(listener) }, addUrl: vi.fn() } };
 const emitted = vi.fn();
 const create = () => createBrowserAdapter(chrome, { uiUrl, emit: emitted });
 const adapter = create();
 return { chrome, storage, create, adapter, emitted, removed, visited, native: (rows: any[]) => { native = rows; } };
}
describe("authenticated adapter history integration", () => {
 it("handles preview/apply/export/reinstantiate and clears both stores with schema-valid state", async () => {
  const f = fixture();
  const p = await f.adapter.request({ type: "browser-plan-history-import", data: source }, sender);
  expect(p.ok).toBe(true); expect(f.storage[NATIVE_IMPORTED_HISTORY_KEY]).toBeUndefined();
  const applied = await f.adapter.request({ type: "browser-apply-history-import", planId: p.historyImportPlan.planId }, sender);
  expect(applied.ok).toBe(true); expect(UserBrowserStateSchema.safeParse(applied.browserState).success).toBe(true);
  expect(applied.browserState.history[0]).toMatchObject({ ...source.entries[0], provenance: "imported" });
  const restarted = f.create(); const state = await restarted.request({ type: "browser-get-state" }, sender);
  expect(state.browserState.history).toEqual(applied.browserState.history);
  expect((await restarted.request({ type: "browser-export-history" }, sender)).historyTransfer).toEqual(source);
  const cleared = await restarted.request({ type: "browser-clear-history" }, sender);
  expect(cleared.ok).toBe(true); expect(cleared.browserState.history).toEqual([]); expect(f.chrome.history.deleteAll).toHaveBeenCalledTimes(1); expect(f.chrome.history.addUrl).not.toHaveBeenCalled();
  expect(f.emitted).toHaveBeenCalledWith("browser-event", expect.objectContaining({ type: "state" }));
 });
 it("mirrors Chrome all-history removal into imported storage and invalidates pending reviews", async () => {
  const f = fixture(), p = await f.adapter.request({ type: "browser-plan-history-import", data: source }, sender);
  await f.adapter.request({ type: "browser-apply-history-import", planId: p.historyImportPlan.planId }, sender);
  const pending = await f.adapter.request({ type: "browser-plan-history-import", data: source }, sender);
  f.emitted.mockClear(); f.removed({ allHistory: true, urls: [] });
  await vi.waitFor(() => expect(f.storage[NATIVE_IMPORTED_HISTORY_KEY].entries).toEqual([]));
  await vi.waitFor(() => expect(f.emitted).toHaveBeenCalledWith("browser-event", expect.objectContaining({ type: "state", state: expect.objectContaining({ history: [] }) })));
  await vi.waitFor(() => expect(f.emitted).toHaveBeenCalledWith("browser-event", { type: "history-sync-recovered" }));
  const events = f.emitted.mock.calls.map(call => call[1]);
  const recoveredIndex = events.findIndex(event => event.type === "history-sync-recovered");
  expect(recoveredIndex).toBeGreaterThan(events.findIndex(event => event.type === "state"));
  expect(UserBrowserEventSchema.safeParse(events[recoveredIndex]).success).toBe(true);
  expect((await f.adapter.request({ type: "browser-apply-history-import", planId: pending.historyImportPlan.planId }, sender)).ok).toBe(false);
  expect(f.chrome.history.deleteAll).not.toHaveBeenCalled(); expect(f.chrome.history.addUrl).not.toHaveBeenCalled();
 });
 it("mirrors partial Chrome URL removal canonically while preserving unrelated original metadata", async () => {
  const f = fixture(), data = structuredClone(source); data.entries.push({ ...data.entries[0], url: "https://keep.example/path", title: "Keep original" });
  const p = await f.adapter.request({ type: "browser-plan-history-import", data }, sender);
  await f.adapter.request({ type: "browser-apply-history-import", planId: p.historyImportPlan.planId }, sender);
  const before = structuredClone(f.storage[NATIVE_IMPORTED_HISTORY_KEY].entries[1]);
  const pending = await f.adapter.request({ type: "browser-plan-history-import", data }, sender);
  f.removed({ allHistory: false, urls: ["https://EXAMPLE.com:443/Original", "chrome://history", "not a URL"] });
  await vi.waitFor(() => expect(f.storage[NATIVE_IMPORTED_HISTORY_KEY].entries).toEqual([before]));
  await vi.waitFor(() => expect(f.emitted).toHaveBeenCalledWith("browser-event", expect.objectContaining({ type: "state", state: expect.objectContaining({ history: [before] }) })));
  expect(f.emitted.mock.calls.some(call => call[1].type === "history-sync-recovered")).toBe(false);
  expect((await f.adapter.request({ type: "browser-apply-history-import", planId: pending.historyImportPlan.planId }, sender)).ok).toBe(false);
  expect(f.chrome.history.deleteAll).not.toHaveBeenCalled();
 });
 it("does not emit history recovery for an unrelated native visit and its refreshed state", async () => {
  const f = fixture(); f.visited();
  await vi.waitFor(() => expect(f.emitted).toHaveBeenCalledWith("browser-event", expect.objectContaining({ type: "state" })));
  expect(f.emitted.mock.calls.some(call => call[1].type === "history-sync-recovered")).toBe(false);
 });
 it("allows Chrome all-history removal to purge a malformed imported archive", async () => {
  const f = fixture(); f.storage[NATIVE_IMPORTED_HISTORY_KEY] = { corrupted: true };
  f.removed({ allHistory: true, urls: [] });
  await vi.waitFor(() => expect(f.storage[NATIVE_IMPORTED_HISTORY_KEY]).toEqual({ version: 1, entries: [] }));
  expect(f.chrome.history.deleteAll).not.toHaveBeenCalled();
 });
 it("surfaces native-removal write failure after the remaining state without an uncaught rejection", async () => {
  const f = fixture(), p = await f.adapter.request({ type: "browser-plan-history-import", data: source }, sender);
  await f.adapter.request({ type: "browser-apply-history-import", planId: p.historyImportPlan.planId }, sender);
  const original = structuredClone(f.storage[NATIVE_IMPORTED_HISTORY_KEY]);
  const pending = await f.adapter.request({ type: "browser-plan-history-import", data: source }, sender);
  f.chrome.storage.local.set = () => { throw Error("storage failure"); };
  f.emitted.mockClear(); f.removed({ allHistory: true, urls: [] });
  await vi.waitFor(() => expect(f.emitted).toHaveBeenCalledWith("browser-event", { type: "error", error: expect.stringMatching(/imported history could not be removed/) }));
  const events = f.emitted.mock.calls.map(call => call[1]); expect(events.at(-1).type).toBe("error"); expect(UserBrowserEventSchema.safeParse(events.at(-1)).success).toBe(true); expect(events.some(event => event.type === "state")).toBe(true); expect(events.some(event => event.type === "history-sync-recovered")).toBe(false);
  expect(f.storage[NATIVE_IMPORTED_HISTORY_KEY]).toEqual(original);
  expect((await f.adapter.request({ type: "browser-apply-history-import", planId: pending.historyImportPlan.planId }, sender)).ok).toBe(false);
  expect(f.chrome.history.deleteAll).not.toHaveBeenCalled();
 });
 it("replays unresolved synchronization status to a new renderer callback and resets only after full recovery", async () => {
  const f = fixture(), data = structuredClone(source); data.entries.push({ ...data.entries[0], url: "https://keep.example/", title: "Keep" });
  const p = await f.adapter.request({ type: "browser-plan-history-import", data }, sender);
  await f.adapter.request({ type: "browser-apply-history-import", planId: p.historyImportPlan.planId }, sender);
  const originalSet = f.chrome.storage.local.set;
  f.chrome.storage.local.set = () => { throw Error("storage failure"); };
  f.removed({ allHistory: true, urls: [] });
  await vi.waitFor(() => expect(f.emitted).toHaveBeenCalledWith("browser-event", expect.objectContaining({ type: "error" })));
  // A reloaded/new document gets the same worker authority via a fresh callback.
  const newRendererRequest = (input: any) => f.adapter.request(input, { ...sender, url: `${uiUrl}?app=history` });
  const initial = await newRendererRequest({ type: "browser-get-state" });
  expect(initial.ok).toBe(true); expect(initial.browserState.historySyncError).toMatch(/imported history could not be removed/);
  expect(UserBrowserStateSchema.safeParse(initial.browserState).success).toBe(true);
  const error = initial.browserState.historySyncError;
  f.visited(); await vi.waitFor(() => expect(f.emitted).toHaveBeenCalledWith("browser-event", expect.objectContaining({ type: "state", state: expect.objectContaining({ historySyncError: error }) })));
  expect((await newRendererRequest({ type: "browser-get-state" })).browserState.historySyncError).toBe(error);
  f.chrome.storage.local.set = originalSet;
  f.removed({ allHistory: false, urls: [source.entries[0].url] });
  await vi.waitFor(() => expect(f.storage[NATIVE_IMPORTED_HISTORY_KEY].entries).toHaveLength(1));
  expect((await newRendererRequest({ type: "browser-get-state" })).browserState.historySyncError).toBe(error);
  f.removed({ allHistory: true, urls: [] });
  await vi.waitFor(() => expect(f.storage[NATIVE_IMPORTED_HISTORY_KEY].entries).toEqual([]));
  expect((await newRendererRequest({ type: "browser-get-state" })).browserState.historySyncError).toBeUndefined();
 });
 it("includes partial Kestrel-clear status in later initial state until full clear succeeds", async () => {
  const f = fixture(), p = await f.adapter.request({ type: "browser-plan-history-import", data: source }, sender);
  await f.adapter.request({ type: "browser-apply-history-import", planId: p.historyImportPlan.planId }, sender);
  const originalClear = f.chrome.history.deleteAll;
  f.chrome.history.deleteAll = () => { throw Error("native clear failed"); };
  const failure = await f.adapter.request({ type: "browser-clear-history" }, sender);
  expect(failure.ok).toBe(false); expect(failure.browserState.historySyncError).toMatch(/partially cleared/);
  expect((await f.adapter.request({ type: "browser-get-state" }, sender)).browserState.historySyncError).toBe(failure.error);
  f.chrome.history.deleteAll = originalClear;
  const recovered = await f.adapter.request({ type: "browser-clear-history" }, sender);
  expect(recovered.ok).toBe(true); expect(recovered.browserState.historySyncError).toBeUndefined();
 });
 it("rejects unauthorized previews and consumes a pending review after malformed apply", async () => {
  const f = fixture(); const denied = await f.adapter.request({ type: "browser-plan-history-import", data: source }, { id: extensionId, url: "https://example.com/" }); expect(denied.ok).toBe(false);
  const p = await f.adapter.request({ type: "browser-plan-history-import", data: source }, sender);
  const invalid = await f.adapter.request({ type: "browser-apply-history-import", planId: p.historyImportPlan.planId, data: source }, sender); expect(invalid.ok).toBe(false);
  const replay = await f.adapter.request({ type: "browser-apply-history-import", planId: p.historyImportPlan.planId }, sender); expect(replay.ok).toBe(false); expect(f.storage[NATIVE_IMPORTED_HISTORY_KEY]).toBeUndefined();
 });
 it("preserves the known partial clear outcome when state emission and response refresh both fail", async () => {
  const f = fixture(); const p = await f.adapter.request({ type: "browser-plan-history-import", data: source }, sender);
  await f.adapter.request({ type: "browser-apply-history-import", planId: p.historyImportPlan.planId }, sender);
  f.chrome.history.deleteAll = () => { f.chrome.history.search = () => { throw Error("refresh failure"); }; throw Error("native clear failure"); };
  const cleared = await f.adapter.request({ type: "browser-clear-history" }, sender);
  expect(cleared.ok).toBe(false); expect(cleared.error).toMatch(/partially cleared/); expect(cleared.error).toMatch(/Chromium history/); expect(cleared.error).toMatch(/could not be refreshed/);
  expect(f.storage[NATIVE_IMPORTED_HISTORY_KEY].entries).toEqual([]);
 });
 it("allows corruption recovery by clear and refuses inaccessible native history imports", async () => {
  const f = fixture(); f.storage[NATIVE_IMPORTED_HISTORY_KEY] = { corrupted: true };
  expect((await f.adapter.request({ type: "browser-clear-history" }, sender)).ok).toBe(true);
  delete f.chrome.history.search;
  expect((await f.adapter.request({ type: "browser-get-state" }, sender)).ok).toBe(true);
  expect((await f.adapter.request({ type: "browser-plan-history-import", data: source }, sender)).ok).toBe(false);
  expect((await f.adapter.request({ type: "browser-export-history" }, sender)).ok).toBe(false);
 });
});
