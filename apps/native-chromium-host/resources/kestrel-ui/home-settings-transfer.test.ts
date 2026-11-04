import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeHomeSettingsTransfer } from "./home-settings-transfer.mjs";
afterEach(() => vi.useRealTimers());
function fixture(initial: Record<string, unknown> = {}) {
 let stored = structuredClone(initial), writes = 0, fail = false, mismatch = false;
 const create = () => createNativeHomeSettingsTransfer({ read: async () => structuredClone(stored), write: async (next: any) => { writes++; if (fail) throw Error("sensitive storage error"); stored = structuredClone(next); if (mismatch) stored.newTabBackground = "dawn"; }, emit: async () => {}, response: async () => ({ ok: true, browserState: {} }) });
 const request = create();
 return { request, create, get: () => stored, set: (value: any) => { stored = structuredClone(value); }, writes: () => writes, fail: () => { fail = true; }, mismatch: () => { mismatch = true; } };
}
const plan = async (f: ReturnType<typeof fixture>, settings: any, categories = ["background"]) => (await f.request({ type: "browser-plan-home-settings-import", settings, categories })).homeSettingsImportPlan;
const apply = (f: ReturnType<typeof fixture>, planId: string) => f.request({ type: "browser-apply-home-settings-import", planId });
describe("native Home settings reviewed writes", () => {
 it("preview/cancel do not write and a stale discard cannot cancel a newer review", async () => {
  const f = fixture({ newTabBackground: "graphite", compatibility: { keep: true } });
  const first = await plan(f, { newTabBackground: "paper" }), second = await plan(f, { newTabBackground: "meadow" });
  await f.request({ type: "browser-discard-home-settings-import", planId: first.planId });
  expect(f.writes()).toBe(0); await apply(f, second.planId); expect(f.get().newTabBackground).toBe("meadow");
  const third = await plan(f, { newTabBackground: "paper" });
  await f.request({ type: "browser-discard-home-settings-import", planId: third.planId });
  await expect(apply(f, third.planId)).rejects.toThrow(/expired/); expect(f.writes()).toBe(1);
 });
 it("changes only selected present keys, preserves unknown metadata, and does not expose activity/image values in receipts", async () => {
  const f = fixture({ newTabBackground: "graphite", newTabWidgets: { keep: true }, compatibility: { keep: true } });
  const p = await plan(f, { newTabBackground: "paper", newTabShortcuts: [{ title: "Private title", url: "https://private.example/" }] }, ["shortcuts"]);
  expect(JSON.stringify(p)).not.toContain("Private"); expect(p.changedCategories).toEqual(["shortcuts"]);
  const r = await apply(f, p.planId); expect(JSON.stringify(r.homeSettingsImportResult)).not.toContain("private.example");
  expect(f.get()).toEqual({ newTabBackground: "graphite", newTabWidgets: { keep: true }, compatibility: { keep: true }, newTabShortcuts: [{ title: "Private title", url: "https://private.example/" }] });
 });
 it("refuses a changed destination and consumes the review without replay", async () => {
  const f = fixture({ newTabBackground: "graphite" }); const p = await plan(f, { newTabBackground: "paper" });
  f.set({ newTabBackground: "meadow" }); await expect(apply(f, p.planId)).rejects.toThrow(/changed/);
  f.set({ newTabBackground: "graphite" }); await expect(apply(f, p.planId)).rejects.toThrow(/expired/); expect(f.writes()).toBe(0);
 });
 it("requires fresh tokens after expiry and worker restart", async () => {
  vi.useFakeTimers(); const f = fixture(); const p = await plan(f, { newTabBackground: "paper" });
  vi.advanceTimersByTime(120_000); await expect(apply(f, p.planId)).rejects.toThrow(/expired/);
  const next = await plan(f, { newTabBackground: "paper" }); await expect(f.create()({ type: "browser-apply-home-settings-import", planId: next.planId })).rejects.toThrow(/expired/); expect(f.writes()).toBe(0);
 });
 it("undo restores missing key presence and preserves later unrelated edits", async () => {
  const f = fixture({ compatibility: true }); const p = await plan(f, { newTabBackground: "paper" }); const r = await apply(f, p.planId);
  f.set({ ...f.get(), newTabShortcuts: [], compatibility: "newer" });
  await f.request({ type: "browser-undo-home-settings-import", undoId: r.homeSettingsImportResult.undoId });
  expect(f.get()).toEqual({ newTabShortcuts: [], compatibility: "newer" });
  await expect(f.request({ type: "browser-undo-home-settings-import", undoId: r.homeSettingsImportResult.undoId })).rejects.toThrow(/expired/);
 });
 it("undo refuses newer selected settings and cannot be replayed", async () => {
  const f = fixture(); const p = await plan(f, { newTabBackground: "paper" }); const r = await apply(f, p.planId);
  f.set({ newTabBackground: "meadow" }); await expect(f.request({ type: "browser-undo-home-settings-import", undoId: r.homeSettingsImportResult.undoId })).rejects.toThrow(/changed/);
  expect(f.get().newTabBackground).toBe("meadow"); expect(f.writes()).toBe(1);
 });
 it.each(["fail", "mismatch"] as const)("returns uncertainty without a retry or undo token on %s", async mode => {
  const f = fixture(); const p = await plan(f, { newTabBackground: "paper" }); f[mode]();
  await expect(apply(f, p.planId)).rejects.toThrow(/uncertain/); await expect(apply(f, p.planId)).rejects.toThrow(/expired/); expect(f.writes()).toBe(1);
 });
 it("refuses oversized merged storage before writing", async () => {
  const f = fixture({ compatibility: "x".repeat(8 * 1024 * 1024) }); const p = await plan(f, { newTabBackground: "paper" });
  await expect(apply(f, p.planId)).rejects.toThrow(/capacity/); expect(f.writes()).toBe(0);
 });
 it.each([{ categories: ["not-in-file"] }, { categories: [] }, { categories: ["background", "background"] }])("refuses unavailable or duplicate categories $categories", async ({ categories }) => {
  const f = fixture(); await expect(plan(f, { newTabBackground: "paper" }, categories)).rejects.toThrow(/Choose/); expect(f.writes()).toBe(0);
 });
});
