import { describe, it, expect } from "vitest";
import { encryptText, decryptText, createEncryptionKey } from "./index.js";

describe("encryption", () => {
  describe("encryptText", () => {
    it("should successfully encrypt text and return payload with base64 strings", () => {
      const key = createEncryptionKey();
      const plaintext = "hello secret world";
      const payload = encryptText(plaintext, key);

      expect(payload).toHaveProperty("ciphertext");
      expect(payload).toHaveProperty("iv");
      expect(payload).toHaveProperty("authTag");

      // Verify they are strings (and non-empty)
      expect(typeof payload.ciphertext).toBe("string");
      expect(payload.ciphertext.length).toBeGreaterThan(0);
      expect(typeof payload.iv).toBe("string");
      expect(payload.iv.length).toBeGreaterThan(0);
      expect(typeof payload.authTag).toBe("string");
      expect(payload.authTag.length).toBeGreaterThan(0);
    });

    it("should throw an error if the key is not 32 bytes", () => {
      const invalidKey = Buffer.alloc(31);
      expect(() => encryptText("test", invalidKey)).toThrowError("Encryption key must be 32 bytes");

      const invalidKey2 = Buffer.alloc(33);
      expect(() => encryptText("test", invalidKey2)).toThrowError("Encryption key must be 32 bytes");
    });

    it("should produce different payloads for the same plaintext and key due to random IV", () => {
      const key = createEncryptionKey();
      const plaintext = "hello secret world";

      const payload1 = encryptText(plaintext, key);
      const payload2 = encryptText(plaintext, key);

      expect(payload1.ciphertext).not.toBe(payload2.ciphertext);
      expect(payload1.iv).not.toBe(payload2.iv);
      expect(payload1.authTag).not.toBe(payload2.authTag);
    });

    it("should be successfully decrypted by decryptText", () => {
      const key = createEncryptionKey();
      const plaintext = "hello secret world, this is a longer string to test decryption.";
      const payload = encryptText(plaintext, key);

      const decrypted = decryptText(payload, key);
      expect(decrypted).toBe(plaintext);
    });
  });

  describe("decryptText", () => {
    it("should fail to decrypt if authTag is altered", () => {
      const key = createEncryptionKey();
      const plaintext = "hello secret world";
      const payload = encryptText(plaintext, key);

      // Alter the authTag slightly
      const invalidPayload = {
        ...payload,
        authTag: Buffer.from(payload.authTag, "base64").map(b => (b + 1) % 256).toString("base64")
      };

      expect(() => decryptText(invalidPayload, key)).toThrow();
    });

    it("should fail to decrypt if ciphertext is altered", () => {
      const key = createEncryptionKey();
      const plaintext = "hello secret world";
      const payload = encryptText(plaintext, key);

      // Alter the ciphertext slightly
      const invalidPayload = {
        ...payload,
        ciphertext: Buffer.from(payload.ciphertext, "base64").map(b => (b + 1) % 256).toString("base64")
      };

      expect(() => decryptText(invalidPayload, key)).toThrow();
    });
  });
});
