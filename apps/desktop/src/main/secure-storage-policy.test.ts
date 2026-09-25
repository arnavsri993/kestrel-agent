import { describe, expect, it } from "vitest";
import {
	shouldUseRealKeychain,
	shouldUseSafeStorage,
} from "./secure-storage-policy";

describe("desktop secure-storage policy", () => {
	it("keeps Keychain and safeStorage off by default on every channel", () => {
		expect(shouldUseRealKeychain({}, "stable")).toBe(false);
		expect(shouldUseSafeStorage({}, "stable")).toBe(false);
		expect(shouldUseRealKeychain({}, "development")).toBe(false);
		expect(shouldUseSafeStorage({}, "development")).toBe(false);
	});

	it("isolates automated profiles from Keychain prompts", () => {
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
		expect(
			shouldUseSafeStorage(
				{
					KESTREL_USE_SAFESTORAGE: "1",
					KESTREL_ALLOW_PLAINTEXT_SECRET_STORAGE: "1",
				},
				"stable",
			),
		).toBe(false);
	});
});
