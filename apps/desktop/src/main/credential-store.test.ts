import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CredentialStoreUnavailableError,
	MacOSKeychainCredentialStore,
} from "./credential-store";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "kestrel-credential-store-"));
	roots.push(value);
	return value;
}

function protectedStore(path: string) {
	const key = 0x6d;
	return new MacOSKeychainCredentialStore(path, {
		isEncryptionAvailable: () => true,
		encryptString: (value) =>
			Buffer.from(Buffer.from(value, "utf8").map((byte) => byte ^ key)),
		decryptString: (value) =>
			Buffer.from(Buffer.from(value).map((byte) => byte ^ key)).toString("utf8"),
	});
}

describe("MacOSKeychainCredentialStore", () => {
	it("keeps ciphertext in a private envelope and round-trips through protected storage", async () => {
		const path = root();
		const store = protectedStore(path);

		await store.write("browser-password-vault", "secret-value");

		const stored = join(
			path,
			"secure",
			"passwords",
			"browser-password-vault.bin",
		);
		expect(readFileSync(stored, "utf8")).toContain("kestrel-password-store-v1");
		expect(readFileSync(stored, "utf8")).not.toContain("secret-value");
		expect(statSync(stored).mode & 0o777).toBe(0o600);
		expect(await store.read("browser-password-vault")).toBe("secret-value");

		await store.remove("browser-password-vault");
		expect(await store.read("browser-password-vault")).toBeUndefined();
	});

	it("fails closed when the platform credential service is unavailable", async () => {
		const store = new MacOSKeychainCredentialStore(root(), {
			isEncryptionAvailable: () => false,
			encryptString: () => Buffer.alloc(0),
			decryptString: () => "",
		});

		await expect(store.write("browser-password-vault", "secret-value")).rejects.toBeInstanceOf(
			CredentialStoreUnavailableError,
		);
	});
});
