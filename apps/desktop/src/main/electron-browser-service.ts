import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, desktopCapturer, session as electronSession, systemPreferences, type Session } from "electron";
import type { BrowserAction, BrowserDiagnostic, BrowserDownload, BrowserSnapshot, BrowserViewport, DesktopAction, ScreenshotFrame } from "@kestrel/agent-core";

export type BrowserBackendWireRequest =
  | { operation: "create"; allowedOrigins: string[] }
  | { operation: "navigate"; sessionId: string; url: string }
  | { operation: "act"; sessionId: string; action: BrowserAction }
  | { operation: "snapshot"; sessionId: string }
  | { operation: "screenshot"; sessionId: string }
  | { operation: "viewport"; sessionId: string; viewport: BrowserViewport }
  | { operation: "diagnostics"; sessionId: string }
  | { operation: "auth-handoff"; sessionId: string; visible: boolean }
  | { operation: "upload"; sessionId: string; selector: string; paths: string[] }
  | { operation: "downloads"; sessionId: string }
  | { operation: "desktop-screenshot" }
  | { operation: "desktop-act"; action: DesktopAction }
  | { operation: "close"; sessionId: string };

interface BrowserRecord { window: BrowserWindow; partition: Session; allowedOrigins: Set<string>; diagnostics: BrowserDiagnostic[]; downloads: BrowserDownload[]; downloadDirectory: string; }

function origin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "about:") return undefined;
    return url.origin;
  } catch { return "invalid"; }
}

export class ElectronBrowserService {
  private readonly sessions = new Map<string, BrowserRecord>();

  async handle(request: BrowserBackendWireRequest, signal: AbortSignal): Promise<unknown> {
    if (request.operation === "create") return this.create(request.allowedOrigins);
    if (request.operation === "navigate") return this.navigate(request.sessionId, request.url, signal);
    if (request.operation === "act") return this.act(request.sessionId, request.action, signal);
    if (request.operation === "snapshot") return this.snapshot(request.sessionId, signal);
    if (request.operation === "screenshot") return this.screenshot(request.sessionId, signal);
    if (request.operation === "viewport") return this.setViewport(request.sessionId, request.viewport, signal);
    if (request.operation === "diagnostics") return this.diagnostics(request.sessionId, signal);
    if (request.operation === "auth-handoff") return this.authHandoff(request.sessionId, request.visible, signal);
    if (request.operation === "upload") return this.upload(request.sessionId, request.selector, request.paths, signal);
    if (request.operation === "downloads") return this.downloads(request.sessionId, signal);
    if (request.operation === "desktop-screenshot") return this.desktopScreenshot(signal);
    if (request.operation === "desktop-act") return this.desktopAct(request.action, signal);
    return this.close(request.sessionId);
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.close(id);
  }

  private async create(allowedOrigins: string[]): Promise<string> {
    const id = `electron-browser-${randomUUID()}`;
    const partitionName = `kestrel-isolated-${randomUUID()}`;
    const partition = electronSession.fromPartition(partitionName, { cache: false });
    const allowed = new Set(allowedOrigins);
    const diagnostics: BrowserDiagnostic[] = [];
    const downloads: BrowserDownload[] = [];
    const downloadDirectory = join(app.getPath("userData"), "browser-downloads", id);
    mkdirSync(downloadDirectory, { recursive: true, mode: 0o700 });
    const recordDiagnostic = (diagnostic: BrowserDiagnostic) => { diagnostics.push(diagnostic); if (diagnostics.length > 2_000) diagnostics.splice(0, diagnostics.length - 2_000); };
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    partition.setPermissionCheckHandler(() => false);
    partition.webRequest.onBeforeRequest((details, callback) => {
      const requestedOrigin = origin(details.url);
      callback({ cancel: requestedOrigin !== undefined && !allowed.has(requestedOrigin) });
    });
    partition.webRequest.onErrorOccurred((details) => recordDiagnostic({ kind: "network", level: "error", message: `${details.error} (${details.resourceType})`.slice(0, 2_000), url: details.url.slice(0, 4_000), timestamp: new Date().toISOString() }));
    partition.on("will-download", (_event, item) => {
      const id = `download-${randomUUID()}`;
      const filename = item.getFilename().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120) || `${id}.bin`;
      const destination = join(downloadDirectory, filename);
      const record: BrowserDownload = { id, filename, bytes: 0, status: "progressing", createdAt: new Date().toISOString() };
      downloads.push(record); item.setSavePath(destination);
      item.on("updated", () => { record.bytes = item.getReceivedBytes(); if (item.getTotalBytes() > 100_000_000 || record.bytes > 100_000_000) item.cancel(); });
      item.once("done", (_doneEvent, state) => {
        record.bytes = item.getReceivedBytes();
        record.status = state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "failed";
        if (record.status === "completed" && statSync(destination).isFile()) record.sha256 = createHash("sha256").update(readFileSync(destination)).digest("hex");
      });
    });
    const window = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      webPreferences: { partition: partitionName, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, javascript: true, devTools: false }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => { const requestedOrigin = origin(url); if (requestedOrigin !== undefined && !allowed.has(requestedOrigin)) event.preventDefault(); });
    window.webContents.on("console-message", (_event, level, message, _line, sourceId) => {
      if (level < 2) return;
      recordDiagnostic({ kind: "console", level: level >= 3 ? "error" : "warning", message: String(message).slice(0, 2_000), ...(sourceId ? { url: String(sourceId).slice(0, 4_000) } : {}), timestamp: new Date().toISOString() });
    });
    this.sessions.set(id, { window, partition, allowedOrigins: allowed, diagnostics, downloads, downloadDirectory });
    return id;
  }

  private require(id: string): BrowserRecord {
    const record = this.sessions.get(id);
    if (!record || record.window.isDestroyed()) throw new Error("Electron browser session is unavailable.");
    return record;
  }

  private async navigate(id: string, url: string, signal: AbortSignal): Promise<void> {
    const { window, allowedOrigins } = this.require(id);
    let requested: URL;
    try {
      requested = new URL(url);
    } catch {
      throw new Error("Electron browser navigation is outside the origin allowlist.");
    }
    if (!allowedOrigins.has(requested.origin)) throw new Error("Electron browser navigation is outside the origin allowlist.");
    const abort = () => window.webContents.stop();
    signal.addEventListener("abort", abort, { once: true });
    try {
      await window.loadURL(url);
      if (signal.aborted) throw signal.reason;
    } finally { signal.removeEventListener("abort", abort); }
  }

  private async targetPoint(window: BrowserWindow, selector: string, focus = false): Promise<{ x: number; y: number }> {
    if (!selector || selector.length > 2_000) throw new Error("Browser selector is invalid.");
    const result = await window.webContents.executeJavaScript(`(async () => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!(node instanceof Element)) throw new Error("Browser target was not found.");
      node.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const box = node.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const styles = [];
      for (let current = node; current; current = current.parentElement) styles.push(getComputedStyle(current));
      if (
        !Number.isFinite(box.left) ||
        !Number.isFinite(box.top) ||
        !Number.isFinite(box.width) ||
        !Number.isFinite(box.height) ||
        box.width <= 0 ||
        box.height <= 0 ||
        styles.some((style) =>
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          style.contentVisibility === "hidden" ||
          Number(style.opacity) <= 0
        )
      ) throw new Error("Browser target is not visible.");
      if (node.matches(":disabled") || node.getAttribute("aria-disabled") === "true") {
        throw new Error("Browser target is disabled.");
      }
      const left = Math.max(0, box.left);
      const top = Math.max(0, box.top);
      const right = Math.min(viewportWidth, box.right);
      const bottom = Math.min(viewportHeight, box.bottom);
      if (right <= left || bottom <= top) throw new Error("Browser target is outside the viewport.");
      const x = left + (right - left) / 2;
      const y = top + (bottom - top) / 2;
      const hit = document.elementFromPoint(x, y);
      if (!(hit instanceof Element) || (hit !== node && !node.contains(hit))) {
        throw new Error("Browser target is obscured or cannot receive pointer input.");
      }
      ${focus ? "if (typeof node.focus === \"function\") node.focus({ preventScroll: true });" : ""}
      return { x, y };
    })()`, true) as { x: number; y: number };
    if (!Number.isFinite(result.x) || !Number.isFinite(result.y)) throw new Error("Browser target bounds are invalid.");
    return result;
  }

  private async act(id: string, action: BrowserAction, signal: AbortSignal): Promise<void> {
    const { window } = this.require(id);
    if (signal.aborted) throw signal.reason;
    if (action.type === "click") {
      const point = await this.targetPoint(window, action.target);
      if (signal.aborted) throw signal.reason;
      // BrowserWindow sessions stay hidden, so Electron's window-level input
      // dispatch can be dropped by a headless runner. CDP input dispatch keeps
      // the action semantic (real mouse events and default activation) without
      // showing or focusing the user's desktop window.
      if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach("1.3");
      const pointer = { x: point.x, y: point.y, modifiers: 0, pointerType: "mouse" };
      await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { ...pointer, type: "mouseMoved", button: "none", buttons: 0, clickCount: 0 });
      if (signal.aborted) throw signal.reason;
      let pressed = false;
      try {
        await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { ...pointer, type: "mousePressed", button: "left", buttons: 1, clickCount: 1 });
        pressed = true;
        if (signal.aborted) throw signal.reason;
        await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { ...pointer, type: "mouseReleased", button: "left", buttons: 0, clickCount: 1 });
        pressed = false;
      } finally {
        if (pressed)
          await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { ...pointer, type: "mouseReleased", button: "left", buttons: 0, clickCount: 1 }).catch(() => undefined);
      }
      // Let the renderer process the click handler before the verified action
      // returns. Generic clicks are never retried here because activation may
      // be consequential and the browser service cannot infer idempotency.
      await window.webContents.executeJavaScript("new Promise((resolve) => requestAnimationFrame(resolve))", true);
    } else if (action.type === "type") {
      await this.targetPoint(window, action.target, true);
      if (signal.aborted) throw signal.reason;
      window.webContents.insertText(action.text);
    } else if (action.type === "key") {
      if (!/^[A-Za-z0-9]{1,20}$/.test(action.key) && !["Enter", "Escape", "Tab", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(action.key)) throw new Error("Browser key is not allowed.");
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: action.key });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: action.key });
    } else {
      window.webContents.sendInputEvent({ type: "mouseWheel", x: 0, y: 0, deltaX: Math.trunc(action.x), deltaY: Math.trunc(action.y), canScroll: true });
    }
    if (signal.aborted) throw signal.reason;
  }

  private async snapshot(id: string, signal: AbortSignal): Promise<BrowserSnapshot> {
    const { window } = this.require(id);
    if (signal.aborted) throw signal.reason;
    if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach("1.3");
    const result = await window.webContents.debugger.sendCommand("Accessibility.getFullAXTree") as { nodes?: unknown[] };
    return { url: window.webContents.getURL(), title: window.webContents.getTitle(), accessibilityTree: { nodes: (result.nodes ?? []).slice(0, 5_000) } };
  }

  private async screenshot(id: string, signal: AbortSignal): Promise<ScreenshotFrame> {
    const { window } = this.require(id);
    if (signal.aborted) throw signal.reason;
    const image = await window.webContents.capturePage();
    const { width, height } = image.getSize();
    const bgra = image.toBitmap();
    const rgba = new Uint8Array(bgra.byteLength);
    for (let offset = 0; offset < bgra.length; offset += 4) {
      rgba[offset] = bgra[offset + 2]!;
      rgba[offset + 1] = bgra[offset + 1]!;
      rgba[offset + 2] = bgra[offset]!;
      rgba[offset + 3] = bgra[offset + 3]!;
    }
    return { width, height, rgba, png: image.toPNG() };
  }

  private async setViewport(id: string, viewport: BrowserViewport, signal: AbortSignal): Promise<void> {
    const { window } = this.require(id);
    if (signal.aborted) throw signal.reason;
    window.setContentSize(viewport.width, viewport.height, false);
    if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.deviceScaleFactor ?? 1, mobile: viewport.width < 768 });
  }

  private diagnostics(id: string, signal: AbortSignal): BrowserDiagnostic[] {
    const record = this.require(id);
    if (signal.aborted) throw signal.reason;
    return record.diagnostics.map((item) => ({ ...item }));
  }

  private authHandoff(id: string, visible: boolean, signal: AbortSignal): void {
    const { window } = this.require(id);
    if (signal.aborted) throw signal.reason;
    if (visible) { window.show(); window.focus(); }
    else window.hide();
  }

  private async upload(id: string, selector: string, paths: string[], signal: AbortSignal): Promise<void> {
    const { window } = this.require(id);
    if (signal.aborted) throw signal.reason;
    if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach("1.3");
    const document = await window.webContents.debugger.sendCommand("DOM.getDocument", { depth: 0 }) as { root: { nodeId: number } };
    const selected = await window.webContents.debugger.sendCommand("DOM.querySelector", { nodeId: document.root.nodeId, selector }) as { nodeId: number };
    if (!selected.nodeId) throw new Error("Browser upload target was not found.");
    await window.webContents.debugger.sendCommand("DOM.setFileInputFiles", { nodeId: selected.nodeId, files: paths });
  }

  private downloads(id: string, signal: AbortSignal): BrowserDownload[] {
    const record = this.require(id);
    if (signal.aborted) throw signal.reason;
    return record.downloads.map((download) => ({ ...download }));
  }

  private async desktopScreenshot(signal: AbortSignal): Promise<ScreenshotFrame> {
    if (signal.aborted) throw signal.reason;
    if (systemPreferences.getMediaAccessStatus("screen") === "denied") throw new Error("macOS Screen Recording permission is required for whole-desktop capture.");
    const displays = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1920, height: 1080 }, fetchWindowIcons: false });
    const source = displays[0]; if (!source) throw new Error("No desktop display is available for capture.");
    const image = source.thumbnail; const { width, height } = image.getSize(); const bgra = image.toBitmap(); const rgba = new Uint8Array(bgra.byteLength);
    for (let offset = 0; offset < bgra.length; offset += 4) { rgba[offset] = bgra[offset + 2]!; rgba[offset + 1] = bgra[offset + 1]!; rgba[offset + 2] = bgra[offset]!; rgba[offset + 3] = bgra[offset + 3]!; }
    return { width, height, rgba, png: image.toPNG() };
  }

  private async desktopAct(action: DesktopAction, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    if (!systemPreferences.isTrustedAccessibilityClient(true)) throw new Error("macOS Accessibility permission is required for whole-desktop control.");
    const keyCodes: Record<Extract<DesktopAction, { type: "key" }>["key"], number> = { Enter: 36, Escape: 53, Tab: 48, Backspace: 51, ArrowUp: 126, ArrowDown: 125, ArrowLeft: 123, ArrowRight: 124 };
    const script = action.type === "click" ? `tell application "System Events" to click at {${action.x}, ${action.y}}` : action.type === "type" ? "tell application \"System Events\" to keystroke (system attribute \"KESTREL_COMPUTER_TEXT\")" : `tell application "System Events" to key code ${keyCodes[action.key]}`;
    await new Promise<void>((resolvePromise, reject) => {
      const child = execFile("/usr/bin/osascript", ["-e", script], { timeout: 30_000, env: { PATH: "/usr/bin:/bin", ...(action.type === "type" ? { KESTREL_COMPUTER_TEXT: action.text } : {}) } }, (error) => error ? reject(error) : resolvePromise());
      const abort = () => child.kill("SIGTERM"); signal.addEventListener("abort", abort, { once: true }); child.once("exit", () => signal.removeEventListener("abort", abort));
    });
  }

  private async close(id: string): Promise<void> {
    const record = this.sessions.get(id);
    if (!record) return;
    this.sessions.delete(id);
    if (record.window.webContents.debugger.isAttached()) record.window.webContents.debugger.detach();
    if (!record.window.isDestroyed()) record.window.destroy();
    await record.partition.clearStorageData();
    await record.partition.clearCache();
  }
}
