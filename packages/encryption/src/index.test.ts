import { describe, it, expect } from "vitest";
import { createEncryptionKey } from "./index.js";

describe("createEncryptionKey", () => {
  it("should generate a 32-byte buffer", () => {
    const key = createEncryptionKey();
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  it("should generate unique keys on subsequent calls", () => {
    const key1 = createEncryptionKey();
    const key2 = createEncryptionKey();
    expect(key1).not.toEqual(key2);
  });
});
