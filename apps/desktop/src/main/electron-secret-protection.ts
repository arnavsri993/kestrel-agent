import { safeStorage } from "electron";
import { PRODUCT_IDENTITY } from "@kestrel/shared-types";
import { PlaintextSecretProtection, SafeStorageSecretProtection, SecureStorageError, SECURE_STORAGE_UNAVAILABLE_MESSAGE, type SecretProtection } from "./credential-broker";
import { shouldUseSafeStorage } from "./secure-storage-policy";

export function createElectronSecretProtection(): SecretProtection {
	try {
		if (!shouldUseSafeStorage(process.env, PRODUCT_IDENTITY.updateChannel)) {
			// Retain recovery of an older wrapped key in development. Only the
			// Electron host supplies this adapter; the portable broker never loads it.
			return new PlaintextSecretProtection(safeStorage);
		}
		if (!safeStorage.isEncryptionAvailable()) throw new SecureStorageError(SECURE_STORAGE_UNAVAILABLE_MESSAGE);
		return new SafeStorageSecretProtection(safeStorage);
	} catch (error) {
		if (error instanceof SecureStorageError) throw error;
		throw new SecureStorageError(SECURE_STORAGE_UNAVAILABLE_MESSAGE, error);
	}
}
