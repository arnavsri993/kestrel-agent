import { describe, expect, it } from "vitest";
import { homeShortcuts, normalizeShortcutUrl } from "./home-shortcuts";
import { UserBrowserSettingsSchema } from "@kestrel/shared-types";
describe("home shortcuts", () => {
 it("normalizes sites and rejects active schemes and embedded secrets", () => {
  expect(normalizeShortcutUrl("example.com/path")).toBe("https://example.com/path");
  for (const value of ["javascript:alert(1)", "file:///tmp/a", "https://user:pass@example.com", ""]) expect(normalizeShortcutUrl(value)).toBeNull();
 });
 it("keeps explicit pages ahead of frequent origins without duplicate sites", () => {
  const result = homeShortcuts([{ title: "Work", url: "https://example.com/work" }], [{ origin: "https://example.com", url: "https://example.com/", title: "Example", hostname: "example.com", visits: 20, lastVisitedAt: "2026-09-12" }]);
  expect(result).toHaveLength(1); expect(result[0]?.title).toBe("Work");
 });
 it("preserves compatibility and validates persisted shortcuts", () => {
  expect(UserBrowserSettingsSchema.parse({}).newTabShortcuts).toBeUndefined();
  expect(UserBrowserSettingsSchema.safeParse({ newTabShortcuts: [{ title: "Bad", url: "javascript:alert(1)" }] }).success).toBe(false);
 });
});
