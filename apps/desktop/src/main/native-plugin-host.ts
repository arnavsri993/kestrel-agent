import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { PluginInstaller } from "@kestrel/agent-core";
import { RendererRequestSchema, type RendererResponse, type PluginSummary } from "@kestrel/shared-types";
import { PluginTrustStore } from "./plugin-trust-store";

import { NATIVE_PLUGIN_REQUEST_TYPES } from "./native-plugin-requests";

interface Options {
  root: string;
  selectBundle(signal: AbortSignal): Promise<string | null>;
  selectPublisher(signal: AbortSignal): Promise<string | null>;
  reconfigure<T>(mutation: () => Promise<T>, rollback?: () => Promise<void>, validate?: () => void | Promise<void>, shouldRestoreCore?: () => boolean): Promise<T>;
  listPlugins(): Promise<PluginSummary[]>;
}

/** Host-owned signed bundle operations. Picker results never come from the renderer. */
export class NativePluginHost {
  private readonly root: string;
  private readonly trust: PluginTrustStore;
  private readonly idsPath: string;
  private readonly trustPath: string;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly controllers = new Set<AbortController>();
  private closing = false;
  constructor(private readonly options: Options) {
    if (!isAbsolute(options.root)) throw new Error("The native plugin profile must be absolute.");
    this.root = join(options.root, "plugins");
    this.trustPath = join(options.root, "trusted-plugin-publishers.json");
    this.trust = new PluginTrustStore(this.trustPath);
    this.idsPath = join(options.root, "native-plugin-activation-ids.json");
  }
  private activationIds(): Record<string, string> {
    if (!existsSync(this.idsPath)) return {};
    const info = lstatSync(this.idsPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000) throw new Error("Plugin activation state is invalid.");
    const parsed: unknown = JSON.parse(readFileSync(this.idsPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Plugin activation state is invalid.");
    const entries = Object.entries(parsed);
    if (entries.some(([key,value]) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key) || typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value))) throw new Error("Plugin activation state is invalid.");
    return Object.fromEntries(entries) as Record<string, string>;
  }
  private async rotateActivation(name: string, check: () => void): Promise<void> {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("Plugin name is invalid.");
    check();
    const next = { ...this.activationIds(), [name]: randomUUID() };
    await mkdir(this.options.root, { recursive: true, mode: 0o700 });
    const temporary = `${this.idsPath}.${randomUUID()}.new`;
    try { await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" }); check(); await rename(temporary, this.idsPath); }
    finally { await rm(temporary, { force: true }); }
  }
  async runtimeConfiguration() {
    return { pluginRoots: [this.root], managedPluginRoots: [this.root], pluginTrustKeys: await this.trust.trustKeys(), pluginActivationIds: this.activationIds() };
  }
  private async installer() { return new PluginInstaller({ managedRoot: this.root, trustKeys: await this.trust.trustKeys() }); }
  private async installed() {
    const installer = await this.installer();
    if (!existsSync(this.root)) return [];
    if (!lstatSync(this.root).isDirectory() || lstatSync(this.root).isSymbolicLink()) throw new Error("Managed plugin root is invalid.");
    return readdirSync(this.root, { withFileTypes: true }).filter(e => !e.name.startsWith(".")).map(e => {
      if (!e.isDirectory() || e.isSymbolicLink()) throw new Error("Managed plugin entry is invalid.");
      const bundle = installer.inspect(join(this.root, e.name));
      if (bundle.name !== e.name) throw new Error("Managed plugin name does not match its directory.");
      return bundle;
    });
  }
  private snapshotFile(path: string): Buffer | null {
    if (!existsSync(path)) return null;
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1_000_000 || (info.mode & 0o077) !== 0) throw new Error("Plugin state cannot be safely preserved.");
    return readFileSync(path);
  }
  private async restoreFile(path: string, previous: Buffer | null): Promise<void> {
    if (previous === null) { await rm(path, { force: true }); return; }
    const temporary = `${path}.${randomUUID()}.rollback`;
    try { await writeFile(temporary, previous, { flag: "wx", mode: 0o600 }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
  }
  private trashEntries(): Set<string> {
    const trash = join(this.root, ".trash");
    if (!existsSync(trash)) return new Set();
    if (!lstatSync(trash).isDirectory() || lstatSync(trash).isSymbolicLink()) throw new Error("Plugin recovery directory is invalid.");
    return new Set(readdirSync(trash));
  }
  private active(signal: AbortSignal, deadline: number): void {
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw new Error("The plugin request timed out.");
  }
  private async wait<T>(work: Promise<T>, signal: AbortSignal, deadline: number): Promise<T> {
    this.active(signal, deadline);
    let rejectWait!: (reason: unknown) => void;
    const interrupted = new Promise<never>((_, reject) => { rejectWait = reject; });
    const abort = () => rejectWait(signal.reason ?? new Error("The plugin request was interrupted."));
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => rejectWait(new Error("The plugin request timed out.")), Math.max(0, deadline - Date.now()));
    timer.unref();
    if (signal.aborted) abort();
    try { const result = await Promise.race([work, interrupted]); this.active(signal, deadline); return result; }
    finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
  }
  private async picked(kind: "bundle" | "publisher", signal: AbortSignal, deadline: number): Promise<string | null> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const cancel = () => controller.abort(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    try {
      const result = await this.wait(kind === "bundle" ? this.options.selectBundle(controller.signal) : this.options.selectPublisher(controller.signal), signal, deadline);
      this.active(signal, deadline);
      if (controller.signal.aborted || this.closing) return null;
      if (result !== null && (!isAbsolute(result) || result.length > 4096 || /[\u0000-\u001f\u007f]/.test(result))) throw new Error("Invalid native picker result.");
      return result;
    } finally { controller.abort(); signal.removeEventListener("abort", cancel); this.controllers.delete(controller); }
  }
  async close() {
    this.closing = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.pending]);
  }
  handle(input: unknown, signal: AbortSignal = new AbortController().signal): Promise<RendererResponse> {
    const request = RendererRequestSchema.parse(input);
    if (!NATIVE_PLUGIN_REQUEST_TYPES.has(request.type)) return Promise.reject(new Error("Unsupported native plugin request."));
    if (this.closing) return Promise.reject(new Error("The native plugin host is shutting down."));
    const work = this.perform(request, signal, Date.now() + 9 * 60_000 + 50_000);
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work)).catch(() => undefined);
    return work;
  }
  private async perform(request: ReturnType<typeof RendererRequestSchema.parse>, signal: AbortSignal, deadline: number): Promise<RendererResponse> {
    this.active(signal, deadline);
    if (request.type === "plugin-get-publishers") return { ok: true, pluginPublishers: await this.trust.list() };
    let selected: string | null = null;
    if (request.type === "plugin-import-publisher") selected = await this.picked("publisher", signal, deadline);
    else if (request.type === "plugin-install-bundle" || request.type === "plugin-update-bundle") selected = await this.picked("bundle", signal, deadline);
    if ((request.type === "plugin-import-publisher" || request.type === "plugin-install-bundle" || request.type === "plugin-update-bundle") && !selected)
      return { ok: true, cancelled: true, pluginPublishers: await this.trust.list() };
    this.active(signal, deadline);
    if (this.closing) throw new Error("The native plugin host is shutting down.");
    let previousTrust: Buffer | null | undefined;
    let previousIds: Buffer | null | undefined;
    let undo: (() => Promise<void>) | undefined;
    let needsRefresh = false;
    let refreshed: PluginSummary[] | undefined;
    const result = await this.options.reconfigure(async (): Promise<RendererResponse> => {
      this.active(signal, deadline);
      previousTrust = this.snapshotFile(this.trustPath);
      previousIds = this.snapshotFile(this.idsPath);
      if (this.closing) throw new Error("The native plugin host is shutting down.");
      if (request.type === "plugin-import-publisher") {
        const info = lstatSync(selected!);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 64_000) throw new Error("Select a bounded public publisher key JSON file.");
        const document = JSON.parse(readFileSync(selected!, "utf8")) as { publicKey?: unknown };
        if (typeof document.publicKey !== "string" || !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(document.publicKey)) throw new Error("Select a public Ed25519 key document.");
        await this.trust.importDocument(selected!, () => this.active(signal, deadline));
        return { ok: true, pluginPublishers: await this.trust.list() };
      }
      if (request.type === "plugin-remove-publisher") {
        if ((await this.installed()).some(bundle => bundle.keyId === request.keyId)) throw new Error("Remove the publisher's managed plugins before removing trust.");
        await this.trust.remove(request.keyId, () => this.active(signal, deadline));
        return { ok: true, pluginPublishers: await this.trust.list() };
      }
      const installer = await this.installer();
      this.active(signal, deadline);
      needsRefresh = true;
      if (request.type === "plugin-install-bundle" || request.type === "plugin-update-bundle") {
        const selectedInfo = lstatSync(selected!);
        if (!selectedInfo.isDirectory() || selectedInfo.isSymbolicLink()) throw new Error("Select a regular plugin bundle directory.");
        const bundle = installer.inspect(selected!);
        const already = (await this.installed()).some(item => item.name === bundle.name);
        if (request.type === "plugin-install-bundle" && already) throw new Error("Plugin is already installed; use update.");
        if (request.type === "plugin-update-bundle" && !already) throw new Error("Plugin is not installed.");
        await this.rotateActivation(bundle.name, () => this.active(signal, deadline));
        this.active(signal, deadline);
        this.trashEntries();
        const result = request.type === "plugin-install-bundle" ? installer.install(selected!) : installer.update(selected!);
        if (request.type === "plugin-install-bundle") undo = async () => { installer.remove(result.name); };
        else {
          const backup = result.replacedRecoveryPath;
          if (!backup) throw new Error("The plugin update did not preserve its predecessor.");
          undo = async () => { installer.remove(result.name); installer.restore(backup); };
        }
        return { ok: true, pluginMutation: { action: request.type === "plugin-install-bundle" ? "install" : "update", name: result.name, version: result.version, ...(result.replacedVersion ? { replacedVersion: result.replacedVersion } : {}) } };
      }
      if (request.type === "plugin-remove-installed") {
        this.trashEntries();
        await this.rotateActivation(request.name, () => this.active(signal, deadline));
        this.active(signal, deadline);
        const result = installer.remove(request.name);
        undo = async () => { installer.restore(result.recoveryPath); };
        return { ok: true, pluginMutation: { action: "remove", name: result.name, version: result.version, recoveryPath: basename(result.recoveryPath) } };
      }
      if (request.type === "plugin-restore-removed") {
        this.trashEntries();
        if (!/^[a-z0-9][a-z0-9.+_-]{0,255}$/i.test(request.recoveryPath) || basename(request.recoveryPath) !== request.recoveryPath) throw new Error("Invalid plugin recovery identifier.");
        const recovery = join(this.root, ".trash", request.recoveryPath);
        const recoveryInfo = lstatSync(recovery);
        if (!recoveryInfo.isDirectory() || recoveryInfo.isSymbolicLink()) throw new Error("Invalid plugin recovery entry.");
        const bundle = installer.inspect(recovery);
        await this.rotateActivation(bundle.name, () => this.active(signal, deadline));
        this.active(signal, deadline);
        const result = installer.restore(recovery);
        undo = async () => { const moved = installer.remove(result.name); await rename(moved.recoveryPath, recovery); };
        return { ok: true, pluginMutation: { action: "restore", name: result.name, version: result.version } };
      }
      throw new Error("Unsupported native plugin request.");
    }, async () => {
      try { await undo?.(); }
      finally {
        if (previousTrust !== undefined) await this.restoreFile(this.trustPath, previousTrust);
        if (previousIds !== undefined) await this.restoreFile(this.idsPath, previousIds);
      }
    }, async () => {
      this.active(signal, deadline);
      if (this.closing) throw new Error("The native plugin host is shutting down.");
      if (needsRefresh) { refreshed = await this.wait(this.options.listPlugins(), signal, deadline); }
    }, () => !this.closing);
    if (result.ok && "pluginMutation" in result && result.pluginMutation) return { ...result, plugins: refreshed ?? [] };
    return result;
  }
}
