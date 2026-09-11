import { randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "playwright";
import { browserUrl } from "./bridge-policy";

export function browserEvidenceUrl(value: string): string {
  try {
    const url = new URL(browserUrl(value));
    url.search = "";
    url.hash = "";
    return url.href;
  } catch { return ""; }
}

/** Owns every web page in the context, including target=_blank and window.open. */
export class ChromiumTabManager {
  private readonly pages = new Map<string, Page>();
  private readonly revisions = new WeakMap<Page, number>();
  private readonly ids = new WeakMap<Page, string>();
  constructor(private readonly context: BrowserContext, private readonly shell: Page, private readonly changed: () => void, private readonly limit = 16) {
    context.on("page", this.register);
    for (const page of context.pages()) this.register(page);
  }
  private readonly register = (page: Page): void => {
    if (page === this.shell || this.ids.has(page) || page.isClosed()) return;
    if (this.pages.size >= this.limit) { void page.close().catch(() => {}); return; }
    const id = `tab-${randomUUID()}`;
    this.ids.set(page, id);
    this.revisions.set(page, 0);
    this.pages.set(id, page);
    page.on("close", () => { this.pages.delete(id); this.changed(); });
    page.on("domcontentloaded", this.changed);
    page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) { this.revisions.set(page, (this.revisions.get(page) ?? 0) + 1); this.changed(); } });
    this.changed();
  };
  async snapshot() {
    return Promise.all([...this.pages].map(async ([id, page]) => ({
      id, revision: this.revisions.get(page) ?? 0, url: page.url(), title: await page.title().catch(() => "Browser tab"),
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
  async readSnapshot(id: string | undefined, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!id) throw new Error("Choose a tab ID from browser.tabs before reading a page.");
    const page = this.pages.get(id);
    if (!page || page.isClosed()) throw new Error("This tab is closed.");
    const url = page.url();
    browserUrl(url); // Never read shell, file, browser-internal, or data pages.
    const client = await this.context.newCDPSession(page);
    try {
      const { nodes } = await client.send("Accessibility.getFullAXTree");
      signal.throwIfAborted();
      const title = await page.title();
      signal.throwIfAborted();
      if (page.url() !== url) throw new Error("The tab navigated while being read. Read it again.");
      // Return accessible names and roles only: no input values, DOM, cookies,
      // hidden nodes, backend IDs, or executable page handles cross this boundary.
      const tree: { role: string; name: string }[] = [];
      let remaining = 60_000;
      let truncated = false;
      for (const node of nodes) {
        if (node.ignored || node.properties?.some((property) => String(property.name) === "protected" && property.value.value)) continue;
        const role = String(node.role?.value ?? "");
        const name = String(node.name?.value ?? "");
        if (!name || ["RootWebArea", "WebArea", "textbox", "searchbox", "combobox"].includes(role)) continue;
        if (tree.length >= 500 || remaining <= 0) { truncated = true; break; }
        const bounded = name.slice(0, Math.min(2_000, remaining));
        if (bounded.length < name.length) truncated = true;
        tree.push({ role: role.slice(0, 80), name: bounded });
        remaining -= bounded.length;
      }
      return { url: browserEvidenceUrl(url), title: title.slice(0, 500), accessibilityTree: tree, truncated, trust: "untrusted_browser" as const };
    } finally { await client.detach().catch(() => {}); }
  }

  async navigate(id: string, input: string, expectedUrl: string, expectedRevision: number, signal: AbortSignal) {
    signal.throwIfAborted();
    const url = browserUrl(input);
    const page = this.pages.get(id);
    if (!page || page.isClosed() || page.url() !== expectedUrl || this.revisions.get(page) !== expectedRevision) throw new Error("The approved tab changed. Request a new navigation approval.");
    browserUrl(page.url());
    // Navigation is dispatched once. Failure after dispatch is not a retry grant.
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    signal.throwIfAborted();
    browserUrl(page.url());
  }

  async focus(id: string): Promise<void> {
    const page = this.pages.get(id);
    if (!page) throw new Error("This tab is closed.");
    await page.bringToFront();
  }
  async close(id: string): Promise<void> { await this.pages.get(id)?.close(); }
}
