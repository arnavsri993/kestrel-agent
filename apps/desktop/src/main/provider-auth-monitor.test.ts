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

  it("does not schedule malformed timer values as immediate polling", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => ({ ok: false, error: "offline" }));
    const monitor = new ProviderAuthMonitor({ request, notify: vi.fn(), initialDelayMs: Number.NaN, intervalMs: Number.POSITIVE_INFINITY });
    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(request).not.toHaveBeenCalled();
    monitor.stop();
    vi.useRealTimers();
  });
});
