import { describe, expect, it } from "vitest";
import { readNdjson } from "./http";

describe("provider HTTP helpers", () => {
  it("cancels an oversized incomplete NDJSON record", async () => {
    let pulls = 0;
    let cancellations = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(40_000));
        if (pulls === 40) controller.close();
      },
      cancel() {
        cancellations += 1;
      },
    }), { status: 200 });

    await expect(readNdjson(response, "fixture", () => undefined)).rejects.toThrow("NDJSON record exceeds 1 MB");
    expect(cancellations).toBe(1);
    expect(pulls).toBeLessThan(40);
  });
});
