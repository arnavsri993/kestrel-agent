import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface EncryptedPayload {
	ciphertext: string;
	iv: string;
	authTag: string;
}

export function createEncryptionKey(): Buffer {
	return randomBytes(32);
}

export function encryptText(plaintext: string, key: Buffer): EncryptedPayload {
	if (key.length !== 32) throw new Error("Encryption key must be 32 bytes");
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const ciphertext =
		cipher.update(plaintext, "utf8", "base64") + cipher.final("base64");
	return {
		ciphertext,
		iv: iv.toString("base64"),
		authTag: cipher.getAuthTag().toString("base64"),
	};
}

export function decryptText(payload: EncryptedPayload, key: Buffer): string {
	const decipher = createDecipheriv(
		"aes-256-gcm",
		key,
		Buffer.from(payload.iv, "base64"),
	);
	decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
	return (
		decipher.update(payload.ciphertext, "base64", "utf8") +
		decipher.final("utf8")
	);
}
