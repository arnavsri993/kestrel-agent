import { randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "playwright";
import { safeFormTarget, type FormAction, type FormTarget } from "./browser-target-policy";
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
  private readonly targets = new Map<string, Map<string, FormTarget>>();
  private readonly refs = new Map<string, Map<number, string>>();
  private nextRef = 1;
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
    page.on("close", () => { this.pages.delete(id); this.targets.delete(id); this.refs.delete(id); this.changed(); });
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
    const revision = this.revisions.get(page) ?? 0;
    browserUrl(url); // Never read shell, file, browser-internal, or data pages.
    const client = await this.context.newCDPSession(page);
    try {
      const { nodes } = await client.send("Accessibility.getFullAXTree");
      signal.throwIfAborted();
      const title = await page.title();
      signal.throwIfAborted();
      if (page.url() !== url || this.revisions.get(page) !== revision) throw new Error("The tab navigated while being read. Read it again.");
      // Return accessible names and roles only: no input values, DOM, cookies,
      // hidden nodes, backend IDs, or executable page handles cross this boundary.
      const tree: { role: string; name: string; ref?: string }[] = [];
      const interactive: { ref: string; role: string; name: string }[] = [];
      const targets = new Map<string, FormTarget>();
      const refs = this.refs.get(id) ?? new Map<number, string>();
      this.refs.set(id, refs);
      let remaining = 60_000;
      let truncated = false;
      // Chromium may expose a text field's value again as descendant StaticText.
      // Omitting the AX value property alone does not redact those descendants.
      const byNodeId = new Map(nodes.map((node) => [node.nodeId, node]));
      const fieldDescendants = new Set<string>();
      const omitDescendants = (nodeId: string) => {
        if (fieldDescendants.has(nodeId)) return;
        fieldDescendants.add(nodeId);
        for (const child of byNodeId.get(nodeId)?.childIds ?? []) omitDescendants(child);
      };
      for (const node of nodes) {
        if (["textbox", "searchbox", "combobox"].includes(String(node.role?.value)) || node.properties?.some((property) => String(property.name) === "protected" && property.value.value)) {
          for (const child of node.childIds ?? []) omitDescendants(child);
        }
      }
      for (const node of nodes) {
        if (fieldDescendants.has(node.nodeId)) continue;
        if (node.ignored || node.properties?.some((property) => String(property.name) === "protected" && property.value.value)) continue;
        const role = String(node.role?.value ?? "");
        const name = String(node.name?.value ?? "");
        if (!name || ["RootWebArea", "WebArea", "combobox"].includes(role)) continue;
        if (tree.length >= 500 || remaining <= 0) { truncated = true; break; }
        const bounded = name.slice(0, Math.min(2_000, remaining));
        if (bounded.length < name.length) truncated = true;
        let ref: string | undefined;
        if (["textbox", "searchbox", "button"].includes(role) && node.backendDOMNodeId && interactive.length < 200) {
          const { node: dom } = await client.send("DOM.describeNode", { backendNodeId: node.backendDOMNodeId });
          const attrs: Record<string, string> = {};
          for (let i = 0; i < (dom.attributes?.length ?? 0); i += 2) attrs[dom.attributes![i]!] = dom.attributes![i + 1]!;
          const metadata = { tag: dom.nodeName, inputType: (attrs.type ?? "").toLowerCase(), autocomplete: (attrs.autocomplete ?? "").toLowerCase(), name: bounded };
          if (role !== "button" && !safeFormTarget(metadata)) continue;
          if (role === "button" && dom.nodeName !== "BUTTON") continue;
          ref = refs.get(node.backendDOMNodeId);
          if (!ref && this.nextRef <= 99_999) { ref = `e${this.nextRef++}`; refs.set(node.backendDOMNodeId, ref); }
          if (ref) {
            targets.set(ref, { ref, backendId: node.backendDOMNodeId, role, revision, ...metadata });
            interactive.push({ ref, role, name: bounded });
          }
        }
        if (["textbox", "searchbox"].includes(role) && !ref) continue;
        tree.push({ role: role.slice(0, 80), name: bounded, ...(ref ? { ref } : {}) });
        remaining -= bounded.length;
      }
      signal.throwIfAborted();
      if (page.url() !== url || this.revisions.get(page) !== revision) throw new Error("The tab changed while being inspected.");
      this.targets.set(id, targets);
      return { interactive, url: browserEvidenceUrl(url), title: title.slice(0, 500), accessibilityTree: tree, truncated, trust: "untrusted_browser" as const };
    } finally { await client.detach().catch(() => {}); }
  }

  inspectedTarget(id: string, action: FormAction): FormTarget {
    const page = this.pages.get(id);
    const target = this.targets.get(id)?.get(action.target);
    if (!page || !target || target.revision !== this.revisions.get(page)) throw new Error("Inspect this page again before proposing an action.");
    if (action.type === "type" ? !safeFormTarget(target) : target.tag !== "BUTTON") throw new Error("This target does not support that action.");
    return { ...target };
  }

  async act(id: string, action: FormAction, approved: FormTarget, signal: AbortSignal) {
    signal.throwIfAborted();
    await this.readSnapshot(id, signal);
    const current = this.inspectedTarget(id, action);
    if (JSON.stringify(current) !== JSON.stringify(approved)) throw new Error("The approved field changed. Inspect the page and request approval again.");
    const page = this.pages.get(id)!;
    browserUrl(page.url());
    const client = await this.context.newCDPSession(page);
    try {
      const { object } = await client.send("DOM.resolveNode", { backendNodeId: approved.backendId });
      if (!object.objectId) throw new Error("The approved element is no longer available.");
      signal.throwIfAborted();
      // Fixed host code, never model-provided script. Validate and mutate the
      // exact inspected node in one browser turn; do not retarget a selector.
      const result = await client.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: `function(action, expected) {
          if (!this.isConnected || this.ownerDocument !== document || this.disabled || this.readOnly || this.hidden || this.getAttribute('aria-disabled') === 'true' || this.getClientRects().length === 0 || getComputedStyle(this).visibility !== 'visible') throw new Error('The approved element is unavailable.');
          if (this.tagName !== expected.tag || (this.getAttribute('type') || '').toLowerCase() !== expected.inputType || (this.getAttribute('autocomplete') || '').toLowerCase() !== expected.autocomplete) throw new Error('The approved element changed.');
          if (action.type === 'click') { if (this.tagName !== 'BUTTON') throw new Error('Only inspected buttons can be clicked.'); this.click(); return { dispatched: true }; }
          const prototype = this.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
          setter.call(this, action.text);
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return { valueMatches: this.isConnected && this.value === action.text };
        }`,
        arguments: [{ value: action }, { value: approved }], returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error("The approved element changed or refused the action. Inspect the page before retrying.");
      if (action.type === "type" && result.result.value?.valueMatches !== true) throw new Error("The field did not retain the approved text. The result is uncertain; inspect before retrying.");
      signal.throwIfAborted();
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
