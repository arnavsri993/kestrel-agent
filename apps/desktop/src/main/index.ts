import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { arch, cpus, platform, totalmem } from "node:os";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  shell,
  systemPreferences,
  Tray,
} from "electron";
import updater from "electron-updater";
import {
  CoreRequestSchema,
  PRODUCT_IDENTITY,
  RendererRequestSchema,
  SelectedAttachmentSchema,
  type AgentState,
  type BackgroundJobsEvent,
  type WorkspaceGrant,
} from "@kestrel/shared-types";
import { CoreSupervisor } from "./core-supervisor";
import { CredentialBroker } from "./credential-broker";
import { WorkspaceGrantStore } from "./workspace-grant-store";
import { MigrationManager, PluginInstaller, readBoundedResponseBytes } from "@kestrel/agent-core";
import { PluginTrustStore } from "./plugin-trust-store";
import { ElectronBrowserService } from "./electron-browser-service";
import { LocalRuntimeManager } from "./local-runtime-manager";
import { GoogleWorkspaceOAuthManager } from "./google-workspace-oauth";
import {
  ChatGptOAuthManager,
  type ChatGptOAuthStatus,
} from "./chatgpt-oauth";
import { ProviderAuthMonitor } from "./provider-auth-monitor";
import { ExternalSecretManager } from "./external-secret-manager";
import type { ResolvedExternalCredentials } from "./credential-broker";
import { readRuntimePreferencesFile, type RuntimePreferences } from "./runtime-preferences";
import { shouldCheckForUpdates, updaterFeedChannel } from "./update-channel";
import {
  isTrustedRendererFrame,
  isTrustedRendererUrl,
  protectRendererNavigation,
  trustedDevelopmentRendererUrl,
} from "./renderer-security";
import { DeepLinkQueue, deepLinksFromArgv } from "./deep-links";
import {
  PetOverlayRequestAccess,
  petOverlayActivityForRuntimeEvent,
} from "./pet-overlay-security";

let mainWindow: BrowserWindow | null = null;
let petOverlayWindow: BrowserWindow | null = null;
const petOverlaysReturning = new WeakSet<BrowserWindow>();
const petOverlayAccess = new WeakMap<
  BrowserWindow,
  PetOverlayRequestAccess
>();
const pendingDeepLinks = new DeepLinkQueue();
let mainRendererDeepLinkReady = false;
let tray: Tray | null = null;
let quitting = false;
let agentState: AgentState = "idle";
const browserService = new ElectronBrowserService();
const supervisor = new CoreSupervisor(
  (request, signal) => browserService.handle(request, signal),
  () => browserService.closeAll(),
);
const providerAuthMonitor = new ProviderAuthMonitor({
  request: (request) => supervisor.request(request),
  notify: ({ providerId, status, detail }) => {
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title:
        status === "failed"
          ? `${PRODUCT_IDENTITY.productName} · Account needs attention`
          : `${PRODUCT_IDENTITY.productName} · Account recovered`,
      body: `${providerId}: ${detail}`,
    });
    notification.on("click", () => {
      mainWindow?.show();
      mainWindow?.focus();
    });
    notification.show();
  },
});
const { autoUpdater } = updater;
const OLLAMA_ORIGIN = "http://127.0.0.1:11434";
const RENDERER_ENTRY_PATH = join(__dirname, "../renderer/index.html");
const RAW_DEVELOPMENT_RENDERER_URL = process.env.ELECTRON_RENDERER_URL;
const DEVELOPMENT_RENDERER_URL = trustedDevelopmentRendererUrl(
  RAW_DEVELOPMENT_RENDERER_URL,
);
const execFileAsync = promisify(execFile);
let managedLocalRuntime: LocalRuntimeManager | null = null;
let appCredentialBroker: CredentialBroker | null = null;
let googleOAuthController: AbortController | null = null;
let chatGptOAuthController: AbortController | null = null;
let activeChatGptOAuthManager: ChatGptOAuthManager | null = null;

function trustedRendererUrl(value: string): boolean {
  return isTrustedRendererUrl(
    value,
    RENDERER_ENTRY_PATH,
    DEVELOPMENT_RENDERER_URL,
  );
}

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

function runtimePreferencesPath(): string {
  return join(app.getPath("userData"), "runtime-preferences.json");
}

function localRuntimeManager(): LocalRuntimeManager {
  managedLocalRuntime ??= new LocalRuntimeManager(
    app.getPath("userData"),
    (progress) => {
      mainWindow?.webContents.send("kestrel:local-runtime-progress", progress);
    },
  );
  return managedLocalRuntime;
}

function credentialBroker(): CredentialBroker {
  appCredentialBroker ??= new CredentialBroker(app.getPath("userData"));
  return appCredentialBroker;
}

function googleWorkspaceOAuthManager(): GoogleWorkspaceOAuthManager {
  return new GoogleWorkspaceOAuthManager({
    broker: credentialBroker(),
    openExternal: (url) => shell.openExternal(url),
  });
}

async function readRuntimePreferences(): Promise<RuntimePreferences> {
  return readRuntimePreferencesFile(runtimePreferencesPath());
}

async function writeRuntimePreferences(
  preferences: RuntimePreferences,
): Promise<void> {
  const path = runtimePreferencesPath();
  const temporary = `${path}.new`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(preferences, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

function detectedSubscriptionCli(id: SubscriptionCliId): string | undefined {
  if (process.env.KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY === "1")
    return undefined;
  const home = app.getPath("home");
  const configured =
    id === "codex"
      ? process.env.KESTREL_CODEX_PATH
      : process.env.KESTREL_CLAUDE_PATH;
  const candidates =
    id === "codex"
      ? [
          configured,
          "/Applications/ChatGPT.app/Contents/Resources/codex",
          "/opt/homebrew/bin/codex",
          "/usr/local/bin/codex",
          join(home, ".local", "bin", "codex"),
          join(home, ".npm-global", "bin", "codex"),
        ]
      : [
          configured,
          "/opt/homebrew/bin/claude",
          "/usr/local/bin/claude",
          join(home, ".local", "bin", "claude"),
          join(home, ".npm-global", "bin", "claude"),
        ];
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    try {
      const metadata = statSync(candidate);
      if (metadata.isFile() && (metadata.mode & 0o111) !== 0)
        return realpathSync(candidate);
    } catch {
      // Continue through bounded known locations.
    }
  }
  return undefined;
}

async function subscriptionCliStatuses() {
  const preferences = await readRuntimePreferences();
  const statuses = await Promise.all((["codex", "claude"] as const).map(async (id) => {
    const path = detectedSubscriptionCli(id);
    const enabled = Boolean(
      path &&
        preferences.subscriptions?.[id]?.enabled &&
        preferences.subscriptions[id]?.path === path,
    );
    const label =
      id === "codex"
        ? "ChatGPT plan through Codex"
        : "Claude plan through Claude Code";
    const chatGptStatus =
      id === "codex" && path
        ? await new ChatGptOAuthManager({
            executable: path,
            openExternal: (url) => shell.openExternal(url),
          })
            .status()
            .catch((): ChatGptOAuthStatus => ({ connected: false }))
        : undefined;
    const chatGptAccount =
      chatGptStatus?.connected === true ? chatGptStatus : undefined;
    return {
      id,
      label,
      detected: Boolean(path),
      enabled,
      ...(path ? { path } : {}),
      ...(chatGptStatus
        ? {
            authenticated: chatGptStatus.connected,
            ...(chatGptAccount?.accountType
              ? { accountType: chatGptAccount.accountType }
              : {}),
            ...(chatGptAccount?.email ? { email: chatGptAccount.email } : {}),
            ...(chatGptAccount?.planType
              ? { planType: chatGptAccount.planType }
              : {}),
          }
        : {}),
      detail: enabled
        ? id === "codex"
          ? chatGptStatus?.connected
            ? `Enabled with ChatGPT${chatGptAccount?.email ? ` as ${chatGptAccount.email}` : ""}${chatGptAccount?.planType ? ` · ${chatGptAccount.planType} plan` : ""}. Codex owns and refreshes the OAuth session.`
            : "Enabled, but Codex is not signed in with ChatGPT. Connect ChatGPT before running this route."
          : "Enabled. Authentication remains in the vendor CLI and is checked without copying tokens."
        : path
          ? id === "codex"
            ? chatGptStatus?.connected
              ? `ChatGPT connected${chatGptAccount?.email ? ` as ${chatGptAccount.email}` : ""}${chatGptAccount?.planType ? ` · ${chatGptAccount.planType} plan` : ""}. Enable the persistent read-only Codex route when ready.`
              : chatGptStatus && "accountType" in chatGptStatus && chatGptStatus.accountType === "apiKey"
                ? "Codex is using an API key. Sign in with ChatGPT to use plan access instead."
                : "Codex found. Sign in with ChatGPT through the official browser OAuth flow."
            : "CLI found. Enable it to use the vendor's existing on-device sign-in for text-only tasks."
          : `Install and sign in to the official ${id === "codex" ? "Codex" : "Claude Code"} CLI to make this route available.`,
    };
  }));
  return statuses;
}

async function fileDigest(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function copyBackupEntry(
  sourceRoot: string,
  source: string,
  destinationRoot: string,
  files: BackupManifestFile[],
): Promise<void> {
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink()) return;
  const relativePath = relative(sourceRoot, source);
  const destination = join(destinationRoot, relativePath);
  if (metadata.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(source))
      await copyBackupEntry(
        sourceRoot,
        join(source, entry),
        destinationRoot,
        files,
      );
    return;
  }
  if (!metadata.isFile()) return;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination);
  files.push({
    path: relativePath,
    bytes: metadata.size,
    sha256: await fileDigest(destination),
  });
}

async function createVerifiedLocalBackup(
  destinationParent: string,
): Promise<{
  path: string;
  createdAt: string;
  files: number;
  bytes: number;
  verified: boolean;
}> {
  const sourceRoot = realpathSync(app.getPath("userData"));
  const parent = realpathSync(destinationParent);
  if (parent === sourceRoot || parent.startsWith(`${sourceRoot}${sep}`))
    throw new Error(
      "Choose a backup folder outside Kestrel's application data.",
    );
  const createdAt = new Date().toISOString();
  const timestamp = createdAt.replaceAll(":", "-");
  const suffix = randomUUID().slice(0, 8);
  const finalPath = join(parent, `Kestrel-backup-${timestamp}-${suffix}`);
  const stagingPath = `${finalPath}.partial`;
  const files: BackupManifestFile[] = [];
  const entries = [
    "database",
    "secure",
    "runtime-preferences.json",
    "workspace-grants.json",
    "trusted-plugin-publishers.json",
    "plugins",
    "learned-skills",
    "migrations",
    "browser-downloads",
  ];
  await mkdir(stagingPath, { recursive: false, mode: 0o700 });
  try {
    for (const entry of entries) {
      const source = join(sourceRoot, entry);
      if (existsSync(source))
        await copyBackupEntry(sourceRoot, source, stagingPath, files);
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    const manifest = {
      format: "workstrand-local-backup",
      version: 1,
      appVersion: app.getVersion(),
      createdAt,
      files,
    };
    await writeFile(
      join(stagingPath, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    const verified = (
      await Promise.all(
        files.map(async (file) => {
          const path = join(stagingPath, file.path);
          const metadata = await lstat(path);
          return (
            metadata.isFile() &&
            metadata.size === file.bytes &&
            (await fileDigest(path)) === file.sha256
          );
        }),
      )
    ).every(Boolean);
    if (!verified)
      throw new Error(
        "Backup verification failed; the incomplete backup was removed.",
      );
    await rename(stagingPath, finalPath);
    return {
      path: finalPath,
      createdAt,
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      verified,
    };
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true });
    throw error;
  }
}

async function distributionReadiness(): Promise<{
  status: "pass" | "warning";
  detail: string;
}> {
  if (!app.isPackaged)
    return {
      status: "warning",
      detail:
        "Running the development build. Use a consistently signed packaged app for stable daily permissions.",
    };
  if (process.platform !== "darwin")
    return {
      status: "pass",
      detail: `Running packaged Kestrel ${app.getVersion()}.`,
    };
  try {
    const bundlePath = realpathSync(
      join(dirname(process.execPath), "..", ".."),
    );
    const result = await execFileAsync(
      "/usr/bin/codesign",
      ["--display", "--verbose=2", bundlePath],
      { timeout: 4_000 },
    );
    const evidence = `${result.stdout}\n${result.stderr}`;
    const stableAuthority =
      /^Authority=.+$/m.test(evidence) && !/Signature=adhoc/i.test(evidence);
    return stableAuthority
      ? {
          status: "pass",
          detail: `Running packaged Kestrel ${app.getVersion()} with a stable signing authority.`,
        }
      : {
          status: "warning",
          detail:
            "This packaged app is ad-hoc signed. macOS may forget Accessibility and Screen Recording grants after a rebuild.",
        };
  } catch {
    return {
      status: "warning",
      detail:
        "The packaged app's code-signing identity could not be verified. macOS permissions may not persist reliably.",
    };
  }
}

async function listLocalModels(
  timeoutMs = 1_500,
): Promise<Array<{ name: string; size: number; modifiedAt?: string }>> {
  if (process.env.KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY === "1") return [];
  const response = await fetch(`${OLLAMA_ORIGIN}/api/tags`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Ollama returned ${response.status}.`);
  const bytes = await readBoundedResponseBytes(response, 1_000_000, "Ollama model list response exceeds 1 MB.");
  const payload = JSON.parse(new TextDecoder().decode(bytes)) as { models?: OllamaTag[] };
  return (payload.models ?? []).flatMap((item) => {
    if (typeof item.name !== "string" || !item.name.trim()) return [];
    return [
      {
        name: item.name,
        size:
          typeof item.size === "number" && Number.isFinite(item.size)
            ? Math.max(0, Math.floor(item.size))
            : 0,
        ...(typeof item.modified_at === "string"
          ? { modifiedAt: item.modified_at }
          : {}),
      },
    ];
  });
}

async function pullLocalModel(
  model: string,
): Promise<{ name: string; size: number; modifiedAt?: string }> {
  const response = await fetch(`${OLLAMA_ORIGIN}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: false }),
    signal: AbortSignal.timeout(30 * 60_000),
  });
  if (!response.ok)
    throw new Error(`Ollama could not download ${model} (${response.status}).`);
  await readBoundedResponseBytes(response, 1_000_000, "Ollama model pull response exceeds 1 MB.");
  const models = await listLocalModels(5_000);
  const downloaded = models.find(
    (item) => item.name === model || item.name === `${model}:latest`,
  );
  if (!downloaded)
    throw new Error(
      `${model} finished downloading but Ollama did not list it.`,
    );
  return downloaded;
}

supervisor.on("runtime-event", (event) => {
  const main = mainWindow;
  if (
    main &&
    !main.isDestroyed() &&
    trustedRendererUrl(main.webContents.getURL())
  )
    main.webContents.send("kestrel:runtime-event", event);
  const overlay = petOverlayWindow;
  const overlayAccess = overlay ? petOverlayAccess.get(overlay) : undefined;
  const activity = overlayAccess
    ? petOverlayActivityForRuntimeEvent(overlayAccess, event)
    : undefined;
  if (
    activity &&
    overlay &&
    !overlay.isDestroyed() &&
    trustedRendererUrl(overlay.webContents.getURL())
  )
    overlay.webContents.send("kestrel:pet-activity", activity);
});
supervisor.on("agent-stream", (event) => {
  const main = mainWindow;
  if (
    main &&
    !main.isDestroyed() &&
    trustedRendererUrl(main.webContents.getURL())
  )
    main.webContents.send("kestrel:agent-stream", event);
});
supervisor.on("background-jobs", (event: BackgroundJobsEvent) => {
  mainWindow?.webContents.send("kestrel:background-jobs", event);
  if (!Notification.isSupported()) return;
  for (const job of event.jobs) {
    const outcome =
      job.status === "waiting_approval"
        ? "Needs your approval"
        : job.status === "failed"
          ? "Background run failed"
          : "Background run finished";
    const body =
      job.status === "pending"
        ? `${job.title} ran successfully and will run again.`
        : (job.error ?? job.title);
    const notification = new Notification({
      title: `${PRODUCT_IDENTITY.productName} · ${outcome}`,
      body,
    });
    notification.on("click", () => {
      mainWindow?.show();
      mainWindow?.focus();
    });
    notification.show();
  }
});
supervisor.on("automation-error", (error: Error) => {
  if (Notification.isSupported())
    new Notification({
      title: `${PRODUCT_IDENTITY.productName} · Automation error`,
      body: error.message,
    }).show();
});
supervisor.on(
  "crash",
  (event: {
    restarts: number;
    recovering: boolean;
    delayMs?: number;
  }) => {
    if (
      !event.recovering ||
      event.restarts !== 1 ||
      !Notification.isSupported()
    )
      return;
    const notification = new Notification({
      title: `${PRODUCT_IDENTITY.productName} · Agent Core restarting`,
      body: "Local agent work was interrupted. Kestrel is recovering it automatically.",
    });
    notification.on("click", showMainWindow);
    notification.show();
  },
);
supervisor.on("recovered", () => {
  void supervisor
    .request({ type: "snapshot" })
    .then((response) => {
      if (!response.ok || !response.snapshot) return;
      agentState = response.snapshot.agentState;
      updateTray();
      mainWindow?.webContents.send("kestrel:snapshot", response.snapshot);
    })
    .catch(() => undefined);
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: `${PRODUCT_IDENTITY.productName} · Agent Core recovered`,
    body: "Local agent work is available again.",
  });
  notification.on("click", showMainWindow);
  notification.show();
});
supervisor.on("recovery-failed", (error: Error) => {
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: `${PRODUCT_IDENTITY.productName} · Agent Core needs attention`,
    body: error.message,
  });
  notification.on("click", showMainWindow);
  notification.show();
});

// Keep the runtime name stable until a tested migration can move the existing
// safeStorage Keychain account and encrypted user data without orphaning them.
app.setName(PRODUCT_IDENTITY.runtimeApplicationName);
app.setPath(
  "userData",
  process.env.KESTREL_TEST_USER_DATA ??
    join(app.getPath("appData"), PRODUCT_IDENTITY.userDataDirectoryName),
);

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

for (const deepLink of deepLinksFromArgv(process.argv))
  pendingDeepLinks.enqueue(deepLink);

function showMainWindow(): void {
  if (mainWindow?.isDestroyed()) {
    mainWindow = null;
    mainRendererDeepLinkReady = false;
  }
  if (!mainWindow && app.isReady()) mainWindow = createMainWindow();
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
}

function deliverPendingDeepLinks(): void {
  const window = mainWindow;
  if (
    !mainRendererDeepLinkReady ||
    !window ||
    window.isDestroyed() ||
    !trustedRendererUrl(window.webContents.getURL())
  )
    return;
  pendingDeepLinks.drain((deepLink) => {
    if (
      !mainRendererDeepLinkReady ||
      window.isDestroyed() ||
      window !== mainWindow ||
      !trustedRendererUrl(window.webContents.getURL())
    )
      throw new Error("The main renderer is not ready for deep links.");
    window.webContents.send("kestrel:deep-link", deepLink);
  });
}

function queueDeepLink(value: unknown): boolean {
  if (!pendingDeepLinks.enqueue(value)) return false;
  showMainWindow();
  deliverPendingDeepLinks();
  return true;
}

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
      devTools: !app.isPackaged,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.session.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const mediaTypes =
        "mediaTypes" in details && Array.isArray(details.mediaTypes)
          ? details.mediaTypes
          : [];
      callback(
        webContents.id === window.webContents.id &&
          permission === "media" &&
          mediaTypes.includes("audio") &&
          !mediaTypes.includes("video"),
      );
    },
  );
  protectRendererNavigation(window.webContents, trustedRendererUrl);
  window.webContents.on(
    "did-start-navigation",
    (_event, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame && mainWindow === window)
        mainRendererDeepLinkReady = false;
    },
  );
  window.on("close", (event) => {
    if (!quitting && process.platform === "darwin") {
      event.preventDefault();
      window.hide();
    }
  });
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
      mainRendererDeepLinkReady = false;
    }
  });
  if (DEVELOPMENT_RENDERER_URL)
    void window.loadURL(DEVELOPMENT_RENDERER_URL);
  else void window.loadFile(RENDERER_ENTRY_PATH);
  window.once("ready-to-show", () => window.show());
  return window;
}

async function petOverlayPosition(): Promise<{ x?: number; y?: number }> {
  const path = join(app.getPath("userData"), "pet-overlay-position.json");
  try {
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > 2_000
    )
      return {};
    const value = JSON.parse(await readFile(path, "utf8")) as {
      x?: unknown;
      y?: unknown;
    };
    return Number.isInteger(value.x) && Number.isInteger(value.y)
      ? { x: value.x as number, y: value.y as number }
      : {};
  } catch {
    return {};
  }
}

async function savePetOverlayPosition(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed()) return;
  const { x, y } = window.getBounds();
  const path = join(app.getPath("userData"), "pet-overlay-position.json");
  const temporary = `${path}.new`;
  await writeFile(temporary, `${JSON.stringify({ x, y })}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function releasePetOverlayAccess(window: BrowserWindow): void {
  const access = petOverlayAccess.get(window);
  if (!access) return;
  petOverlayAccess.delete(window);
  for (const streamId of access.drainStreamIds()) {
    void supervisor
      .request({ type: "runtime-cancel-stream", streamId })
      .catch(() => undefined);
  }
}

async function createPetOverlay(): Promise<BrowserWindow> {
  if (petOverlayWindow && !petOverlayWindow.isDestroyed()) {
    petOverlayWindow.showInactive();
    return petOverlayWindow;
  }
  const saved = await petOverlayPosition();
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = 236;
  const height = 278;
  const candidateX = saved.x ?? workArea.x + workArea.width - width - 28;
  const candidateY = saved.y ?? workArea.y + workArea.height - height - 28;
  const visible = screen
    .getAllDisplays()
    .some(
      (display) =>
        candidateX < display.workArea.x + display.workArea.width - 40 &&
        candidateX + width > display.workArea.x + 40 &&
        candidateY < display.workArea.y + display.workArea.height - 40 &&
        candidateY + height > display.workArea.y + 40,
    );
  const window = new BrowserWindow({
    width,
    height,
    x: visible ? candidateX : workArea.x + workArea.width - width - 28,
    y: visible ? candidateY : workArea.y + workArea.height - height - 28,
    minWidth: 180,
    minHeight: 220,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    resizable: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      partition: "kestrel-pet-overlay",
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });
  petOverlayWindow = window;
  petOverlayAccess.set(window, new PetOverlayRequestAccess());
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // The overlay must not replace the permission policy on Electron's shared
  // default session. Keep its renderer and permission state isolated.
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  protectRendererNavigation(window.webContents, trustedRendererUrl);
  let positionTimer: NodeJS.Timeout | undefined;
  window.on("moved", () => {
    if (positionTimer) clearTimeout(positionTimer);
    positionTimer = setTimeout(() => void savePetOverlayPosition(window), 150);
  });
  window.on("closed", () => {
    if (positionTimer) clearTimeout(positionTimer);
    releasePetOverlayAccess(window);
    if (petOverlayWindow === window) petOverlayWindow = null;
    if (!quitting && !petOverlaysReturning.has(window)) {
      void supervisor
        .request({ type: "pet-configure", poppedOut: false })
        .then(broadcastPetStatus)
        .catch(() => undefined);
    }
  });
  window.once("ready-to-show", () => window.showInactive());
  if (DEVELOPMENT_RENDERER_URL) {
    const url = new URL(DEVELOPMENT_RENDERER_URL);
    url.searchParams.set("petOverlay", "1");
    await window.loadURL(url.toString());
  } else
    await window.loadFile(RENDERER_ENTRY_PATH, {
      query: { petOverlay: "1" },
    });
  if (!window.isVisible()) window.showInactive();
  return window;
}

function trayIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><path fill="black" d="M3 2h3v6l5-6h4l-6 7 6 7h-4l-5-6v6H3z"/></svg>`;
  const icon = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
  );
  icon.setTemplateImage(true);
  return icon;
}

function updateTray(): void {
  if (!tray) tray = new Tray(trayIcon());
  const paused = agentState === "paused";
  const label = agentState.replace("_", " ");
  tray.setToolTip(`${PRODUCT_IDENTITY.productName} · ${label}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `${PRODUCT_IDENTITY.productName} · ${label}`, enabled: false },
      { type: "separator" },
      {
        label: `Open ${PRODUCT_IDENTITY.productName}`,
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
        },
      },
      {
        label: paused ? "Resume agent" : "Pause agent",
        click: async () => {
          const response = await supervisor.request({
            type: "set-paused",
            paused: !paused,
          });
          if (response.ok && response.snapshot) {
            agentState = response.snapshot.agentState;
            updateTray();
            mainWindow?.webContents.send("kestrel:snapshot", response.snapshot);
          }
        },
      },
      { type: "separator" },
      {
        label: `Quit ${PRODUCT_IDENTITY.productName}`,
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

function broadcastPetStatus(
  response: Awaited<ReturnType<CoreSupervisor["request"]>>,
): void {
  if (!response.ok || !("petStatus" in response) || !response.petStatus) return;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed())
      window.webContents.send("kestrel:pet-status", response.petStatus);
  }
}

async function initializeCore(
  resolvedExternal?: ResolvedExternalCredentials,
): Promise<void> {
  const userData = app.getPath("userData");
  const broker = credentialBroker();
  const key = await broker.getDatabaseKey();
  const external =
    resolvedExternal ??
    (await new ExternalSecretManager(userData, broker)
      .resolveEnabled()
      .catch(() => ({ values: {}, overrideStoredIds: [] })));
  const secureEnvironment = await broker.providerEnvironment(
    process.env,
    external,
  );
  const preferences = await readRuntimePreferences();
  const codexPath = detectedSubscriptionCli("codex");
  if (
    codexPath &&
    preferences.subscriptions?.codex?.enabled &&
    preferences.subscriptions.codex.path === codexPath
  ) {
    secureEnvironment.KESTREL_ENABLE_CODEX_SUBSCRIPTION = "1";
    secureEnvironment.KESTREL_CODEX_PATH = codexPath;
  }
  const claudePath = detectedSubscriptionCli("claude");
  if (
    claudePath &&
    preferences.subscriptions?.claude?.enabled &&
    preferences.subscriptions.claude.path === claudePath
  ) {
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
  const workspaceGrantStore = new WorkspaceGrantStore(
    join(userData, "workspace-grants.json"),
  );
  const configuredWorkspaceRoots =
    await workspaceGrantStore.configuredPaths();
  const workspaceRoots = (await workspaceGrantStore.list()).map(
    (grant) => grant.path,
  );
  const managedPluginRoot = join(userData, "plugins");
  const pluginRoots = [
    managedPluginRoot,
    join(app.getPath("home"), ".codex", "plugins", "cache", "camarade"),
  ];
  await supervisor.start({
    databasePath: join(userData, "database", "kestrel.sqlite"),
    encryptionKeyBase64: key.toString("base64"),
    workspaceRoots,
    configuredWorkspaceRoots,
    pluginRoots,
    managedPluginRoots: [managedPluginRoot],
    learnedSkillRoot: join(userData, "learned-skills"),
    secureEnvironment,
  });
  const response = await supervisor.request({ type: "snapshot" });
  if (response.ok && response.snapshot)
    agentState = response.snapshot.agentState;
}

function pluginTrustStore(): PluginTrustStore {
  return new PluginTrustStore(
    join(app.getPath("userData"), "trusted-plugin-publishers.json"),
  );
}

async function pluginInstaller(): Promise<PluginInstaller> {
  return new PluginInstaller({
    managedRoot: join(app.getPath("userData"), "plugins"),
    trustKeys: await pluginTrustStore().trustKeys(),
  });
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

async function selectPluginDirectory(
  title: string,
): Promise<string | undefined> {
  const options = {
    title,
    buttonLabel: "Select plugin",
    properties: ["openDirectory"] as Array<"openDirectory">,
  };
  const selection = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  return selection.canceled ? undefined : selection.filePaths[0];
}

function mediaTypeForPath(path: string): string {
  const extension = extname(path).toLowerCase();
  return (
    (
      {
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".json": "application/json",
        ".csv": "text/csv",
        ".ts": "text/typescript",
        ".tsx": "text/typescript",
        ".js": "application/javascript",
        ".jsx": "application/javascript",
        ".py": "text/x-python",
        ".html": "text/html",
        ".css": "text/css",
        ".xml": "application/xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".m4a": "audio/mp4",
        ".mp4": "video/mp4",
        ".mov": "video/quicktime",
        ".webm": "video/webm",
        ".pdf": "application/pdf",
      } as Record<string, string>
    )[extension] ?? "application/octet-stream"
  );
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
  return new WorkspaceGrantStore(
    join(app.getPath("userData"), "workspace-grants.json"),
  ).statusList();
}

function registerIpc(): void {
  const setDeepLinkReadiness = (
    event: Electron.IpcMainEvent,
    ready: boolean,
  ) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (
      !senderWindow ||
      senderWindow !== mainWindow ||
      !isTrustedRendererFrame(
        event.senderFrame,
        event.sender.mainFrame,
        trustedRendererUrl,
      )
    )
      return;
    mainRendererDeepLinkReady = ready;
    if (ready) deliverPendingDeepLinks();
  };
  ipcMain.on("kestrel:deep-link-ready", (event) =>
    setDeepLinkReadiness(event, true),
  );
  ipcMain.on("kestrel:deep-link-not-ready", (event) =>
    setDeepLinkReadiness(event, false),
  );

  ipcMain.handle("kestrel:request", async (event, raw) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (
      !senderWindow ||
      (senderWindow !== mainWindow && senderWindow !== petOverlayWindow) ||
      !isTrustedRendererFrame(
        event.senderFrame,
        event.sender.mainFrame,
        trustedRendererUrl,
      )
    )
      throw new Error("Kestrel rejected a request from an untrusted renderer.");
    const request = RendererRequestSchema.parse(raw);
    const overlayAccess =
      senderWindow === petOverlayWindow
        ? petOverlayAccess.get(senderWindow)
        : undefined;
    if (senderWindow === petOverlayWindow) {
      if (!overlayAccess)
        throw new Error("Kestrel rejected a stale pet overlay request.");
      overlayAccess.assertAllowed(request);
    }
    if (request.type === "get-system-state") {
      const state = app.getLoginItemSettings();
      return {
        ok: true,
        launchAtLogin: state.openAtLogin,
        launchStatus:
          state.status ?? (state.openAtLogin ? "enabled" : "not-registered"),
      };
    }
    if (request.type === "set-launch-at-login") {
      app.setLoginItemSettings({
        openAtLogin: request.enabled,
        type: "mainAppService",
      });
      const state = app.getLoginItemSettings();
      return {
        ok: true,
        launchAtLogin: state.openAtLogin,
        launchStatus:
          state.status ?? (state.openAtLogin ? "enabled" : "not-registered"),
      };
    }
    if (request.type === "request-microphone-access") {
      const microphoneAccess =
        process.platform === "darwin"
          ? await systemPreferences.askForMediaAccess("microphone")
          : true;
      return { ok: true, microphoneAccess };
    }
    if (request.type === "local-model-status") {
      const systemProfile = {
        platform: platform(),
        architecture: arch(),
        memoryBytes: totalmem(),
        logicalCpus: Math.max(1, cpus().length),
      };
      const localRuntime = await localRuntimeManager().status();
      return {
        ok: true,
        systemProfile,
        ollamaAvailable: localRuntime.ollamaAvailable,
        localModels: localRuntime.localModels,
        localRuntime,
      };
    }
    if (request.type === "local-model-pull") {
      const downloadedModel = await pullLocalModel(request.model);
      await supervisor.stop();
      await initializeCore();
      return {
        ok: true,
        downloadedModel,
        localModels: await listLocalModels(5_000),
      };
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
      const checks: Array<{
        id: string;
        label: string;
        status: "pass" | "warning" | "fail";
        detail: string;
      }> = [];
      const coreState = await supervisor
        .request({ type: "snapshot" })
        .catch(() => undefined);
      const coreReady = Boolean(coreState?.ok && coreState.snapshot);
      checks.push({
        id: "core",
        label: "Local agent core",
        status: coreReady ? "pass" : "fail",
        detail: coreReady
          ? "The isolated agent process is responding."
          : "The agent core is unavailable. Restart Kestrel before starting live work.",
      });
      const providerState = coreReady
        ? await supervisor
            .request({ type: "runtime-list-providers" })
            .catch(() => undefined)
        : undefined;
      const providers = providerState?.ok
        ? (providerState.providers ?? []).filter(
            (provider) => provider.id !== "auto",
          )
        : [];
      const modelReady = providers.length > 0;
      checks.push({
        id: "models",
        label: "Model route",
        status: modelReady ? "pass" : "fail",
        detail: modelReady
          ? `${providers.length} model route${providers.length === 1 ? " is" : "s are"} configured. Run the live check below before relying on it.`
          : "No cloud account or local Ollama model is configured.",
      });
      const grants = await new WorkspaceGrantStore(
        join(app.getPath("userData"), "workspace-grants.json"),
      ).list();
      checks.push({
        id: "workspace",
        label: "Project access",
        status: grants.length > 0 ? "pass" : "warning",
        detail:
          grants.length > 0
            ? `${grants.length} project folder${grants.length === 1 ? " is" : "s are"} explicitly granted.`
            : "No project folder is granted yet. Conversation-only tasks still work.",
      });
      const microphone =
        process.platform === "darwin"
          ? systemPreferences.getMediaAccessStatus("microphone")
          : "granted";
      const screen =
        process.platform === "darwin"
          ? systemPreferences.getMediaAccessStatus("screen")
          : "granted";
      const accessibility =
        process.platform === "darwin"
          ? systemPreferences.isTrustedAccessibilityClient(false)
          : true;
      checks.push({
        id: "permissions",
        label: "macOS permissions",
        status:
          microphone === "granted" && screen === "granted" && accessibility
            ? "pass"
            : "warning",
        detail: `Microphone ${microphone}; screen recording ${screen}; Accessibility ${accessibility ? "granted" : "not granted"}. Kestrel asks only when a task needs them.`,
      });
      const backupMetadataPath = join(
        app.getPath("userData"),
        "last-backup.json",
      );
      let backupDetail = "No verified local backup has been recorded.";
      let backupStatus: "pass" | "warning" = "warning";
      try {
        const metadata = JSON.parse(
          await readFile(backupMetadataPath, "utf8"),
        ) as { path?: unknown; createdAt?: unknown };
        if (
          typeof metadata.path === "string" &&
          typeof metadata.createdAt === "string" &&
          existsSync(metadata.path)
        ) {
          backupStatus = "pass";
          backupDetail = `Verified backup created ${new Date(metadata.createdAt).toLocaleString()}.`;
        }
      } catch {
        // A first-run system has no backup metadata.
      }
      checks.push({
        id: "backup",
        label: "Recovery snapshot",
        status: backupStatus,
        detail: backupDetail,
      });
      const distribution = await distributionReadiness();
      checks.push({
        id: "distribution",
        label: "Installed build",
        status: distribution.status,
        detail: distribution.detail,
      });
      return {
        ok: true,
        systemReadiness: {
          checkedAt: new Date().toISOString(),
          readyForLiveWork: coreReady && modelReady,
          checks,
        },
      };
    }
    if (request.type === "create-local-backup") {
      const options = {
        title: "Choose a folder for a verified Kestrel backup",
        buttonLabel: "Create backup",
        properties: ["openDirectory", "createDirectory"] as Array<
          "openDirectory" | "createDirectory"
        >,
      };
      const selection = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      if (selection.canceled || !selection.filePaths[0])
        return { ok: true, cancelled: true };
      await supervisor.stop();
      let localBackup;
      try {
        localBackup = await createVerifiedLocalBackup(selection.filePaths[0]);
        await writeFile(
          join(app.getPath("userData"), "last-backup.json"),
          `${JSON.stringify(localBackup, null, 2)}\n`,
          { mode: 0o600 },
        );
      } finally {
        await initializeCore();
      }
      return { ok: true, localBackup };
    }
    if (request.type === "reveal-local-backup") {
      if (!existsSync(request.path))
        throw new Error("That backup is no longer available.");
      shell.showItemInFolder(request.path);
      return { ok: true };
    }
    if (request.type === "subscription-cli-status")
      return { ok: true, subscriptionClis: await subscriptionCliStatuses() };
    if (request.type === "subscription-cli-set") {
      const statuses = await subscriptionCliStatuses();
      const selected = statuses.find((status) => status.id === request.id);
      if (!selected?.path && request.enabled)
        throw new Error(
          `${request.id === "codex" ? "Codex" : "Claude Code"} CLI was not found in a trusted local installation path.`,
        );
      const preferences = await readRuntimePreferences();
      const subscriptions = { ...(preferences.subscriptions ?? {}) };
      if (request.enabled && selected?.path)
        subscriptions[request.id] = { enabled: true, path: selected.path };
      else delete subscriptions[request.id];
      await writeRuntimePreferences({ ...preferences, subscriptions });
      await supervisor.stop();
      await initializeCore();
      return { ok: true, subscriptionClis: await subscriptionCliStatuses() };
    }
    if (request.type === "oauth-chatgpt-connect") {
      if (chatGptOAuthController)
        throw new Error("ChatGPT sign-in is already in progress.");
      const codexPath = detectedSubscriptionCli("codex");
      if (!codexPath)
        throw new Error(
          "Codex was not found in a trusted local installation path.",
        );
      const controller = new AbortController();
      const manager = new ChatGptOAuthManager({
        executable: codexPath,
        openExternal: (url) => shell.openExternal(url),
      });
      chatGptOAuthController = controller;
      activeChatGptOAuthManager = manager;
      await supervisor.stop();
      try {
        await manager.connect(controller.signal);
        const preferences = await readRuntimePreferences();
        await writeRuntimePreferences({
          ...preferences,
          subscriptions: {
            ...(preferences.subscriptions ?? {}),
            codex: { enabled: true, path: codexPath },
          },
        });
      } finally {
        if (chatGptOAuthController === controller)
          chatGptOAuthController = null;
        if (activeChatGptOAuthManager === manager)
          activeChatGptOAuthManager = null;
        await initializeCore();
      }
      return { ok: true, subscriptionClis: await subscriptionCliStatuses() };
    }
    if (request.type === "oauth-chatgpt-cancel") {
      chatGptOAuthController?.abort(
        new Error("ChatGPT sign-in was cancelled."),
      );
      await activeChatGptOAuthManager?.cancel();
      return { ok: true, subscriptionClis: await subscriptionCliStatuses() };
    }
    if (request.type === "oauth-google-status")
      return {
        ok: true,
        googleWorkspaceOAuth: await googleWorkspaceOAuthManager().status(),
      };
    if (request.type === "oauth-google-connect") {
      if (googleOAuthController)
        throw new Error("Google sign-in is already in progress.");
      const controller = new AbortController();
      googleOAuthController = controller;
      try {
        const googleWorkspaceOAuth =
          await googleWorkspaceOAuthManager().connect(
            request.clientId,
            controller.signal,
          );
        await supervisor.stop();
        await initializeCore();
        return { ok: true, googleWorkspaceOAuth };
      } finally {
        if (googleOAuthController === controller) googleOAuthController = null;
      }
    }
    if (request.type === "oauth-google-cancel") {
      googleOAuthController?.abort(new Error("Google sign-in was cancelled."));
      return {
        ok: true,
        googleWorkspaceOAuth: await googleWorkspaceOAuthManager().status(),
      };
    }
    if (request.type === "oauth-google-disconnect") {
      googleOAuthController?.abort(new Error("Google sign-in was cancelled."));
      const googleWorkspaceOAuth =
        await googleWorkspaceOAuthManager().disconnect();
      await supervisor.stop();
      await initializeCore();
      return { ok: true, googleWorkspaceOAuth };
    }
    const grantStore = new WorkspaceGrantStore(
      join(app.getPath("userData"), "workspace-grants.json"),
    );
    if (request.type === "get-workspace-grants")
      return { ok: true, workspaceGrants: await grantStore.statusList() };
    if (request.type === "select-workspace-folder") {
      const options = {
        title: `Grant ${PRODUCT_IDENTITY.productName} a project folder`,
        buttonLabel: "Grant folder",
        properties: ["openDirectory", "createDirectory"] as Array<
          "openDirectory" | "createDirectory"
        >,
      };
      const selection = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      if (selection.canceled || !selection.filePaths[0])
        return {
          ok: true,
          cancelled: true,
          workspaceGrants: await grantStore.statusList(),
        };
      const selectedWorkspacePath = realpathSync(selection.filePaths[0]);
      await grantStore.add(selectedWorkspacePath);
      return {
        ok: true,
        selectedWorkspacePath,
        workspaceGrants: await restartCoreAfterGrantChange(),
      };
    }
    if (request.type === "remove-workspace-folder") {
      await grantStore.remove(request.path);
      return { ok: true, workspaceGrants: await restartCoreAfterGrantChange() };
    }
    if (request.type === "select-context-files") {
      const workspaceRoot = realpathSync(request.workspaceRoot);
      const granted = (await grantStore.list()).some((grant) => {
        try {
          return realpathSync(grant.path) === workspaceRoot;
        } catch {
          return false;
        }
      });
      if (!granted)
        throw new Error(
          "Choose a currently granted task workspace before adding files.",
        );
      const options = {
        title: "Add files from this task workspace",
        buttonLabel: "Add context",
        defaultPath: workspaceRoot,
        properties: ["openFile", "multiSelections"] as Array<
          "openFile" | "multiSelections"
        >,
      };
      const selection = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      if (selection.canceled)
        return { ok: true, cancelled: true, selectedAttachments: [] };
      if (selection.filePaths.length > 8)
        throw new Error("Select at most 8 attachments per message.");
      const selectedAttachments = selection.filePaths.map((selectedPath) => {
        const path = realpathSync(selectedPath);
        if (
          path !== workspaceRoot &&
          !path.startsWith(`${workspaceRoot}${sep}`)
        )
          throw new Error(
            "Attachments must stay inside the selected task workspace.",
          );
        const metadata = statSync(path);
        if (!metadata.isFile() || metadata.size > 10 * 1024 * 1024)
          throw new Error(
            "Attachments must be regular files no larger than 10 MB.",
          );
        return SelectedAttachmentSchema.parse({
          path,
          name: basename(path),
          mediaType: mediaTypeForPath(path),
          size: metadata.size,
        });
      });
      return { ok: true, selectedAttachments };
    }
    if (request.type === "credential-list")
      return {
        ok: true,
        credentials: await credentialBroker().listCredentials(),
      };
    if (request.type === "credential-set") {
      const broker = credentialBroker();
      await broker.setCredential(request.credentialId, request.value);
      await supervisor.stop();
      await initializeCore();
      return { ok: true, credentials: await broker.listCredentials() };
    }
    if (request.type === "credential-remove") {
      const broker = credentialBroker();
      await broker.removeCredential(request.credentialId);
      await supervisor.stop();
      await initializeCore();
      return { ok: true, credentials: await broker.listCredentials() };
    }
    if (request.type === "external-secret-list") {
      const manager = new ExternalSecretManager(
        app.getPath("userData"),
        credentialBroker(),
      );
      const state = await manager.status();
      return {
        ok: true,
        externalSecretSources: state.sources,
        externalSecretConfiguration: state.configuration,
      };
    }
    if (request.type === "external-secret-save") {
      const manager = new ExternalSecretManager(
        app.getPath("userData"),
        credentialBroker(),
      );
      await manager.save(request.configuration, {
        ...(request.onePasswordToken
          ? { onePasswordToken: request.onePasswordToken }
          : {}),
        ...(request.bitwardenToken
          ? { bitwardenToken: request.bitwardenToken }
          : {}),
      });
      const state = await manager.status();
      return {
        ok: true,
        externalSecretSources: state.sources,
        externalSecretConfiguration: state.configuration,
      };
    }
    if (request.type === "external-secret-sync") {
      const broker = credentialBroker();
      const manager = new ExternalSecretManager(
        app.getPath("userData"),
        broker,
      );
      const resolved = await manager.resolveEnabled();
      const state = await manager.status();
      const selected = state.sources.find(
        (source) => source.id === request.providerId,
      );
      if (!selected || selected.state !== "verified")
        throw new Error(
          selected?.detail ?? "The secret source could not be verified.",
        );
      await supervisor.stop();
      await initializeCore(resolved);
      return {
        ok: true,
        externalSecretSources: state.sources,
        externalSecretConfiguration: state.configuration,
      };
    }
    if (request.type === "external-secret-install-bitwarden") {
      const manager = new ExternalSecretManager(
        app.getPath("userData"),
        credentialBroker(),
      );
      const sources = await manager.installBitwarden();
      return {
        ok: true,
        externalSecretSources: sources,
        externalSecretConfiguration: await manager.configuration(),
      };
    }
    if (request.type === "external-secret-remove") {
      const manager = new ExternalSecretManager(
        app.getPath("userData"),
        credentialBroker(),
      );
      await manager.remove(request.providerId);
      await supervisor.stop();
      await initializeCore();
      const state = await manager.status();
      return {
        ok: true,
        externalSecretSources: state.sources,
        externalSecretConfiguration: state.configuration,
      };
    }
    if (request.type === "plugin-get-publishers")
      return { ok: true, pluginPublishers: await pluginTrustStore().list() };
    if (request.type === "plugin-import-publisher") {
      const options = {
        title: "Trust a plugin publisher key",
        buttonLabel: "Trust publisher",
        properties: ["openFile"] as Array<"openFile">,
        filters: [{ name: "Publisher key", extensions: ["json"] }],
      };
      const selection = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      if (selection.canceled || !selection.filePaths[0])
        return {
          ok: true,
          cancelled: true,
          pluginPublishers: await pluginTrustStore().list(),
        };
      await pluginTrustStore().importDocument(selection.filePaths[0]);
      return { ok: true, pluginPublishers: await pluginTrustStore().list() };
    }
    if (request.type === "plugin-remove-publisher") {
      const installer = await pluginInstaller();
      for (const plugin of (await pluginList()).filter(
        (item) => item.managed,
      )) {
        const installedRoot = join(
          app.getPath("userData"),
          "plugins",
          plugin.name,
        );
        if (
          existsSync(installedRoot) &&
          installer.inspect(installedRoot).keyId === request.keyId
        )
          throw new Error(
            `Remove ${plugin.name} before untrusting publisher ${request.keyId}.`,
          );
      }
      await pluginTrustStore().remove(request.keyId);
      return { ok: true, pluginPublishers: await pluginTrustStore().list() };
    }
    if (request.type === "plugin-install-bundle") {
      const source = await selectPluginDirectory(
        `Install a signed ${PRODUCT_IDENTITY.productName} plugin`,
      );
      if (!source)
        return {
          ok: true,
          cancelled: true,
          pluginPublishers: await pluginTrustStore().list(),
        };
      const installer = await pluginInstaller();
      const bundle = installer.inspect(source);
      if ((await pluginList()).some((plugin) => plugin.name === bundle.name))
        throw new Error(
          `Plugin ${bundle.name} is already discovered; use update for a managed plugin.`,
        );
      const installed = installer.install(source);
      const plugins = await restartCoreAfterPluginChange();
      return {
        ok: true,
        pluginMutation: {
          action: "install",
          name: installed.name,
          version: installed.version,
        },
        plugins,
      };
    }
    if (request.type === "plugin-update-bundle") {
      const source = await selectPluginDirectory(
        `Update a managed ${PRODUCT_IDENTITY.productName} plugin`,
      );
      if (!source)
        return {
          ok: true,
          cancelled: true,
          pluginPublishers: await pluginTrustStore().list(),
        };
      const installer = await pluginInstaller();
      const bundle = installer.inspect(source);
      if (!existsSync(join(app.getPath("userData"), "plugins", bundle.name)))
        throw new Error(`Managed plugin ${bundle.name} is not installed.`);
      await supervisor.stop();
      let updated;
      try {
        updated = installer.update(source);
      } finally {
        await initializeCore();
      }
      return {
        ok: true,
        pluginMutation: {
          action: "update",
          name: updated.name,
          version: updated.version,
          ...(updated.replacedVersion
            ? { replacedVersion: updated.replacedVersion }
            : {}),
        },
        plugins: await pluginList(),
      };
    }
    if (request.type === "plugin-remove-installed") {
      const installer = await pluginInstaller();
      await supervisor.stop();
      let removed;
      try {
        removed = installer.remove(request.name);
      } finally {
        await initializeCore();
      }
      return {
        ok: true,
        pluginMutation: {
          action: "remove",
          name: removed.name,
          version: removed.version,
          recoveryPath: removed.recoveryPath,
        },
        plugins: await pluginList(),
      };
    }
    if (request.type === "plugin-restore-removed") {
      const installer = await pluginInstaller();
      await supervisor.stop();
      let restored;
      try {
        restored = installer.restore(request.recoveryPath);
      } finally {
        await initializeCore();
      }
      return {
        ok: true,
        pluginMutation: {
          action: "restore",
          name: restored.name,
          version: restored.version,
        },
        plugins: await pluginList(),
      };
    }
    if (request.type === "migration-select-plan") {
      const sourceOptions = {
        title: `Select ${request.product} data to import`,
        buttonLabel: "Select source",
        properties: ["openDirectory"] as Array<"openDirectory">,
      };
      const source = mainWindow
        ? await dialog.showOpenDialog(mainWindow, sourceOptions)
        : await dialog.showOpenDialog(sourceOptions);
      if (source.canceled || !source.filePaths[0])
        return {
          ok: true,
          cancelled: true,
          migrationPlan: new MigrationManager().plan(
            [],
            join(app.getPath("userData"), "migrations"),
          ),
        };
      const targetOptions = {
        title: `Select the destination for migrated ${PRODUCT_IDENTITY.productName} data`,
        buttonLabel: "Choose folder",
        defaultPath: join(app.getPath("userData"), "migrations"),
        properties: ["openDirectory", "createDirectory"] as Array<
          "openDirectory" | "createDirectory"
        >,
      };
      const target = mainWindow
        ? await dialog.showOpenDialog(mainWindow, targetOptions)
        : await dialog.showOpenDialog(targetOptions);
      if (target.canceled || !target.filePaths[0])
        return {
          ok: true,
          cancelled: true,
          migrationPlan: new MigrationManager().plan(
            [],
            join(app.getPath("userData"), "migrations"),
          ),
        };
      return {
        ok: true,
        migrationPlan: new MigrationManager().plan(
          [{ product: request.product, root: source.filePaths[0] }],
          target.filePaths[0],
        ),
      };
    }
    if (request.type === "migration-apply-plan")
      return {
        ok: true,
        migrationResult: new MigrationManager().apply(request.plan, {
          approved: request.confirmation === "IMPORT",
          overwrite: request.overwrite,
        }),
      };
    if (request.type === "skin-import-file") {
      const options = {
        title: "Install a Kestrel skin",
        buttonLabel: "Install skin",
        properties: ["openFile"] as Array<"openFile">,
        filters: [{ name: "Kestrel skin", extensions: ["json"] }],
      };
      const selection = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      if (selection.canceled || !selection.filePaths[0]) {
        const current = await supervisor.request({ type: "skin-get" });
        if (!current.ok) throw new Error(current.error);
        return { ok: true, cancelled: true, skinStatus: current.skinStatus };
      }
      const path = selection.filePaths[0];
      const metadata = await lstat(path);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size < 1 ||
        metadata.size > 65_536
      )
        throw new Error(
          "Skin must be a regular non-symlink JSON file no larger than 64 KB.",
        );
      return supervisor.request({
        type: "skin-import",
        source: await readFile(path, "utf8"),
      });
    }
    if (request.type === "pet-overlay-open") {
      const response = await supervisor.request({
        type: "pet-configure",
        poppedOut: true,
      });
      if (!response.ok) return response;
      await createPetOverlay();
      broadcastPetStatus(response);
      return response;
    }
    if (request.type === "pet-overlay-close") {
      const response = await supervisor.request({
        type: "pet-configure",
        poppedOut: false,
      });
      broadcastPetStatus(response);
      const overlay = petOverlayWindow;
      if (overlay) {
        petOverlaysReturning.add(overlay);
        releasePetOverlayAccess(overlay);
      }
      petOverlayWindow = null;
      setTimeout(() => {
        if (overlay && !overlay.isDestroyed()) overlay.destroy();
      }, 40);
      return response;
    }
    if (request.type === "pet-overlay-toggle-main") {
      if (!mainWindow) mainWindow = createMainWindow();
      else if (mainWindow.isVisible() && mainWindow.isFocused())
        mainWindow.hide();
      else {
        mainWindow.show();
        mainWindow.focus();
      }
      return { ok: true };
    }
    if (request.type === "reset-local-data") {
      if (request.confirmation !== PRODUCT_IDENTITY.productName)
        return {
          ok: false,
          error: `Type ${PRODUCT_IDENTITY.productName} to confirm reset.`,
        };
      await supervisor.stop();
      await rm(app.getPath("userData"), { recursive: true, force: true });
      app.relaunch();
      quitting = true;
      app.quit();
      return { ok: true };
    }
    const coreRequest = CoreRequestSchema.parse(request);
    if (overlayAccess && request.type === "runtime-create-session") {
      const response = await supervisor.request(coreRequest);
      if (response.ok && response.session)
        overlayAccess.registerSession(response.session.id);
      return response;
    }
    if (overlayAccess && request.type === "runtime-run-agent") {
      const streamId = request.streamId!;
      overlayAccess.beginStream(streamId);
      try {
        return await supervisor.request(coreRequest);
      } finally {
        overlayAccess.finishStream(streamId);
      }
    }
    const response = await supervisor.request(coreRequest);
    if (response.ok && response.snapshot) {
      agentState = response.snapshot.agentState;
      updateTray();
    }
    return response;
  });
}

async function initializeCoreForStartup(): Promise<boolean> {
  while (true) {
    try {
      await initializeCore();
      return true;
    } catch (cause) {
      const detail =
        cause instanceof Error
          ? cause.message
          : "An unknown startup error occurred.";
      const result = await dialog.showMessageBox({
        type: "error",
        title: `${PRODUCT_IDENTITY.productName} could not start`,
        message: "Kestrel needs access to its encrypted data.",
        detail: `${detail}\n\nKestrel will not open your data without its encryption boundary. If you denied the Keychain prompt, unlock the login keychain and choose “Always Allow” for Kestrel Safe Storage, then try again.`,
        buttons: ["Try again", "Quit"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (result.response !== 0) return false;
    }
  }
}

app.on("second-instance", (_event, argv) => {
  const deepLinks = deepLinksFromArgv(argv);
  if (deepLinks.length === 0) showMainWindow();
  else for (const deepLink of deepLinks) queueDeepLink(deepLink);
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  queueDeepLink(url);
});
app.on("before-quit", () => {
  quitting = true;
});
app.on("will-quit", () => {
  providerAuthMonitor.stop();
  void Promise.all([
    supervisor.stop(),
    managedLocalRuntime?.stop() ?? Promise.resolve(),
  ]);
});
app.on("activate", () => {
  showMainWindow();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

void app
  .whenReady()
  .then(async () => {
    app.setAsDefaultProtocolClient(PRODUCT_IDENTITY.protocol);
    registerIpc();
    if (!(await initializeCoreForStartup())) {
      quitting = true;
      app.quit();
      return;
    }
    providerAuthMonitor.start();
    updateTray();
    const launchedAtLogin = app.getLoginItemSettings().wasOpenedAtLogin;
    if (!mainWindow) mainWindow = createMainWindow();
    const startupWindow = mainWindow;
    const pet = await supervisor.request({ type: "pet-get" });
    if (
      pet.ok &&
      pet.petStatus?.configuration.poppedOut &&
      pet.petStatus.configuration.enabled
    )
      await createPetOverlay();
    if (launchedAtLogin)
      startupWindow.once("ready-to-show", () => startupWindow.hide());
    if (
      shouldCheckForUpdates(
        app.isPackaged,
        PRODUCT_IDENTITY.updateChannel,
        process.env.KESTREL_DISABLE_UPDATES === "1",
      )
    ) {
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.channel = updaterFeedChannel(PRODUCT_IDENTITY.updateChannel)!;
      autoUpdater.on("update-downloaded", (info) => {
        if (!Notification.isSupported()) return;
        const notification = new Notification({
          title: `${PRODUCT_IDENTITY.productName} ${info.version} is ready`,
          body: "The signed update will install after you quit and reopen Kestrel.",
        });
        notification.on("click", () => {
          mainWindow?.show();
          mainWindow?.focus();
        });
        notification.show();
      });
      setTimeout(
        () => void autoUpdater.checkForUpdates().catch(() => undefined),
        15000,
      ).unref();
    }
  })
  .catch((cause) => {
    const detail =
      cause instanceof Error ? cause.message : "An unknown startup error occurred.";
    dialog.showErrorBox(
      `${PRODUCT_IDENTITY.productName} could not start`,
      `${detail}\n\nKestrel did not open your data without its encryption boundary. Unlock macOS secure storage and try again.`,
    );
    quitting = true;
    app.quit();
  });
