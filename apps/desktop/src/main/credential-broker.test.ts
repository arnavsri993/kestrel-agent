import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    let decryptCalls = 0;
    const protection = {
      isEncryptionAvailable: () => true,
      encryptString: async (value: string) => Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`),
      decryptString: async (value: Buffer) => {
        decryptCalls += 1;
        return Buffer.from(value.toString().slice("sealed:".length), "base64").toString();
      }
    };
    const broker = new CredentialBroker(root, protection);
    await broker.setCredential("openai", "sk-test-secret-value");
    await broker.setCredential("openai-secondary", "sk-test-backup-value");
    await broker.setCredential("cohere", "cohere-test-secret");
    await broker.setOpaqueSecret("google-workspace-oauth", "{\"refreshToken\":\"refresh-secret\"}");
    expect(await broker.listCredentials()).toContainEqual({ id: "openai", label: "OpenAI API key", configured: true });
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
      UNRELATED_SECRET: "do-not-forward"
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
      KESTREL_GOOGLE_WORKSPACE_OAUTH: "{\"refreshToken\":\"refresh-secret\"}"
    });
    expect(await broker.providerEnvironment(baseEnvironment)).toEqual(environment);
    const reopened = new CredentialBroker(root, protection);
    expect(await reopened.providerEnvironment(baseEnvironment)).toEqual(environment);
    expect(await reopened.providerEnvironment(baseEnvironment)).toEqual(environment);
    expect(decryptCalls).toBe(4);
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
    const broker = new CredentialBroker(root, { isEncryptionAvailable: () => false, encryptString: async () => Buffer.alloc(0), decryptString: async () => "" });
    await expect(broker.setCredential("anthropic", "test-secret-value")).rejects.toThrow("secure storage is unavailable");
    await expect(broker.getDatabaseKey()).rejects.toThrow("secure storage is unavailable");
  });

  it("rejects a decrypted database key with the wrong length", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-credentials-invalid-key-"));
    roots.push(root);
    mkdirSync(join(root, "secure"), { recursive: true });
    writeFileSync(
      join(root, "secure", "database-key.bin"),
      `sealed:${Buffer.from("too-short").toString("base64")}`,
    );
    const broker = new CredentialBroker(root, {
      isEncryptionAvailable: () => true,
      encryptString: async (value: string) => Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`),
      decryptString: async (value: Buffer) => Buffer.from(value.toString().slice("sealed:".length), "base64").toString(),
    });
    await expect(broker.getDatabaseKey()).rejects.toThrow("database key is invalid");
  });

  it("serializes concurrent writes to the same secret across broker instances", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-credentials-concurrent-"));
    roots.push(root);
    const first = new CredentialBroker(root, {
      isEncryptionAvailable: () => true,
      encryptString: async (value: string) => Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`),
      decryptString: async (value: Buffer) => Buffer.from(value.toString().slice("sealed:".length), "base64").toString()
    });
    const second = new CredentialBroker(root, {
      isEncryptionAvailable: () => true,
      encryptString: async (value: string) => Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`),
      decryptString: async (value: Buffer) => Buffer.from(value.toString().slice("sealed:".length), "base64").toString()
    });

    await Promise.all([
      first.setCredential("openai", "first-secret-value"),
      second.setCredential("openai", "second-secret-value")
    ]);

    expect(["first-secret-value", "second-secret-value"]).toContain(
      await new CredentialBroker(root, {
        isEncryptionAvailable: () => true,
        encryptString: async (value: string) => Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`),
        decryptString: async (value: Buffer) => Buffer.from(value.toString().slice("sealed:".length), "base64").toString()
      }).providerEnvironment().then((environment) => environment.OPENAI_API_KEY)
    );
  });
});
