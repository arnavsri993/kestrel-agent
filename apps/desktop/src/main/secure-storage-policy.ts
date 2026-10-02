import type { ReleaseChannel } from "@kestrel/shared-types";

type StorageEnvironment = Record<string, string | undefined>;

/**
 * Real macOS Keychain prompts are disruptive across rebuilds and machines.
 * Mock Keychain is the product default; opt in with KESTREL_USE_REAL_KEYCHAIN=1.
 * Channel is accepted for compatibility with callers and explicit overrides.
 */
export function shouldUseRealKeychain(
	environment: StorageEnvironment,
	_channel: ReleaseChannel,
): boolean {
	if (environment.KESTREL_USE_MOCK_KEYCHAIN === "1") return false;
	if (environment.KESTREL_USE_REAL_KEYCHAIN === "1") return true;
	if (environment.KESTREL_TEST_USER_DATA) return false;
	return false;
}

/**
 * Database root keys stay in a local plaintext envelope by default.
 * Opt in to Electron safeStorage with KESTREL_USE_SAFESTORAGE=1.
 * Channel is accepted for compatibility with callers and explicit overrides.
 */
export function shouldUseSafeStorage(
	environment: StorageEnvironment,
	_channel: ReleaseChannel,
): boolean {
	if (environment.KESTREL_ALLOW_PLAINTEXT_SECRET_STORAGE === "1") return false;
	if (environment.KESTREL_USE_SAFESTORAGE === "1") return true;
	if (environment.KESTREL_TEST_USER_DATA) return false;
	return false;
}
