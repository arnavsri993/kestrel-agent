import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { AgentCore, createEnvironmentMediaProviders, createEnvironmentTranscriptionProvider, environmentChannelConfiguration, environmentRemoteExecutionConfiguration, environmentWebAccessOptions, loadSignedManagedPolicy } from "@kestrel/agent-core";
import { KestrelDatabase } from "@kestrel/database";

export function dataDirectory(): string {
  return resolve(process.env.KESTREL_DATA_DIR ?? join(homedir(), ".kestrel"));
}

function encryptionKey(directory: string): Buffer {
  const path = join(directory, "encryption.key");
  if (existsSync(path)) {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Kestrel data key must be a regular non-symlink file.");
    chmodSync(path, 0o600);
    const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
    if (key.byteLength !== 32) throw new Error("Kestrel data key is invalid.");
    return key;
  }
  const key = randomBytes(32);
  const descriptor = openSync(path, "wx", 0o600);
  try { writeFileSync(descriptor, `${key.toString("base64")}\n`); } finally { closeSync(descriptor); }
  return key;
}

export function openKestrel(workspaceRoots: string[] = []): AgentCore {
  const directory = dataDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Kestrel data directory must be a regular directory.");
  chmodSync(directory, 0o700);
  const databasePath = join(directory, "kestrel.sqlite");
  if (existsSync(databasePath) && lstatSync(databasePath).isSymbolicLink()) throw new Error("Kestrel database cannot be a symbolic link.");
  const managedPluginRoot = join(directory, "plugins");
  const pluginRoots = [managedPluginRoot, join(homedir(), ".codex", "plugins", "cache", "camarade")];
  const database = new KestrelDatabase(databasePath, encryptionKey(directory));
  const persistedWorkspaceRoots = database.listRuntimeSessions()
    .flatMap((session) => session.workspaceRoot ? [session.workspaceRoot] : [])
    .filter(isAbsolute)
    .map((root) => resolve(root));
  const activePersistedWorkspaceRoots = persistedWorkspaceRoots.flatMap((root) => {
    try {
      const rootMetadata = lstatSync(root);
      return rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink()
        ? [realpathSync(root)]
        : [];
    } catch {
      return [];
    }
  });
  const explicitWorkspaceRoots = workspaceRoots.map((root) => realpathSync(root));
  const grantedWorkspaceRoots = [...new Set([
    ...explicitWorkspaceRoots,
    ...activePersistedWorkspaceRoots,
  ])];
  const configuredWorkspaceRoots = [...new Set([
    ...explicitWorkspaceRoots,
    ...persistedWorkspaceRoots,
  ])];
  const webAccess = environmentWebAccessOptions();
  const channels = environmentChannelConfiguration();
  const transcriptionProvider = createEnvironmentTranscriptionProvider();
  const remoteExecution = environmentRemoteExecutionConfiguration(process.env, join(directory, "artifacts", "remote"));
  const managedPolicy = process.env.KESTREL_MANAGED_POLICY && process.env.KESTREL_MANAGED_POLICY_KEY
    ? loadSignedManagedPolicy(process.env.KESTREL_MANAGED_POLICY, process.env.KESTREL_MANAGED_POLICY_KEY)
    : undefined;
  if (Boolean(process.env.KESTREL_MANAGED_POLICY) !== Boolean(process.env.KESTREL_MANAGED_POLICY_KEY)) throw new Error("KESTREL_MANAGED_POLICY and KESTREL_MANAGED_POLICY_KEY must be configured together.");
  return new AgentCore({
    database,
    workspaceRoots: grantedWorkspaceRoots,
    configuredWorkspaceRoots,
    learnedSkillRoot: join(directory, "learned-skills"),
    pluginRoots,
    managedPluginRoots: [managedPluginRoot],
    artifactRoot: join(directory, "artifacts"),
    petRoot: join(directory, "pets"),
    mediaProviders: createEnvironmentMediaProviders(),
    ...(transcriptionProvider ? { transcriptionProvider } : {}),
    ...(remoteExecution ? { remoteExecution } : {}),
    ...(process.env.GITHUB_TOKEN ? { githubToken: process.env.GITHUB_TOKEN } : {}),
    ...(webAccess ? { webAccess } : {}),
    ...(channels ? { channels } : {}),
    ...(managedPolicy ? { managedPolicy } : {})
  });
}

export function resolveModelConfig(input: { model?: string; providers?: string[] }): { model: string; providers: string[] } {
  const model = input.model ?? process.env.KESTREL_MODEL;
  const providers = input.providers?.length ? input.providers : (process.env.KESTREL_PROVIDERS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!model) throw new Error("A model is required. Pass --model or set KESTREL_MODEL.");
  if (providers.length === 0) throw new Error("At least one provider is required. Pass --providers or set KESTREL_PROVIDERS.");
  return { model, providers };
}
