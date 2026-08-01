import { ModelProviderError } from "./types";

export interface ServerSentEvent {
  event?: string;
  data: string;
}

export async function readServerSentEvents(
  response: Response,
  providerId: string,
  onEvent: (event: ServerSentEvent) => void
): Promise<void> {
  if (!response.body) throw new ModelProviderError("Provider returned an empty streaming response.", providerId, true, response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        const match = buffer.slice(boundary).match(/^\r?\n\r?\n/);
        buffer = buffer.slice(boundary + (match?.[0].length ?? 2));
        let event: string | undefined;
        const data: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (data.length > 0) onEvent({ ...(event ? { event } : {}), data: data.join("\n") });
        boundary = buffer.search(/\r?\n\r?\n/);
      }
      if (done) break;
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* Preserve the original stream or callback error. */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function readNdjson(response: Response, providerId: string, onValue: (value: unknown) => void): Promise<void> {
  if (!response.body) throw new ModelProviderError("Provider returned an empty streaming response.", providerId, true, response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onValue(JSON.parse(line));
      if (done) break;
    }
    if (buffer.trim()) onValue(JSON.parse(buffer));
  } catch (error) {
    try { await reader.cancel(); } catch { /* Preserve the original stream or callback error. */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function providerFetch(
  providerId: string,
  url: string,
  init: RequestInit
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ModelProviderError(
      `Provider request failed before a response was received: ${error instanceof Error ? error.message : "network error"}`,
      providerId,
      true
    );
  }
  if (!response.ok) {
    const body = (await response.text()).slice(0, 2_000).replace(/[\r\n]+/g, " ");
    const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
    throw new ModelProviderError(`Provider returned HTTP ${response.status}${body ? `: ${body}` : ""}`, providerId, retryable, response.status);
  }
  return response;
}
