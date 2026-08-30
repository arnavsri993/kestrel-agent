import type { ReleaseChannel } from "@kestrel/shared-types";

type StorageEnvironment = Record<string, string | undefined>;

/**
 * Stable, distributable builds use the real macOS Keychain. Development and
 * automated profiles stay isolated so ad-hoc rebuilds do not repeatedly ask
 * for access under a changing code signature.
 */
export function shouldUseRealKeychain(
	environment: StorageEnvironment,
	channel: ReleaseChannel,
): boolean {
	if (environment.KESTREL_USE_MOCK_KEYCHAIN === "1") return false;
	if (environment.KESTREL_USE_REAL_KEYCHAIN === "1") return true;
	if (environment.KESTREL_TEST_USER_DATA) return false;
	return channel === "stable";
}

/**
 * The database root key follows the same stable/development boundary as
 * Chromium storage. Explicit overrides remain available for recovery and
 * isolated diagnostics, but production never silently falls back.
 */
export function shouldUseSafeStorage(
	environment: StorageEnvironment,
	channel: ReleaseChannel,
): boolean {
	if (environment.KESTREL_ALLOW_PLAINTEXT_SECRET_STORAGE === "1") return false;
	if (environment.KESTREL_USE_SAFESTORAGE === "1") return true;
	if (environment.KESTREL_TEST_USER_DATA) return false;
	return channel === "stable";
}
