import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { safeStorage } from "electron";

export type BrokeredCredentialId = "openai" | "openai-secondary" | "anthropic" | "anthropic-secondary" | "gemini" | "brave-search" | "github";

const credentials: Record<BrokeredCredentialId, { environmentKey: string; label: string }> = {
  openai: { environmentKey: "OPENAI_API_KEY", label: "OpenAI API key" },
  "openai-secondary": { environmentKey: "OPENAI_API_KEY_SECONDARY", label: "OpenAI backup API key" },
  anthropic: { environmentKey: "ANTHROPIC_API_KEY", label: "Anthropic API key" },
  "anthropic-secondary": { environmentKey: "ANTHROPIC_API_KEY_SECONDARY", label: "Anthropic backup API key" },
  gemini: { environmentKey: "GEMINI_API_KEY", label: "Google Gemini API key" },
  "brave-search": { environmentKey: "BRAVE_SEARCH_API_KEY", label: "Brave Search API key" },
  github: { environmentKey: "GITHUB_TOKEN", label: "GitHub token" }
};

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
    return Promise.all((Object.keys(credentials) as BrokeredCredentialId[]).map(async (id) => ({ id, label: credentials[id].label, configured: await this.hasCredential(id) })));
  }

  async setCredential(id: BrokeredCredentialId, value: string): Promise<void> {
    this.assertAvailable();
    if (!credentials[id]) throw new Error("Credential type is not supported.");
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
    if (!credentials[id]) throw new Error("Credential type is not supported.");
    try { await unlink(this.credentialPath(id)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  async providerEnvironment(base: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
    const environment: NodeJS.ProcessEnv = {
      ...(base.OPENAI_BASE_URL ? { OPENAI_BASE_URL: base.OPENAI_BASE_URL } : {}),
      ...(base.OPENAI_ORGANIZATION ? { OPENAI_ORGANIZATION: base.OPENAI_ORGANIZATION } : {}),
      ...(base.OPENAI_PROJECT ? { OPENAI_PROJECT: base.OPENAI_PROJECT } : {}),
      ...(base.OPENAI_MODEL ? { OPENAI_MODEL: base.OPENAI_MODEL } : {}),
      ...(base.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: base.ANTHROPIC_BASE_URL } : {}),
      ...(base.ANTHROPIC_MODEL ? { ANTHROPIC_MODEL: base.ANTHROPIC_MODEL } : {}),
      ...(base.GEMINI_BASE_URL ? { GEMINI_BASE_URL: base.GEMINI_BASE_URL } : {}),
      ...(base.GEMINI_MODEL ? { GEMINI_MODEL: base.GEMINI_MODEL } : {}),
      ...(base.KESTREL_OLLAMA_BASE_URL ? { KESTREL_OLLAMA_BASE_URL: base.KESTREL_OLLAMA_BASE_URL } : {}),
      ...(base.KESTREL_OLLAMA_MODEL ? { KESTREL_OLLAMA_MODEL: base.KESTREL_OLLAMA_MODEL } : {}),
      ...(base.KESTREL_ENABLE_OLLAMA ? { KESTREL_ENABLE_OLLAMA: base.KESTREL_ENABLE_OLLAMA } : {}),
      ...(base.KESTREL_ENABLE_CODEX_SUBSCRIPTION ? { KESTREL_ENABLE_CODEX_SUBSCRIPTION: base.KESTREL_ENABLE_CODEX_SUBSCRIPTION } : {}),
      ...(base.KESTREL_CODEX_PATH ? { KESTREL_CODEX_PATH: base.KESTREL_CODEX_PATH } : {}),
      ...(base.KESTREL_CODEX_SUBSCRIPTION_MODEL ? { KESTREL_CODEX_SUBSCRIPTION_MODEL: base.KESTREL_CODEX_SUBSCRIPTION_MODEL } : {}),
      ...(base.KESTREL_ENABLE_CLAUDE_SUBSCRIPTION ? { KESTREL_ENABLE_CLAUDE_SUBSCRIPTION: base.KESTREL_ENABLE_CLAUDE_SUBSCRIPTION } : {}),
      ...(base.KESTREL_CLAUDE_PATH ? { KESTREL_CLAUDE_PATH: base.KESTREL_CLAUDE_PATH } : {}),
      ...(base.KESTREL_CLAUDE_SUBSCRIPTION_MODEL ? { KESTREL_CLAUDE_SUBSCRIPTION_MODEL: base.KESTREL_CLAUDE_SUBSCRIPTION_MODEL } : {}),
      ...(base.KESTREL_WEB_ALLOW_PUBLIC ? { KESTREL_WEB_ALLOW_PUBLIC: base.KESTREL_WEB_ALLOW_PUBLIC } : {})
      ,...(base.KESTREL_REMOTE_TARGETS ? { KESTREL_REMOTE_TARGETS: base.KESTREL_REMOTE_TARGETS } : {})
    };
    for (const id of Object.keys(credentials) as BrokeredCredentialId[]) {
      const value = await this.getCredential(id);
      if (value) environment[credentials[id].environmentKey] = value;
      else if (base[credentials[id].environmentKey]) environment[credentials[id].environmentKey] = base[credentials[id].environmentKey];
    }
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

  private assertAvailable(): void {
    if (!this.protection.isEncryptionAvailable()) throw new Error("macOS secure storage is unavailable; credentials will not be stored or loaded unprotected.");
  }
}
