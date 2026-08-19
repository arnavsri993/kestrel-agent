import { hkdfSync, randomBytes } from "node:crypto";
import {
	chmod,
	mkdir,
	readFile,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { ProtectedDatabaseError } from "@kestrel/database";
import { decryptText, encryptText } from "@kestrel/encryption";

export type BrokeredCredentialId =
	| "openai"
	| "openai-secondary"
	| "anthropic"
	| "anthropic-secondary"
	| "gemini"
	| "nous"
	| "groq"
	| "mistral"
	| "openrouter"
	| "cloudflare"
	| "xai"
	| "deepseek"
	| "together"
	| "fireworks"
	| "nvidia"
	| "huggingface"
	| "perplexity"
	| "github-models"
	| "cohere"
	| "brave-search"
	| "github"
	| "honcho"
	| "fal";

export const BROKERED_CREDENTIALS: Record<
	BrokeredCredentialId,
	{ environmentKey: string; label: string }
> = {
	openai: { environmentKey: "OPENAI_API_KEY", label: "OpenAI API key" },
	"openai-secondary": {
		environmentKey: "OPENAI_API_KEY_SECONDARY",
		label: "OpenAI backup API key",
	},
	anthropic: {
		environmentKey: "ANTHROPIC_API_KEY",
		label: "Anthropic API key",
	},
	"anthropic-secondary": {
		environmentKey: "ANTHROPIC_API_KEY_SECONDARY",
		label: "Anthropic backup API key",
	},
	gemini: { environmentKey: "GEMINI_API_KEY", label: "Google Gemini API key" },
	nous: { environmentKey: "NOUS_API_KEY", label: "Nous Portal API key" },
	groq: { environmentKey: "GROQ_API_KEY", label: "Groq API key" },
	mistral: { environmentKey: "MISTRAL_API_KEY", label: "Mistral API key" },
	openrouter: {
		environmentKey: "OPENROUTER_API_KEY",
		label: "OpenRouter API key",
	},
	cloudflare: {
		environmentKey: "CLOUDFLARE_API_KEY",
		label: "Cloudflare Workers AI API token",
	},
	xai: { environmentKey: "XAI_API_KEY", label: "xAI API key" },
	deepseek: { environmentKey: "DEEPSEEK_API_KEY", label: "DeepSeek API key" },
	together: {
		environmentKey: "TOGETHER_API_KEY",
		label: "Together AI API key",
	},
	fireworks: {
		environmentKey: "FIREWORKS_API_KEY",
		label: "Fireworks AI API key",
	},
	nvidia: { environmentKey: "NVIDIA_API_KEY", label: "NVIDIA NIM API key" },
	huggingface: {
		environmentKey: "HUGGINGFACE_API_KEY",
		label: "Hugging Face token",
	},
	perplexity: {
		environmentKey: "PERPLEXITY_API_KEY",
		label: "Perplexity API key",
	},
	"github-models": {
		environmentKey: "GITHUB_MODELS_TOKEN",
		label: "GitHub Models token",
	},
	cohere: { environmentKey: "COHERE_API_KEY", label: "Cohere API key" },
	"brave-search": {
		environmentKey: "BRAVE_SEARCH_API_KEY",
		label: "Brave Search API key",
	},
	github: { environmentKey: "GITHUB_TOKEN", label: "GitHub token" },
	honcho: { environmentKey: "HONCHO_API_KEY", label: "Honcho API key" },
	fal: { environmentKey: "FAL_KEY", label: "fal media API key" },
};

const BROKERED_NON_SECRET_ENVIRONMENT_KEYS = [
	"KESTREL_ALLOW_EXTERNAL_SEARCH",
	"KESTREL_WEB_ALLOWED_HOSTS",
	"KESTREL_ALLOW_HOSTED_TRANSCRIPTION",
	"KESTREL_OPENAI_TRANSCRIPTION_MODEL",
	"KESTREL_OPENAI_IMAGE_MODEL",
	"KESTREL_OPENAI_SPEECH_MODEL",
	"KESTREL_OPENAI_VOICE",
	"KESTREL_OLLAMA_CONTEXT_WINDOW",
] as const;

export const SECURE_STORAGE_UNAVAILABLE_MESSAGE =
	"Protected storage is unavailable; Agent Core will not start with an unprotected key.";
const SECRET_ENVELOPE_PREFIX = Buffer.from("kestrel-secret-v1\n", "utf8");
const PLAINTEXT_PROTECTION_PREFIX = Buffer.from("kestrel-plaintext-v1\n", "utf8");
const SECRET_KEY_SALT = Buffer.from("kestrel-credential-broker-v1", "utf8");
const fileMutationQueues = new Map<string, Promise<void>>();

export class SecureStorageError extends Error {
	readonly code = "kestrel-secure-storage-unavailable";

	constructor(message: string, cause?: unknown) {
		super(message);
		this.name = "SecureStorageError";
		if (cause !== undefined) this.cause = cause;
	}
}

export function isSecureStorageError(error: unknown): error is SecureStorageError {
	return error instanceof SecureStorageError;
}

function asSecureStorageError(error: unknown): SecureStorageError {
	if (isSecureStorageError(error)) return error;
	return new SecureStorageError(
		"Kestrel could not unlock its protected data. Restore the local database key file, then try again.",
		error,
	);
}

export interface ResolvedExternalCredentials {
	values: Partial<Record<BrokeredCredentialId, string>>;
	overrideStoredIds: BrokeredCredentialId[];
}

export interface ProtectedDecryption {
	result: string;
	shouldReEncrypt: boolean;
}

interface SecretProtection {
	isEncryptionAvailable?(): boolean;
	prepare?(): Promise<void>;
	encryptString(value: string): Promise<Buffer>;
	decryptString(value: Buffer): Promise<string | ProtectedDecryption>;
}

export class PlaintextSecretProtection implements SecretProtection {
	isEncryptionAvailable(): boolean {
		return true;
	}

	async encryptString(value: string): Promise<Buffer> {
		return Buffer.concat([
			PLAINTEXT_PROTECTION_PREFIX,
			Buffer.from(value, "utf8"),
		]);
	}

	async decryptString(value: Buffer): Promise<ProtectedDecryption> {
		if (
			value
				.subarray(0, PLAINTEXT_PROTECTION_PREFIX.length)
				.equals(PLAINTEXT_PROTECTION_PREFIX)
		) {
			return {
				result: value.subarray(PLAINTEXT_PROTECTION_PREFIX.length).toString("utf8"),
				shouldReEncrypt: false,
			};
		}
		throw new SecureStorageError(
			"Kestrel found a Keychain-protected secret, but this build stores the database key as a local file instead of using macOS Keychain.",
		);
	}
}

let defaultProtection: Promise<SecretProtection> | undefined;

function loadDefaultProtection(): Promise<SecretProtection> {
	defaultProtection ??= Promise.resolve(new PlaintextSecretProtection());
	return defaultProtection;
}

export class CredentialBroker {
	private readonly keyPath: string;
	private readonly databasePath: string;
	private readonly credentialRoot: string;
	private readonly protection: Promise<SecretProtection>;
	private databaseKey: Promise<Buffer> | undefined;
	private readonly credentialCache = new Map<
		BrokeredCredentialId,
		Promise<string | undefined>
	>();
	private readonly opaqueSecretCache = new Map<
		string,
		Promise<string | undefined>
	>();

	constructor(userDataPath: string, protection?: SecretProtection) {
		this.keyPath = join(userDataPath, "secure", "database-key.bin");
		this.databasePath = join(userDataPath, "database", "kestrel.sqlite");
		this.credentialRoot = join(userDataPath, "secure", "credentials");
		this.protection = protection
			? Promise.resolve(protection)
			: loadDefaultProtection();
	}

	async getDatabaseKey(): Promise<Buffer> {
		this.databaseKey ??= this.loadDatabaseKey();
		try {
			return await this.databaseKey;
		} catch (error) {
			this.databaseKey = undefined;
			throw error;
		}
	}

	async listCredentials(): Promise<
		Array<{ id: BrokeredCredentialId; label: string; configured: boolean }>
	> {
		return Promise.all(
			(Object.keys(BROKERED_CREDENTIALS) as BrokeredCredentialId[]).map(
				async (id) => ({
					id,
					label: BROKERED_CREDENTIALS[id].label,
					configured: await this.hasCredential(id),
				}),
			),
		);
	}

	async setCredential(id: BrokeredCredentialId, value: string): Promise<void> {
		if (!BROKERED_CREDENTIALS[id])
			throw new Error("Credential type is not supported.");
		const secret = value.trim();
		if (secret.length < 8 || secret.length > 20_000 || /[\r\n\0]/.test(secret))
			throw new Error("Credential value is invalid.");
		const path = this.credentialPath(id);
		await this.mutateFile(path, async () => {
			await this.writeSecret(
				path,
				`credential:${id}`,
				secret,
				await this.getDatabaseKey(),
			);
			this.credentialCache.set(id, Promise.resolve(secret));
		});
	}

	async removeCredential(id: BrokeredCredentialId): Promise<void> {
		if (!BROKERED_CREDENTIALS[id])
			throw new Error("Credential type is not supported.");
		await this.mutateFile(this.credentialPath(id), async () => {
			try {
				await unlink(this.credentialPath(id));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			this.credentialCache.delete(id);
		});
	}

	async setOpaqueSecret(id: string, value: string): Promise<void> {
		this.assertOpaqueId(id);
		if (value.length < 8 || value.length > 100_000 || value.includes("\0"))
			throw new Error("Opaque credential value is invalid.");
		const path = this.opaquePath(id);
		await this.mutateFile(path, async () => {
			await this.writeSecret(
				path,
				`opaque:${id}`,
				value,
				await this.getDatabaseKey(),
			);
			this.opaqueSecretCache.set(id, Promise.resolve(value));
		});
	}

	async getOpaqueSecret(id: string): Promise<string | undefined> {
		this.assertOpaqueId(id);
		const cached = this.opaqueSecretCache.get(id);
		if (cached) return cached;
		const pending = this.loadOpaqueSecret(id);
		this.opaqueSecretCache.set(id, pending);
		try {
			return await pending;
		} catch (error) {
			if (this.opaqueSecretCache.get(id) === pending)
				this.opaqueSecretCache.delete(id);
			throw error;
		}
	}

	async removeOpaqueSecret(id: string): Promise<void> {
		this.assertOpaqueId(id);
		await this.mutateFile(this.opaquePath(id), async () => {
			try {
				await unlink(this.opaquePath(id));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			this.opaqueSecretCache.delete(id);
		});
	}

	async providerEnvironment(
		base: NodeJS.ProcessEnv = process.env,
		external?: ResolvedExternalCredentials,
	): Promise<NodeJS.ProcessEnv> {
		const environment: NodeJS.ProcessEnv = {
			...(base.OPENAI_BASE_URL
				? { OPENAI_BASE_URL: base.OPENAI_BASE_URL }
				: {}),
			...(base.OPENAI_ORGANIZATION
				? { OPENAI_ORGANIZATION: base.OPENAI_ORGANIZATION }
				: {}),
			...(base.OPENAI_PROJECT ? { OPENAI_PROJECT: base.OPENAI_PROJECT } : {}),
			...(base.OPENAI_MODEL ? { OPENAI_MODEL: base.OPENAI_MODEL } : {}),
			...(base.ANTHROPIC_BASE_URL
				? { ANTHROPIC_BASE_URL: base.ANTHROPIC_BASE_URL }
				: {}),
			...(base.ANTHROPIC_MODEL
				? { ANTHROPIC_MODEL: base.ANTHROPIC_MODEL }
				: {}),
			...(base.GEMINI_BASE_URL
				? { GEMINI_BASE_URL: base.GEMINI_BASE_URL }
				: {}),
			...(base.GEMINI_MODEL ? { GEMINI_MODEL: base.GEMINI_MODEL } : {}),
			...Object.fromEntries(
				Object.entries(base).filter(
					([key, value]) =>
						value &&
						/^(NOUS|GROQ|MISTRAL|OPENROUTER|CLOUDFLARE|XAI|DEEPSEEK|TOGETHER|FIREWORKS|NVIDIA|HUGGINGFACE|PERPLEXITY|GITHUB_MODELS|COHERE)_(BASE_URL|MODEL|ACCOUNT_ID|SITE_URL|APP_NAME)$/.test(
							key,
						),
				),
			),
			...(base.KESTREL_OLLAMA_BASE_URL
				? { KESTREL_OLLAMA_BASE_URL: base.KESTREL_OLLAMA_BASE_URL }
				: {}),
			...(base.KESTREL_OLLAMA_MODEL
				? { KESTREL_OLLAMA_MODEL: base.KESTREL_OLLAMA_MODEL }
				: {}),
			...(base.KESTREL_ENABLE_OLLAMA
				? { KESTREL_ENABLE_OLLAMA: base.KESTREL_ENABLE_OLLAMA }
				: {}),
			...(base.KESTREL_ENABLE_CODEX_SUBSCRIPTION
				? {
						KESTREL_ENABLE_CODEX_SUBSCRIPTION:
							base.KESTREL_ENABLE_CODEX_SUBSCRIPTION,
					}
				: {}),
			...(base.KESTREL_CODEX_PATH
				? { KESTREL_CODEX_PATH: base.KESTREL_CODEX_PATH }
				: {}),
			...(base.KESTREL_CODEX_SUBSCRIPTION_MODEL
				? {
						KESTREL_CODEX_SUBSCRIPTION_MODEL:
							base.KESTREL_CODEX_SUBSCRIPTION_MODEL,
					}
				: {}),
			...(base.KESTREL_ENABLE_CLAUDE_SUBSCRIPTION
				? {
						KESTREL_ENABLE_CLAUDE_SUBSCRIPTION:
							base.KESTREL_ENABLE_CLAUDE_SUBSCRIPTION,
					}
				: {}),
			...(base.KESTREL_CLAUDE_PATH
				? { KESTREL_CLAUDE_PATH: base.KESTREL_CLAUDE_PATH }
				: {}),
			...(base.KESTREL_CLAUDE_SUBSCRIPTION_MODEL
				? {
						KESTREL_CLAUDE_SUBSCRIPTION_MODEL:
							base.KESTREL_CLAUDE_SUBSCRIPTION_MODEL,
					}
				: {}),
			...(base.KESTREL_ENABLE_OPENCODE_SUBSCRIPTION
				? {
						KESTREL_ENABLE_OPENCODE_SUBSCRIPTION:
							base.KESTREL_ENABLE_OPENCODE_SUBSCRIPTION,
					}
				: {}),
			...(base.KESTREL_OPENCODE_PATH
				? { KESTREL_OPENCODE_PATH: base.KESTREL_OPENCODE_PATH }
				: {}),
			...(base.KESTREL_OPENCODE_SUBSCRIPTION_MODEL
				? {
						KESTREL_OPENCODE_SUBSCRIPTION_MODEL:
							base.KESTREL_OPENCODE_SUBSCRIPTION_MODEL,
					}
				: {}),
			...(base.KESTREL_WEB_ALLOW_PUBLIC
				? { KESTREL_WEB_ALLOW_PUBLIC: base.KESTREL_WEB_ALLOW_PUBLIC }
				: {}),
			...Object.fromEntries(
				BROKERED_NON_SECRET_ENVIRONMENT_KEYS.flatMap((key) =>
					base[key] ? [[key, base[key]]] : [],
				),
			),
			...(base.KESTREL_REMOTE_TARGETS
				? { KESTREL_REMOTE_TARGETS: base.KESTREL_REMOTE_TARGETS }
				: {}),
		};
		for (const id of Object.keys(
			BROKERED_CREDENTIALS,
		) as BrokeredCredentialId[]) {
			const stored = await this.getCredential(id);
			const inherited = base[BROKERED_CREDENTIALS[id].environmentKey];
			const resolved = external?.values[id];
			const value =
				resolved &&
				(external?.overrideStoredIds.includes(id) || (!stored && !inherited))
					? resolved
					: (stored ?? inherited);
			if (value) environment[BROKERED_CREDENTIALS[id].environmentKey] = value;
		}
		const googleWorkspaceOAuth = await this.getOpaqueSecret(
			"google-workspace-oauth",
		);
		if (googleWorkspaceOAuth)
			environment.KESTREL_GOOGLE_WORKSPACE_OAUTH = googleWorkspaceOAuth;
		return environment;
	}

	private async hasCredential(id: BrokeredCredentialId): Promise<boolean> {
		try {
			await readFile(this.credentialPath(id));
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}

	private async getCredential(
		id: BrokeredCredentialId,
	): Promise<string | undefined> {
		const cached = this.credentialCache.get(id);
		if (cached) return cached;
		const pending = this.loadCredential(id);
		this.credentialCache.set(id, pending);
		try {
			return await pending;
		} catch (error) {
			if (this.credentialCache.get(id) === pending)
				this.credentialCache.delete(id);
			throw error;
		}
	}

	private async loadDatabaseKey(): Promise<Buffer> {
		return this.mutateFile(this.keyPath, async () => {
			const protection = await this.availableProtection(
				SECURE_STORAGE_UNAVAILABLE_MESSAGE,
			);
			try {
				const encrypted = await readFile(this.keyPath);
				const decrypted = this.normalizedDecryption(
					await this.decryptWithProtection(protection, encrypted),
				);
				const key = Buffer.from(decrypted.result, "base64");
				if (key.length !== 32 || key.toString("base64") !== decrypted.result)
					throw new Error("The protected database key is invalid.");
				if (decrypted.shouldReEncrypt)
					await this.writeProtectedFile(
						this.keyPath,
						await this.encryptWithProtection(protection, decrypted.result),
					);
				return key;
			} catch (error) {
				const missingKeyFile =
					(error as NodeJS.ErrnoException).code === "ENOENT";
				if (!missingKeyFile && !isSecureStorageError(error)) throw error;
				try {
					if ((await stat(this.databasePath)).isFile())
						throw new ProtectedDatabaseError(
							missingKeyFile
								? "Kestrel found its encrypted database, but the protected database key is missing. The existing profile will not be overwritten."
								: "Kestrel found its encrypted database, but this build no longer uses macOS Keychain to unlock the old key. The existing profile will not be overwritten.",
						);
				} catch (databaseError) {
					if (databaseError instanceof ProtectedDatabaseError)
						throw databaseError;
					if ((databaseError as NodeJS.ErrnoException).code !== "ENOENT")
						throw databaseError;
				}
				const key = randomBytes(32);
				await this.writeProtectedFile(
					this.keyPath,
					await this.encryptWithProtection(
						protection,
						key.toString("base64"),
					),
				);
				return key;
			}
		});
	}

	private async loadCredential(
		id: BrokeredCredentialId,
	): Promise<string | undefined> {
		return this.loadSecret(this.credentialPath(id), `credential:${id}`);
	}

	private async loadOpaqueSecret(id: string): Promise<string | undefined> {
		return this.loadSecret(this.opaquePath(id), `opaque:${id}`);
	}

	private async loadSecret(
		path: string,
		purpose: string,
	): Promise<string | undefined> {
		return this.mutateFile(path, async () => {
			let encrypted: Buffer;
			try {
				encrypted = await readFile(path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT")
					return undefined;
				throw error;
			}
			const databaseKey = await this.getDatabaseKey();
			if (
				encrypted
					.subarray(0, SECRET_ENVELOPE_PREFIX.length)
					.equals(SECRET_ENVELOPE_PREFIX)
			)
				return this.decryptSecret(encrypted, purpose, databaseKey);

			// Older builds protected files individually with Electron safeStorage.
			// This build never opens macOS Keychain, so leftover ciphertext is refused.
			const legacy = this.normalizedDecryption(
				await this.decryptWithProtection(
					await this.availableProtection(),
					encrypted,
				),
			).result;
			await this.writeSecret(path, purpose, legacy, databaseKey);
			return legacy;
		});
	}

	private decryptSecret(
		encrypted: Buffer,
		purpose: string,
		databaseKey: Buffer,
	): string {
		let envelope: unknown;
		try {
			envelope = JSON.parse(
				encrypted.subarray(SECRET_ENVELOPE_PREFIX.length).toString("utf8"),
			);
		} catch {
			throw new Error("A protected credential file is malformed.");
		}
		if (
			!envelope ||
			typeof envelope !== "object" ||
			(envelope as { version?: unknown }).version !== 1 ||
			(envelope as { algorithm?: unknown }).algorithm !== "aes-256-gcm" ||
			typeof (envelope as { ciphertext?: unknown }).ciphertext !== "string" ||
			typeof (envelope as { iv?: unknown }).iv !== "string" ||
			typeof (envelope as { authTag?: unknown }).authTag !== "string"
		)
			throw new Error("A protected credential file is malformed.");
		const payload = envelope as {
			ciphertext: string;
			iv: string;
			authTag: string;
		};
		return decryptText(payload, this.secretKey(databaseKey, purpose));
	}

	private async writeSecret(
		path: string,
		purpose: string,
		value: string,
		databaseKey: Buffer,
	): Promise<void> {
		const payload = encryptText(value, this.secretKey(databaseKey, purpose));
		await this.writeProtectedFile(
			path,
			Buffer.concat([
				SECRET_ENVELOPE_PREFIX,
				Buffer.from(
					JSON.stringify({
						version: 1,
						algorithm: "aes-256-gcm",
						...payload,
					}),
					"utf8",
				),
			]),
		);
	}

	private secretKey(databaseKey: Buffer, purpose: string): Buffer {
		return Buffer.from(
			hkdfSync(
				"sha256",
				databaseKey,
				SECRET_KEY_SALT,
				Buffer.from(purpose, "utf8"),
				32,
			),
		);
	}

	private normalizedDecryption(
		decrypted: string | ProtectedDecryption,
	): ProtectedDecryption {
		return typeof decrypted === "string"
			? { result: decrypted, shouldReEncrypt: false }
			: decrypted;
	}

	private async writeProtectedFile(path: string, value: Buffer): Promise<void> {
		const temporary = `${path}.new`;
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		try {
			await writeFile(temporary, value, { mode: 0o600 });
			await chmod(temporary, 0o600);
			await rename(temporary, path);
			await chmod(path, 0o600);
		} finally {
			await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		}
	}

	private credentialPath(id: BrokeredCredentialId): string {
		return join(this.credentialRoot, `${id}.bin`);
	}
	private opaquePath(id: string): string {
		return join(this.credentialRoot, `opaque-${id}.bin`);
	}
	private assertOpaqueId(id: string): void {
		if (!/^[a-z][a-z0-9-]{0,63}$/.test(id))
			throw new Error("Opaque credential ID is invalid.");
	}

	private async availableProtection(
		unavailableMessage = "Protected storage is unavailable; credentials will not be stored or loaded unprotected.",
	): Promise<SecretProtection> {
		const protection = await this.protection;
		if (protection.prepare) {
			try {
				await protection.prepare();
			} catch (error) {
				throw asSecureStorageError(error);
			}
		} else if (!protection.isEncryptionAvailable?.())
			throw new SecureStorageError(unavailableMessage);
		return protection;
	}

	private async encryptWithProtection(
		protection: SecretProtection,
		value: string,
	): Promise<Buffer> {
		try {
			return await protection.encryptString(value);
		} catch (error) {
			throw asSecureStorageError(error);
		}
	}

	private async decryptWithProtection(
		protection: SecretProtection,
		value: Buffer,
	): Promise<string | ProtectedDecryption> {
		try {
			return await protection.decryptString(value);
		} catch (error) {
			throw asSecureStorageError(error);
		}
	}

	private async mutateFile<T>(
		path: string,
		operation: () => Promise<T>,
	): Promise<T> {
		const previous = fileMutationQueues.get(path) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const queued = previous.catch(() => undefined).then(() => current);
		fileMutationQueues.set(path, queued);
		await previous.catch(() => undefined);
		try {
			return await operation();
		} finally {
			release();
			if (fileMutationQueues.get(path) === queued)
				fileMutationQueues.delete(path);
		}
	}
}
