import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProtectedDatabaseError } from "@kestrel/database";
import { afterEach, describe, expect, it } from "vitest";
import {
	CredentialBroker,
	PlaintextSecretProtection,
	SAFESTORAGE_PROTECTION_PREFIX,
	SafeStorageSecretProtection,
	SecureStorageError,
} from "./credential-broker";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("desktop credential broker", () => {
	it("stores scoped credentials encrypted, exports only the core environment, and revokes them", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-credentials-"));
		roots.push(root);
		let encryptCalls = 0;
		let decryptCalls = 0;
		const protection = {
			isEncryptionAvailable: () => true,
			encryptString: async (value: string) => {
				encryptCalls += 1;
				return Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`);
			},
			decryptString: async (value: Buffer) => {
				decryptCalls += 1;
				return Buffer.from(
					value.toString().slice("sealed:".length),
					"base64",
				).toString();
			},
		};
		const broker = new CredentialBroker(root, protection);
		await broker.setCredential("openai", "sk-test-secret-value");
		await broker.setCredential("openai-secondary", "sk-test-backup-value");
		await broker.setCredential("cohere", "cohere-test-secret");
		await broker.setOpaqueSecret(
			"google-workspace-oauth",
			'{"refreshToken":"refresh-secret"}',
		);
		expect(await broker.listCredentials()).toContainEqual({
			id: "openai",
			label: "OpenAI API key",
			configured: true,
		});
		const baseEnvironment = {
			OPENAI_BASE_URL: "https://provider.test/v1",
			KESTREL_ENABLE_CODEX_SUBSCRIPTION: "1",
			KESTREL_CODEX_PATH: "/Applications/ChatGPT.app/Contents/Resources/codex",
			KESTREL_ALLOW_EXTERNAL_SEARCH: "true",
			KESTREL_WEB_ALLOWED_HOSTS: "docs.example.test,api.example.test",
			KESTREL_ALLOW_HOSTED_TRANSCRIPTION: "true",
			KESTREL_OPENAI_TRANSCRIPTION_MODEL: "gpt-4o-mini-transcribe",
			KESTREL_OPENAI_IMAGE_MODEL: "gpt-image-1",
			KESTREL_OPENAI_SPEECH_MODEL: "gpt-4o-mini-tts",
			KESTREL_OPENAI_VOICE: "alloy",
			KESTREL_OLLAMA_CONTEXT_WINDOW: "32768",
			UNRELATED_SECRET: "do-not-forward",
		};
		const environment = await broker.providerEnvironment(baseEnvironment);
		expect(environment).toEqual({
			OPENAI_API_KEY: "sk-test-secret-value",
			OPENAI_API_KEY_SECONDARY: "sk-test-backup-value",
			COHERE_API_KEY: "cohere-test-secret",
			OPENAI_BASE_URL: "https://provider.test/v1",
			KESTREL_ENABLE_CODEX_SUBSCRIPTION: "1",
			KESTREL_CODEX_PATH: "/Applications/ChatGPT.app/Contents/Resources/codex",
			KESTREL_ALLOW_EXTERNAL_SEARCH: "true",
			KESTREL_WEB_ALLOWED_HOSTS: "docs.example.test,api.example.test",
			KESTREL_ALLOW_HOSTED_TRANSCRIPTION: "true",
			KESTREL_OPENAI_TRANSCRIPTION_MODEL: "gpt-4o-mini-transcribe",
			KESTREL_OPENAI_IMAGE_MODEL: "gpt-image-1",
			KESTREL_OPENAI_SPEECH_MODEL: "gpt-4o-mini-tts",
			KESTREL_OPENAI_VOICE: "alloy",
			KESTREL_OLLAMA_CONTEXT_WINDOW: "32768",
			KESTREL_GOOGLE_WORKSPACE_OAUTH: '{"refreshToken":"refresh-secret"}',
		});
		expect(await broker.providerEnvironment(baseEnvironment)).toEqual(
			environment,
		);
		expect(encryptCalls).toBe(1);
		expect(decryptCalls).toBe(0);
		const reopened = new CredentialBroker(root, protection);
		expect(await reopened.providerEnvironment(baseEnvironment)).toEqual(
			environment,
		);
		expect(await reopened.providerEnvironment(baseEnvironment)).toEqual(
			environment,
		);
		expect(decryptCalls).toBe(1);
		const storedPath = join(root, "secure", "credentials", "openai.bin");
		expect(readFileSync(storedPath, "utf8")).not.toContain(
			"sk-test-secret-value",
		);
		expect(statSync(storedPath).mode & 0o777).toBe(0o600);
		expect(
			readFileSync(
				join(
					root,
					"secure",
					"credentials",
					"opaque-google-workspace-oauth.bin",
				),
				"utf8",
			),
		).not.toContain("refresh-secret");
		await broker.removeCredential("openai");
		expect(await broker.listCredentials()).toContainEqual({
			id: "openai",
			label: "OpenAI API key",
			configured: false,
		});
	});

	it("forwards every added free-provider credential through protected storage", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-credentials-free-providers-"));
		roots.push(root);
		const broker = new CredentialBroker(root, {
			isEncryptionAvailable: () => true,
			encryptString: async (value: string) =>
				Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`),
			decryptString: async (value: Buffer) =>
				Buffer.from(
					value.toString().slice("sealed:".length),
					"base64",
				).toString(),
		});
		const credentials = [
			["tokenrouter", "TOKENROUTER_API_KEY"],
			["bai", "BAI_API_KEY"],
			["inferx", "INFERX_API_KEY"],
			["zenmux", "ZENMUX_API_KEY"],
			["opencode-zen", "OPENCODE_API_KEY"],
			["sensenova", "SENSENOVA_API_KEY"],
			["gmicloud", "GMICLOUD_API_KEY"],
			["tokenharbor", "TOKENHARBOR_API_KEY"],
			["cline", "CLINE_API_KEY"],
			["command-code", "COMMAND_CODE_API_KEY"],
			["kilo", "KILO_API_KEY"],
			["orcarouter", "ORCAROUTER_API_KEY"],
			["aihubmix", "AIHUBMIX_API_KEY"],
		] as const;
		for (const [id] of credentials)
			await broker.setCredential(id, `${id}-protected-secret`);

		const environment = await broker.providerEnvironment({
			TOKENROUTER_MODEL: "custom-tokenrouter-model",
			TOKENROUTER_BASE_URL: "https://tokenrouter.example.test/v1",
			OPENCODE_MODEL: "custom-opencode-model",
			OPENCODE_BASE_URL: "https://opencode.example.test/v1",
			UNRELATED_PROVIDER_MODEL: "must-not-forward",
		});
		for (const [id, environmentKey] of credentials)
			expect(environment[environmentKey]).toBe(`${id}-protected-secret`);
		expect(environment).toMatchObject({
			TOKENROUTER_MODEL: "custom-tokenrouter-model",
			TOKENROUTER_BASE_URL: "https://tokenrouter.example.test/v1",
			OPENCODE_MODEL: "custom-opencode-model",
			OPENCODE_BASE_URL: "https://opencode.example.test/v1",
		});
		expect(environment).not.toHaveProperty("UNRELATED_PROVIDER_MODEL");
	});

	it("stores the database key as a local plaintext file in dev-only protection", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-credentials-plaintext-"));
		roots.push(root);
		const broker = new CredentialBroker(root, new PlaintextSecretProtection());
		const key = await broker.getDatabaseKey();
		expect(key).toHaveLength(32);
		const stored = readFileSync(join(root, "secure", "database-key.bin"));
		expect(
			stored.subarray(0, "kestrel-plaintext-v1\n".length).toString("utf8"),
		).toBe("kestrel-plaintext-v1\n");
		expect(stored.toString("utf8")).toContain(key.toString("base64"));
		expect(
			await new CredentialBroker(root, new PlaintextSecretProtection()).getDatabaseKey(),
		).toEqual(key);
	});

	it("seals the database key with safeStorage and migrates plaintext keys on first read", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-credentials-safestorage-"));
		roots.push(root);
		const key = Buffer.alloc(32, 9);
		const keyPath = join(root, "secure", "database-key.bin");
		mkdirSync(join(root, "secure"), { recursive: true });
		writeFileSync(
			keyPath,
			Buffer.concat([
				Buffer.from("kestrel-plaintext-v1\n", "utf8"),
				Buffer.from(key.toString("base64"), "utf8"),
			]),
		);
		const storage = {
			available: true,
			encryptString(value: string) {
				return Buffer.from(`sealed:${Buffer.from(value, "utf8").toString("base64")}`);
			},
			decryptString(value: Buffer) {
				return Buffer.from(value.toString().slice("sealed:".length), "base64").toString(
					"utf8",
				);
			},
			isEncryptionAvailable() {
				return this.available;
			},
		};
		const protection = new SafeStorageSecretProtection(storage);
		const broker = new CredentialBroker(root, protection);

		expect(await broker.getDatabaseKey()).toEqual(key);
		expect(await broker.getDatabaseKey()).toEqual(key);
		const migrated = readFileSync(keyPath);
		expect(
			migrated.subarray(0, SAFESTORAGE_PROTECTION_PREFIX.length).equals(
				SAFESTORAGE_PROTECTION_PREFIX,
			),
		).toBe(true);
		expect(migrated.toString("utf8")).not.toContain(key.toString("base64"));
	});

	it("refuses safeStorage ciphertext when only plaintext protection is enabled", async () => {
		const protection = new PlaintextSecretProtection();
		await expect(
			protection.decryptString(Buffer.from([0x00, 0x01, 0x02, 0xff])),
		).rejects.toBeInstanceOf(SecureStorageError);
	});

	it("persists a rotated database-key ciphertext without repeating decryption", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-credentials-rotate-"));
		roots.push(root);
		const key = Buffer.alloc(32, 7);
		const keyPath = join(root, "secure", "database-key.bin");
		mkdirSync(join(root, "secure"), { recursive: true });
		writeFileSync(keyPath, "legacy-key");
		let decryptCalls = 0;
		let encryptCalls = 0;
		const broker = new CredentialBroker(root, {
			isEncryptionAvailable: () => true,
			decryptString: async () => {
				decryptCalls += 1;
				return { result: key.toString("base64"), shouldReEncrypt: true };
			},
			encryptString: async (value) => {
				encryptCalls += 1;
				return Buffer.from(`current:${value}`);
			},
		});

		expect(await broker.getDatabaseKey()).toEqual(key);
		expect(await broker.getDatabaseKey()).toEqual(key);
		expect(decryptCalls).toBe(1);
		expect(encryptCalls).toBe(1);
		expect(readFileSync(keyPath, "utf8")).toBe(
			`current:${key.toString("base64")}`,
		);
	});

	it("does not invent a key when an existing database has a leftover Keychain-protected key", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-credentials-legacy-key-"));
		roots.push(root);
		mkdirSync(join(root, "database"), { recursive: true });
		mkdirSync(join(root, "secure"), { recursive: true });
		writeFileSync(join(root, "database", "kestrel.sqlite"), "encrypted profile");
		writeFileSync(join(root, "secure", "database-key.bin"), Buffer.from([0, 1, 2]));
		const broker = new CredentialBroker(root, new PlaintextSecretProtection());

		await expect(broker.getDatabaseKey()).rejects.toBeInstanceOf(
			ProtectedDatabaseError,
		);
		expect(readFileSync(join(root, "secure", "database-key.bin")).equals(Buffer.from([0, 1, 2]))).toBe(
			true,
		);
	});

	it("does not invent a key when an existing database has lost its key file", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-credentials-missing-key-"));
		roots.push(root);
		mkdirSync(join(root, "database"), { recursive: true });
		writeFileSync(join(root, "database", "kestrel.sqlite"), "encrypted profile");
		const broker = new CredentialBroker(root, {
			isEncryptionAvailable: () => true,
			decryptString: async () => "unused",
			encryptString: async () => Buffer.from("unused"),
		});

		await expect(broker.getDatabaseKey()).rejects.toBeInstanceOf(
			ProtectedDatabaseError,
		);
		expect(existsSync(join(root, "secure", "database-key.bin"))).toBe(false);
	});

	it("migrates individually protected legacy credentials to the one-root-key format", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-credentials-migrate-"));
		roots.push(root);
		const key = Buffer.alloc(32, 11);
		const credentialRoot = join(root, "secure", "credentials");
		mkdirSync(credentialRoot, { recursive: true });
		const seal = (value: string) =>
			Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`);
		writeFileSync(
			join(root, "secure", "database-key.bin"),
			seal(key.toString("base64")),
		);
		writeFileSync(
			join(credentialRoot, "openai.bin"),
			seal("sk-legacy-secret-value"),
		);
		let decryptCalls = 0;
		const protection = {
			isEncryptionAvailable: () => true,
			encryptString: async (value: string) => seal(value),
			decryptString: async (value: Buffer) => {
				decryptCalls += 1;
				return Buffer.from(
					value.toString().slice("sealed:".length),
					"base64",
				).toString();
			},
		};

		const first = new CredentialBroker(root, protection);
		expect((await first.providerEnvironment()).OPENAI_API_KEY).toBe(
			"sk-legacy-secret-value",
		);
		expect(decryptCalls).toBe(2);
		expect(readFileSync(join(credentialRoot, "openai.bin"), "utf8")).toMatch(
			/^kestrel-secret-v1\n/,
		);

		const reopened = new CredentialBroker(root, protection);
		expect((await reopened.providerEnvironment()).OPENAI_API_KEY).toBe(
			"sk-legacy-secret-value",
		);
		expect(decryptCalls).toBe(3);
	});

	it("refuses to load or store secrets when protection is unavailable", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "kestrel-credentials-unavailable-"),
		);
		roots.push(root);
		const broker = new CredentialBroker(root, {
			isEncryptionAvailable: () => false,
			encryptString: async () => Buffer.alloc(0),
			decryptString: async () => "",
		});
		await expect(
			broker.setCredential("anthropic", "test-secret-value"),
		).rejects.toThrow("Protected storage is unavailable");
		await expect(broker.getDatabaseKey()).rejects.toThrow(
			"Protected storage is unavailable",
		);
		await expect(broker.getDatabaseKey()).rejects.toBeInstanceOf(
			SecureStorageError,
		);
	});

	it("serializes concurrent writes to the same secret across broker instances", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-credentials-concurrent-"));
		roots.push(root);
		const first = new CredentialBroker(root, {
			isEncryptionAvailable: () => true,
			encryptString: async (value: string) =>
				Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`),
			decryptString: async (value: Buffer) =>
				Buffer.from(
					value.toString().slice("sealed:".length),
					"base64",
				).toString(),
		});
		const second = new CredentialBroker(root, {
			isEncryptionAvailable: () => true,
			encryptString: async (value: string) =>
				Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`),
			decryptString: async (value: Buffer) =>
				Buffer.from(
					value.toString().slice("sealed:".length),
					"base64",
				).toString(),
		});

		await Promise.all([
			first.setCredential("openai", "first-secret-value"),
			second.setCredential("openai", "second-secret-value"),
		]);

		expect(["first-secret-value", "second-secret-value"]).toContain(
			await new CredentialBroker(root, {
				isEncryptionAvailable: () => true,
				encryptString: async (value: string) =>
					Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`),
				decryptString: async (value: Buffer) =>
					Buffer.from(
						value.toString().slice("sealed:".length),
						"base64",
					).toString(),
			})
				.providerEnvironment()
				.then((environment) => environment.OPENAI_API_KEY),
		);
	});
});
