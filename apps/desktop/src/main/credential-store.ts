import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SafeStorage } from "electron";
import type { CredentialBroker } from "./credential-broker";

const STORE_PREFIX = Buffer.from("kestrel-password-store-v1\n", "utf8");
const MAX_SECRET_BYTES = 12 * 1024 * 1024;

type SafeStorageLike = Pick<
	SafeStorage,
	"decryptString" | "encryptString" | "isEncryptionAvailable"
>;

export class CredentialStoreUnavailableError extends Error {
	constructor(
		message = "Kestrel could not access protected credential storage.",
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "CredentialStoreUnavailableError";
	}
}

/**
 * A narrow, main-process-only secret storage contract. Its values are never a
 * renderer or agent transport; callers keep the decrypted lifetime bounded to
 * the one privileged operation that needs it.
 */
export interface CredentialStore {
	read(id: string): Promise<string | undefined>;
	write(id: string, value: string): Promise<void>;
	remove(id: string): Promise<void>;
}

function assertId(id: string): void {
	if (!/^[a-z][a-z0-9-]{0,63}$/.test(id))
		throw new Error("Credential store identifier is invalid.");
}

function assertValue(value: string): void {
	if (!value || value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES)
		throw new Error("Credential store value is invalid or too large.");
}

/**
 * Uses Electron safeStorage, which maps to the logged-in user's Keychain on
 * macOS. The encrypted file is only a ciphertext envelope; its decryption key
 * never shares Kestrel's database or Agent Core bootstrap path.
 */
export class MacOSKeychainCredentialStore implements CredentialStore {
	private readonly root: string;
	private storagePromise: Promise<SafeStorageLike> | undefined;

	constructor(
		userDataPath: string,
		private readonly injectedStorage?: SafeStorageLike,
	) {
		this.root = join(userDataPath, "secure", "passwords");
	}

	async read(id: string): Promise<string | undefined> {
		assertId(id);
		let encrypted: Buffer;
		try {
			encrypted = await readFile(this.pathFor(id));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		if (!encrypted.subarray(0, STORE_PREFIX.length).equals(STORE_PREFIX))
			throw new CredentialStoreUnavailableError(
				"Kestrel found an unreadable protected password store.",
			);
		try {
			return (await this.storage()).decryptString(
				encrypted.subarray(STORE_PREFIX.length),
			);
		} catch (error) {
			throw new CredentialStoreUnavailableError(
				"Kestrel could not unlock saved passwords with macOS Keychain.",
				{ cause: error },
			);
		}
	}

	async write(id: string, value: string): Promise<void> {
		assertId(id);
		assertValue(value);
		let encrypted: Buffer;
		try {
			encrypted = Buffer.concat([
				STORE_PREFIX,
				(await this.storage()).encryptString(value),
			]);
		} catch (error) {
			throw new CredentialStoreUnavailableError(
				"Kestrel could not save passwords because macOS Keychain is unavailable.",
				{ cause: error },
			);
		}
		const path = this.pathFor(id);
		const temporary = `${path}.new`;
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		try {
			await writeFile(temporary, encrypted, { mode: 0o600 });
			await chmod(temporary, 0o600);
			await rename(temporary, path);
			await chmod(path, 0o600);
		} finally {
			await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		}
	}

	async remove(id: string): Promise<void> {
		assertId(id);
		try {
			await unlink(this.pathFor(id));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	private pathFor(id: string): string {
		return join(this.root, `${id}.bin`);
	}

	private storage(): Promise<SafeStorageLike> {
		this.storagePromise ??= this.loadStorage();
		return this.storagePromise;
	}

	private async loadStorage(): Promise<SafeStorageLike> {
		const storage = this.injectedStorage ?? (await import("electron")).safeStorage;
		if (!storage?.isEncryptionAvailable())
			throw new CredentialStoreUnavailableError(
				"macOS Keychain is unavailable; Kestrel will not store passwords unprotected.",
			);
		return storage;
	}
}

/** Transitional reader for existing Kestrel password vaults. New secrets are
 * immediately rewritten through the Keychain-backed store and then removed
 * from the older database-key envelope. */
export class BrokerCredentialStore implements CredentialStore {
	constructor(private readonly broker: CredentialBroker) {}

	read(id: string): Promise<string | undefined> {
		return this.broker.getOpaqueSecret(id);
	}

	write(id: string, value: string): Promise<void> {
		return this.broker.setOpaqueSecret(id, value);
	}

	remove(id: string): Promise<void> {
		return this.broker.removeOpaqueSecret(id);
	}
}
