import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ BrowserWindow: class {}, screen: {} }));
import { tabPreviewHtml } from "./tab-preview-window";
import { createEmptyBrowserTab } from "./browser-tab-store";

describe("tab preview content", () => {
 it("shows only current resource icons and sleeping estimates", () => {
  const tab = { ...createEmptyBrowserTab(), title: "Notes", activity: { microphone: true, camera: false }, estimatedSavedMemoryBytes: 104857600 };
  const awake = tabPreviewHtml(tab);
  expect(awake).toContain('data-label="Using microphone"');
  expect(awake).not.toContain('data-label="Using camera"');
  expect(awake).not.toContain("100 MB saved");
  expect(tabPreviewHtml({ ...tab, discarded: true })).toContain("100 MB saved");
  expect(tabPreviewHtml({ ...tab, discarded: true, estimatedSavedMemoryBytes: undefined })).not.toContain("MB saved");
 });
 it("escapes page titles and rejects executable image URLs", () => {
  const html = tabPreviewHtml({ ...createEmptyBrowserTab(), title: '<img src=x onerror="alert(1)">', preview: { image: "javascript:alert(1)", capturedAt: new Date().toISOString() } });
  expect(html).not.toContain('<img src=x');
  expect(html).not.toContain('src="javascript:');
  expect(html).toContain("&lt;img");
  expect(html).toContain("No snapshot yet");
 });
});
