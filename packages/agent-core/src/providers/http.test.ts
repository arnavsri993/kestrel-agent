import { describe, expect, it } from "vitest";
import { readServerSentEvents } from "./http";

describe("provider HTTP helpers", () => {
  it("dispatches an SSE event when the provider closes without a blank-line terminator", async () => {
    const events: Array<{ event?: string; data: string }> = [];
    const response = new Response("event: message\ndata: final payload\n", { status: 200 });

    await readServerSentEvents(response, "fixture", (event) => events.push(event));

    expect(events).toEqual([{ event: "message", data: "final payload" }]);
  });
});
