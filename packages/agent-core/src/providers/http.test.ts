import { afterEach, describe, expect, it, vi } from "vitest";
import { providerFetch } from "./http";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider HTTP helpers", () => {
  it("cancels oversized error bodies before formatting provider failures", async () => {
    let cancelled = false;
    const reader = {
      read: async () => ({
        done: false,
        value: { byteLength: 8_001 } as Uint8Array,
      }),
      cancel: async () => {
        cancelled = true;
      },
      releaseLock: () => undefined,
    };
    const response = {
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      headers: new Headers(),
      body: { getReader: () => reader },
    } as unknown as Response;
    vi.stubGlobal("fetch", async () => response);

    await expect(
      providerFetch("provider-test", "https://provider.test/models", {}),
    ).rejects.toMatchObject({
      name: "ModelProviderError",
      providerId: "provider-test",
      retryable: true,
      status: 502,
      message: "Provider returned HTTP 502",
    });
    expect(cancelled).toBe(true);
  });
});
