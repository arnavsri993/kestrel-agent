import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export function readBoundedFile(
  path: string,
  maximumBytes: number,
  limitErrorMessage: string,
): Buffer {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError("File byte limit must be a non-negative safe integer.");
  }

  const descriptor = openSync(path, "r");
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > maximumBytes) {
      throw new Error(limitErrorMessage);
    }

    const buffer = Buffer.alloc(maximumBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      const count = readSync(
        descriptor,
        buffer,
        bytesRead,
        buffer.byteLength - bytesRead,
        null,
      );
      if (count === 0) break;
      bytesRead += count;
    }

    if (bytesRead > maximumBytes || fstatSync(descriptor).size > maximumBytes) {
      throw new Error(limitErrorMessage);
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(descriptor);
  }
}
