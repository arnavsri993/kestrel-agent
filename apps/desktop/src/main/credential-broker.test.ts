import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialBroker } from "./credential-broker";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("desktop credential broker", () => {
  it("stores scoped credentials encrypted, exports only the core environment, and revokes them", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-credentials-"));
    roots.push(root);
    const protection = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`),
      decryptString: (value: Buffer) => Buffer.from(value.toString().slice("sealed:".length), "base64").toString()
    };
    const broker = new CredentialBroker(root, protection);
    await broker.setCredential("openai", "sk-test-secret-value");
    await broker.setCredential("openai-secondary", "sk-test-backup-value");
    await broker.setOpaqueSecret("google-workspace-oauth", "{\"refreshToken\":\"refresh-secret\"}");
    expect(await broker.listCredentials()).toContainEqual({ id: "openai", label: "OpenAI API key", configured: true });
    expect(await broker.providerEnvironment({ OPENAI_BASE_URL: "https://provider.test/v1", KESTREL_ENABLE_CODEX_SUBSCRIPTION: "1", KESTREL_CODEX_PATH: "/Applications/ChatGPT.app/Contents/Resources/codex", UNRELATED_SECRET: "do-not-forward" })).toEqual({
      OPENAI_API_KEY: "sk-test-secret-value",
      OPENAI_API_KEY_SECONDARY: "sk-test-backup-value",
      OPENAI_BASE_URL: "https://provider.test/v1",
      KESTREL_ENABLE_CODEX_SUBSCRIPTION: "1",
      KESTREL_CODEX_PATH: "/Applications/ChatGPT.app/Contents/Resources/codex",
      KESTREL_GOOGLE_WORKSPACE_OAUTH: "{\"refreshToken\":\"refresh-secret\"}"
    });
    const storedPath = join(root, "secure", "credentials", "openai.bin");
    expect(readFileSync(storedPath, "utf8")).not.toContain("sk-test-secret-value");
    expect(statSync(storedPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(root, "secure", "credentials", "opaque-google-workspace-oauth.bin"), "utf8")).not.toContain("refresh-secret");
    await broker.removeCredential("openai");
    expect(await broker.listCredentials()).toContainEqual({ id: "openai", label: "OpenAI API key", configured: false });
  });

  it("refuses to load or store secrets without OS encryption", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-credentials-unavailable-"));
    roots.push(root);
    const broker = new CredentialBroker(root, { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => "" });
    await expect(broker.setCredential("anthropic", "test-secret-value")).rejects.toThrow("secure storage is unavailable");
    await expect(broker.getDatabaseKey()).rejects.toThrow("secure storage is unavailable");
  });
});
