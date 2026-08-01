import { describe, expect, it, vi } from "vitest";
import { ProviderAuthMonitor } from "./provider-auth-monitor";

describe("provider authentication monitor", () => {
  it("notifies on auth failure and recovery without repeating unchanged state", async () => {
    let ok = false;
    const notify = vi.fn();
    const monitor = new ProviderAuthMonitor({
      request: async (request) => request.type === "runtime-list-providers"
        ? { ok: true, providers: [{ id: "openai", capabilities: { streaming: true, tools: true, images: false, audio: false, documents: false, local: false } }] }
        : { ok: true, providerVerifications: [{ providerId: "openai-key-1", poolId: "openai", ok, latencyMs: 12, ...(!ok ? { error: "expired credential" } : {}) }] },
      notify
    });
    expect(await monitor.check()).toHaveLength(1);
    expect(notify).toHaveBeenLastCalledWith({ providerId: "openai-key-1", status: "failed", detail: "expired credential" });
    await monitor.check();
    expect(notify).toHaveBeenCalledTimes(1);
    ok = true;
    await monitor.check();
    expect(notify).toHaveBeenLastCalledWith({ providerId: "openai-key-1", status: "recovered", detail: "The provider accepted its saved authentication again." });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("runs one bounded timer pair and stops cleanly", () => {
    vi.useFakeTimers();
    const monitor = new ProviderAuthMonitor({ request: async () => ({ ok: false, error: "offline" }), notify: vi.fn(), initialDelayMs: 1_000, intervalMs: 60_000 });
    monitor.start();
    monitor.start();
    expect(vi.getTimerCount()).toBe(2);
    monitor.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("discards an in-flight verification after shutdown", async () => {
    let release: (() => void) | undefined;
    const listed = new Promise<void>((resolve) => { release = resolve; });
    const notify = vi.fn();
    const monitor = new ProviderAuthMonitor({
      request: async (request) => {
        if (request.type === "runtime-list-providers") {
          await listed;
          return { ok: true, providers: [{ id: "openai", capabilities: { streaming: true, tools: true, images: false, audio: false, documents: false, local: false } }] };
        }
        return { ok: true, providerVerifications: [{ providerId: "openai-key-1", poolId: "openai", ok: false, latencyMs: 12, error: "expired credential" }] };
      },
      notify
    });
    const pending = monitor.check();
    monitor.stop();
    release!();
    await expect(pending).resolves.toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });
});
