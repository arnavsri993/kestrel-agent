import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { BrowserContext, Page } from "playwright";
import { ChromiumTabManager, browserEvidenceUrl } from "./tab-manager";
class TestPage extends EventEmitter {
  closed = false;
  isClosed() { return this.closed; }
  async close() { this.closed = true; this.emit("close"); }
  url() { return "https://example.com/"; }
  async title() { return "Example"; }
  async bringToFront() {}
  mainFrame() { return this; }
}
describe("Chromium tab ownership", () => {
  it("bounds observations, excludes field values and refuses missing or cancelled reads", async () => {
    const context = new EventEmitter() as any;
    const shell = new TestPage();
    const page = new TestPage();
    const detach = vi.fn(async () => {});
    context.pages = () => [shell, page];
    context.newCDPSession = async () => ({
      send: async () => ({ nodes: [
        { role: { value: "textbox" }, name: { value: "Password" }, value: { value: "secret" } },
        { ignored: true, role: { value: "StaticText" }, name: { value: "hidden" } },
        ...Array.from({ length: 501 }, () => ({ role: { value: "heading" }, name: { value: "Visible evidence" } })),
      ] }), detach,
    });
    const manager = new ChromiumTabManager(context, shell as unknown as Page, () => {});
    const [tab] = await manager.snapshot();
    const result = await manager.readSnapshot(tab!.id, new AbortController().signal);
    expect(result.accessibilityTree).toHaveLength(500);
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/secret|hidden|Password/);
    expect(detach).toHaveBeenCalledOnce();
    await expect(manager.readSnapshot(undefined, new AbortController().signal)).rejects.toThrow("Choose a tab");
    await expect(manager.readSnapshot(tab!.id, AbortSignal.abort())).rejects.toThrow();
    await manager.close(tab!.id);
    await expect(manager.readSnapshot(tab!.id, new AbortController().signal)).rejects.toThrow("closed");
  });
  it("strips sensitive URL metadata from model evidence", () => {
    expect(browserEvidenceUrl("https://example.com/page?token=private#secret")).toBe("https://example.com/page");
    expect(browserEvidenceUrl("file:///private/data")).toBe("");
    expect(browserEvidenceUrl("https://name:password@example.com/")).toBe("");
  });

  it("excludes the shell, deduplicates pages, bounds popups and releases capacity on close", async () => {
    const context = new EventEmitter() as EventEmitter & { pages: () => Page[] };
    const shell = new TestPage();
    context.pages = () => [shell as unknown as Page];
    const changed = vi.fn();
    const manager = new ChromiumTabManager(context as unknown as BrowserContext, shell as unknown as Page, changed, 1);
    const first = new TestPage();
    context.emit("page", first);
    context.emit("page", first);
    expect(await manager.snapshot()).toHaveLength(1);
    const excess = new TestPage();
    context.emit("page", excess);
    expect(excess.closed).toBe(true);
    expect(await manager.snapshot()).toHaveLength(1);
    const [tab] = await manager.snapshot();
    await manager.close(tab!.id);
    expect(await manager.snapshot()).toEqual([]);
    await expect(manager.focus(tab!.id)).rejects.toThrow("closed");
    const replacement = new TestPage();
    context.emit("page", replacement);
    expect(replacement.closed).toBe(false);
    expect(await manager.snapshot()).toHaveLength(1);
    expect(changed).toHaveBeenCalledTimes(3);
  });
});
