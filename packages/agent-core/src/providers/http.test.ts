import { describe, expect, it } from "vitest";
import { readNdjson, readServerSentEvents } from "./http";

const encoder = new TextEncoder();

function responseWithChunk(chunk: string): { response: Response; wasCancelled: () => boolean } {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(encoder.encode(chunk));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { response: new Response(body), wasCancelled: () => cancelled };
}

describe("provider streaming HTTP helpers", () => {
  it.each([
    ["SSE", "data: {}\n\n", async (response: Response, onValue: () => void) => readServerSentEvents(response, "test", () => onValue())],
    ["NDJSON", "{}\n", async (response: Response, onValue: () => void) => readNdjson(response, "test", () => onValue())],
  ])("cancels and releases the %s reader when a callback fails", async (_format, chunk, read) => {
    const { response, wasCancelled } = responseWithChunk(chunk);
    await expect(read(response, () => { throw new Error("stop"); })).rejects.toThrow("stop");
    expect(wasCancelled()).toBe(true);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    reader?.releaseLock();
  });

  it.each([
    ["SSE", "data: {}\n\n", async (response: Response) => readServerSentEvents(response, "test", () => undefined)],
    ["NDJSON", "{}\n", async (response: Response) => readNdjson(response, "test", () => undefined)],
  ])("releases the %s reader after normal completion", async (_format, chunk, read) => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }));
    await read(response);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    reader?.releaseLock();
  });
});
