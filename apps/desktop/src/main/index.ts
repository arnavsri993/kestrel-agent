import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { arch, cpus, platform, totalmem } from "node:os";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, systemPreferences, Tray } from "electron";
import updater from "electron-updater";
import { CoreRequestSchema, PRODUCT_IDENTITY, RendererRequestSchema, SelectedAttachmentSchema, type AgentState, type BackgroundJobsEvent, type WorkspaceGrant } from "@kestrel/shared-types";
import { CoreSupervisor } from "./core-supervisor";
import { CredentialBroker } from "./credential-broker";
import { WorkspaceGrantStore } from "./workspace-grant-store";
import { MigrationManager, PluginInstaller } from "@kestrel/agent-core";
import { PluginTrustStore } from "./plugin-trust-store";
import { ElectronBrowserService } from "./electron-browser-service";
import { LocalRuntimeManager } from "./local-runtime-manager";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let agentState: AgentState = "idle";
const browserService = new ElectronBrowserService();
const supervisor = new CoreSupervisor((request, signal) => browserService.handle(request, signal), () => browserService.closeAll());
const { autoUpdater } = updater;
const OLLAMA_ORIGIN = "http://127.0.0.1:11434";
const execFileAsync = promisify(execFile);
let managedLocalRuntime: LocalRuntimeManager | null = null;

interface OllamaTag {
  name?: unknown;
  size?: unknown;
  modified_at?: unknown;
}

interface BackupManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}

type SubscriptionCliId = "codex" | "claude";
interface RuntimePreferences {
  subscriptions?: Partial<Record<SubscriptionCliId, { enabled: boolean; path: string }>>;
}

function runtimePreferencesPath(): string {
  return join(app.getPath("userData"), "runtime-preferences.json");
}

function localRuntimeManager(): LocalRuntimeManager {
  managedLocalRuntime ??= new LocalRuntimeManager(app.getPath("userData"), (progress) => {
    mainWindow?.webContents.send("kestrel:local-runtime-progress", progress);
  });
  return managedLocalRuntime;
}

async function readRuntimePreferences(): Promise<RuntimePreferences> {
  try {
    const value: unknown = JSON.parse(await readFile(runtimePreferencesPath(), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as RuntimePreferences : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return {};
    throw error;
  }
}

async function writeRuntimePreferences(preferences: RuntimePreferences): Promise<void> {
  const path = runtimePreferencesPath();
  const temporary = `${path}.new`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(preferences, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function detectedSubscriptionCli(id: SubscriptionCliId): string | undefined {
  const home = app.getPath("home");
  const configured = id === "codex" ? process.env.KESTREL_CODEX_PATH : process.env.KESTREL_CLAUDE_PATH;
  const candidates = id === "codex"
    ? [configured, "/Applications/ChatGPT.app/Contents/Resources/codex", "/opt/homebrew/bin/codex", "/usr/local/bin/codex", join(home, ".local", "bin", "codex"), join(home, ".npm-global", "bin", "codex")]
    : [configured, "/opt/homebrew/bin/claude", "/usr/local/bin/claude", join(home, ".local", "bin", "claude"), join(home, ".npm-global", "bin", "claude")];
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    try {
      const metadata = statSync(candidate);
      if (metadata.isFile() && (metadata.mode & 0o111) !== 0) return realpathSync(candidate);
    } catch {
      // Continue through bounded known locations.
    }
  }
  return undefined;
}

async function subscriptionCliStatuses() {
  const preferences = await readRuntimePreferences();
  return (["codex", "claude"] as const).map((id) => {
    const path = detectedSubscriptionCli(id);
    const enabled = Boolean(path && preferences.subscriptions?.[id]?.enabled && preferences.subscriptions[id]?.path === path);
    const label = id === "codex" ? "ChatGPT plan through Codex" : "Claude plan through Claude Code";
    return {
      id,
      label,
      detected: Boolean(path),
      enabled,
      ...(path ? { path } : {}),
      detail: enabled
        ? "Enabled. Authentication remains in the vendor CLI and is checked without copying tokens."
        : path
          ? "CLI found. Enable it to use the vendor's existing on-device sign-in for text-only tasks."
          : `Install and sign in to the official ${id === "codex" ? "Codex" : "Claude Code"} CLI to make this route available.`
    };
  });
}

async function fileDigest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function copyBackupEntry(sourceRoot: string, source: string, destinationRoot: string, files: BackupManifestFile[]): Promise<void> {
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink()) return;
  const relativePath = relative(sourceRoot, source);
  const destination = join(destinationRoot, relativePath);
  if (metadata.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(source)) await copyBackupEntry(sourceRoot, join(source, entry), destinationRoot, files);
    return;
  }
  if (!metadata.isFile()) return;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination);
  files.push({ path: relativePath, bytes: metadata.size, sha256: await fileDigest(destination) });
}

async function createVerifiedLocalBackup(destinationParent: string): Promise<{ path: string; createdAt: string; files: number; bytes: number; verified: boolean }> {
  const sourceRoot = realpathSync(app.getPath("userData"));
  const parent = realpathSync(destinationParent);
  if (parent === sourceRoot || parent.startsWith(`${sourceRoot}${sep}`)) throw new Error("Choose a backup folder outside Workstrand's application data.");
  const createdAt = new Date().toISOString();
  const timestamp = createdAt.replaceAll(":", "-");
  const suffix = randomUUID().slice(0, 8);
  const finalPath = join(parent, `Workstrand-backup-${timestamp}-${suffix}`);
  const stagingPath = `${finalPath}.partial`;
  const files: BackupManifestFile[] = [];
  const entries = ["database", "secure", "runtime-preferences.json", "workspace-grants.json", "trusted-plugin-publishers.json", "plugins", "learned-skills", "migrations", "browser-downloads"];
  await mkdir(stagingPath, { recursive: false, mode: 0o700 });
  try {
    for (const entry of entries) {
      const source = join(sourceRoot, entry);
      if (existsSync(source)) await copyBackupEntry(sourceRoot, source, stagingPath, files);
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    const manifest = {
      format: "workstrand-local-backup",
      version: 1,
      appVersion: app.getVersion(),
      createdAt,
      files
    };
    await writeFile(join(stagingPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    const verified = (await Promise.all(files.map(async (file) => {
      const path = join(stagingPath, file.path);
      const metadata = await lstat(path);
      return metadata.isFile() && metadata.size === file.bytes && await fileDigest(path) === file.sha256;
    }))).every(Boolean);
    if (!verified) throw new Error("Backup verification failed; the incomplete backup was removed.");
    await rename(stagingPath, finalPath);
    return { path: finalPath, createdAt, files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), verified };
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true });
    throw error;
  }
}

async function distributionReadiness(): Promise<{ status: "pass" | "warning"; detail: string }> {
  if (!app.isPackaged) return { status: "warning", detail: "Running the development build. Use a consistently signed packaged app for stable daily permissions." };
  if (process.platform !== "darwin") return { status: "pass", detail: `Running packaged Workstrand ${app.getVersion()}.` };
  try {
    const bundlePath = realpathSync(join(dirname(process.execPath), "..", ".."));
    const result = await execFileAsync("/usr/bin/codesign", ["--display", "--verbose=2", bundlePath], { timeout: 4_000 });
    const evidence = `${result.stdout}\n${result.stderr}`;
    const stableAuthority = /^Authority=.+$/m.test(evidence) && !/Signature=adhoc/i.test(evidence);
    return stableAuthority
      ? { status: "pass", detail: `Running packaged Workstrand ${app.getVersion()} with a stable signing authority.` }
      : { status: "warning", detail: "This packaged app is ad-hoc signed. macOS may forget Accessibility and Screen Recording grants after a rebuild." };
  } catch {
    return { status: "warning", detail: "The packaged app's code-signing identity could not be verified. macOS permissions may not persist reliably." };
  }
}

async function listLocalModels(timeoutMs = 1_500): Promise<Array<{ name: string; size: number; modifiedAt?: string }>> {
  const response = await fetch(`${OLLAMA_ORIGIN}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Ollama returned ${response.status}.`);
  const payload = await response.json() as { models?: OllamaTag[] };
  return (payload.models ?? []).flatMap((item) => {
    if (typeof item.name !== "string" || !item.name.trim()) return [];
    return [{
      name: item.name,
      size: typeof item.size === "number" && Number.isFinite(item.size) ? Math.max(0, Math.floor(item.size)) : 0,
      ...(typeof item.modified_at === "string" ? { modifiedAt: item.modified_at } : {})
    }];
  });
}

async function pullLocalModel(model: string): Promise<{ name: string; size: number; modifiedAt?: string }> {
  const response = await fetch(`${OLLAMA_ORIGIN}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: false }),
    signal: AbortSignal.timeout(30 * 60_000)
  });
  if (!response.ok) throw new Error(`Ollama could not download ${model} (${response.status}).`);
  await response.text();
  const models = await listLocalModels(5_000);
  const downloaded = models.find((item) => item.name === model || item.name === `${model}:latest`);
  if (!downloaded) throw new Error(`${model} finished downloading but Ollama did not list it.`);
  return downloaded;
}

supervisor.on("runtime-event", (event) => mainWindow?.webContents.send("kestrel:runtime-event", event));
supervisor.on("agent-stream", (event) => mainWindow?.webContents.send("kestrel:agent-stream", event));
supervisor.on("background-jobs", (event: BackgroundJobsEvent) => {
  mainWindow?.webContents.send("kestrel:background-jobs", event);
  if (!Notification.isSupported()) return;
  for (const job of event.jobs) {
    const outcome = job.status === "waiting_approval" ? "Needs your approval" : job.status === "failed" ? "Background run failed" : "Background run finished";
    const body = job.status === "pending" ? `${job.title} ran successfully and will run again.` : job.error ?? job.title;
    const notification = new Notification({ title: `${PRODUCT_IDENTITY.productName} · ${outcome}`, body });
    notification.on("click", () => { mainWindow?.show(); mainWindow?.focus(); });
    notification.show();
  }
});
supervisor.on("automation-error", (error: Error) => {
  if (Notification.isSupported()) new Notification({ title: `${PRODUCT_IDENTITY.productName} · Automation error`, body: error.message }).show();
});

app.setName(PRODUCT_IDENTITY.productName);
app.setPath("userData", process.env.KESTREL_TEST_USER_DATA ?? join(app.getPath("appData"), PRODUCT_IDENTITY.userDataDirectoryName));

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 920,
    minHeight: 680,
    show: false,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#eceee7",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = "mediaTypes" in details && Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
    callback(webContents.id === window.webContents.id && permission === "media" && mediaTypes.includes("audio") && !mediaTypes.includes("video"));
  });
  window.webContents.on("will-navigate", (event, url) => {
    const current = window.webContents.getURL();
    if (url !== current && !url.startsWith("file://") && !url.startsWith("http://localhost")) event.preventDefault();
  });
  window.on("close", (event) => {
    if (!quitting && process.platform === "darwin") { event.preventDefault(); window.hide(); }
  });
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(__dirname, "../renderer/index.html"));
  window.once("ready-to-show", () => window.show());
  return window;
}

function trayIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><path fill="black" d="M3 2h3v6l5-6h4l-6 7 6 7h-4l-5-6v6H3z"/></svg>`;
  const icon = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
  icon.setTemplateImage(true);
  return icon;
}

function updateTray(): void {
  if (!tray) tray = new Tray(trayIcon());
  const paused = agentState === "paused";
  const label = agentState.replace("_", " ");
  tray.setToolTip(`${PRODUCT_IDENTITY.productName} · ${label}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${PRODUCT_IDENTITY.productName} · ${label}`, enabled: false },
    { type: "separator" },
    { label: `Open ${PRODUCT_IDENTITY.productName}`, click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: paused ? "Resume agent" : "Pause agent", click: async () => {
      const response = await supervisor.request({ type: "set-paused", paused: !paused });
      if (response.ok && response.snapshot) { agentState = response.snapshot.agentState; updateTray(); mainWindow?.webContents.send("kestrel:snapshot", response.snapshot); }
    } },
    { type: "separator" },
    { label: `Quit ${PRODUCT_IDENTITY.productName}`, click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on("click", () => { mainWindow?.show(); mainWindow?.focus(); });
}

async function initializeCore(): Promise<void> {
  const userData = app.getPath("userData");
  const broker = new CredentialBroker(userData);
  const key = await broker.getDatabaseKey();
  const secureEnvironment = await broker.providerEnvironment();
  const preferences = await readRuntimePreferences();
  const codexPath = detectedSubscriptionCli("codex");
  if (codexPath && preferences.subscriptions?.codex?.enabled && preferences.subscriptions.codex.path === codexPath) {
    secureEnvironment.KESTREL_ENABLE_CODEX_SUBSCRIPTION = "1";
    secureEnvironment.KESTREL_CODEX_PATH = codexPath;
  }
  const claudePath = detectedSubscriptionCli("claude");
  if (claudePath && preferences.subscriptions?.claude?.enabled && preferences.subscriptions.claude.path === claudePath) {
    secureEnvironment.KESTREL_ENABLE_CLAUDE_SUBSCRIPTION = "1";
    secureEnvironment.KESTREL_CLAUDE_PATH = claudePath;
  }
  try {
    await localRuntimeManager().startManagedIfInstalled();
    const localModels = await listLocalModels(700);
    if (localModels.length > 0) {
      secureEnvironment.KESTREL_ENABLE_OLLAMA = "1";
      secureEnvironment.KESTREL_OLLAMA_MODEL ??= localModels[0]!.name;
    }
  } catch {
    // A local model server is optional and must not delay or block startup.
  }
  const workspaceRoots = (await new WorkspaceGrantStore(join(userData, "workspace-grants.json")).list()).map((grant) => grant.path);
  const managedPluginRoot = join(userData, "plugins");
  const pluginRoots = [managedPluginRoot, join(app.getPath("home"), ".codex", "plugins", "cache", "camarade")];
  await supervisor.start({ databasePath: join(userData, "database", "kestrel.sqlite"), encryptionKeyBase64: key.toString("base64"), workspaceRoots, pluginRoots, managedPluginRoots: [managedPluginRoot], learnedSkillRoot: join(userData, "learned-skills"), secureEnvironment });
  const response = await supervisor.request({ type: "snapshot" });
  if (response.ok && response.snapshot) agentState = response.snapshot.agentState;
}

function pluginTrustStore(): PluginTrustStore {
  return new PluginTrustStore(join(app.getPath("userData"), "trusted-plugin-publishers.json"));
}

async function pluginInstaller(): Promise<PluginInstaller> {
  return new PluginInstaller({ managedRoot: join(app.getPath("userData"), "plugins"), trustKeys: await pluginTrustStore().trustKeys() });
}

async function pluginList() {
  const response = await supervisor.request({ type: "plugin-list" });
  if (!response.ok) throw new Error(response.error);
  return response.plugins ?? [];
}

async function restartCoreAfterPluginChange() {
  await supervisor.stop();
  await initializeCore();
  return pluginList();
}

async function selectPluginDirectory(title: string): Promise<string | undefined> {
  const options = { title, buttonLabel: "Select plugin", properties: ["openDirectory"] as Array<"openDirectory"> };
  const selection = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  return selection.canceled ? undefined : selection.filePaths[0];
}

function mediaTypeForPath(path: string): string {
  const extension = extname(path).toLowerCase();
  return ({
    ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".csv": "text/csv", ".ts": "text/typescript", ".tsx": "text/typescript",
    ".js": "application/javascript", ".jsx": "application/javascript", ".py": "text/x-python", ".html": "text/html", ".css": "text/css", ".xml": "application/xml",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".pdf": "application/pdf"
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}

async function restartCoreAfterGrantChange(): Promise<WorkspaceGrant[]> {
  await supervisor.stop();
  await initializeCore();
  const response = await supervisor.request({ type: "snapshot" });
  if (response.ok && response.snapshot) {
    agentState = response.snapshot.agentState;
    updateTray();
    mainWindow?.webContents.send("kestrel:snapshot", response.snapshot);
  }
  return new WorkspaceGrantStore(join(app.getPath("userData"), "workspace-grants.json")).list();
}

function registerIpc(): void {
  ipcMain.handle("kestrel:request", async (_event, raw) => {
    const request = RendererRequestSchema.parse(raw);
    if (request.type === "get-system-state") {
      const state = app.getLoginItemSettings();
      return { ok: true, launchAtLogin: state.openAtLogin, launchStatus: state.status ?? (state.openAtLogin ? "enabled" : "not-registered") };
    }
    if (request.type === "set-launch-at-login") {
      app.setLoginItemSettings({ openAtLogin: request.enabled, type: "mainAppService" });
      const state = app.getLoginItemSettings();
      return { ok: true, launchAtLogin: state.openAtLogin, launchStatus: state.status ?? (state.openAtLogin ? "enabled" : "not-registered") };
    }
    if (request.type === "request-microphone-access") {
      const microphoneAccess = process.platform === "darwin" ? await systemPreferences.askForMediaAccess("microphone") : true;
      return { ok: true, microphoneAccess };
    }
    if (request.type === "local-model-status") {
      const systemProfile = { platform: platform(), architecture: arch(), memoryBytes: totalmem(), logicalCpus: Math.max(1, cpus().length) };
      const localRuntime = await localRuntimeManager().status();
      return {
        ok: true,
        systemProfile,
        ollamaAvailable: localRuntime.ollamaAvailable,
        localModels: localRuntime.localModels,
        localRuntime
      };
    }
    if (request.type === "local-model-pull") {
      const downloadedModel = await pullLocalModel(request.model);
      await supervisor.stop();
      await initializeCore();
      return { ok: true, downloadedModel, localModels: await listLocalModels(5_000) };
    }
    if (request.type === "local-runtime-bootstrap") {
      const localRuntime = await localRuntimeManager().bootstrap(request.model);
      await supervisor.stop();
      await initializeCore();
      return { ok: true, localRuntime };
    }
    if (request.type === "local-runtime-cancel") {
      localRuntimeManager().cancel();
      return { ok: true };
    }
    if (request.type === "system-readiness") {
      const checks: Array<{ id: string; label: string; status: "pass" | "warning" | "fail"; detail: string }> = [];
      const coreState = await supervisor.request({ type: "snapshot" }).catch(() => undefined);
      const coreReady = Boolean(coreState?.ok && coreState.snapshot);
      checks.push({
        id: "core",
        label: "Local agent core",
        status: coreReady ? "pass" : "fail",
        detail: coreReady ? "The isolated agent process is responding." : "The agent core is unavailable. Restart Workstrand before starting live work."
      });
      const providerState = coreReady ? await supervisor.request({ type: "runtime-list-providers" }).catch(() => undefined) : undefined;
      const providers = providerState?.ok ? (providerState.providers ?? []).filter((provider) => provider.id !== "auto") : [];
      const modelReady = providers.length > 0;
      checks.push({
        id: "models",
        label: "Model route",
        status: modelReady ? "pass" : "fail",
        detail: modelReady ? `${providers.length} model route${providers.length === 1 ? " is" : "s are"} configured. Run the live check below before relying on it.` : "No cloud account or local Ollama model is configured."
      });
      const grants = await new WorkspaceGrantStore(join(app.getPath("userData"), "workspace-grants.json")).list();
      checks.push({
        id: "workspace",
        label: "Project access",
        status: grants.length > 0 ? "pass" : "warning",
        detail: grants.length > 0 ? `${grants.length} project folder${grants.length === 1 ? " is" : "s are"} explicitly granted.` : "No project folder is granted yet. Conversation-only tasks still work."
      });
      const microphone = process.platform === "darwin" ? systemPreferences.getMediaAccessStatus("microphone") : "granted";
      const screen = process.platform === "darwin" ? systemPreferences.getMediaAccessStatus("screen") : "granted";
      const accessibility = process.platform === "darwin" ? systemPreferences.isTrustedAccessibilityClient(false) : true;
      checks.push({
        id: "permissions",
        label: "macOS permissions",
        status: microphone === "granted" && screen === "granted" && accessibility ? "pass" : "warning",
        detail: `Microphone ${microphone}; screen recording ${screen}; Accessibility ${accessibility ? "granted" : "not granted"}. Workstrand asks only when a task needs them.`
      });
      const backupMetadataPath = join(app.getPath("userData"), "last-backup.json");
      let backupDetail = "No verified local backup has been recorded.";
      let backupStatus: "pass" | "warning" = "warning";
      try {
        const metadata = JSON.parse(await readFile(backupMetadataPath, "utf8")) as { path?: unknown; createdAt?: unknown };
        if (typeof metadata.path === "string" && typeof metadata.createdAt === "string" && existsSync(metadata.path)) {
          backupStatus = "pass";
          backupDetail = `Verified backup created ${new Date(metadata.createdAt).toLocaleString()}.`;
        }
      } catch {
        // A first-run system has no backup metadata.
      }
      checks.push({ id: "backup", label: "Recovery snapshot", status: backupStatus, detail: backupDetail });
      const distribution = await distributionReadiness();
      checks.push({
        id: "distribution",
        label: "Installed build",
        status: distribution.status,
        detail: distribution.detail
      });
      return { ok: true, systemReadiness: { checkedAt: new Date().toISOString(), readyForLiveWork: coreReady && modelReady, checks } };
    }
    if (request.type === "create-local-backup") {
      const options = { title: "Choose a folder for a verified Workstrand backup", buttonLabel: "Create backup", properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory"> };
      const selection = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
      if (selection.canceled || !selection.filePaths[0]) return { ok: true, cancelled: true };
      await supervisor.stop();
      let localBackup;
      try {
        localBackup = await createVerifiedLocalBackup(selection.filePaths[0]);
        await writeFile(join(app.getPath("userData"), "last-backup.json"), `${JSON.stringify(localBackup, null, 2)}\n`, { mode: 0o600 });
      } finally {
        await initializeCore();
      }
      return { ok: true, localBackup };
    }
    if (request.type === "reveal-local-backup") {
      if (!existsSync(request.path)) throw new Error("That backup is no longer available.");
      shell.showItemInFolder(request.path);
      return { ok: true };
    }
    if (request.type === "subscription-cli-status") return { ok: true, subscriptionClis: await subscriptionCliStatuses() };
    if (request.type === "subscription-cli-set") {
      const statuses = await subscriptionCliStatuses();
      const selected = statuses.find((status) => status.id === request.id);
      if (!selected?.path && request.enabled) throw new Error(`${request.id === "codex" ? "Codex" : "Claude Code"} CLI was not found in a trusted local installation path.`);
      const preferences = await readRuntimePreferences();
      const subscriptions = { ...(preferences.subscriptions ?? {}) };
      if (request.enabled && selected?.path) subscriptions[request.id] = { enabled: true, path: selected.path };
      else delete subscriptions[request.id];
      await writeRuntimePreferences({ ...preferences, subscriptions });
      await supervisor.stop();
      await initializeCore();
      return { ok: true, subscriptionClis: await subscriptionCliStatuses() };
    }
    const grantStore = new WorkspaceGrantStore(join(app.getPath("userData"), "workspace-grants.json"));
    if (request.type === "get-workspace-grants") return { ok: true, workspaceGrants: await grantStore.list() };
    if (request.type === "select-workspace-folder") {
      const options = {
        title: `Grant ${PRODUCT_IDENTITY.productName} a project folder`,
        buttonLabel: "Grant folder",
        properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">
      };
      const selection = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
      if (selection.canceled || !selection.filePaths[0]) return { ok: true, cancelled: true, workspaceGrants: await grantStore.list() };
      await grantStore.add(selection.filePaths[0]);
      return { ok: true, workspaceGrants: await restartCoreAfterGrantChange() };
    }
    if (request.type === "remove-workspace-folder") {
      await grantStore.remove(request.path);
      return { ok: true, workspaceGrants: await restartCoreAfterGrantChange() };
    }
    if (request.type === "select-context-files") {
      const workspaceRoot = realpathSync(request.workspaceRoot);
      const granted = (await grantStore.list()).some((grant) => {
        try { return realpathSync(grant.path) === workspaceRoot; } catch { return false; }
      });
      if (!granted) throw new Error("Choose a currently granted task workspace before adding files.");
      const options = { title: "Add files from this task workspace", buttonLabel: "Add context", defaultPath: workspaceRoot, properties: ["openFile", "multiSelections"] as Array<"openFile" | "multiSelections"> };
      const selection = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
      if (selection.canceled) return { ok: true, cancelled: true, selectedAttachments: [] };
      if (selection.filePaths.length > 8) throw new Error("Select at most 8 attachments per message.");
      const selectedAttachments = selection.filePaths.map((selectedPath) => {
        const path = realpathSync(selectedPath);
        if (path !== workspaceRoot && !path.startsWith(`${workspaceRoot}${sep}`)) throw new Error("Attachments must stay inside the selected task workspace.");
        const metadata = statSync(path);
        if (!metadata.isFile() || metadata.size > 10 * 1024 * 1024) throw new Error("Attachments must be regular files no larger than 10 MB.");
        return SelectedAttachmentSchema.parse({ path, name: basename(path), mediaType: mediaTypeForPath(path), size: metadata.size });
      });
      return { ok: true, selectedAttachments };
    }
    if (request.type === "credential-list") return { ok: true, credentials: await new CredentialBroker(app.getPath("userData")).listCredentials() };
    if (request.type === "credential-set") {
      const broker = new CredentialBroker(app.getPath("userData"));
      await broker.setCredential(request.credentialId, request.value);
      await supervisor.stop();
      await initializeCore();
      return { ok: true, credentials: await broker.listCredentials() };
    }
    if (request.type === "credential-remove") {
      const broker = new CredentialBroker(app.getPath("userData"));
      await broker.removeCredential(request.credentialId);
      await supervisor.stop();
      await initializeCore();
      return { ok: true, credentials: await broker.listCredentials() };
    }
    if (request.type === "plugin-get-publishers") return { ok: true, pluginPublishers: await pluginTrustStore().list() };
    if (request.type === "plugin-import-publisher") {
      const options = { title: "Trust a plugin publisher key", buttonLabel: "Trust publisher", properties: ["openFile"] as Array<"openFile">, filters: [{ name: "Publisher key", extensions: ["json"] }] };
      const selection = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
      if (selection.canceled || !selection.filePaths[0]) return { ok: true, cancelled: true, pluginPublishers: await pluginTrustStore().list() };
      await pluginTrustStore().importDocument(selection.filePaths[0]);
      return { ok: true, pluginPublishers: await pluginTrustStore().list() };
    }
    if (request.type === "plugin-remove-publisher") {
      const installer = await pluginInstaller();
      for (const plugin of (await pluginList()).filter((item) => item.managed)) {
        const installedRoot = join(app.getPath("userData"), "plugins", plugin.name);
        if (existsSync(installedRoot) && installer.inspect(installedRoot).keyId === request.keyId) throw new Error(`Remove ${plugin.name} before untrusting publisher ${request.keyId}.`);
      }
      await pluginTrustStore().remove(request.keyId);
      return { ok: true, pluginPublishers: await pluginTrustStore().list() };
    }
    if (request.type === "plugin-install-bundle") {
      const source = await selectPluginDirectory(`Install a signed ${PRODUCT_IDENTITY.productName} plugin`);
      if (!source) return { ok: true, cancelled: true, pluginPublishers: await pluginTrustStore().list() };
      const installer = await pluginInstaller();
      const bundle = installer.inspect(source);
      if ((await pluginList()).some((plugin) => plugin.name === bundle.name)) throw new Error(`Plugin ${bundle.name} is already discovered; use update for a managed plugin.`);
      const installed = installer.install(source);
      const plugins = await restartCoreAfterPluginChange();
      return { ok: true, pluginMutation: { action: "install", name: installed.name, version: installed.version }, plugins };
    }
    if (request.type === "plugin-update-bundle") {
      const source = await selectPluginDirectory(`Update a managed ${PRODUCT_IDENTITY.productName} plugin`);
      if (!source) return { ok: true, cancelled: true, pluginPublishers: await pluginTrustStore().list() };
      const installer = await pluginInstaller();
      const bundle = installer.inspect(source);
      if (!existsSync(join(app.getPath("userData"), "plugins", bundle.name))) throw new Error(`Managed plugin ${bundle.name} is not installed.`);
      await supervisor.stop();
      let updated;
      try { updated = installer.update(source); }
      finally { await initializeCore(); }
      return { ok: true, pluginMutation: { action: "update", name: updated.name, version: updated.version, ...(updated.replacedVersion ? { replacedVersion: updated.replacedVersion } : {}) }, plugins: await pluginList() };
    }
    if (request.type === "plugin-remove-installed") {
      const installer = await pluginInstaller();
      await supervisor.stop();
      let removed;
      try { removed = installer.remove(request.name); }
      finally { await initializeCore(); }
      return { ok: true, pluginMutation: { action: "remove", name: removed.name, version: removed.version, recoveryPath: removed.recoveryPath }, plugins: await pluginList() };
    }
    if (request.type === "plugin-restore-removed") {
      const installer = await pluginInstaller();
      await supervisor.stop();
      let restored;
      try { restored = installer.restore(request.recoveryPath); }
      finally { await initializeCore(); }
      return { ok: true, pluginMutation: { action: "restore", name: restored.name, version: restored.version }, plugins: await pluginList() };
    }
    if (request.type === "migration-select-plan") {
      const sourceOptions = { title: `Select ${request.product} data to import`, buttonLabel: "Select source", properties: ["openDirectory"] as Array<"openDirectory"> };
      const source = mainWindow ? await dialog.showOpenDialog(mainWindow, sourceOptions) : await dialog.showOpenDialog(sourceOptions);
      if (source.canceled || !source.filePaths[0]) return { ok: true, cancelled: true, migrationPlan: new MigrationManager().plan([], join(app.getPath("userData"), "migrations")) };
      const targetOptions = {
        title: `Select the destination for migrated ${PRODUCT_IDENTITY.productName} data`,
        buttonLabel: "Choose folder",
        defaultPath: join(app.getPath("userData"), "migrations"),
        properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">
      };
      const target = mainWindow ? await dialog.showOpenDialog(mainWindow, targetOptions) : await dialog.showOpenDialog(targetOptions);
      if (target.canceled || !target.filePaths[0]) return { ok: true, cancelled: true, migrationPlan: new MigrationManager().plan([], join(app.getPath("userData"), "migrations")) };
      return { ok: true, migrationPlan: new MigrationManager().plan([{ product: request.product, root: source.filePaths[0] }], target.filePaths[0]) };
    }
    if (request.type === "migration-apply-plan") return { ok: true, migrationResult: new MigrationManager().apply(request.plan, { approved: request.confirmation === "IMPORT", overwrite: request.overwrite }) };
    if (request.type === "reset-local-data") {
      if (request.confirmation !== PRODUCT_IDENTITY.productName) return { ok: false, error: `Type ${PRODUCT_IDENTITY.productName} to confirm reset.` };
      await supervisor.stop();
      await rm(app.getPath("userData"), { recursive: true, force: true });
      app.relaunch();
      quitting = true;
      app.quit();
      return { ok: true };
    }
    const coreRequest = CoreRequestSchema.parse(request);
    const response = await supervisor.request(coreRequest);
    if (response.ok && response.snapshot) { agentState = response.snapshot.agentState; updateTray(); }
    return response;
  });
}

app.on("second-instance", (_event, argv) => {
  mainWindow?.show();
  mainWindow?.focus();
  const deepLink = argv.find((value) => value.startsWith(`${PRODUCT_IDENTITY.protocol}://`));
  if (deepLink) mainWindow?.webContents.send("kestrel:deep-link", deepLink);
});

app.on("open-url", (event, url) => { event.preventDefault(); mainWindow?.webContents.send("kestrel:deep-link", url); });
app.on("before-quit", () => { quitting = true; });
app.on("will-quit", () => {
  void Promise.all([supervisor.stop(), managedLocalRuntime?.stop() ?? Promise.resolve()]);
});
app.on("activate", () => { if (!mainWindow) mainWindow = createMainWindow(); else mainWindow.show(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

void app.whenReady().then(async () => {
  app.setAsDefaultProtocolClient(PRODUCT_IDENTITY.protocol);
  registerIpc();
  await initializeCore();
  updateTray();
  const launchedAtLogin = app.getLoginItemSettings().wasOpenedAtLogin;
  mainWindow = createMainWindow();
  if (launchedAtLogin) mainWindow.once("ready-to-show", () => mainWindow?.hide());
  if (app.isPackaged) {
    autoUpdater.autoDownload = true;
    autoUpdater.channel = PRODUCT_IDENTITY.updateChannel;
    setTimeout(() => void autoUpdater.checkForUpdates().catch(() => undefined), 15000).unref();
  }
});
