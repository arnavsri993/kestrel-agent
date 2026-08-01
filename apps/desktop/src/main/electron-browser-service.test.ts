import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {},
  BrowserWindow: class {},
  desktopCapturer: {},
  session: {},
  systemPreferences: {},
}));

import { ElectronBrowserService } from "./electron-browser-service";

describe("Electron browser action cancellation", () => {
  it("does not type after cancellation while resolving the target", async () => {
    let resolveTarget: (point: { x: number; y: number }) => void =
      () => undefined;
    const target = new Promise<{ x: number; y: number }>((resolvePromise) => {
      resolveTarget = resolvePromise;
    });
    const insertText = vi.fn();
    const executeJavaScript = vi.fn(() => target);
    const service = new ElectronBrowserService();
    const sessions = (
      service as unknown as {
        sessions: Map<string, unknown>;
      }
    ).sessions;
    sessions.set("browser-test", {
      window: {
        isDestroyed: () => false,
        webContents: {
          executeJavaScript,
          insertText,
        },
      },
      partition: {},
      allowedOrigins: new Set<string>(),
      diagnostics: [],
      downloads: [],
      downloadDirectory: "/tmp/browser-test",
    });
    const controller = new AbortController();
    const running = service.handle(
      {
        operation: "act",
        sessionId: "browser-test",
        action: { type: "type", target: "#prompt", text: "do not send" },
      },
      controller.signal,
    );
    const outcome = running.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await vi.waitFor(() => expect(executeJavaScript).toHaveBeenCalledOnce());

    controller.abort(new Error("cancelled before typing"));
    resolveTarget({ x: 10, y: 10 });

    await expect(outcome).resolves.toMatchObject({
      ok: false,
      error: expect.objectContaining({ message: "cancelled before typing" }),
    });
    expect(insertText).not.toHaveBeenCalled();
  });

  it("returns an actionable error when a browser operation is cancelled with a null reason", async () => {
    const service = new ElectronBrowserService();
    const sessions = (service as unknown as { sessions: Map<string, unknown> }).sessions;
    sessions.set("browser-test", {
      window: { isDestroyed: () => false },
      partition: {},
      allowedOrigins: new Set<string>(),
      diagnostics: [],
      downloads: [],
      downloadDirectory: "/tmp/browser-test",
    });
    const controller = new AbortController();
    controller.abort(null);

    await expect(service.handle({ operation: "diagnostics", sessionId: "browser-test" }, controller.signal)).rejects.toThrow("Browser operation cancelled.");
  });
});
