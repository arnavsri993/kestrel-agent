import { describe, expect, it } from "vitest";
import {
	shouldUseRealKeychain,
	shouldUseSafeStorage,
} from "./secure-storage-policy";

describe("desktop secure-storage policy", () => {
	it("protects stable builds with Keychain and safeStorage by default", () => {
		expect(shouldUseRealKeychain({}, "stable")).toBe(true);
		expect(shouldUseSafeStorage({}, "stable")).toBe(true);
	});

	it("isolates development and automated profiles from repeated Keychain prompts", () => {
		expect(shouldUseRealKeychain({}, "development")).toBe(false);
		expect(shouldUseSafeStorage({}, "development")).toBe(false);
		expect(
			shouldUseRealKeychain({ KESTREL_TEST_USER_DATA: "/tmp/profile" }, "stable"),
		).toBe(false);
		expect(
			shouldUseSafeStorage({ KESTREL_TEST_USER_DATA: "/tmp/profile" }, "stable"),
		).toBe(false);
	});

	it("honors explicit recovery overrides without allowing silent fallback", () => {
		expect(
			shouldUseRealKeychain({ KESTREL_USE_REAL_KEYCHAIN: "1" }, "development"),
		).toBe(true);
		expect(
			shouldUseRealKeychain(
				{
					KESTREL_USE_REAL_KEYCHAIN: "1",
					KESTREL_USE_MOCK_KEYCHAIN: "1",
				},
				"stable",
			),
		).toBe(false);
		expect(
			shouldUseSafeStorage({ KESTREL_USE_SAFESTORAGE: "1" }, "development"),
		).toBe(true);
		expect(
			shouldUseSafeStorage(
				{ KESTREL_ALLOW_PLAINTEXT_SECRET_STORAGE: "1" },
				"stable",
			),
		).toBe(false);
	});
});
