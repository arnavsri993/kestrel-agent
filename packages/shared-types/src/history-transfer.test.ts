import { describe, expect, it } from "vitest";
import { NativeHistoryTransferSchema, RendererRequestSchema, UserBrowserSettingsSchema, parseNativeHistoryTransferFile } from "./contracts";
const entry = () => ({ url: "https://example.com/Original", title: "Original title", visitedAt: "2020-01-01T00:00:00Z" });
const valid = () => ({ format: "kestrel-history", version: 1, entries: [entry()] });
const legacy = () => ({ format: "kestrel-browser-data", version: 1, exportedAt: "2026-01-01T00:00:00Z", bookmarks: [{ id: "bookmark-00000000-0000-4000-8000-000000000001", url: "https://example.com/", title: "Example", createdAt: "2020-01-01T00:00:00Z" }], bookmarkFolders: [], history: [{ ...entry(), id: "visit-00000000-0000-4000-8000-000000000002", tabId: "tab-00000000-0000-4000-8000-000000000003" }], sitePermissions: [{ origin: "https://example.com", permission: "camera", decision: "allow", updatedAt: "2020-01-01T00:00:00Z" }], settings: UserBrowserSettingsSchema.parse({}) });
describe("strict native history transfer files", () => {
 it("accepts standalone history and extracts full validated legacy data with explicit exclusions", () => {
  expect(parseNativeHistoryTransferFile(valid())).toEqual({ data: valid(), source: "native", excluded: { bookmarks: 0, sitePermissions: 0, settings: false } });
  expect(parseNativeHistoryTransferFile(legacy())).toEqual({ data: valid(), source: "browser-data", excluded: { bookmarks: 1, sitePermissions: 1, settings: true } });
 });
 it.each([
  ["credentials", (v: any) => { v.entries[0].url = "https://name:secret@example.com/"; }],
  ["controls", (v: any) => { v.entries[0].url = "https://exam\nple.com/"; }],
  ["file URL", (v: any) => { v.entries[0].url = "file:///private/file"; }],
  ["URL size", (v: any) => { v.entries[0].url += "a".repeat(8192); }],
  ["date", (v: any) => { v.entries[0].visitedAt = "not a date"; }],
  ["blank title", (v: any) => { v.entries[0].title = ""; }],
  ["title controls", (v: any) => { v.entries[0].title = "bad\tname"; }],
  ["title size", (v: any) => { v.entries[0].title = "a".repeat(501); }],
  ["identity", (v: any) => { v.entries[0].id = "native-id"; }],
  ["cookies", (v: any) => { v.cookies = []; }],
  ["row capacity", (v: any) => { v.entries = Array.from({ length: 5001 }, entry); }],
  ["UTF8 capacity", (v: any) => { v.entries = Array.from({ length: 1000 }, () => ({ ...entry(), title: "界".repeat(500) })); }],
 ])("rejects %s without dropping or fixing entries", (_name, mutate) => {
  const value = valid(); mutate(value); expect(() => parseNativeHistoryTransferFile(value)).toThrow();
 });
 it("allows exactly 5000 small records and refuses invalid full legacy payloads before extraction", () => {
  expect(NativeHistoryTransferSchema.safeParse({ ...valid(), entries: Array.from({ length: 5000 }, entry) }).success).toBe(true);
  for (const change of [(v: any) => { v.cookies = []; }, (v: any) => { v.bookmarks[0].createdAt = "invalid"; }, (v: any) => { v.settings.startupBehavior = "unknown"; }, (v: any) => { v.settings.token = "secret"; }, (v: any) => { v.settings.newTabWidgets = { version: 1, enabled: ["bad-widget"], layouts: {} }; }, (v: any) => { v.bookmarks[0].token = "secret"; }]) {
   const v = legacy(); change(v); expect(() => parseNativeHistoryTransferFile(v)).toThrow();
  }
 });
 it("refuses source files over 10 MiB even when excluded data causes the excess", () => {
  const v = { ...legacy(), extra: "x".repeat(10 * 1024 * 1024) };
  expect(() => parseNativeHistoryTransferFile(v)).toThrow(/10 MiB/);
 });
 it("exposes strict request shapes and forbids apply-time payload substitution", () => {
  expect(RendererRequestSchema.safeParse({ type: "browser-plan-history-import", data: valid() }).success).toBe(true);
  for (const type of ["browser-apply-history-import", "browser-discard-history-import"]) {
   const request = { type, planId: "00000000-0000-4000-8000-000000000000" };
   expect(RendererRequestSchema.safeParse(request).success).toBe(true);
   expect(RendererRequestSchema.safeParse({ ...request, data: valid() }).success).toBe(false);
  }
 });
});
