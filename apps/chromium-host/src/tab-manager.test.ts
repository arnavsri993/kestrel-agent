import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { BrowserContext, Page } from "playwright";
import { ChromiumTabManager } from "./tab-manager";
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
