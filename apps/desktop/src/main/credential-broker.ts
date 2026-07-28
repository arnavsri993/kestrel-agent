import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { safeStorage } from "electron";

export type BrokeredCredentialId = "openai" | "openai-secondary" | "anthropic" | "anthropic-secondary" | "gemini" | "nous" | "groq" | "mistral" | "openrouter" | "cloudflare" | "xai" | "deepseek" | "together" | "fireworks" | "nvidia" | "huggingface" | "perplexity" | "github-models" | "cohere" | "brave-search" | "github" | "honcho" | "fal";

export const BROKERED_CREDENTIALS: Record<BrokeredCredentialId, { environmentKey: string; label: string }> = {
  openai: { environmentKey: "OPENAI_API_KEY", label: "OpenAI API key" },
  "openai-secondary": { environmentKey: "OPENAI_API_KEY_SECONDARY", label: "OpenAI backup API key" },
  anthropic: { environmentKey: "ANTHROPIC_API_KEY", label: "Anthropic API key" },
  "anthropic-secondary": { environmentKey: "ANTHROPIC_API_KEY_SECONDARY", label: "Anthropic backup API key" },
  gemini: { environmentKey: "GEMINI_API_KEY", label: "Google Gemini API key" },
  nous: { environmentKey: "NOUS_API_KEY", label: "Nous Portal API key" },
  groq: { environmentKey: "GROQ_API_KEY", label: "Groq API key" },
  mistral: { environmentKey: "MISTRAL_API_KEY", label: "Mistral API key" },
  openrouter: { environmentKey: "OPENROUTER_API_KEY", label: "OpenRouter API key" },
  cloudflare: { environmentKey: "CLOUDFLARE_API_KEY", label: "Cloudflare Workers AI API token" },
  xai: { environmentKey: "XAI_API_KEY", label: "xAI API key" },
  deepseek: { environmentKey: "DEEPSEEK_API_KEY", label: "DeepSeek API key" },
  together: { environmentKey: "TOGETHER_API_KEY", label: "Together AI API key" },
  fireworks: { environmentKey: "FIREWORKS_API_KEY", label: "Fireworks AI API key" },
  nvidia: { environmentKey: "NVIDIA_API_KEY", label: "NVIDIA NIM API key" },
  huggingface: { environmentKey: "HUGGINGFACE_API_KEY", label: "Hugging Face token" },
  perplexity: { environmentKey: "PERPLEXITY_API_KEY", label: "Perplexity API key" },
  "github-models": { environmentKey: "GITHUB_MODELS_TOKEN", label: "GitHub Models token" },
  cohere: { environmentKey: "COHERE_API_KEY", label: "Cohere API key" },
  "brave-search": { environmentKey: "BRAVE_SEARCH_API_KEY", label: "Brave Search API key" },
  github: { environmentKey: "GITHUB_TOKEN", label: "GitHub token" },
  honcho: { environmentKey: "HONCHO_API_KEY", label: "Honcho API key" },
  fal: { environmentKey: "FAL_KEY", label: "fal media API key" }
};

const BROKERED_NON_SECRET_ENVIRONMENT_KEYS = [
  "KESTREL_ALLOW_EXTERNAL_SEARCH",
  "KESTREL_WEB_ALLOWED_HOSTS",
  "KESTREL_ALLOW_HOSTED_TRANSCRIPTION",
  "KESTREL_OPENAI_TRANSCRIPTION_MODEL",
  "KESTREL_OPENAI_IMAGE_MODEL",
  "KESTREL_OPENAI_SPEECH_MODEL",
  "KESTREL_OPENAI_VOICE",
  "KESTREL_OLLAMA_CONTEXT_WINDOW"
] as const;

export interface ResolvedExternalCredentials {
  values: Partial<Record<BrokeredCredentialId, string>>;
  overrideStoredIds: BrokeredCredentialId[];
}

interface SecretProtection {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export class CredentialBroker {
  private readonly keyPath: string;
  private readonly credentialRoot: string;

  constructor(userDataPath: string, private readonly protection: SecretProtection = safeStorage) {
    this.keyPath = join(userDataPath, "secure", "database-key.bin");
    this.credentialRoot = join(userDataPath, "secure", "credentials");
  }

  async getDatabaseKey(): Promise<Buffer> {
    if (!this.protection.isEncryptionAvailable()) throw new Error("macOS secure storage is unavailable; Agent Core will not start with an unprotected key.");
    try {
      const encrypted = await readFile(this.keyPath);
      return Buffer.from(this.protection.decryptString(encrypted), "base64");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const key = randomBytes(32);
      await mkdir(dirname(this.keyPath), { recursive: true, mode: 0o700 });
      await writeFile(this.keyPath, this.protection.encryptString(key.toString("base64")), { mode: 0o600 });
      await chmod(this.keyPath, 0o600);
      return key;
    }
  }

  async listCredentials(): Promise<Array<{ id: BrokeredCredentialId; label: string; configured: boolean }>> {
    return Promise.all((Object.keys(BROKERED_CREDENTIALS) as BrokeredCredentialId[]).map(async (id) => ({ id, label: BROKERED_CREDENTIALS[id].label, configured: await this.hasCredential(id) })));
  }

  async setCredential(id: BrokeredCredentialId, value: string): Promise<void> {
    this.assertAvailable();
    if (!BROKERED_CREDENTIALS[id]) throw new Error("Credential type is not supported.");
    const secret = value.trim();
    if (secret.length < 8 || secret.length > 20_000 || /[\r\n\0]/.test(secret)) throw new Error("Credential value is invalid.");
    const path = this.credentialPath(id);
    const temporary = `${path}.new`;
    await mkdir(this.credentialRoot, { recursive: true, mode: 0o700 });
    await writeFile(temporary, this.protection.encryptString(secret), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  }

  async removeCredential(id: BrokeredCredentialId): Promise<void> {
    if (!BROKERED_CREDENTIALS[id]) throw new Error("Credential type is not supported.");
    try { await unlink(this.credentialPath(id)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  async setOpaqueSecret(id: string, value: string): Promise<void> {
    this.assertOpaqueId(id);
    this.assertAvailable();
    if (value.length < 8 || value.length > 100_000 || value.includes("\0")) throw new Error("Opaque credential value is invalid.");
    const path = this.opaquePath(id);
    const temporary = `${path}.new`;
    await mkdir(this.credentialRoot, { recursive: true, mode: 0o700 });
    await writeFile(temporary, this.protection.encryptString(value), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  }

  async getOpaqueSecret(id: string): Promise<string | undefined> {
    this.assertOpaqueId(id);
    this.assertAvailable();
    try { return this.protection.decryptString(await readFile(this.opaquePath(id))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  async removeOpaqueSecret(id: string): Promise<void> {
    this.assertOpaqueId(id);
    try { await unlink(this.opaquePath(id)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  async providerEnvironment(base: NodeJS.ProcessEnv = process.env, external?: ResolvedExternalCredentials): Promise<NodeJS.ProcessEnv> {
    const environment: NodeJS.ProcessEnv = {
      ...(base.OPENAI_BASE_URL ? { OPENAI_BASE_URL: base.OPENAI_BASE_URL } : {}),
      ...(base.OPENAI_ORGANIZATION ? { OPENAI_ORGANIZATION: base.OPENAI_ORGANIZATION } : {}),
      ...(base.OPENAI_PROJECT ? { OPENAI_PROJECT: base.OPENAI_PROJECT } : {}),
      ...(base.OPENAI_MODEL ? { OPENAI_MODEL: base.OPENAI_MODEL } : {}),
      ...(base.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: base.ANTHROPIC_BASE_URL } : {}),
      ...(base.ANTHROPIC_MODEL ? { ANTHROPIC_MODEL: base.ANTHROPIC_MODEL } : {}),
      ...(base.GEMINI_BASE_URL ? { GEMINI_BASE_URL: base.GEMINI_BASE_URL } : {}),
      ...(base.GEMINI_MODEL ? { GEMINI_MODEL: base.GEMINI_MODEL } : {}),
      ...Object.fromEntries(Object.entries(base).filter(([key, value]) =>
        value && /^(NOUS|GROQ|MISTRAL|OPENROUTER|CLOUDFLARE|XAI|DEEPSEEK|TOGETHER|FIREWORKS|NVIDIA|HUGGINGFACE|PERPLEXITY|GITHUB_MODELS|COHERE)_(BASE_URL|MODEL|ACCOUNT_ID|SITE_URL|APP_NAME)$/.test(key))),
      ...(base.KESTREL_OLLAMA_BASE_URL ? { KESTREL_OLLAMA_BASE_URL: base.KESTREL_OLLAMA_BASE_URL } : {}),
      ...(base.KESTREL_OLLAMA_MODEL ? { KESTREL_OLLAMA_MODEL: base.KESTREL_OLLAMA_MODEL } : {}),
      ...(base.KESTREL_ENABLE_OLLAMA ? { KESTREL_ENABLE_OLLAMA: base.KESTREL_ENABLE_OLLAMA } : {}),
      ...(base.KESTREL_ENABLE_CODEX_SUBSCRIPTION ? { KESTREL_ENABLE_CODEX_SUBSCRIPTION: base.KESTREL_ENABLE_CODEX_SUBSCRIPTION } : {}),
      ...(base.KESTREL_CODEX_PATH ? { KESTREL_CODEX_PATH: base.KESTREL_CODEX_PATH } : {}),
      ...(base.KESTREL_CODEX_SUBSCRIPTION_MODEL ? { KESTREL_CODEX_SUBSCRIPTION_MODEL: base.KESTREL_CODEX_SUBSCRIPTION_MODEL } : {}),
      ...(base.KESTREL_ENABLE_CLAUDE_SUBSCRIPTION ? { KESTREL_ENABLE_CLAUDE_SUBSCRIPTION: base.KESTREL_ENABLE_CLAUDE_SUBSCRIPTION } : {}),
      ...(base.KESTREL_CLAUDE_PATH ? { KESTREL_CLAUDE_PATH: base.KESTREL_CLAUDE_PATH } : {}),
      ...(base.KESTREL_CLAUDE_SUBSCRIPTION_MODEL ? { KESTREL_CLAUDE_SUBSCRIPTION_MODEL: base.KESTREL_CLAUDE_SUBSCRIPTION_MODEL } : {}),
      ...(base.KESTREL_WEB_ALLOW_PUBLIC ? { KESTREL_WEB_ALLOW_PUBLIC: base.KESTREL_WEB_ALLOW_PUBLIC } : {}),
      ...Object.fromEntries(BROKERED_NON_SECRET_ENVIRONMENT_KEYS.flatMap((key) => base[key] ? [[key, base[key]]] : [])),
      ...(base.KESTREL_REMOTE_TARGETS ? { KESTREL_REMOTE_TARGETS: base.KESTREL_REMOTE_TARGETS } : {})
    };
    for (const id of Object.keys(BROKERED_CREDENTIALS) as BrokeredCredentialId[]) {
      const stored = await this.getCredential(id);
      const inherited = base[BROKERED_CREDENTIALS[id].environmentKey];
      const resolved = external?.values[id];
      const value = resolved && (external?.overrideStoredIds.includes(id) || (!stored && !inherited))
        ? resolved
        : stored ?? inherited;
      if (value) environment[BROKERED_CREDENTIALS[id].environmentKey] = value;
    }
    const googleWorkspaceOAuth = await this.getOpaqueSecret("google-workspace-oauth");
    if (googleWorkspaceOAuth) environment.KESTREL_GOOGLE_WORKSPACE_OAUTH = googleWorkspaceOAuth;
    return environment;
  }

  private async hasCredential(id: BrokeredCredentialId): Promise<boolean> {
    try { await readFile(this.credentialPath(id)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }

  private async getCredential(id: BrokeredCredentialId): Promise<string | undefined> {
    this.assertAvailable();
    try { return this.protection.decryptString(await readFile(this.credentialPath(id))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  private credentialPath(id: BrokeredCredentialId): string { return join(this.credentialRoot, `${id}.bin`); }
  private opaquePath(id: string): string { return join(this.credentialRoot, `opaque-${id}.bin`); }
  private assertOpaqueId(id: string): void {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error("Opaque credential ID is invalid.");
  }

  private assertAvailable(): void {
    if (!this.protection.isEncryptionAvailable()) throw new Error("macOS secure storage is unavailable; credentials will not be stored or loaded unprotected.");
  }
}
