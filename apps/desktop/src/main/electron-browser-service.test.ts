import { describe, expect, it, vi } from "vitest";

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock("electron", () => ({
  app: {},
  BrowserWindow: class {},
  desktopCapturer: {},
  session: {},
  systemPreferences: { isTrustedAccessibilityClient: vi.fn(() => true) },
}));
vi.mock("node:child_process", () => ({ execFile }));

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

  it("kills a desktop action when cancellation races process launch", async () => {
    const controller = new AbortController();
    const kill = vi.fn();
    const once = vi.fn();
    execFile.mockImplementationOnce(() => {
      controller.abort(new Error("cancelled during launch"));
      return { kill, once };
    });

    const service = new ElectronBrowserService();
    const outcome = service.handle(
      { operation: "desktop-act", action: { type: "click", x: 10, y: 20 } },
      controller.signal,
    );

    await expect(outcome).rejects.toThrow("cancelled during launch");
    expect(execFile).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });
});
