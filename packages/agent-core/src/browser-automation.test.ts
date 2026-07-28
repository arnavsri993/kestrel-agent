import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { BrowserController, VisualValidator, installBrowserTools, type BrowserAutomationBackend, type BrowserAction, type ScreenshotFrame } from "./browser-automation";
import { AgentRuntime } from "./runtime";

class FakeBrowser implements BrowserAutomationBackend {
  actions: BrowserAction[] = [];
  viewport?: { name: string; width: number; height: number };
  uploaded: string[] = [];
  desktopActions: Array<{ type: string }> = [];
  async createSession(input: { allowedOrigins: string[]; isolated: true }): Promise<string> { expect(input.isolated).toBe(true); return "backend-1"; }
  async navigate(_id: string, _url: string): Promise<void> {}
  async act(_id: string, action: BrowserAction): Promise<void> { this.actions.push(action); }
  async snapshot(): Promise<{ url: string; title: string; accessibilityTree: unknown }> { return { url: "https://example.test/", title: "Example", accessibilityTree: { role: "document" } }; }
  async screenshot(): Promise<ScreenshotFrame> { return { width: 1, height: 1, rgba: Uint8Array.from([0, 0, 0, 255]) }; }
  async setViewport(_id: string, viewport: { name: string; width: number; height: number }): Promise<void> { this.viewport = viewport; }
  async diagnostics(): Promise<Array<{ kind: "console"; level: "error"; message: string; timestamp: string }>> { return [{ kind: "console", level: "error", message: "render failed", timestamp: "2026-07-22T23:00:00.000Z" }]; }
  async upload(_id: string, _selector: string, paths: string[]): Promise<void> { this.uploaded = paths; }
  async downloads(): Promise<Array<{ id: string; filename: string; bytes: number; status: "completed"; createdAt: string }>> { return [{ id: "download-1", filename: "report.pdf", bytes: 100, status: "completed", createdAt: "2026-07-22T23:00:00.000Z" }]; }
  async desktopScreenshot(): Promise<ScreenshotFrame> { return { width: 1, height: 1, rgba: Uint8Array.from([0, 0, 0, 255]), png: Uint8Array.from([137, 80, 78, 71]) }; }
  async desktopAct(action: { type: string }): Promise<void> { this.desktopActions.push(action); }
  async close(): Promise<void> {}
}

describe("isolated browser automation and visual validation", () => {
  it("accepts only HTTPS or exact loopback HTTP browser origins", async () => {
    const controller = new BrowserController(new FakeBrowser());
    for (const allowed of [
      "https://example.test",
      "http://localhost:4173",
      "http://127.0.0.1:4173",
      "http://[::1]:4173",
    ])
      await expect(controller.create("owner", [allowed])).resolves.toMatchObject({
        browserSessionId: expect.any(String),
      });
    for (const rejected of [
      "file://127.0.0.1/etc/hosts",
      "data://localhost/text/plain,private",
      "ftp://localhost/private",
      "ws://localhost/socket",
      "http://localhost.evil.example",
      "https://user:secret@example.test",
    ])
      await expect(controller.create("owner", [rejected])).rejects.toThrow(
        "must use HTTPS",
      );
  });

  it("scopes sessions and origins and approval-gates computer actions", async () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const root = mkdtempSync(join(tmpdir(), "kestrel-browser-workspace-"));
    writeFileSync(join(root, "upload.txt"), "safe");
    const backend = new FakeBrowser();
    const controller = new BrowserController(backend);
    const runtime = new AgentRuntime(database, [root]);
    const session = runtime.createSession({ title: "Browser", workspaceRoot: root });
    installBrowserTools(runtime, controller, session.id);
    const created = await runtime.callTool(session.id, "browser.create", { allowedOrigins: ["https://example.test"] }, { approvalStatus: "approved", idempotencyKey: "browser" });
    const browserSessionId = String(created.output?.browserSessionId);
    await expect(controller.navigate(session.id, browserSessionId, "https://evil.test/", new AbortController().signal)).rejects.toThrow("outside");
    expect((await runtime.callTool(session.id, "browser.navigate", { browserSessionId, url: "https://example.test/page" }, { idempotencyKey: "nav" })).status).toBe("blocked");
    expect((await runtime.callTool(session.id, "browser.navigate", { browserSessionId, url: "https://example.test/page" }, { approvalStatus: "approved", idempotencyKey: "nav" })).status).toBe("verified");
    const snapshot = await runtime.callTool(session.id, "browser.snapshot", { browserSessionId }, { approvalStatus: "approved" });
    expect(snapshot).toMatchObject({ output: { title: "Example", trust: "untrusted_browser" } });
    expect((await runtime.callTool(session.id, "browser.upload", { browserSessionId, selector: "input[type=file]", paths: ["upload.txt"] }, { approvalStatus: "approved", idempotencyKey: "upload" })).status).toBe("verified");
    expect(backend.uploaded).toEqual([realpathSync(join(root, "upload.txt"))]);
    expect(await runtime.callTool(session.id, "browser.downloads", { browserSessionId }, { approvalStatus: "approved" })).toMatchObject({ output: { downloads: [{ filename: "report.pdf", status: "completed" }] } });
    expect((await runtime.callTool(session.id, "computer.act", { action: { type: "click", x: 10, y: 20 } }, { approvalStatus: "approved", idempotencyKey: "desktop-click" })).status).toBe("verified");
    expect(backend.desktopActions).toEqual([{ type: "click", x: 10, y: 20 }]);
    database.close();
  });

  it("records deterministic pixel comparisons with encrypted metadata", () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const validator = new VisualValidator(database, () => new Date("2026-07-22T23:00:00.000Z"));
    const baseline = { width: 2, height: 1, rgba: Uint8Array.from([0,0,0,255, 255,255,255,255]) };
    const actual = { width: 2, height: 1, rgba: Uint8Array.from([0,0,0,255, 250,255,255,255]) };
    expect(validator.compare(baseline, actual, 0.4)).toMatchObject({ changedPixels: 1, differenceRatio: 0.5, passed: false });
    expect(validator.list()).toHaveLength(1);
    database.close();
  });

  it("persists responsive baseline, actual, diff, and diagnostics artifacts and gates browser errors", async () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const root = mkdtempSync(join(tmpdir(), "kestrel-visual-"));
    const backend = new FakeBrowser();
    backend.screenshot = async () => ({ width: 320, height: 240, rgba: new Uint8Array(320 * 240 * 4).fill(255) });
    const controller = new BrowserController(backend);
    const validator = new VisualValidator(database, root, () => new Date("2026-07-22T23:00:00.000Z"));
    const runtime = new AgentRuntime(database);
    const session = runtime.createSession({ title: "Visual" });
    installBrowserTools(runtime, controller, session.id, validator);
    const created = await runtime.callTool(session.id, "browser.create", { allowedOrigins: ["https://example.test"] }, { approvalStatus: "approved", idempotencyKey: "visual-browser" });
    const result = await runtime.callTool(session.id, "visual.validate-matrix", { browserSessionId: String(created.output?.browserSessionId), suite: "homepage", viewports: [{ name: "mobile", width: 320, height: 240 }], updateBaselines: true, threshold: 0, failOnConsoleErrors: true, failOnNetworkErrors: true }, { approvalStatus: "approved", idempotencyKey: "visual-matrix" });
    expect(result).toMatchObject({ status: "verified", output: { suite: "homepage", passed: false, results: [{ viewport: { name: "mobile" }, consoleErrors: 1, differenceRatio: 0 }] } });
    const stored = validator.results()[0]!;
    expect(existsSync(stored.baselinePath)).toBe(true);
    expect(existsSync(stored.actualPath)).toBe(true);
    expect(existsSync(stored.diffPath)).toBe(true);
    expect(existsSync(stored.diagnosticsPath)).toBe(true);
    expect(backend.viewport).toEqual({ name: "mobile", width: 320, height: 240 });
    database.close();
  });
});
