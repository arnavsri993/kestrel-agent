import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialBroker } from "./credential-broker";
import {
  DEFAULT_EXTERNAL_SECRET_CONFIGURATION,
  ExternalSecretManager,
  safeExternalSecretArchiveEntries
} from "./external-secret-manager";

const roots: string[] = [];
const protection = {
  isEncryptionAvailable: () => true,
  encryptString: async (value: string) => Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`),
  decryptString: async (value: Buffer) => Buffer.from(value.toString().slice("sealed:".length), "base64").toString()
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workstrand-external-secrets-"));
  roots.push(root);
  const paths = {
    op: join(root, "op"),
    bws: join(root, "bws"),
    helper: join(root, "helper")
  };
  for (const path of Object.values(paths)) {
    writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(path, 0o700);
  }
  return { root, paths, broker: new CredentialBroker(root, protection) };
}

describe("external secret manager", () => {
  it("resolves all three sources through an allowlist and applies explicit precedence without persisting values", async () => {
    const item = fixture();
    await item.broker.setCredential("openai", "stored-openai-secret");
    await item.broker.setCredential("github", "stored-github-secret");
    const configuration = structuredClone(DEFAULT_EXTERNAL_SECRET_CONFIGURATION);
    configuration.onepassword = {
      enabled: true,
      binaryPath: item.paths.op,
      account: "team.1password.com",
      mappings: { openai: "op://Private/OpenAI/api-key" },
      overrideStored: true
    };
    configuration.bitwarden = {
      enabled: true,
      binaryPath: item.paths.bws,
      projectId: "11111111-2222-4333-8444-555555555555",
      serverUrl: "https://vault.bitwarden.eu",
      autoInstall: false,
      overrideStored: true
    };
    configuration.command = {
      enabled: true,
      executablePath: item.paths.helper,
      arguments: ["--workstrand"],
      timeoutMs: 1_500,
      overrideStored: false
    };
    const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const manager = new ExternalSecretManager(item.root, item.broker, {
      now: () => new Date("2026-07-23T08:00:00.000Z"),
      execute: async (file, args, options) => {
        calls.push({ file, args, env: options.env });
        if (file.endsWith("/op")) return { stdout: "onepassword-openai-secret" };
        if (file.endsWith("/bws")) return { stdout: JSON.stringify([
          { key: "ANTHROPIC_API_KEY", value: "bitwarden-anthropic-secret" },
          { key: "UNRELATED_PRIVATE_VALUE", value: "must-not-cross" }
        ]) };
        return { stdout: "GITHUB_TOKEN=command-github-secret\nUNRELATED_SECRET=must-not-cross\n" };
      }
    });
    await manager.save(configuration, {
      onePasswordToken: "ops_service_account_token",
      bitwardenToken: "0.machine-account-token"
    });
    const resolved = await manager.resolveEnabled();
    expect(resolved).toEqual({
      values: {
        openai: "onepassword-openai-secret",
        anthropic: "bitwarden-anthropic-secret",
        github: "command-github-secret"
      },
      overrideStoredIds: ["openai", "anthropic"]
    });
    expect(await item.broker.providerEnvironment({}, resolved)).toMatchObject({
      OPENAI_API_KEY: "onepassword-openai-secret",
      ANTHROPIC_API_KEY: "bitwarden-anthropic-secret",
      GITHUB_TOKEN: "stored-github-secret"
    });
    const opCall = calls.find(c => c.file.endsWith("/op"));
    const bwsCall = calls.find(c => c.file.endsWith("/bws"));
    const helperCall = calls.find(c => c.file.endsWith("/helper"));
    expect(opCall).toMatchObject({
      file: expect.stringMatching(/\/op$/),
      args: ["read", "op://Private/OpenAI/api-key", "--no-newline", "--account", "team.1password.com"]
    });
    expect(opCall!.env.OP_SERVICE_ACCOUNT_TOKEN).toBe("ops_service_account_token");
    expect(bwsCall!.env.BWS_ACCESS_TOKEN).toBe("0.machine-account-token");
    expect(bwsCall!.env.BWS_SERVER_URL).toBe("https://vault.bitwarden.eu");
    expect(helperCall!.env).not.toHaveProperty("OPENAI_API_KEY");
    const status = await manager.status();
    expect(status.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "onepassword", state: "verified", resolvedCredentialIds: ["openai"] }),
      expect.objectContaining({ id: "bitwarden", state: "verified", resolvedCredentialIds: ["anthropic"] }),
      expect.objectContaining({ id: "command", state: "verified", resolvedCredentialIds: ["github"] })
    ]));
    const credentialRoot = join(item.root, "secure", "credentials");
    for (const file of [
      "opaque-external-secret-configuration.bin",
      "opaque-external-secret-onepassword-token.bin",
      "opaque-external-secret-bitwarden-token.bin"
    ]) {
      const stored = readFileSync(join(credentialRoot, file), "utf8");
      expect(stored).not.toContain("onepassword-openai-secret");
      expect(stored).not.toContain("ops_service_account_token");
      expect(stored).not.toContain("0.machine-account-token");
    }
    expect(readFileSync(join(item.root, "secure", "external-secret-status.json"), "utf8")).not.toContain("secret");
  });

  it("records only a safe failure and preserves startup fallback when a provider process leaks diagnostics", async () => {
    const item = fixture();
    const configuration = structuredClone(DEFAULT_EXTERNAL_SECRET_CONFIGURATION);
    configuration.onepassword = {
      enabled: true,
      binaryPath: item.paths.op,
      account: "",
      mappings: { openai: "op://Private/OpenAI/api-key" },
      overrideStored: true
    };
    const manager = new ExternalSecretManager(item.root, item.broker, {
      execute: async () => { throw new Error("stderr accidentally contained sk-live-do-not-log"); }
    });
    await manager.save(configuration);
    expect(await manager.resolveEnabled()).toEqual({ values: {}, overrideStoredIds: [] });
    const source = (await manager.status()).sources.find((item) => item.id === "onepassword");
    expect(source).toMatchObject({ state: "error", detail: "1Password failed, timed out, or requires authentication." });
    expect(JSON.stringify(source)).not.toContain("sk-live-do-not-log");
  });

  it("rejects unsafe references, non-absolute helpers, and unexpected archive entries", async () => {
    const item = fixture();
    const manager = new ExternalSecretManager(item.root, item.broker);
    const badReference = structuredClone(DEFAULT_EXTERNAL_SECRET_CONFIGURATION);
    badReference.onepassword.mappings.openai = "--account=attacker";
    await expect(manager.save(badReference)).rejects.toThrow("op://vault/item/field");
    const badCommand = structuredClone(DEFAULT_EXTERNAL_SECRET_CONFIGURATION);
    badCommand.command.executablePath = "helper.sh";
    await expect(manager.save(badCommand)).rejects.toThrow("must be absolute");
    expect(() => safeExternalSecretArchiveEntries("../bws\n")).toThrow("unexpected file list");
    expect(() => safeExternalSecretArchiveEntries("bws\nextra\n")).toThrow("unexpected file list");
    expect(safeExternalSecretArchiveEntries("bws\n")).toEqual(["bws"]);
  });

  it("removes provider configuration and its encrypted bootstrap token without touching other sources", async () => {
    const item = fixture();
    const configuration = structuredClone(DEFAULT_EXTERNAL_SECRET_CONFIGURATION);
    configuration.bitwarden = {
      enabled: true,
      binaryPath: item.paths.bws,
      projectId: "11111111-2222-4333-8444-555555555555",
      serverUrl: "",
      autoInstall: false,
      overrideStored: true
    };
    const manager = new ExternalSecretManager(item.root, item.broker);
    await manager.save(configuration, { bitwardenToken: "0.machine-account-token" });
    await manager.remove("bitwarden");
    expect((await manager.configuration()).bitwarden).toEqual(DEFAULT_EXTERNAL_SECRET_CONFIGURATION.bitwarden);
    expect(await item.broker.getOpaqueSecret("external-secret-bitwarden-token")).toBeUndefined();
  });

  it("does not trust an oversized managed Bitwarden marker", async () => {
    const item = fixture();
    const managedRoot = join(item.root, "managed-tools", "bws", "2.0.0");
    mkdirSync(managedRoot, { recursive: true });
    writeFileSync(join(managedRoot, "bws"), "#!/bin/sh\n", { mode: 0o700 });
    chmodSync(join(managedRoot, "bws"), 0o700);
    writeFileSync(join(managedRoot, "workstrand-install.json"), JSON.stringify({
      tool: "bws",
      version: "2.0.0",
      source: "x".repeat(65_000),
      sha256: "67ab9bc345e2ec3b5dfddd116f938fdab79538042623a6bcca5ca0c1b0c42d95",
      bytes: 12_371_243,
      installedAt: "2026-07-23T08:00:00.000Z"
    }));

    const source = (await new ExternalSecretManager(item.root, item.broker).status()).sources.find((entry) => entry.id === "bitwarden");
    expect(source).toMatchObject({ managedBinary: false });
  });
});
