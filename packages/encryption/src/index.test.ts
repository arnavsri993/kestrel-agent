import { describe, it, expect } from "vitest";
import { encryptText, decryptText, createEncryptionKey } from "./index";

describe("Encryption module", () => {
  describe("decryptText", () => {
    it("should successfully decrypt a valid encrypted payload", () => {
      const key = createEncryptionKey();
      const plaintext = "Hello, secret world!";
      const payload = encryptText(plaintext, key);

      const decrypted = decryptText(payload, key);
      expect(decrypted).toBe(plaintext);
    });

    it("should throw an error with incorrect key", () => {
      const key = createEncryptionKey();
      const wrongKey = createEncryptionKey();
      const plaintext = "Hello, secret world!";
      const payload = encryptText(plaintext, key);

      expect(() => decryptText(payload, wrongKey)).toThrowError();
    });

    it("should throw an error with tampered ciphertext", () => {
      const key = createEncryptionKey();
      const plaintext = "Hello, secret world!";
      const payload = encryptText(plaintext, key);

      // Tamper with the ciphertext
      const tamperedPayload = {
        ...payload,
        ciphertext: payload.ciphertext.replace(/[A-Za-z0-9]/, c => c === "Z" ? "A" : "Z")
      };

      // In AES-GCM, tampering with ciphertext will cause authTag validation to fail
      expect(() => decryptText(tamperedPayload, key)).toThrowError();
    });

    it("should throw an error with invalid authTag", () => {
      const key = createEncryptionKey();
      const plaintext = "Hello, secret world!";
      const payload = encryptText(plaintext, key);

      // Tamper with the authTag
      const tamperedPayload = {
        ...payload,
        authTag: payload.authTag.replace(/[A-Za-z0-9]/, c => c === "Z" ? "A" : "Z")
      };

      expect(() => decryptText(tamperedPayload, key)).toThrowError();
    });

    it("should throw an error with invalid IV", () => {
      const key = createEncryptionKey();
      const plaintext = "Hello, secret world!";
      const payload = encryptText(plaintext, key);

      // Tamper with the iv
      const tamperedPayload = {
        ...payload,
        iv: payload.iv.replace(/[A-Za-z0-9]/, c => c === "Z" ? "A" : "Z")
      };

      expect(() => decryptText(tamperedPayload, key)).toThrowError();
    });
  });
});
