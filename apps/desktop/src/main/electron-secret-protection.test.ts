import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElectronSecretProtection } from "./electron-secret-protection";
import { SAFESTORAGE_PROTECTION_PREFIX, PlaintextSecretProtection, SafeStorageSecretProtection, SecureStorageError } from "./credential-broker";

const storage = vi.hoisted(() => ({
	isEncryptionAvailable: vi.fn(() => true),
	encryptString: vi.fn((value: string) => Buffer.from(`wrapped:${value}`)),
	decryptString: vi.fn(() => "recovered-fixture"),
}));
vi.mock("electron", () => ({ safeStorage: storage }));
beforeEach(() => {
	vi.stubEnv("KESTREL_ALLOW_PLAINTEXT_SECRET_STORAGE", undefined);
	vi.stubEnv("KESTREL_USE_SAFESTORAGE", "1");
	storage.isEncryptionAvailable.mockReset().mockReturnValue(true);
	storage.encryptString.mockClear(); storage.decryptString.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("explicit Electron credential protection adapter", () => {
	it("retains protected storage when required", async () => {
		const protection = createElectronSecretProtection();
		expect(protection).toBeInstanceOf(SafeStorageSecretProtection);
		const encrypted = await protection.encryptString("fixture");
		expect(encrypted.subarray(0, SAFESTORAGE_PROTECTION_PREFIX.length)).toEqual(SAFESTORAGE_PROTECTION_PREFIX);
		expect(storage.encryptString).toHaveBeenCalledWith("fixture");
	});

	it("fails closed and does not expose platform diagnostics when protected storage fails", () => {
		storage.isEncryptionAvailable.mockReturnValue(false);
		expect(createElectronSecretProtection).toThrow(SecureStorageError);
		storage.isEncryptionAvailable.mockImplementation(() => { throw new Error("private-platform-fixture"); });
		expect(createElectronSecretProtection).toThrow(SecureStorageError);
		expect(createElectronSecretProtection).not.toThrow("private-platform-fixture");
	});

	it("preserves explicit development migration without probing Keychain for a new plaintext key", async () => {
		vi.stubEnv("KESTREL_ALLOW_PLAINTEXT_SECRET_STORAGE", "1");
		const protection = createElectronSecretProtection();
		expect(protection).toBeInstanceOf(PlaintextSecretProtection);
		await protection.prepare?.();
		expect(storage.isEncryptionAvailable).not.toHaveBeenCalled();
		const legacy = Buffer.concat([SAFESTORAGE_PROTECTION_PREFIX, Buffer.from("older-key")]);
		expect(await protection.decryptString(legacy)).toEqual({ result: "recovered-fixture", shouldReEncrypt: true });
		expect(storage.decryptString).toHaveBeenCalledWith(Buffer.from("older-key"));
	});
});
