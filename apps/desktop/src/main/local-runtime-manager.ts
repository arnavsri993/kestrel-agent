import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { once } from "node:events";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { readBoundedResponseBytes } from "@kestrel/agent-core";
import type { LocalModelSummary, LocalRuntimeProgress, LocalRuntimeStatus } from "@kestrel/shared-types";

const execFileAsync = promisify(execFile);
const OLLAMA_ORIGIN = "http://127.0.0.1:11434";

export interface LocalRuntimeManifest {
  runtime: "ollama";
  version: string;
  platform: "darwin";
  architectures: ["arm64"];
  url: string;
  fileName: string;
  sha256: string;
  bytes: number;
  binaryPath: string;
}

export const MANAGED_OLLAMA_MANIFEST: LocalRuntimeManifest = {
  runtime: "ollama",
  version: "0.32.1",
  platform: "darwin",
  architectures: ["arm64"],
  url: "https://github.com/ollama/ollama/releases/download/v0.32.1/ollama-darwin.tgz",
  fileName: "ollama-darwin.tgz",
  sha256: "346d28fe70f3ef3776e42100f5721510aa35fc07f3733f6629dbb117b1cfede9",
  bytes: 145_355_166,
  binaryPath: "ollama"
};

interface OllamaTag {
  name?: unknown;
  size?: unknown;
  modified_at?: unknown;
}

interface ManagerDependencies {
  fetch?: typeof fetch;
  execFile?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  spawn?: typeof spawn;
  platform?: NodeJS.Platform;
  architecture?: string;
  manifest?: LocalRuntimeManifest;
  now?: () => Date;
}

function modelSummaries(payload: { models?: OllamaTag[] }): LocalModelSummary[] {
  return (payload.models ?? []).flatMap((item) => {
    if (typeof item.name !== "string" || !item.name.trim()) return [];
    return [{
      name: item.name,
      size: typeof item.size === "number" && Number.isFinite(item.size) ? Math.max(0, Math.floor(item.size)) : 0,
      ...(typeof item.modified_at === "string" ? { modifiedAt: item.modified_at } : {})
    }];
  });
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted|cancelled/i.test(error.message));
}

function safeArchiveEntries(stdout: string): string[] {
  const entries = stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0 || entries.length > 10_000) throw new Error("The local runtime archive has an invalid file list.");
  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/");
    if (normalized.startsWith("/") || normalized.split("/").some((part) => part === "..")) {
      throw new Error("The local runtime archive contains a path outside its install folder.");
    }
  }
  return entries;
}

async function rejectExtractedLinks(root: string, current = root, canonicalRoot?: string): Promise<void> {
  const containedRoot = canonicalRoot ?? await realpath(root);
  for (const entry of await readdir(current)) {
    const path = join(current, entry);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      const resolved = await realpath(path);
      if (resolved !== containedRoot && !resolved.startsWith(`${containedRoot}${sep}`)) {
        throw new Error("The local runtime archive contains a symbolic link outside its install folder.");
      }
      continue;
    }
    if (metadata.isDirectory()) await rejectExtractedLinks(root, path, containedRoot);
    const pathWithinRoot = relative(root, path);
    if (pathWithinRoot.startsWith(`..${sep}`) || pathWithinRoot === "..") throw new Error("The local runtime archive escaped its install folder.");
  }
}

export class LocalRuntimeManager {
  private readonly fetcher: typeof fetch;
  private readonly execute: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  private readonly spawnProcess: typeof spawn;
  private readonly currentPlatform: NodeJS.Platform;
  private readonly currentArchitecture: string;
  private readonly manifest: LocalRuntimeManifest;
  private readonly now: () => Date;
  private child: ChildProcess | null = null;
  private operation: AbortController | null = null;

  constructor(
    private readonly root: string,
    private readonly emit: (progress: LocalRuntimeProgress) => void,
    dependencies: ManagerDependencies = {}
  ) {
    this.fetcher = dependencies.fetch ?? fetch;
    this.execute = dependencies.execFile ?? (async (file, args) => {
      const result = await execFileAsync(file, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
      return { stdout: result.stdout, stderr: result.stderr };
    });
    this.spawnProcess = dependencies.spawn ?? spawn;
    this.currentPlatform = dependencies.platform ?? process.platform;
    this.currentArchitecture = dependencies.architecture ?? process.arch;
    this.manifest = dependencies.manifest ?? MANAGED_OLLAMA_MANIFEST;
    this.now = dependencies.now ?? (() => new Date());
  }

  private installRoot(): string {
    return join(this.root, "local-runtime", this.manifest.runtime, this.manifest.version);
  }

  private binaryPath(): string {
    return join(this.installRoot(), this.manifest.binaryPath);
  }

  private markerPath(): string {
    return join(this.installRoot(), "workstrand-install.json");
  }

  private verificationPath(): string {
    return join(this.root, "local-runtime", "last-verification.json");
  }

  private automaticSupported(): boolean {
    return (
      this.currentPlatform === this.manifest.platform &&
      this.currentArchitecture === "arm64"
    );
  }

  private progress(progress: Omit<LocalRuntimeProgress, "updatedAt">): void {
    this.emit({ ...progress, updatedAt: this.now().toISOString() });
  }

  async listModels(timeoutMs = 1_500, signal?: AbortSignal): Promise<LocalModelSummary[]> {
    const response = await this.fetcher(`${OLLAMA_ORIGIN}/api/tags`, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new Error(`The local model service returned ${response.status}.`);
    return modelSummaries(await response.json() as { models?: OllamaTag[] });
  }

  private async hasManagedInstall(): Promise<boolean> {
    try {
      const marker = JSON.parse(await readFile(this.markerPath(), "utf8")) as { version?: unknown; sha256?: unknown; binaryPath?: unknown };
      const metadata = await lstat(this.binaryPath());
      return metadata.isFile()
        && (metadata.mode & 0o111) !== 0
        && marker.version === this.manifest.version
        && marker.sha256 === this.manifest.sha256
        && marker.binaryPath === this.manifest.binaryPath;
    } catch {
      return false;
    }
  }

  async status(): Promise<LocalRuntimeStatus> {
    const automaticSupported = this.automaticSupported();
    const managedRuntime = await this.hasManagedInstall();
    try {
      const localModels = await this.listModels();
      const verification = await this.readVerification(localModels);
      return {
        automaticSupported,
        managedRuntime,
        ollamaAvailable: true,
        source: managedRuntime ? "managed" : "external",
        runtimeVersion: this.manifest.version,
        runtimeDownloadBytes: this.manifest.bytes,
        localModels,
        ...verification
      };
    } catch {
      return {
        automaticSupported,
        managedRuntime,
        ollamaAvailable: false,
        source: managedRuntime ? "managed" : "none",
        runtimeVersion: this.manifest.version,
        runtimeDownloadBytes: this.manifest.bytes,
        localModels: []
      };
    }
  }

  cancel(): void {
    this.operation?.abort(new DOMException("Local setup was cancelled.", "AbortError"));
  }

  async bootstrap(model: string): Promise<LocalRuntimeStatus> {
    if (this.operation) throw new Error("A local setup operation is already running.");
    if (!/^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9][a-z0-9._-]*)?$/i.test(model)) throw new Error("Choose a valid Ollama model name.");
    const operation = new AbortController();
    this.operation = operation;
    try {
      this.progress({ stage: "detecting", message: "Checking for an existing local model service.", model });
      let serviceReady = false;
      try {
        await this.listModels(1_500, operation.signal);
        serviceReady = true;
      } catch {
        // Continue into the managed installation path.
      }
      if (!serviceReady) {
        if (!this.automaticSupported()) throw new Error("Automatic local setup is currently available only on supported macOS builds. Use manual setup on this device.");
        if (!await this.hasManagedInstall()) await this.install(operation.signal);
        await this.start(operation.signal);
      }
      const existing = await this.listModels(5_000, operation.signal);
      if (!existing.some((item) => item.name === model || item.name === `${model}:latest`)) await this.pullModel(model, operation.signal);
      await this.verifyModel(model, operation.signal);
      await this.recordVerification(model);
      const status = await this.status();
      this.progress({ stage: "ready", message: `${model} completed a real local response and is ready.`, model, percent: 100 });
      return status;
    } catch (error) {
      const cancelled = isAbort(error) || operation.signal.aborted;
      this.progress({
        stage: cancelled ? "cancelled" : "error",
        message: cancelled ? "Local setup stopped. Partial downloads were removed." : error instanceof Error ? error.message : "Local setup failed.",
        model
      });
      throw error;
    } finally {
      this.operation = null;
    }
  }

  private async readVerification(models: LocalModelSummary[]): Promise<{ verifiedModel: string; verifiedAt: string } | Record<string, never>> {
    try {
      const value = JSON.parse(await readFile(this.verificationPath(), "utf8")) as { model?: unknown; verifiedAt?: unknown };
      if (typeof value.model !== "string" || typeof value.verifiedAt !== "string" || !Number.isFinite(Date.parse(value.verifiedAt))) return {};
      if (!models.some((item) => item.name === value.model || item.name === `${value.model}:latest`)) return {};
      return { verifiedModel: value.model, verifiedAt: value.verifiedAt };
    } catch {
      return {};
    }
  }

  private async recordVerification(model: string): Promise<void> {
    const path = this.verificationPath();
    const temporary = `${path}.new`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify({ model, verifiedAt: this.now().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }

  private async install(signal: AbortSignal): Promise<void> {
    const parent = dirname(this.installRoot());
    const staging = `${this.installRoot()}.partial`;
    const archive = join(staging, this.manifest.fileName);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: false, mode: 0o700 });
    try {
      this.progress({
        stage: "downloading-runtime",
        message: `Downloading the verified Ollama ${this.manifest.version} runtime from GitHub.`,
        downloadedBytes: 0,
        totalBytes: this.manifest.bytes,
        percent: 0
      });
      const response = await this.fetcher(this.manifest.url, { redirect: "follow", signal });
      if (!response.ok || !response.body) throw new Error(`The local runtime download returned ${response.status}.`);
      const finalUrl = new URL(response.url || this.manifest.url);
      if (finalUrl.protocol !== "https:" || !["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"].includes(finalUrl.hostname)) {
        throw new Error("The local runtime download redirected to an untrusted host.");
      }
      const file = await open(archive, "wx", 0o600);
      const digest = createHash("sha256");
      let downloaded = 0;
      try {
        const reader = response.body.getReader();
        while (true) {
          signal.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          downloaded += chunk.value.byteLength;
          if (downloaded > this.manifest.bytes) throw new Error("The local runtime download exceeded its signed manifest size.");
          digest.update(chunk.value);
          await file.write(chunk.value);
          this.progress({
            stage: "downloading-runtime",
            message: `Downloading the verified Ollama ${this.manifest.version} runtime from GitHub.`,
            downloadedBytes: downloaded,
            totalBytes: this.manifest.bytes,
            percent: Math.min(100, Math.floor(downloaded / this.manifest.bytes * 100))
          });
        }
      } finally {
        await file.close();
      }
      if (downloaded !== this.manifest.bytes) throw new Error(`The local runtime download was incomplete (${downloaded} of ${this.manifest.bytes} bytes).`);
      this.progress({ stage: "verifying-runtime", message: "Verifying the runtime checksum before anything is installed.", percent: 100 });
      if (digest.digest("hex") !== this.manifest.sha256) throw new Error("The local runtime checksum did not match the signed release manifest.");
      const contents = safeArchiveEntries((await this.execute("/usr/bin/tar", ["-tzf", archive])).stdout);
      if (!contents.includes(this.manifest.binaryPath)) throw new Error("The local runtime archive does not contain the expected executable.");
      this.progress({ stage: "installing-runtime", message: "Installing the verified runtime inside Kestrel's private application data." });
      await this.execute("/usr/bin/tar", ["-xzf", archive, "-C", staging]);
      await rm(archive, { force: true });
      await rejectExtractedLinks(staging);
      const binary = join(staging, this.manifest.binaryPath);
      const binaryMetadata = await lstat(binary);
      if (!binaryMetadata.isFile()) throw new Error("The extracted local runtime executable is invalid.");
      await chmod(binary, 0o700);
      await writeFile(join(staging, "workstrand-install.json"), `${JSON.stringify({
        runtime: this.manifest.runtime,
        version: this.manifest.version,
        source: this.manifest.url,
        sha256: this.manifest.sha256,
        bytes: this.manifest.bytes,
        binaryPath: this.manifest.binaryPath,
        installedAt: this.now().toISOString()
      }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rm(this.installRoot(), { recursive: true, force: true });
      await rename(staging, this.installRoot());
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  private async start(signal: AbortSignal): Promise<void> {
    this.progress({ stage: "starting-runtime", message: "Starting the local model service on this Mac only." });
    if (!await this.hasManagedInstall()) throw new Error("The managed local runtime is not installed.");
    if (this.child && this.child.exitCode === null) return;
    const modelsRoot = join(this.root, "local-models");
    const managedHome = join(this.root, "local-runtime-home");
    await Promise.all([
      mkdir(modelsRoot, { recursive: true, mode: 0o700 }),
      mkdir(managedHome, { recursive: true, mode: 0o700 })
    ]);
    const child = this.spawnProcess(this.binaryPath(), ["serve"], {
      cwd: this.installRoot(),
      stdio: "ignore",
      windowsHide: true,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: managedHome,
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        OLLAMA_HOST: "127.0.0.1:11434",
        OLLAMA_MODELS: modelsRoot,
        OLLAMA_KEEP_ALIVE: "10m",
        OLLAMA_CONTEXT_LENGTH: "32768",
        OLLAMA_NO_CLOUD: "1"
      }
    });
    this.child = child;
    child.once("exit", () => { if (this.child === child) this.child = null; });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (child.exitCode !== null) throw new Error(`The managed local model service exited with code ${child.exitCode}.`);
      try {
        await this.listModels(750, signal);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    child.kill("SIGTERM");
    throw new Error("The managed local model service did not become ready in time.");
  }

  private async pullModel(model: string, signal: AbortSignal): Promise<void> {
    this.progress({ stage: "downloading-model", message: `Downloading ${model}. This is the larger part of setup.`, model, percent: 0 });
    const response = await this.fetcher(`${OLLAMA_ORIGIN}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: true }),
      signal
    });
    if (!response.ok || !response.body) throw new Error(`The local model service could not download ${model} (${response.status}).`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const update = JSON.parse(line) as { status?: unknown; completed?: unknown; total?: unknown; error?: unknown };
        if (typeof update.error === "string") throw new Error(update.error);
        const completed = typeof update.completed === "number" ? Math.max(0, update.completed) : undefined;
        const total = typeof update.total === "number" && update.total > 0 ? update.total : undefined;
        this.progress({
          stage: "downloading-model",
          message: typeof update.status === "string" ? update.status : `Downloading ${model}.`,
          model,
          ...(completed !== undefined ? { downloadedBytes: completed } : {}),
          ...(total !== undefined ? { totalBytes: total } : {}),
          ...(completed !== undefined && total !== undefined ? { percent: Math.min(100, Math.floor(completed / total * 100)) } : {})
        });
      }
    }
    const installed = await this.listModels(5_000, signal);
    if (!installed.some((item) => item.name === model || item.name === `${model}:latest`)) {
      throw new Error(`${model} finished downloading but was not listed by the local model service.`);
    }
  }

  private async verifyModel(model: string, signal: AbortSignal): Promise<void> {
    this.progress({ stage: "verifying-model", message: `Asking ${model} for one real local response before marking setup complete.`, model });
    const response = await this.fetcher(`${OLLAMA_ORIGIN}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with the single word READY." }],
        stream: false,
        think: false,
        options: { temperature: 0, num_predict: 32, num_ctx: 32_768 }
      }),
      signal
    });
    if (!response.ok) throw new Error(`The local model verification returned ${response.status}.`);
    const bytes = await readBoundedResponseBytes(response, 1_000_000, "The local model verification response exceeds 1 MB.");
    let result: { done?: unknown; message?: { content?: unknown }; error?: unknown };
    try {
      result = JSON.parse(new TextDecoder().decode(bytes)) as { done?: unknown; message?: { content?: unknown }; error?: unknown };
    } catch {
      throw new Error("The local model verification returned invalid JSON.");
    }
    if (typeof result.error === "string") throw new Error(result.error);
    if (result.done !== true || typeof result.message?.content !== "string" || !result.message.content.trim()) {
      throw new Error("The local model started but did not complete a verification response.");
    }
  }

  async stop(): Promise<void> {
    this.cancel();
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }

  async startManagedIfInstalled(): Promise<void> {
    if (!await this.hasManagedInstall()) return;
    try {
      await this.listModels(700);
    } catch {
      await this.start(AbortSignal.timeout(20_000));
    }
  }
}
