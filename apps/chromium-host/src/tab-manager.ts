import { randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "playwright";
import { browserUrl } from "./bridge-policy";

/** Owns every web page in the context, including target=_blank and window.open. */
export class ChromiumTabManager {
  private readonly pages = new Map<string, Page>();
  private readonly ids = new WeakMap<Page, string>();
  constructor(private readonly context: BrowserContext, private readonly shell: Page, private readonly changed: () => void, private readonly limit = 16) {
    context.on("page", this.register);
    for (const page of context.pages()) this.register(page);
  }
  private readonly register = (page: Page): void => {
    if (page === this.shell || this.ids.has(page) || page.isClosed()) return;
    if (this.pages.size >= this.limit) { void page.close().catch(() => {}); return; }
    const id = randomUUID();
    this.ids.set(page, id);
    this.pages.set(id, page);
    page.on("close", () => { this.pages.delete(id); this.changed(); });
    page.on("domcontentloaded", this.changed);
    page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) this.changed(); });
    this.changed();
  };
  async snapshot() {
    return Promise.all([...this.pages].map(async ([id, page]) => ({
      id, url: page.url(), title: await page.title().catch(() => "Browser tab"),
    })));
  }
  async open(value: string): Promise<string> {
    const url = browserUrl(value);
    if (this.pages.size >= this.limit) throw new Error("Close a browser tab before opening another.");
    const page = await this.context.newPage();
    this.register(page);
    const id = this.ids.get(page);
    if (!id || page.isClosed()) throw new Error("The browser tab limit was reached.");
    try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }); }
    catch { await page.close().catch(() => {}); throw new Error("Could not open that URL."); }
    await page.bringToFront();
    return id;
  }
  async focus(id: string): Promise<void> {
    const page = this.pages.get(id);
    if (!page) throw new Error("This tab is closed.");
    await page.bringToFront();
  }
  async close(id: string): Promise<void> { await this.pages.get(id)?.close(); }
}
