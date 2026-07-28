/**
 * Reads an HTTP response body without allowing a missing or dishonest
 * Content-Length header to bypass the caller's byte limit.
 */
export async function readBoundedResponseBytes(
  response: Response,
  maximumBytes: number,
  limitErrorMessage: string,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError("HTTP response byte limit must be a non-negative safe integer.");
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const normalized = contentLength.trim();
    const declared = /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN;
    if (!Number.isSafeInteger(declared) || declared > maximumBytes) {
      try {
        void response.body?.cancel().catch(() => undefined);
      } catch {
        // Preserve the deterministic limit error if the stream cannot be cancelled.
      }
      throw new Error(limitErrorMessage);
    }
  }

  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        try {
          void reader.cancel().catch(() => undefined);
        } catch {
          // Preserve the deterministic limit error if the stream cannot be cancelled.
        }
        throw new Error(limitErrorMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (chunks.length === 0) return new Uint8Array();
  if (chunks.length === 1) return chunks[0]!;
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
