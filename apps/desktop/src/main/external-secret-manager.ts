import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import {
  ExternalSecretConfigurationSchema,
  type ExternalSecretConfiguration,
  type ExternalSecretProviderId,
  type ExternalSecretProviderStatus
} from "@kestrel/shared-types";
import {
  BROKERED_CREDENTIALS,
  type BrokeredCredentialId,
  type CredentialBroker,
  type ResolvedExternalCredentials
} from "./credential-broker";

const execFileAsync = promisify(execFile);
const CONFIGURATION_SECRET_ID = "external-secret-configuration";
const ONEPASSWORD_TOKEN_SECRET_ID = "external-secret-onepassword-token";
const BITWARDEN_TOKEN_SECRET_ID = "external-secret-bitwarden-token";

const BWS_MANIFEST = {
  version: "2.0.0",
  url: "https://github.com/bitwarden/sdk-sm/releases/download/bws-v2.0.0/bws-macos-universal-2.0.0.zip",
  fileName: "bws-macos-universal-2.0.0.zip",
  bytes: 12_371_243,
  sha256: "67ab9bc345e2ec3b5dfddd116f938fdab79538042623a6bcca5ca0c1b0c42d95",
  binaryPath: "bws"
} as const;

type SourceVerification = {
  state: "verified" | "error";
  detail: string;
  resolvedCredentialIds: BrokeredCredentialId[];
  lastSyncedAt: string;
};

type VerificationState = Partial<Record<ExternalSecretProviderId, SourceVerification>>;

interface ExecutionOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBuffer: number;
}

interface ExternalSecretManagerDependencies {
  fetch?: typeof fetch;
  execute?: (file: string, args: string[], options: ExecutionOptions) => Promise<{ stdout: string }>;
  now?: () => Date;
  platform?: NodeJS.Platform;
  architecture?: string;
}

export const DEFAULT_EXTERNAL_SECRET_CONFIGURATION: ExternalSecretConfiguration = {
  version: 1,
  onepassword: { enabled: false, account: "", mappings: {}, overrideStored: true },
  bitwarden: { enabled: false, projectId: "", serverUrl: "", autoInstall: true, overrideStored: true },
  command: { enabled: false, executablePath: "", arguments: [], timeoutMs: 3_000, overrideStored: false }
};

const environmentToCredential = Object.fromEntries(
  (Object.entries(BROKERED_CREDENTIALS) as Array<[BrokeredCredentialId, { environmentKey: string }]>)
    .map(([id, descriptor]) => [descriptor.environmentKey, id])
) as Record<string, BrokeredCredentialId>;

function minimalEnvironment(): NodeJS.ProcessEnv {
  return {
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env.PATH ? { PATH: process.env.PATH } : { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8"
  };
}

function safeSecret(value: string, source: string): string {
  const clean = value.trim();
  if (clean.length < 8 || clean.length > 20_000 || /[\r\n\0]/.test(clean)) {
    throw new Error(`${source} returned an empty or invalid provider credential.`);
  }
  return clean;
}

export function safeExternalSecretArchiveEntries(stdout: string): string[] {
  const entries = stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  if (entries.length !== 1 || entries[0] !== BWS_MANIFEST.binaryPath) {
    throw new Error("The Bitwarden archive has an unexpected file list.");
  }
  return entries;
}

function validateConfiguration(configuration: ExternalSecretConfiguration): ExternalSecretConfiguration {
  const parsed = ExternalSecretConfigurationSchema.parse(configuration);
  if (parsed.onepassword.binaryPath && !isAbsolute(parsed.onepassword.binaryPath)) {
    throw new Error("The 1Password binary path must be absolute.");
  }
  if (parsed.onepassword.account && !/^[A-Za-z0-9.-]+$/.test(parsed.onepassword.account)) {
    throw new Error("The 1Password account must be an account shorthand or sign-in host.");
  }
  for (const reference of Object.values(parsed.onepassword.mappings)) {
    if (!/^op:\/\/[^/\s]+\/[^/\s]+\/[^\r\n\0]+$/.test(reference)) {
      throw new Error("Every 1Password mapping must use op://vault/item/field.");
    }
  }
  if (parsed.bitwarden.binaryPath && !isAbsolute(parsed.bitwarden.binaryPath)) {
    throw new Error("The Bitwarden binary path must be absolute.");
  }
  if (parsed.bitwarden.projectId && !/^[0-9a-f]{8}-[0-9a-f-]{27,35}$/i.test(parsed.bitwarden.projectId)) {
    throw new Error("The Bitwarden project ID must be a UUID.");
  }
  if (parsed.bitwarden.serverUrl) {
    const server = new URL(parsed.bitwarden.serverUrl);
    if (server.protocol !== "https:" || server.username || server.password || server.hash) {
      throw new Error("The Bitwarden server must be a credential-free HTTPS URL.");
    }
  }
  if (parsed.command.executablePath && !isAbsolute(parsed.command.executablePath)) {
    throw new Error("The command helper executable path must be absolute.");
  }
  for (const argument of parsed.command.arguments) {
    if (!argument || /[\r\n\0]/.test(argument)) throw new Error("Command helper arguments must be non-empty single-line values.");
  }
  return parsed;
}

function validateBootstrapToken(value: string, label: string): string {
  const clean = value.trim();
  if (clean.length < 8 || clean.length > 20_000 || /[\r\n\0]/.test(clean)) throw new Error(`${label} is invalid.`);
  return clean;
}

export class ExternalSecretManager {
  private readonly fetcher: typeof fetch;
  private readonly execute: NonNullable<ExternalSecretManagerDependencies["execute"]>;
  private readonly now: () => Date;
  private readonly currentPlatform: NodeJS.Platform;
  private readonly currentArchitecture: string;
  private readonly statusPath: string;

  constructor(
    private readonly root: string,
    private readonly broker: CredentialBroker,
    dependencies: ExternalSecretManagerDependencies = {}
  ) {
    this.fetcher = dependencies.fetch ?? fetch;
    this.execute = dependencies.execute ?? (async (file, args, options) => {
      try {
        const result = await execFileAsync(file, args, {
          env: options.env,
          timeout: options.timeoutMs,
          maxBuffer: options.maxBuffer,
          encoding: "utf8",
          windowsHide: true,
          killSignal: "SIGKILL"
        });
        return { stdout: result.stdout };
      } catch {
        throw new Error("The secret-source process failed, timed out, or requires authentication.");
      }
    });
    this.now = dependencies.now ?? (() => new Date());
    this.currentPlatform = dependencies.platform ?? process.platform;
    this.currentArchitecture = dependencies.architecture ?? process.arch;
    this.statusPath = join(root, "secure", "external-secret-status.json");
  }

  async configuration(): Promise<ExternalSecretConfiguration> {
    const stored = await this.broker.getOpaqueSecret(CONFIGURATION_SECRET_ID);
    if (!stored) return structuredClone(DEFAULT_EXTERNAL_SECRET_CONFIGURATION);
    try {
      return validateConfiguration(JSON.parse(stored) as ExternalSecretConfiguration);
    } catch {
      throw new Error("The encrypted external-secret configuration is invalid.");
    }
  }

  async save(
    configuration: ExternalSecretConfiguration,
    tokens: { onePasswordToken?: string; bitwardenToken?: string } = {}
  ): Promise<void> {
    const normalized = validateConfiguration(configuration);
    if (tokens.onePasswordToken) {
      await this.broker.setOpaqueSecret(ONEPASSWORD_TOKEN_SECRET_ID, validateBootstrapToken(tokens.onePasswordToken, "The 1Password service-account token"));
    }
    if (tokens.bitwardenToken) {
      await this.broker.setOpaqueSecret(BITWARDEN_TOKEN_SECRET_ID, validateBootstrapToken(tokens.bitwardenToken, "The Bitwarden machine-account token"));
    }
    await this.broker.setOpaqueSecret(CONFIGURATION_SECRET_ID, JSON.stringify(normalized));
  }

  async remove(providerId: ExternalSecretProviderId): Promise<void> {
    const configuration = await this.configuration();
    const next = structuredClone(configuration);
    next[providerId] = structuredClone(DEFAULT_EXTERNAL_SECRET_CONFIGURATION[providerId]) as never;
    await this.broker.setOpaqueSecret(CONFIGURATION_SECRET_ID, JSON.stringify(next));
    if (providerId === "onepassword") await this.broker.removeOpaqueSecret(ONEPASSWORD_TOKEN_SECRET_ID);
    if (providerId === "bitwarden") await this.broker.removeOpaqueSecret(BITWARDEN_TOKEN_SECRET_ID);
    const verification = await this.readVerification();
    delete verification[providerId];
    await this.writeVerification(verification);
  }

  async status(): Promise<{ configuration: ExternalSecretConfiguration; sources: ExternalSecretProviderStatus[] }> {
    const configuration = await this.configuration();
    const verification = await this.readVerification();
    const onePasswordBinary = await this.resolveKnownBinary(configuration.onepassword.binaryPath, "op");
    const bitwardenBinary = await this.resolveKnownBinary(configuration.bitwarden.binaryPath, "bws");
    const commandBinary = await this.resolveExplicitBinary(configuration.command.executablePath);
    const managedBinary = await this.hasManagedBitwarden();
    const hasOnePasswordToken = Boolean(await this.broker.getOpaqueSecret(ONEPASSWORD_TOKEN_SECRET_ID));
    const hasBitwardenToken = Boolean(await this.broker.getOpaqueSecret(BITWARDEN_TOKEN_SECRET_ID));
    return {
      configuration,
      sources: [
        this.sourceStatus("onepassword", configuration.onepassword.enabled, Boolean(onePasswordBinary), false, onePasswordBinary, verification.onepassword,
          Object.keys(configuration.onepassword.mappings).length > 0,
          "Install and sign in to the official 1Password CLI, then add at least one op:// mapping.",
          hasOnePasswordToken ? "Configured with an encrypted service-account token." : "Configured for the 1Password desktop or CLI session."),
        this.sourceStatus("bitwarden", configuration.bitwarden.enabled, Boolean(bitwardenBinary), managedBinary, bitwardenBinary, verification.bitwarden,
          Boolean(configuration.bitwarden.projectId && hasBitwardenToken),
          "Add a machine-account token and project ID. Kestrel can install the verified bws CLI.",
          "Configured; sync to verify the project and supported secret names."),
        this.sourceStatus("command", configuration.command.enabled, Boolean(commandBinary), false, commandBinary, verification.command,
          Boolean(commandBinary),
          "Choose an executable helper that prints supported KEY=VALUE records.",
          "Configured for argv-only execution; sync to verify its output.")
      ]
    };
  }

  async resolveEnabled(): Promise<ResolvedExternalCredentials> {
    const configuration = await this.configuration();
    const values: Partial<Record<BrokeredCredentialId, string>> = {};
    const overrideStoredIds: BrokeredCredentialId[] = [];
    for (const providerId of ["onepassword", "bitwarden", "command"] as const) {
      if (!configuration[providerId].enabled) continue;
      try {
        const sourceValues = await this.resolveSource(providerId, configuration);
        for (const [id, value] of Object.entries(sourceValues) as Array<[BrokeredCredentialId, string]>) {
          if (values[id]) continue;
          values[id] = value;
          if (configuration[providerId].overrideStored) overrideStoredIds.push(id);
        }
        await this.recordVerification(providerId, "verified", Object.keys(sourceValues) as BrokeredCredentialId[], `${Object.keys(sourceValues).length} supported credentials resolved.`);
      } catch (error) {
        await this.recordVerification(providerId, "error", [], error instanceof Error ? error.message : "Secret source failed.");
      }
    }
    return { values, overrideStoredIds };
  }

  async sync(providerId: ExternalSecretProviderId): Promise<ExternalSecretProviderStatus[]> {
    const configuration = await this.configuration();
    if (!configuration[providerId].enabled) throw new Error("Enable this secret source before syncing it.");
    try {
      const values = await this.resolveSource(providerId, configuration);
      const ids = Object.keys(values) as BrokeredCredentialId[];
      if (ids.length === 0) throw new Error("The secret source returned no supported provider credentials.");
      await this.recordVerification(providerId, "verified", ids, `${ids.length} supported credentials resolved.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Secret source failed.";
      await this.recordVerification(providerId, "error", [], message);
      throw new Error(message);
    }
    return (await this.status()).sources;
  }

  async installBitwarden(): Promise<ExternalSecretProviderStatus[]> {
    if (!["arm64", "x64"].includes(this.currentArchitecture) || this.currentPlatform !== "darwin") {
      throw new Error("Managed Bitwarden CLI installation is available only on supported macOS builds.");
    }
    if (!await this.hasManagedBitwarden()) await this.downloadBitwarden();
    const configuration = await this.configuration();
    configuration.bitwarden.binaryPath = this.managedBitwardenPath();
    await this.broker.setOpaqueSecret(CONFIGURATION_SECRET_ID, JSON.stringify(configuration));
    return (await this.status()).sources;
  }

  private sourceStatus(
    id: ExternalSecretProviderId,
    enabled: boolean,
    available: boolean,
    managedBinary: boolean,
    binaryPath: string | undefined,
    verification: SourceVerification | undefined,
    setupComplete: boolean,
    setupDetail: string,
    readyDetail: string
  ): ExternalSecretProviderStatus {
    const label = id === "onepassword" ? "1Password" : id === "bitwarden" ? "Bitwarden Secrets Manager" : "Command helper";
    if (!enabled) return { id, label, state: "disabled", available, managedBinary, detail: "Disabled; saved configuration is not resolved at startup.", resolvedCredentialIds: [], ...(binaryPath ? { binaryPath } : {}) };
    if (!available || !setupComplete) return { id, label, state: "needs_setup", available, managedBinary, detail: setupDetail, resolvedCredentialIds: [], ...(binaryPath ? { binaryPath } : {}) };
    if (verification) {
      return {
        id,
        label,
        state: verification.state,
        available,
        managedBinary,
        detail: verification.detail,
        resolvedCredentialIds: verification.resolvedCredentialIds,
        lastSyncedAt: verification.lastSyncedAt,
        ...(binaryPath ? { binaryPath } : {})
      };
    }
    return { id, label, state: "ready", available, managedBinary, detail: readyDetail, resolvedCredentialIds: [], ...(binaryPath ? { binaryPath } : {}) };
  }

  private async resolveSource(
    providerId: ExternalSecretProviderId,
    configuration: ExternalSecretConfiguration
  ): Promise<Partial<Record<BrokeredCredentialId, string>>> {
    if (providerId === "onepassword") return this.resolveOnePassword(configuration);
    if (providerId === "bitwarden") return this.resolveBitwarden(configuration);
    return this.resolveCommand(configuration);
  }

  private async resolveOnePassword(configuration: ExternalSecretConfiguration): Promise<Partial<Record<BrokeredCredentialId, string>>> {
    const binary = await this.resolveKnownBinary(configuration.onepassword.binaryPath, "op");
    if (!binary) throw new Error("The official 1Password CLI is unavailable. Install it or set an absolute binary path.");
    const mappings = Object.entries(configuration.onepassword.mappings) as Array<[BrokeredCredentialId, string]>;
    if (mappings.length === 0) throw new Error("Add at least one 1Password credential mapping.");
    const environment = minimalEnvironment();
    for (const [key, value] of Object.entries(process.env)) {
      if (/^OP_SESSION_[A-Z0-9_]+$/.test(key) && value) environment[key] = value;
    }
    const token = await this.broker.getOpaqueSecret(ONEPASSWORD_TOKEN_SECRET_ID);
    if (token) environment.OP_SERVICE_ACCOUNT_TOKEN = token;
    const values: Partial<Record<BrokeredCredentialId, string>> = {};
    await Promise.all(
      mappings.map(async ([id, reference]) => {
        const args = ["read", reference, "--no-newline", ...(configuration.onepassword.account ? ["--account", configuration.onepassword.account] : [])];
        const result = await this.runSecretProcess(binary, args, { env: environment, timeoutMs: 5_000, maxBuffer: 24_000 }, "1Password");
        values[id] = safeSecret(result.stdout, "1Password");
      })
    );
    return values;
  }

  private async resolveBitwarden(configuration: ExternalSecretConfiguration): Promise<Partial<Record<BrokeredCredentialId, string>>> {
    let binary = await this.resolveKnownBinary(configuration.bitwarden.binaryPath, "bws");
    if (!binary && configuration.bitwarden.autoInstall) {
      await this.installBitwarden();
      binary = this.managedBitwardenPath();
    }
    if (!binary) throw new Error("The Bitwarden Secrets Manager CLI is unavailable. Install the verified binary or set an absolute path.");
    if (!configuration.bitwarden.projectId) throw new Error("Add the Bitwarden Secrets Manager project ID.");
    const token = await this.broker.getOpaqueSecret(BITWARDEN_TOKEN_SECRET_ID);
    if (!token) throw new Error("Add the Bitwarden machine-account access token.");
    const environment = minimalEnvironment();
    environment.BWS_ACCESS_TOKEN = token;
    if (configuration.bitwarden.serverUrl) environment.BWS_SERVER_URL = configuration.bitwarden.serverUrl;
    const result = await this.runSecretProcess(binary, ["secret", "list", configuration.bitwarden.projectId, "--output", "json"], { env: environment, timeoutMs: 10_000, maxBuffer: 1024 * 1024 }, "Bitwarden");
    let payload: unknown;
    try { payload = JSON.parse(result.stdout); } catch { throw new Error("Bitwarden returned invalid JSON."); }
    if (!Array.isArray(payload)) throw new Error("Bitwarden returned an invalid secret list.");
    const values: Partial<Record<BrokeredCredentialId, string>> = {};
    for (const item of payload) {
      if (!item || typeof item !== "object") continue;
      const key = (item as { key?: unknown }).key;
      const value = (item as { value?: unknown }).value;
      if (typeof key !== "string" || typeof value !== "string") continue;
      const id = environmentToCredential[key];
      if (!id) continue;
      if (values[id]) throw new Error(`Bitwarden returned duplicate ${key} entries.`);
      values[id] = safeSecret(value, "Bitwarden");
    }
    return values;
  }

  private async resolveCommand(configuration: ExternalSecretConfiguration): Promise<Partial<Record<BrokeredCredentialId, string>>> {
    const binary = await this.resolveExplicitBinary(configuration.command.executablePath);
    if (!binary) throw new Error("Choose an executable command helper.");
    const result = await this.runSecretProcess(binary, configuration.command.arguments, { env: minimalEnvironment(), timeoutMs: configuration.command.timeoutMs, maxBuffer: 1024 * 1024 }, "The command helper");
    const values: Partial<Record<BrokeredCredentialId, string>> = {};
    for (const rawLine of result.stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const match = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
      if (!match) throw new Error("The command helper output was not a KEY=VALUE map.");
      const id = environmentToCredential[match[1]!];
      if (!id) continue;
      let value = match[2]!.trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (!value.trim()) continue;
      if (values[id]) throw new Error(`The command helper returned duplicate ${match[1]} entries.`);
      values[id] = safeSecret(value, "The command helper");
    }
    return values;
  }

  private async resolveKnownBinary(configured: string | undefined, name: "op" | "bws"): Promise<string | undefined> {
    if (configured) return this.resolveExplicitBinary(configured);
    const home = process.env.HOME;
    const candidates = name === "op"
      ? ["/opt/homebrew/bin/op", "/usr/local/bin/op", home ? join(home, ".local", "bin", "op") : undefined]
      : [this.managedBitwardenPath(), "/opt/homebrew/bin/bws", "/usr/local/bin/bws", home ? join(home, ".local", "bin", "bws") : undefined];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const resolved = await this.resolveExplicitBinary(candidate);
      if (resolved) return resolved;
    }
    return undefined;
  }

  private async resolveExplicitBinary(path: string | undefined): Promise<string | undefined> {
    if (!path || !isAbsolute(path)) return undefined;
    try {
      const resolved = await realpath(path);
      const metadata = await lstat(resolved);
      return metadata.isFile() && (metadata.mode & 0o111) !== 0 ? resolved : undefined;
    } catch {
      return undefined;
    }
  }

  private managedBitwardenRoot(): string {
    return join(this.root, "managed-tools", "bws", BWS_MANIFEST.version);
  }

  private managedBitwardenPath(): string {
    return join(this.managedBitwardenRoot(), BWS_MANIFEST.binaryPath);
  }

  private async hasManagedBitwarden(): Promise<boolean> {
    try {
      const marker = JSON.parse(await readFile(join(this.managedBitwardenRoot(), "workstrand-install.json"), "utf8")) as Record<string, unknown>;
      const binary = await lstat(this.managedBitwardenPath());
      return binary.isFile() && (binary.mode & 0o111) !== 0 && marker.version === BWS_MANIFEST.version && marker.sha256 === BWS_MANIFEST.sha256;
    } catch {
      return false;
    }
  }

  private async downloadBitwarden(): Promise<void> {
    const parent = dirname(this.managedBitwardenRoot());
    const staging = `${this.managedBitwardenRoot()}.partial`;
    const archive = join(staging, BWS_MANIFEST.fileName);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { mode: 0o700 });
    try {
      const response = await this.fetcher(BWS_MANIFEST.url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
      if (!response.ok || !response.body) throw new Error(`The Bitwarden CLI download returned ${response.status}.`);
      const finalUrl = new URL(response.url || BWS_MANIFEST.url);
      if (finalUrl.protocol !== "https:" || !["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"].includes(finalUrl.hostname)) {
        throw new Error("The Bitwarden CLI download redirected to an untrusted host.");
      }
      const file = await open(archive, "wx", 0o600);
      const digest = createHash("sha256");
      let bytes = 0;
      try {
        const reader = response.body.getReader();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > BWS_MANIFEST.bytes) throw new Error("The Bitwarden CLI download exceeded the pinned size.");
          digest.update(chunk.value);
          await file.write(chunk.value);
        }
      } finally {
        await file.close();
      }
      if (bytes !== BWS_MANIFEST.bytes || digest.digest("hex") !== BWS_MANIFEST.sha256) {
        throw new Error("The Bitwarden CLI download did not match the pinned release manifest.");
      }
      safeExternalSecretArchiveEntries((await this.execute("/usr/bin/tar", ["-tf", archive], { env: minimalEnvironment(), timeoutMs: 10_000, maxBuffer: 64_000 })).stdout);
      await this.execute("/usr/bin/tar", ["-xf", archive, "-C", staging], { env: minimalEnvironment(), timeoutMs: 20_000, maxBuffer: 64_000 });
      await rm(archive, { force: true });
      const binary = await lstat(join(staging, BWS_MANIFEST.binaryPath));
      if (!binary.isFile() || binary.isSymbolicLink()) throw new Error("The extracted Bitwarden CLI executable is invalid.");
      await chmod(join(staging, BWS_MANIFEST.binaryPath), 0o700);
      const version = await this.execute(join(staging, BWS_MANIFEST.binaryPath), ["--version"], { env: minimalEnvironment(), timeoutMs: 5_000, maxBuffer: 10_000 });
      if (!new RegExp(`\\b${BWS_MANIFEST.version.replaceAll(".", "\\.")}\\b`).test(version.stdout)) throw new Error("The installed Bitwarden CLI reported an unexpected version.");
      await writeFile(join(staging, "workstrand-install.json"), `${JSON.stringify({
        tool: "bws",
        version: BWS_MANIFEST.version,
        source: BWS_MANIFEST.url,
        sha256: BWS_MANIFEST.sha256,
        bytes: BWS_MANIFEST.bytes,
        installedAt: this.now().toISOString()
      }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rm(this.managedBitwardenRoot(), { recursive: true, force: true });
      await rename(staging, this.managedBitwardenRoot());
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  private async readVerification(): Promise<VerificationState> {
    try {
      const parsed = JSON.parse(await readFile(this.statusPath, "utf8")) as VerificationState;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return {};
      throw error;
    }
  }

  private async runSecretProcess(file: string, args: string[], options: ExecutionOptions, label: string): Promise<{ stdout: string }> {
    try {
      return await this.execute(file, args, options);
    } catch {
      throw new Error(`${label} failed, timed out, or requires authentication.`);
    }
  }

  private async writeVerification(verification: VerificationState): Promise<void> {
    const temporary = `${this.statusPath}.new`;
    await mkdir(dirname(this.statusPath), { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(verification, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.statusPath);
    await chmod(this.statusPath, 0o600);
  }

  private async recordVerification(
    providerId: ExternalSecretProviderId,
    state: SourceVerification["state"],
    resolvedCredentialIds: BrokeredCredentialId[],
    detail: string
  ): Promise<void> {
    const verification = await this.readVerification();
    verification[providerId] = { state, detail, resolvedCredentialIds, lastSyncedAt: this.now().toISOString() };
    await this.writeVerification(verification);
  }
}
