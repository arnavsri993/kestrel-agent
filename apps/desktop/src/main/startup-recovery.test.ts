import { describe, expect, it } from "vitest";
import { SecureStorageError } from "./credential-broker";
import { startupRecoveryCopy } from "./startup-recovery";

describe("desktop startup recovery copy", () => {
	it("explains the Keychain action only for secure-storage failures", () => {
		const copy = startupRecoveryCopy(
			new SecureStorageError("Keychain access was denied."),
		);

		expect(copy.message).toBe("Kestrel needs access to its encrypted data.");
		expect(copy.detail).toContain("Always Allow");
		expect(copy.detail).not.toContain("separate from Keychain");
	});

	it("does not mislabel Agent Core failures as Keychain failures", () => {
		const copy = startupRecoveryCopy(
			new Error("The active agent configuration is unavailable."),
		);

		expect(copy.message).toBe("Kestrel's local Agent Core could not start.");
		expect(copy.detail).toContain("separate from Keychain");
		expect(copy.detail).toContain("active agent configuration");
	});
});
