import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdir, realpath, readFile, readdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { promisify } from "node:util";
import { z } from "zod";
import { UserBrowserTabSchema, type NativeBrowserStatus } from "@kestrel/shared-types";

const execFileAsync = promisify(execFile);
const stateSchema = z.object({
  tabs: z.array(UserBrowserTabSchema).max(32),
  activeTabId: z.string().regex(/^tab-[a-f0-9-]{36}$/).nullable(),
});
const messageSchema = z.object({
  version: z.literal(1), type: z.enum(["state", "response"]),
  state: stateSchema, id: z.string().max(64).optional(),
  ok: z.boolean().optional(), error: z.string().max(500).optional(),
});
type BrowserState = z.infer<typeof stateSchema>;
type BrowserRequest = { type: "browser-get-state" | "browser-open-native-extensions" } |
  { type: "browser-create-tab"; input: string; active: boolean } |
  { type: "browser-navigate"; tabId: string; input: string } |
  { type: "browser-select-tab"; tabId: string };
type Pending = { resolve(state: BrowserState): void; reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>; generation: number };
const profileMarkerSchema = z.object({ format: z.literal(1), owner: z.literal("kestrel-native-browser"),
  credentialMode: z.enum(["system_keychain", "development_mock"]) }).strict();

export class NativeBrowserManager {
  private child: ChildProcessWithoutNullStreams | undefined;
  private launching: Promise<void> | undefined;
  private generation = 0;
  private sequence = 0;
  private pending = new Map<string, Pending>();
  private buffer = "";
  private state: BrowserState | undefined;
  private stopped = false;
  private termination: Promise<void> | undefined;
  private faultedGeneration = -1;
  private ready = false;
  private lastError: string | undefined;
  private exit: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    executable: string; profileRoot: string; profileOwnerRoot?: string;
    mode?: "persistent" | "ephemeral";
    /** Test-only probes accepted solely with a disposable mock-storage profile. */
    fixtureExtensionPath?: string; debug?: boolean;
  }) {
    if (!isAbsolute(options.executable) || !isAbsolute(options.profileRoot))
      throw new Error("Native browser paths must be absolute.");
    if (options.mode !== "ephemeral" && (options.fixtureExtensionPath || options.debug))
      throw new Error("Persistent native browsing does not accept development probes.");
  }

  async status(): Promise<NativeBrowserStatus> {
    let available = false;
    try { await access(this.options.executable, constants.X_OK); available = process.platform === "darwin"; } catch { }
    return { available, running: this.ready && Boolean(this.child?.exitCode === null),
      profile: "persistent", credentialStorage: "system_keychain_unverified",
      ...(this.lastError ? { error: this.lastError } : {}) };
  }

  private async prepareProfile(): Promise<void> {
    const root = this.options.profileRoot;
    const anchor = resolve(this.options.profileOwnerRoot ?? dirname(root));
    const subpath = relative(anchor, resolve(root));
    if (!subpath || subpath === ".." || subpath.startsWith(`..${sep}`) || isAbsolute(subpath))
      throw new Error("The native browser profile is outside its owner directory.");
    const realAnchor = await realpath(anchor);
    let cursor = anchor;
    for (const component of subpath.split(sep)) {
      cursor = join(cursor, component);
      try {
        const existing = await lstat(cursor);
        if (existing.isSymbolicLink() || !existing.isDirectory())
          throw new Error("The native browser profile contains an unsafe directory.");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        await mkdir(cursor, { mode: 0o700 });
      }
      const actual = relative(realAnchor, await realpath(cursor));
      if (actual === ".." || actual.startsWith(`..${sep}`) || isAbsolute(actual))
        throw new Error("The native browser profile escaped its owner directory.");
    }
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("The native browser profile is unavailable.");
    const markerPath = join(root, "kestrel-browser-profile.json");
    const mode = this.options.mode === "ephemeral" ? "development_mock" : "system_keychain";
    try {
      const markerStat = await lstat(markerPath);
      if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 4096) throw new Error("Invalid native profile marker.");
      const marker = profileMarkerSchema.parse(JSON.parse(await readFile(markerPath, "utf8")));
      if (marker.credentialMode !== mode) throw new Error("Native profile credential modes cannot be changed.");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      if ((await readdir(root)).length) throw new Error("An unrecognized native browser profile was preserved.");
      await writeFile(markerPath, JSON.stringify({ format: 1, owner: "kestrel-native-browser", credentialMode: mode }),
        { flag: "wx", mode: 0o600 });
    }
    await chmod(root, 0o700);
  }

  private async validateBundle(): Promise<void> {
    const app = dirname(dirname(dirname(this.options.executable)));
    await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { timeout: 15000 });
    // The normal installed path has a pinned preparation manifest. Source
    // smokes use a freshly signed .tmp native bundle without that manifest.
    if (this.options.mode === "ephemeral") return;
    const manifestPath = join(dirname(app), "runtime-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { format?: number; binaries?: Record<string, string> };
    const expected = manifest.binaries?.["Kestrel.app/Contents/MacOS/Kestrel"];
    if (manifest.format !== 1 || !expected ||
      createHash("sha256").update(await readFile(this.options.executable)).digest("hex") !== expected)
      throw new Error("The bundled native browser could not be verified.");
  }

  private async start(): Promise<void> {
    if (this.stopped) throw new Error("Kestrel is shutting down.");
    if (this.ready && this.child?.exitCode === null) return;
    if (this.launching) return this.launching;
    this.launching = this.launch();
    try { await this.launching; }
    catch {
      this.lastError = "The native browser could not start. Its existing data was preserved.";
      throw new Error(this.lastError);
    } finally { this.launching = undefined; }
  }

  private async launch(): Promise<void> {
    if (this.termination) await this.termination;
    await this.exit;
    await this.validateBundle();
    await this.prepareProfile();
    if (this.stopped) throw new Error("Kestrel is shutting down.");
    const generation = ++this.generation;
    this.buffer = ""; this.state = undefined; this.ready = false; this.lastError = undefined;
    const ephemeral = this.options.mode === "ephemeral";
    const args = ["--kestrel-extension-workbench", "--kestrel-browser-child",
      ...(!ephemeral ? ["--kestrel-persistent-browser"] : []),
      "--kestrel-cache-path", this.options.profileRoot,
      ...(ephemeral && this.options.debug ? ["--remote-debugging-port=0"] : []),
      ...(ephemeral && this.options.fixtureExtensionPath ? [`--load-extension=${this.options.fixtureExtensionPath}`] : [])];
    const child = spawn(this.options.executable, args, { shell: false, detached: false,
      env: { HOME: homedir(), LANG: "en_US.UTF-8", PATH: "/usr/bin:/bin", TMPDIR: tmpdir() },
      stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.exit = new Promise(resolve => {
      child.once("close", () => {
        if (this.generation === generation) { this.ready = false; this.child = undefined; this.failPending(); }
        resolve();
      });
    });
    child.stderr.resume(); // Native diagnostics are not model/history/UI content.
    child.stdin.on("error", () => this.connectionFault(generation));
    child.on("error", () => this.connectionFault(generation));
    child.stdout.on("end", () => this.connectionFault(generation));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk, generation));
    try {
      this.state = await this.request({ type: "browser-get-state" }, generation);
      this.ready = true;
    } catch {
      this.lastError = "The native browser could not start. Try again.";
      await this.terminate(child);
      throw new Error(this.lastError);
    }
  }

  private consume(chunk: string, generation: number): void {
    if (generation !== this.generation) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > 1024 * 1024) {
      this.connectionFault(generation); return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (!line.startsWith("KESTREL_BROWSER_IPC ")) continue;
      let message: z.infer<typeof messageSchema>;
      try { message = messageSchema.parse(JSON.parse(line.slice(20))); } catch { continue; }
      this.state = message.state;
      if (message.type !== "response" || !message.id) continue;
      const pending = this.pending.get(message.id);
      if (!pending || pending.generation !== generation) continue;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.ok === true) pending.resolve(message.state);
      else pending.reject(new Error("The native browser could not complete that action."));
    }
  }

  private request(request: BrowserRequest, generation = this.generation): Promise<BrowserState> {
    const child = this.child;
    if (!child || child.exitCode !== null || this.pending.size >= 64)
      return Promise.reject(new Error("The native browser is unavailable or busy."));
    const id = `native-${generation}-${++this.sequence}`;
    const line = JSON.stringify({ version: 1, type: "request", id, request }) + "\n";
    if (Buffer.byteLength(line) > 16384) return Promise.reject(new Error("The native browser request was too large."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("The native browser did not respond in time.")); }, 15000);
      this.pending.set(id, { resolve, reject, timer, generation });
      child.stdin.write(line, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (pending) { clearTimeout(pending.timer); this.pending.delete(id); pending.reject(new Error("The native browser connection closed.")); }
      });
    });
  }

  private connectionFault(generation: number): void {
    if (generation !== this.generation || this.faultedGeneration === generation) return;
    this.faultedGeneration = generation;
    this.ready = false; this.state = undefined; this.buffer = "";
    this.failPending();
    const child = this.child;
    if (!child || this.stopped) return;
    child.stdout.pause();
    this.termination = this.terminate(child);
    void this.termination.catch(() => {
      this.lastError = "The native browser did not stop. Its profile was preserved.";
    });
  }

  private failPending(): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("The native browser closed. Try again.")); }
    this.pending.clear();
  }

  async openExtensions(): Promise<NativeBrowserStatus> {
    await this.start();
    await this.request({ type: "browser-open-native-extensions" });
    return this.status();
  }

  async open(input = ""): Promise<NativeBrowserStatus> {
    if (input) {
      const url = new URL(input);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || input.length > 8192)
        throw new Error("Enter an HTTP or HTTPS address for the native browser.");
      input = url.href;
    }
    await this.start();
    const existing = this.state?.tabs.find(tab => !tab.url);
    if (existing) {
      if (input) await this.request({ type: "browser-navigate", tabId: existing.id, input });
      await this.request({ type: "browser-select-tab", tabId: existing.id });
    } else await this.request({ type: "browser-create-tab", input, active: true });
    return this.status();
  }

  private async terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
    child.stdin.end();
    let closed = child.exitCode !== null || child.signalCode !== null;
    const onClose = () => { closed = true; };
    child.once("close", onClose);
    for (let attempt = 0; attempt < 60 && !closed; attempt++) {
      if (attempt === 20) child.kill("SIGTERM");
      if (attempt === 40) child.kill("SIGKILL");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    child.removeListener("close", onClose);
    if (!closed) throw new Error("The native browser did not stop. Its profile was preserved.");
  }

  async stop(): Promise<void> {
    this.stopped = true; this.ready = false; this.failPending();
    const child = this.child;
    if (child) await this.terminate(child);
  }
}
