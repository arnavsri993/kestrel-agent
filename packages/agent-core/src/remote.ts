import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { KestrelDatabase } from "@kestrel/database";
import type { RuntimeSession } from "@kestrel/shared-types";
import type { AgentRuntime } from "./runtime";
import type { ScheduledAgentJob, TaskOrchestrator } from "./orchestration";
import { readBoundedResponseBytes } from "./bounded-http";

export type RemoteBackendKind = "docker" | "ssh" | "cluster" | "serverless";
export interface RemoteTarget { id: string; kind: RemoteBackendKind; backendId: string; allowedCommands: string[]; enabled: boolean; configuration?: Record<string, unknown>; }
export interface RemoteArtifact { filename: string; mediaType: string; dataBase64: string; sha256: string; }
export interface RemoteExecutionResult { exitCode: number; stdout: string; stderr: string; remoteExecutionId: string; artifacts?: RemoteArtifact[]; }
export interface RemoteExecutionBackend {
  id: string;
  execute(input: { target: RemoteTarget; command: string; args: string[]; timeoutMs: number; signal: AbortSignal; onOutput?: (stream: "stdout" | "stderr", chunk: string) => void }): Promise<RemoteExecutionResult>;
}

const REMOTE_BACKEND_KINDS = new Set<RemoteBackendKind>(["docker", "ssh", "cluster", "serverless"]);

function isRemoteTarget(value: unknown): value is RemoteTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  return typeof target.id === "string" && typeof target.kind === "string" && REMOTE_BACKEND_KINDS.has(target.kind as RemoteBackendKind) && typeof target.backendId === "string" && Array.isArray(target.allowedCommands) && target.allowedCommands.every((command) => typeof command === "string") && typeof target.enabled === "boolean" && (target.configuration === undefined || (typeof target.configuration === "object" && target.configuration !== null && !Array.isArray(target.configuration)));
}

interface ProcessResult { exitCode: number; stdout: string; stderr: string; }

const DEFAULT_REMOTE_TIMEOUT_MS = 120_000;

function boundedRemoteTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs)) return DEFAULT_REMOTE_TIMEOUT_MS;
  return Math.max(1_000, Math.min(300_000, Math.floor(timeoutMs)));
}

async function runBounded(executable: string, args: string[], timeoutMs: number, signal: AbortSignal, onOutput?: (stream: "stdout" | "stderr", chunk: string) => void): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Remote execution cancelled."));
      return;
    }
    const environment = Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "SSH_AUTH_SOCK", "KUBECONFIG", "DOCKER_HOST", "DOCKER_CONTEXT"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
    const child = spawn(executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], env: environment });
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let stdoutBytes = 0; let stderrBytes = 0; let settled = false; let timeout: NodeJS.Timeout | undefined;
    const finish = (error?: Error, code?: number | null) => {
      if (settled) return; settled = true; if (timeout) clearTimeout(timeout); signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve({ exitCode: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    };
    const capture = (chunks: Buffer[], kind: "stdout" | "stderr") => (chunk: Buffer) => {
      if (kind === "stdout") stdoutBytes += chunk.byteLength; else stderrBytes += chunk.byteLength;
      if (stdoutBytes > 1_000_000 || stderrBytes > 1_000_000) { child.kill("SIGKILL"); finish(new Error("Remote adapter output exceeded 1 MB per stream.")); return; }
      chunks.push(chunk); onOutput?.(kind, chunk.toString("utf8"));
    };
    child.stdout.on("data", capture(stdout, "stdout")); child.stderr.on("data", capture(stderr, "stderr"));
    child.once("error", (error) => finish(new Error(`Remote adapter could not start ${executable}: ${error.message}`)));
    child.once("close", (code) => finish(undefined, code));
    const abort = () => { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 1_000).unref(); finish(signal.reason instanceof Error ? signal.reason : new Error("Remote execution cancelled.")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    timeout = setTimeout(() => { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 1_000).unref(); finish(new Error("Remote execution timed out.")); }, timeoutMs);
    timeout.unref();
  });
}

function stringConfig(target: RemoteTarget, key: string, required = true): string | undefined {
  const value = target.configuration?.[key];
  if (typeof value === "string" && value.trim() && value.length <= 4_000) return value;
  if (required) throw new Error(`Remote target ${target.id} requires ${key}.`);
  return undefined;
}

function commandResult(result: ProcessResult): RemoteExecutionResult { return { ...result, remoteExecutionId: `remote-${randomUUID()}` }; }

export class DockerCliRemoteBackend implements RemoteExecutionBackend {
  readonly id = "docker-cli";
  async execute({ target, command, args, timeoutMs, signal, onOutput }: Parameters<RemoteExecutionBackend["execute"]>[0]): Promise<RemoteExecutionResult> {
    if (target.kind !== "docker") throw new Error("Docker backend received a non-Docker target.");
    const image = stringConfig(target, "image")!;
    if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,500}$/.test(image)) throw new Error("Docker image reference is invalid.");
    const dockerArgs = ["run", "--rm", "--init", "--label", `kestrel.execution=${randomUUID()}`];
    const workspaceRoot = stringConfig(target, "workspaceRoot", false);
    if (workspaceRoot) {
      const root = realpathSync(workspaceRoot); if (!statSync(root).isDirectory()) throw new Error("Docker workspace root must be a directory.");
      dockerArgs.push("--mount", `type=bind,src=${root},dst=/workspace`, "--workdir", stringConfig(target, "workdir", false) ?? "/workspace");
    }
    if (target.configuration?.network !== true) dockerArgs.push("--network", "none");
    dockerArgs.push(image, command, ...args);
    return commandResult(await runBounded("docker", dockerArgs, timeoutMs, signal, onOutput));
  }
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }

export class SshCliRemoteBackend implements RemoteExecutionBackend {
  readonly id = "ssh-cli";
  async execute({ target, command, args, timeoutMs, signal, onOutput }: Parameters<RemoteExecutionBackend["execute"]>[0]): Promise<RemoteExecutionResult> {
    if (target.kind !== "ssh") throw new Error("SSH backend received a non-SSH target.");
    const host = stringConfig(target, "host")!; if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(host)) throw new Error("SSH host is invalid.");
    const user = stringConfig(target, "user", false); if (user && !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(user)) throw new Error("SSH user is invalid.");
    const sshArgs = ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=15"];
    const port = target.configuration?.port; if (port !== undefined) { if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("SSH port is invalid."); sshArgs.push("-p", String(port)); }
    const identityFile = stringConfig(target, "identityFile", false); if (identityFile) { const identity = realpathSync(identityFile); if (!statSync(identity).isFile()) throw new Error("SSH identity must be a regular file."); sshArgs.push("-i", identity); }
    sshArgs.push(user ? `${user}@${host}` : host);
    const workdir = stringConfig(target, "remoteWorkdir", false);
    const remoteCommand = `${workdir ? `cd -- ${shellQuote(workdir)} && ` : ""}exec ${[command, ...args].map(shellQuote).join(" ")}`;
    sshArgs.push(remoteCommand);
    return commandResult(await runBounded("ssh", sshArgs, timeoutMs, signal, onOutput));
  }
}

export class KubernetesCliRemoteBackend implements RemoteExecutionBackend {
  readonly id = "kubernetes-cli";
  async execute({ target, command, args, timeoutMs, signal, onOutput }: Parameters<RemoteExecutionBackend["execute"]>[0]): Promise<RemoteExecutionResult> {
    if (target.kind !== "cluster") throw new Error("Kubernetes backend received a non-cluster target.");
    const image = stringConfig(target, "image")!; if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,500}$/.test(image)) throw new Error("Kubernetes image reference is invalid.");
    const pod = `kestrel-${randomUUID().slice(0, 12)}`;
    const prefix: string[] = []; const context = stringConfig(target, "context", false); const namespace = stringConfig(target, "namespace", false);
    if (context) prefix.push("--context", context); if (namespace) prefix.push("--namespace", namespace);
    const runArgs = [...prefix, "run", pod, "--quiet", "--rm", "-i", "--restart=Never", `--image=${image}`, "--command", "--", command, ...args];
    try { return commandResult(await runBounded("kubectl", runArgs, timeoutMs, signal, onOutput)); }
    finally { if (signal.aborted) void runBounded("kubectl", [...prefix, "delete", "pod", pod, "--ignore-not-found=true", "--wait=false"], 15_000, new AbortController().signal).catch(() => undefined); }
  }
}

export class ServerlessHttpRemoteBackend implements RemoteExecutionBackend {
  readonly id = "serverless-http";
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  async execute({ target, command, args, timeoutMs, signal, onOutput }: Parameters<RemoteExecutionBackend["execute"]>[0]): Promise<RemoteExecutionResult> {
    if (target.kind !== "serverless") throw new Error("Serverless backend received a non-serverless target.");
    let endpoint: URL;
    try { endpoint = new URL(stringConfig(target, "endpoint")!); } catch { throw new Error("Serverless endpoint must be a valid URL."); }
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) throw new Error("Serverless endpoint must be credential-free HTTPS.");
    const bearerToken = stringConfig(target, "bearerToken", false);
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const response = await this.fetcher(endpoint, { method: "POST", signal: boundedSignal, headers: { "content-type": "application/json", accept: "application/json", ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}) }, body: JSON.stringify({ executionId: `kestrel-${randomUUID()}`, command, args, timeoutMs }) });
    const bytes = await readBoundedResponseBytes(response, 36_000_000, "Serverless response exceeds 36 MB.");
    const text = new TextDecoder().decode(bytes);
    if (!response.ok) throw new Error(`Serverless backend returned HTTP ${response.status}: ${text.slice(0, 2_000)}`);
    let body: Record<string, unknown>; try { body = JSON.parse(text) as Record<string, unknown>; } catch { throw new Error("Serverless backend returned malformed JSON."); }
    if (!Number.isInteger(body.exitCode) || typeof body.stdout !== "string" || typeof body.stderr !== "string") throw new Error("Serverless backend response is invalid.");
    if (body.stdout) onOutput?.("stdout", body.stdout.slice(0, 16_000)); if (body.stderr) onOutput?.("stderr", body.stderr.slice(0, 16_000));
    const artifacts = Array.isArray(body.artifacts) ? body.artifacts as RemoteArtifact[] : undefined;
    return { exitCode: Number(body.exitCode), stdout: body.stdout, stderr: body.stderr, remoteExecutionId: typeof body.remoteExecutionId === "string" ? body.remoteExecutionId.slice(0, 200) : `remote-${randomUUID()}`, ...(artifacts ? { artifacts } : {}) };
  }
}

export class RemoteBackendManager {
  private readonly backends = new Map<string, RemoteExecutionBackend>();
  private readonly key = "providers.remote-targets";
  private readonly artifactRoot?: string;
  constructor(private readonly database: KestrelDatabase, backends: RemoteExecutionBackend[], artifactRoot?: string) { for (const backend of backends) this.backends.set(backend.id, backend); if (artifactRoot) { mkdirSync(artifactRoot, { recursive: true, mode: 0o700 }); this.artifactRoot = realpathSync(artifactRoot); } }
  listTargets(): RemoteTarget[] {
    const stored = this.database.getPrivateState<unknown>(this.key);
    return Array.isArray(stored) ? stored.filter(isRemoteTarget) : [];
  }
  setTargets(targets: RemoteTarget[]): void {
    if (targets.length > 100 || Buffer.byteLength(JSON.stringify(targets), "utf8") > 1_000_000) throw new Error("Remote target configuration exceeds limits.");
    if (new Set(targets.map((target) => target.id)).size !== targets.length) throw new Error("Remote target IDs must be unique.");
    for (const target of targets) {
      if (!this.backends.has(target.backendId)) throw new Error(`Remote backend ${target.backendId} is not configured.`);
      if (target.allowedCommands.length === 0 || target.allowedCommands.length > 200 || target.allowedCommands.some((command) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(command))) throw new Error(`Remote target ${target.id} needs a valid explicit command allowlist.`);
    }
    this.database.setPrivateState(this.key, targets);
  }
  async execute(targetId: string, command: string, args: string[], timeoutMs: number, signal: AbortSignal, onOutput?: (stream: "stdout" | "stderr", chunk: string) => void): Promise<Record<string, unknown>> {
    const target = this.listTargets().find((candidate) => candidate.id === targetId);
    if (!target || !target.enabled) throw new Error("Remote target is not enabled.");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(command) || !target.allowedCommands.includes(command)) throw new Error("Remote command is outside the target allowlist.");
    if (args.length > 200 || args.some((arg) => arg.length > 10_000)) throw new Error("Remote command arguments exceed limits.");
    const backend = this.backends.get(target.backendId)!;
    const boundedTimeout = boundedRemoteTimeout(timeoutMs);
    const result = await backend.execute({ target, command, args, timeoutMs: boundedTimeout, signal: AbortSignal.any([signal, AbortSignal.timeout(boundedTimeout)]), ...(onOutput ? { onOutput } : {}) });
    const artifacts = await this.storeArtifacts(result.artifacts ?? []);
    return { ...result, artifacts, stdout: result.stdout.slice(0, 1_000_000), stderr: result.stderr.slice(0, 1_000_000), targetId, backendKind: target.kind, attestedBy: backend.id };
  }
  private async storeArtifacts(artifacts: RemoteArtifact[]): Promise<Array<{ filename: string; mediaType: string; bytes: number; sha256: string; path: string }>> {
    if (artifacts.length > 20) throw new Error("Remote execution returned more than 20 artifacts.");
    if (artifacts.length && !this.artifactRoot) throw new Error("Remote artifact storage is not configured.");
    const output: Array<{ filename: string; mediaType: string; bytes: number; sha256: string; path: string }> = []; let total = 0;
    for (const artifact of artifacts) {
      const filename = basename(artifact.filename); if (filename !== artifact.filename || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(filename)) throw new Error("Remote artifact filename is invalid.");
      if (typeof artifact.mediaType !== "string" || artifact.mediaType.length > 200 || !artifact.sha256?.match(/^[a-f0-9]{64}$/)) throw new Error("Remote artifact metadata is invalid.");
      const data = Buffer.from(artifact.dataBase64, "base64"); if (!data.byteLength || data.toString("base64").replace(/=+$/, "") !== artifact.dataBase64.replace(/=+$/, "")) throw new Error("Remote artifact data is invalid.");
      total += data.byteLength; if (data.byteLength > 25_000_000 || total > 100_000_000) throw new Error("Remote artifacts exceed size limits.");
      const sha256 = createHash("sha256").update(data).digest("hex"); if (sha256 !== artifact.sha256) throw new Error("Remote artifact hash verification failed.");
      const path = join(this.artifactRoot!, `${randomUUID()}-${filename}`); const temporary = `${path}.new`; await writeFile(temporary, data, { mode: 0o600, flag: "wx" }); await chmod(temporary, 0o600); await rename(temporary, path);
      output.push({ filename, mediaType: artifact.mediaType, bytes: data.byteLength, sha256, path });
    }
    return output;
  }
}

export interface RemoteExecutionConfiguration { backends: RemoteExecutionBackend[]; targets: RemoteTarget[]; artifactRoot?: string; }
export function environmentRemoteExecutionConfiguration(environment: NodeJS.ProcessEnv = process.env, artifactRoot?: string): RemoteExecutionConfiguration | undefined {
  if (!environment.KESTREL_REMOTE_TARGETS) return undefined;
  let parsed: unknown; try { parsed = JSON.parse(environment.KESTREL_REMOTE_TARGETS); } catch { throw new Error("KESTREL_REMOTE_TARGETS must be valid JSON."); }
  if (!Array.isArray(parsed) || parsed.length > 100) throw new Error("KESTREL_REMOTE_TARGETS must contain at most 100 targets.");
  if (parsed.some((target) => !isRemoteTarget(target))) throw new Error("KESTREL_REMOTE_TARGETS must contain valid target records.");
  const targets = parsed.filter(isRemoteTarget);
  const backends: RemoteExecutionBackend[] = [new DockerCliRemoteBackend(), new SshCliRemoteBackend(), new KubernetesCliRemoteBackend(), new ServerlessHttpRemoteBackend()];
  return { backends, targets, ...(artifactRoot ? { artifactRoot } : {}) };
}

export function installRemoteExecutionTool(runtime: AgentRuntime, manager: RemoteBackendManager, sessionId: string): void {
  runtime.registerExternalTool({
    descriptor: { name: "remote.execute", title: "Execute on remote target", description: "Run an argv-only allowlisted command through an explicitly enabled Docker, SSH, cluster, or serverless backend.", category: "execution", riskLevel: "high_consequence", readOnly: false, requiresWorkspace: false, source: "connector", tags: ["remote", "docker", "ssh", "cluster", "serverless"] },
    inputSchema: { type: "object", properties: { targetId: { type: "string" }, command: { type: "string" }, args: { type: "array", items: { type: "string" } }, timeoutMs: { type: "integer" } }, required: ["targetId", "command"] },
    execute: ({ signal, progress }, input) => manager.execute(String(input.targetId), String(input.command), Array.isArray(input.args) ? input.args.map(String) : [], Number(input.timeoutMs ?? 120_000), signal, (stream, chunk) => progress({ stream, chunk: chunk.slice(0, 16_000) }))
  });
  runtime.allowTool(sessionId, "remote.execute");
}

export type RemoteScope = "read" | "tasks" | "approve";
export interface RemoteTrustedIdentity { kind: "trusted-proxy"; identity: string; scopes: RemoteScope[]; }
export type RemoteCredential = string | RemoteTrustedIdentity;
interface PairingRecord { id: string; label: string; codeHash: string; scopes: RemoteScope[]; expiresAt: string; attempts: number; status: "pending" | "used" | "locked"; }
interface DeviceRecord { id: string; label: string; tokenHash: string; scopes: RemoteScope[]; createdAt: string; revokedAt?: string; }
export interface RemoteSessionSummary { id: string; title: string; status: RuntimeSession["status"]; parentSessionId?: string; updatedAt: string; }

const MAX_REMOTE_PAIRINGS = 200;
const MAX_REMOTE_PAIRING_LABEL_LENGTH = 100;
const REMOTE_SCOPES = new Set<RemoteScope>(["read", "tasks", "approve"]);

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isRemoteScope(value: unknown): value is RemoteScope {
  return typeof value === "string" && REMOTE_SCOPES.has(value as RemoteScope);
}

function isPairingRecord(value: unknown): value is PairingRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pairing = value as Record<string, unknown>;
  return (
    typeof pairing.id === "string" && pairing.id.length > 0 &&
    typeof pairing.label === "string" && pairing.label.length > 0 && pairing.label.length <= MAX_REMOTE_PAIRING_LABEL_LENGTH &&
    typeof pairing.codeHash === "string" && /^[a-f0-9]{64}$/.test(pairing.codeHash) &&
    Array.isArray(pairing.scopes) && pairing.scopes.length > 0 && pairing.scopes.every(isRemoteScope) &&
    typeof pairing.expiresAt === "string" && Number.isFinite(Date.parse(pairing.expiresAt)) &&
    isInteger(pairing.attempts) && pairing.attempts >= 0 && pairing.attempts <= 5 &&
    ["pending", "used", "locked"].includes(String(pairing.status))
  );
}

function isDeviceRecord(value: unknown): value is DeviceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const device = value as Record<string, unknown>;
  return (
    typeof device.id === "string" && device.id.length > 0 &&
    typeof device.label === "string" && device.label.length > 0 && device.label.length <= MAX_REMOTE_PAIRING_LABEL_LENGTH &&
    typeof device.tokenHash === "string" && /^[a-f0-9]{64}$/.test(device.tokenHash) &&
    Array.isArray(device.scopes) && device.scopes.length > 0 && device.scopes.every(isRemoteScope) &&
    typeof device.createdAt === "string" && Number.isFinite(Date.parse(device.createdAt)) &&
    (device.revokedAt === undefined || (typeof device.revokedAt === "string" && Number.isFinite(Date.parse(device.revokedAt))))
  );
}

export class RemoteControl {
  private readonly pairingKey = "remote.pairings";
  private readonly devicesKey = "remote.devices";
  constructor(private readonly database: KestrelDatabase, private readonly runtime: AgentRuntime, private readonly orchestrator: TaskOrchestrator, private readonly now: () => Date = () => new Date()) {}

  beginPairing(label: string, scopes: RemoteScope[], lifetimeMs = 300_000): { pairingId: string; code: string; expiresAt: string } {
    if (!label.trim() || label.length > MAX_REMOTE_PAIRING_LABEL_LENGTH || scopes.length === 0) throw new Error("Remote pairing requires a valid label and scopes.");
    if (scopes.some((scope) => !["read", "tasks", "approve"].includes(scope))) throw new Error("Remote pairing scope is invalid.");
    const pairings = this.prunePairings();
    if (pairings.length >= MAX_REMOTE_PAIRINGS) throw new Error("Remote pairing limit reached.");
    const code = randomBytes(6).toString("base64url");
    const pairing: PairingRecord = { id: `pair-${randomUUID()}`, label, codeHash: digest(code), scopes: [...new Set(scopes)], expiresAt: new Date(this.now().getTime() + Math.max(30_000, Math.min(lifetimeMs, 600_000))).toISOString(), attempts: 0, status: "pending" };
    this.database.setPrivateState(this.pairingKey, [...pairings, pairing]);
    return { pairingId: pairing.id, code, expiresAt: pairing.expiresAt };
  }

  completePairing(pairingId: string, code: string): { deviceId: string; token: string; scopes: RemoteScope[] } {
    const pairings = this.prunePairings();
    const index = pairings.findIndex((pairing) => pairing.id === pairingId);
    const pairing = pairings[index];
    if (!pairing || pairing.status !== "pending" || pairing.attempts >= 5 || new Date(pairing.expiresAt).getTime() < this.now().getTime()) throw new Error("Remote pairing is invalid or expired.");
    const supplied = Buffer.from(digest(code), "hex");
    const expected = Buffer.from(pairing.codeHash, "hex");
    if (!timingSafeEqual(supplied, expected)) {
      pairings[index] = { ...pairing, attempts: pairing.attempts + 1, ...(pairing.attempts + 1 >= 5 ? { status: "locked" as const } : {}) };
      this.database.setPrivateState(this.pairingKey, pairings);
      throw new Error("Remote pairing code is invalid.");
    }
    pairings[index] = { ...pairing, status: "used" };
    this.database.setPrivateState(this.pairingKey, pairings);
    const token = randomBytes(32).toString("base64url");
    const device: DeviceRecord = { id: `device-${randomUUID()}`, label: pairing.label, tokenHash: digest(token), scopes: pairing.scopes, createdAt: this.now().toISOString() };
    this.database.setPrivateState(this.devicesKey, [...this.devices(), device]);
    return { deviceId: device.id, token, scopes: device.scopes };
  }

  listSessions(token: RemoteCredential): RemoteSessionSummary[] {
    this.authorize(token, "read");
    return this.runtime.listSessions().map(({ id, title, status, parentSessionId, updatedAt }) => ({ id, title, status, ...(parentSessionId ? { parentSessionId } : {}), updatedAt }));
  }
  listJobs(token: RemoteCredential): Array<Omit<ScheduledAgentJob, "prompt" | "instructions">> {
    this.authorize(token, "read");
    return this.orchestrator.listJobs().map(({ prompt: _prompt, instructions: _instructions, ...job }) => job);
  }
  submitJob(token: RemoteCredential, input: Omit<ScheduledAgentJob, "id" | "status" | "createdAt" | "updatedAt">): Omit<ScheduledAgentJob, "prompt" | "instructions"> {
    this.authorize(token, "tasks");
    const { prompt: _prompt, instructions: _instructions, ...job } = this.orchestrator.schedule(input);
    return job;
  }
  async resumeJob(token: RemoteCredential, jobId: string): Promise<Omit<ScheduledAgentJob, "prompt" | "instructions">> {
    this.authorize(token, "approve");
    const { prompt: _prompt, instructions: _instructions, ...job } = await this.orchestrator.resumeJob(jobId);
    return job;
  }
  assertAuthorized(token: RemoteCredential, scope: RemoteScope): void { this.authorize(token, scope); }
  hasAuthorizedScope(token: RemoteCredential, scope: RemoteScope): boolean {
    try { this.authorize(token, scope); return true; }
    catch { return false; }
  }
  revoke(deviceId: string): void {
    const devices = this.devices();
    const index = devices.findIndex((device) => device.id === deviceId);
    if (index < 0) throw new Error("Remote device not found.");
    devices[index] = { ...devices[index]!, revokedAt: this.now().toISOString() };
    this.database.setPrivateState(this.devicesKey, devices);
  }

  private authorize(token: RemoteCredential, scope: RemoteScope): DeviceRecord | RemoteTrustedIdentity {
    if (typeof token !== "string") {
      if (!token.scopes.includes(scope)) throw new Error("Trusted proxy identity lacks the required scope.");
      return token;
    }
    const hash = digest(token);
    const device = this.devices().find((candidate) => candidate.tokenHash === hash && !candidate.revokedAt);
    if (!device || !device.scopes.includes(scope)) throw new Error("Remote token is invalid or lacks the required scope.");
    return device;
  }
  private prunePairings(): PairingRecord[] {
    const pairings = this.pairings();
    const now = this.now().getTime();
    const active = pairings.filter((pairing) => {
      const expiresAt = Date.parse(pairing.expiresAt);
      return pairing.status === "pending" && Number.isFinite(expiresAt) && expiresAt > now;
    });
    if (active.length !== pairings.length) this.database.setPrivateState(this.pairingKey, active);
    return active;
  }
  private pairings(): PairingRecord[] {
    const stored: unknown = this.database.getPrivateState<unknown>(this.pairingKey);
    return Array.isArray(stored) ? stored.filter(isPairingRecord) : [];
  }
  private devices(): DeviceRecord[] {
    const stored: unknown = this.database.getPrivateState<unknown>(this.devicesKey);
    return Array.isArray(stored) ? stored.filter(isDeviceRecord) : [];
  }
}
