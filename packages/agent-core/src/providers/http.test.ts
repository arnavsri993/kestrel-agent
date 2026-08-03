import { describe, expect, it } from "vitest";
import { readNdjson, readServerSentEvents } from "./http";

function openResponse(payload: string, cancellations: { count: number }): Response {
  let emitted = false;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted) return;
      emitted = true;
      controller.enqueue(new TextEncoder().encode(payload));
    },
    cancel() {
      cancellations.count += 1;
    },
  }), { status: 200 });
}

describe("provider HTTP helpers", () => {
  it("cancels an SSE response when an event consumer fails", async () => {
    const cancellations = { count: 0 };
    await expect(readServerSentEvents(openResponse("data: {}\n\n", cancellations), "fixture", () => { throw new Error("consumer failed"); })).rejects.toThrow("consumer failed");
    expect(cancellations.count).toBe(1);
  });

  it("cancels an NDJSON response when a record consumer fails", async () => {
    const cancellations = { count: 0 };
    await expect(readNdjson(openResponse("{}\n", cancellations), "fixture", () => { throw new Error("consumer failed"); })).rejects.toThrow("consumer failed");
    expect(cancellations.count).toBe(1);
  });
});
