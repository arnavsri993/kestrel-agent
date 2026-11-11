import { describe, expect, it, vi } from "vitest";
import { createNativeHistoryTransfer, normalizeNativeHistory } from "./history-transfer.mjs";
import { readFileSync } from "node:fs";
const source = () => ({ format: "kestrel-history", version: 1, entries: [{ url: "https://example.com/Original", title: "Original title", visitedAt: "2020-01-01T00:00:00Z" }] });
// Alternate the enumerable key order on every Chrome-like read, including
// collection and entry fields, while preserving all values and array order.
const reorderKeys = (value: any, reverse: boolean): any => Array.isArray(value) ? value.map(item => reorderKeys(item, reverse)) : value && typeof value === "object"
 ? Object.fromEntries((reverse ? Object.keys(value).reverse() : Object.keys(value)).map(key => [key, reorderKeys(value[key], reverse)])) : value;
function fixture(reorderReads = false) {
 let stored: any = { version: 1, entries: [] }, native: any = { entries: [], excluded: 0, truncated: false }, writes = 0, failWrite = false, failClear = false, mismatch = false, time = 1_000_000;
 let reads = 0, alterWrite: ((value: any) => void) | undefined;
 const emit = vi.fn(async () => {}), clear = vi.fn(async () => { if (failClear) throw Error("secret native failure"); native.entries = []; });
 const create = () => createNativeHistoryTransfer({ read: async () => reorderReads ? reorderKeys(stored, ++reads % 2 === 1) : structuredClone(stored), write: async (value: any) => { writes++; if (failWrite) throw Error("Storage unavailable"); stored = structuredClone(value); if (mismatch) stored.entries = []; alterWrite?.(stored); }, readNative: async () => structuredClone(native), clearNative: clear, emit, response: async () => ({ ok: true, browserState: { history: await adapter.read() } }), clock: () => time });
 const adapter = create();
 return { adapter, create, emit, clear, alterWrite: (fn: (value: any) => void) => { alterWrite = fn; }, get: () => stored, set: (value: any) => { stored = value; }, native: (value: any) => { native = value; }, writes: () => writes, failWrite: (value = true) => { failWrite = value; }, failClear: (value = true) => { failClear = value; }, mismatch: () => { mismatch = true; }, expire: () => { time += 120_000; } };
}
const plan = async (f: ReturnType<typeof fixture>, data: any = source()) => (await f.adapter.request({ type: "browser-plan-history-import", data })).historyImportPlan;
const apply = (f: ReturnType<typeof fixture>, id: string) => f.adapter.request({ type: "browser-apply-history-import", planId: id });
describe("native archival history transfer", () => {
 it("previews without writes and applies stable, durable original metadata without native visits", async () => {
  const f = fixture(), p = await plan(f);
  expect(p.summary).toEqual({ entriesToAdd: 1, duplicateEntries: 0 }); expect(f.writes()).toBe(0); expect(await f.adapter.read()).toEqual([]);
  const result = await apply(f, p.planId); expect(result.ok).toBe(true);
  const imported = (await f.adapter.read())[0]; expect(imported).toMatchObject({ ...source().entries[0], provenance: "imported" }); expect(imported.id).toMatch(/^visit-/);
  expect(await f.create().read()).toEqual([imported]);
  expect((await f.create().request({ type: "browser-export-history" })).historyTransfer).toEqual(source());
  expect(f.clear).not.toHaveBeenCalled(); expect(f.emit).toHaveBeenCalledTimes(1);
  await expect(apply(f, p.planId)).rejects.toThrow(/expired/); expect(f.writes()).toBe(1);
 });
 it("verifies apply and clear despite Chrome reordering collection and entry keys on every read", async () => {
  const f = fixture(true), p = await plan(f);
  expect((await apply(f, p.planId)).ok).toBe(true);
  const original = structuredClone(f.get());
  const duplicate = await plan(f);
  expect(duplicate.summary).toEqual({ entriesToAdd: 0, duplicateEntries: 1 });
  expect((await apply(f, duplicate.planId)).ok).toBe(true);
  expect(f.get()).toEqual(original); expect(f.writes()).toBe(1);
  expect((await f.create().request({ type: "browser-export-history" })).historyTransfer).toEqual(source());
  expect((await f.adapter.request({ type: "browser-clear-history" })).ok).toBe(true);
  expect(f.get()).toEqual({ version: 1, entries: [] }); expect(f.writes()).toBe(2);
 });
 it.each([
  ["title", (v: any) => { v.entries[0].title = "Changed title"; }],
  ["date representation", (v: any) => { v.entries[0].visitedAt = "2020-01-01T00:00:00.000Z"; }],
  ["identity", (v: any) => { v.entries[0].id = `visit-${crypto.randomUUID()}`; }],
  ["tab identity", (v: any) => { v.entries[0].tabId = `tab-${crypto.randomUUID()}`; }],
  ["URL representation", (v: any) => { v.entries[0].url = "https://EXAMPLE.com/Original"; }],
  ["provenance", (v: any) => { delete v.entries[0].provenance; }],
 ])("still refuses changed %s during reordered read-back verification", async (_field, mutate) => {
  const f = fixture(true), p = await plan(f); f.alterWrite(mutate);
  await expect(apply(f, p.planId)).rejects.toThrow(/saved or verified/);
  await expect(apply(f, p.planId)).rejects.toThrow(/expired/); expect(f.writes()).toBe(1);
 });
 it("still refuses reordered history entries during read-back verification", async () => {
  const f = fixture(true), data = source(); data.entries.push({ ...data.entries[0], url: "https://example.com/Second" });
  const p = await plan(f, data); f.alterWrite(value => value.entries.reverse());
  await expect(apply(f, p.planId)).rejects.toThrow(/saved or verified/); expect(f.writes()).toBe(1);
 });
 it("deduplicates canonical URL and date, preserving existing titles, timestamps, and IDs", async () => {
  const f = fixture(); const p = await plan(f); await apply(f, p.planId); const original = structuredClone(f.get());
  const duplicate = source(); duplicate.entries[0] = { url: "https://EXAMPLE.com:443/Original", title: "Do not replace", visitedAt: "2020-01-01T00:00:00.000Z" };
  duplicate.entries.push(duplicate.entries[0]);
  const next = await plan(f, duplicate); expect(next.summary).toEqual({ entriesToAdd: 0, duplicateEntries: 2 }); await apply(f, next.planId);
  expect(f.get()).toEqual(original); expect(f.writes()).toBe(1);
 });
 it.each(["wrong", "malformed", "discard", "expired", "new-plan", "restart"])("invalidates reviews after %s without replay", async mode => {
  const f = fixture(), p = await plan(f);
  if (mode === "wrong") await expect(apply(f, crypto.randomUUID())).rejects.toThrow(/invalid/);
  if (mode === "malformed") await expect(f.adapter.request({ type: "browser-apply-history-import", planId: p.planId, data: source() })).rejects.toThrow(/Invalid/);
  if (mode === "discard") await f.adapter.request({ type: "browser-discard-history-import", planId: p.planId });
  if (mode === "expired") f.expire();
  if (mode === "new-plan") await plan(f);
  if (mode === "restart") { await expect(f.create().request({ type: "browser-apply-history-import", planId: p.planId })).rejects.toThrow(/expired/); return; }
  await expect(apply(f, p.planId)).rejects.toThrow(/expired/); expect(f.writes()).toBe(0);
 });
 it.each(["imported", "native"])("rejects stale %s history and consumes the witness", async destination => {
  const f = fixture(), p = await plan(f);
  if (destination === "imported") f.set({ version: 1, entries: [{ id: `visit-${crypto.randomUUID()}`, tabId: `tab-${crypto.randomUUID()}`, ...source().entries[0], title: "External", provenance: "imported" }] });
  else f.native({ entries: [{ ...source().entries[0], title: "External" }], excluded: 0 });
  await expect(apply(f, p.planId)).rejects.toThrow(/changed/); await expect(apply(f, p.planId)).rejects.toThrow(/expired/); expect(f.writes()).toBe(0);
 });
 it("retains worker-owned synchronization status through reads and partial success until a full purge succeeds", async () => {
  const f = fixture(), p = await plan(f); await apply(f, p.planId); f.failWrite();
  const failure = await f.adapter.nativeHistoryRemoved({ allHistory: true, urls: [] });
  expect(failure.ok).toBe(false); expect(f.adapter.getSyncError()).toBe(failure.error);
  await f.adapter.read(); expect(f.adapter.getSyncError()).toBe(failure.error);
  f.failWrite(false);
  expect((await f.adapter.nativeHistoryRemoved({ allHistory: false, urls: [source().entries[0].url] })).ok).toBe(true);
  expect(f.adapter.getSyncError()).toBe(failure.error);
  expect((await f.adapter.nativeHistoryRemoved({ allHistory: true, urls: [] })).ok).toBe(true);
  expect(f.adapter.getSyncError()).toBeUndefined();
 });
 it("retains a partial Kestrel-clear failure until an explicitly successful full clear", async () => {
  const f = fixture(), p = await plan(f); await apply(f, p.planId); f.failClear();
  const failure = await f.adapter.request({ type: "browser-clear-history" });
  expect(failure.ok).toBe(false); expect(f.adapter.getSyncError()).toBe(failure.error);
  await f.adapter.nativeHistoryRemoved({ allHistory: false, urls: [] }); expect(f.adapter.getSyncError()).toBe(failure.error);
  f.failClear(false);
  expect((await f.adapter.request({ type: "browser-clear-history" })).ok).toBe(true);
  expect(f.adapter.getSyncError()).toBeUndefined();
 });
 it("rejects over-capacity current native history without hiding imported entries", async () => {
  const f = fixture(); f.native({ entries: Array.from({ length: 5000 }, (_, i) => ({ ...source().entries[0], url: `https://native.example/${i}` })), excluded: 0 });
  await expect(plan(f)).rejects.toThrow(/5,000/); expect(f.writes()).toBe(0);
  f.native({ entries: [], excluded: 1, truncated: true }); await expect(plan(f)).rejects.toThrow(/5,000/);
 });
 it("keeps imported storage durable while the bounded view follows newest visits and export reports observed exclusions", async () => {
  const f = fixture(); const p = await plan(f); await apply(f, p.planId);
  f.native({ entries: Array.from({ length: 5001 }, (_, i) => ({ ...source().entries[0], url: `https://native.example/${i}`, visitedAt: "2026-01-01T00:00:00Z" })), excluded: 2, truncated: true });
  const entries = await f.adapter.read(); expect(entries).toHaveLength(5000); expect(entries.some((item: any) => item.provenance === "imported")).toBe(false); expect(f.get().entries).toHaveLength(1);
  const exported = await f.adapter.request({ type: "browser-export-history" }); expect(exported.historyExportExcluded).toEqual({ entries: 4, nativeTruncated: true });
 });
 it("clear removes both collections, emits fresh state, and invalidates reviews", async () => {
  const f = fixture(); const p = await plan(f); await apply(f, p.planId); const next = await plan(f);
  const cleared = await f.adapter.request({ type: "browser-clear-history" }); expect(cleared.ok).toBe(true); expect(f.get().entries).toEqual([]); expect(f.clear).toHaveBeenCalledTimes(1); expect(f.emit).toHaveBeenCalledTimes(2);
  await expect(apply(f, next.planId)).rejects.toThrow(/expired/);
 });
 it.each(["native", "storage"])("clear attempts both stores and reports partial %s failure", async which => {
  const f = fixture(); const p = await plan(f); await apply(f, p.planId);
  if (which === "native") f.failClear(); else f.failWrite();
  const result = await f.adapter.request({ type: "browser-clear-history" }); expect(result.ok).toBe(false); expect(result.error).toMatch(/partially/); expect(f.clear).toHaveBeenCalled(); expect(f.writes()).toBe(2); expect(f.emit).toHaveBeenCalledTimes(2);
  expect(f.get().entries.length).toBe(which === "native" ? 0 : 1);
 });
 it.each(["write", "verify"])("storage %s failure never returns success and consumes review", async which => {
  const f = fixture(); const p = await plan(f); if (which === "write") f.failWrite(); else f.mismatch();
  await expect(apply(f, p.planId)).rejects.toThrow(); await expect(apply(f, p.planId)).rejects.toThrow(/expired/); expect(f.writes()).toBe(1);
 });
 it("refuses an oversized merged collection before writing", async () => {
  const f = fixture(); const data = source(); data.entries[0].title = "界".repeat(500);
  data.entries = Array.from({ length: 500 }, (_, i) => ({ ...data.entries[0], url: `https://first.example/${i}` }));
  const p = await plan(f, data); await apply(f, p.planId);
  const more = { ...data, entries: data.entries.map((item: any) => ({ ...item, url: item.url.replace("first", "second") })) };
  await expect(plan(f, more)).rejects.toThrow(/1 MiB/); expect(f.writes()).toBe(1);
 });
 it("expires a review when asynchronous native reading crosses its deadline", async () => {
  let slow = false, time = 1000, writes = 0;
  const f = createNativeHistoryTransfer({ read: async () => ({ version: 1, entries: [] }), write: async () => { writes++; }, readNative: async () => { if (slow) time += 120_000; return { entries: [], excluded: 0 }; }, clearNative: async () => {}, response: async () => ({ ok: true, browserState: {} }), emit: async () => {}, clock: () => time });
  const p = (await f.request({ type: "browser-plan-history-import", data: source() })).historyImportPlan; slow = true;
  await expect(f.request({ type: "browser-apply-history-import", planId: p.planId })).rejects.toThrow(/expired/); expect(writes).toBe(0);
 });
 it("rejects imported storage changed while native snapshot APIs are pending", async () => {
  let changed = false, slow = false, writes = 0;
  const f = createNativeHistoryTransfer({ read: async () => ({ version: 1, entries: changed ? [{ id: `visit-00000000-0000-4000-8000-000000000001`, tabId: `tab-00000000-0000-4000-8000-000000000002`, ...source().entries[0], provenance: "imported" }] : [] }), write: async () => { writes++; }, readNative: async () => { if (slow) changed = true; return { entries: [], excluded: 0 }; }, clearNative: async () => {}, response: async () => ({ ok: true, browserState: {} }), emit: async () => {} });
  const p = (await f.request({ type: "browser-plan-history-import", data: source() })).historyImportPlan; slow = true;
  await expect(f.request({ type: "browser-apply-history-import", planId: p.planId })).rejects.toThrow(/changed/); expect(writes).toBe(0);
 });
 it("preserves long/control native display titles while excluding nonportable original metadata", () => {
  const rows = [{ url: "https://native.example/long", title: "a".repeat(600), lastVisitTime: 0 }, { url: "https://native.example/control", title: "Control\tTitle", lastVisitTime: 0 }];
  const result = normalizeNativeHistory(rows, `tab-${crypto.randomUUID()}`);
  expect(result.entries).toHaveLength(2); expect(result.entries[0].title).toHaveLength(500); expect(result.entries[1].title).toBe("Control\tTitle");
  expect(result.portableEntries).toEqual([]); expect(result.excluded).toBe(2);
 });
 it("serializes review/apply/clear without lost updates or deadlocks", async () => {
  const f = fixture(); const p = await plan(f);
  const [applied, cleared] = await Promise.all([apply(f, p.planId), f.adapter.request({ type: "browser-clear-history" })]);
  expect(applied.ok).toBe(true); expect(cleared.ok).toBe(true); expect(f.get().entries).toEqual([]); expect(f.writes()).toBe(2);
 });
 it("filters unsafe native rows with an explicit exclusion count and never calls addUrl", () => {
  const valid = { url: "https://example.com/", title: "Native", lastVisitTime: 0 };
  const result = normalizeNativeHistory([valid, { ...valid, url: "https://user:secret@example.com/" }, { ...valid, lastVisitTime: 1e100 }, { ...valid, lastVisitTime: undefined }], `tab-${crypto.randomUUID()}`);
  expect(result.entries).toHaveLength(4); expect(result.portableEntries).toHaveLength(1); expect(result.entries[0].visitedAt).toBe("1970-01-01T00:00:00.000Z"); expect(result.excluded).toBe(3);
  const implementation = readFileSync(new URL("./history-transfer.mjs", import.meta.url), "utf8");
  expect(implementation).not.toMatch(/addUrl|fetch\(|sqlite/i);
 });
});
