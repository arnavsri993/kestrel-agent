import { describe, expect, it } from "vitest";
import { readNdjson, readServerSentEvents } from "./http";

function oversizedResponse(onCancel: () => void): Response {
  const reader = {
    read: async () => ({ done: false, value: new Uint8Array(1_000_001) }),
    cancel: async () => {
      onCancel();
    },
    releaseLock: () => undefined,
  };
  return {
    status: 200,
    body: { getReader: () => reader },
  } as unknown as Response;
}

describe("provider streaming readers", () => {
  it("cancels an unterminated oversized SSE event", async () => {
    let cancelled = false;
    await expect(
      readServerSentEvents(oversizedResponse(() => { cancelled = true; }), "provider-test", () => undefined),
    ).rejects.toMatchObject({
      name: "ModelProviderError",
      providerId: "provider-test",
      message: "Provider returned an oversized streaming event.",
    });
    expect(cancelled).toBe(true);
  });

  it("cancels an unterminated oversized NDJSON line", async () => {
    let cancelled = false;
    await expect(
      readNdjson(oversizedResponse(() => { cancelled = true; }), "provider-test", () => undefined),
    ).rejects.toMatchObject({
      name: "ModelProviderError",
      providerId: "provider-test",
      message: "Provider returned an oversized streaming line.",
    });
    expect(cancelled).toBe(true);
  });
});
