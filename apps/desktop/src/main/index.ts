import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, join, relative, sep } from "node:path";
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
import { arch, cpus, platform, totalmem, userInfo } from "node:os";
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
	CommunicationCodeScanSchema,
	ExternalIntakeSchema,
	GMAIL_READONLY_SCOPE,
	isLoginCodeChallenge,
	PRODUCT_IDENTITY,
	RendererRequestSchema,
	SelectedAttachmentSchema,
  type AgentState,
  type BackgroundJobsEvent,
  type CommunicationCodeCandidate,
  type CommunicationCodeScan,
  type CommunicationSourceStatus,
  type InstalledExtension,
  type UserBrowserState,
  type UserBrowserTab,
  type WorkspaceGrant,
  type WorkspaceSnapshot,
} from "@kestrel/shared-types";
import { CoreSupervisor } from "./core-supervisor";
import { CredentialBroker } from "./credential-broker";
import { WorkspaceGrantStore } from "./workspace-grant-store";
import { MigrationManager, PluginInstaller, readBoundedResponseBytes } from "@kestrel/agent-core";
import { PluginTrustStore } from "./plugin-trust-store";
import { ElectronBrowserService } from "./electron-browser-service";
import {
  UserBrowserService,
  isUserBrowserBackendWireRequest,
} from "./user-browser-service";
import { LocalRuntimeManager } from "./local-runtime-manager";
import { listWorkspaceFiles } from "./workspace-file-search";
import { GoogleWorkspaceOAuthManager } from "./google-workspace-oauth";
import {
  ChatGptOAuthManager,
  type ChatGptOAuthStatus,
} from "./chatgpt-oauth";
import { ProviderAuthMonitor } from "./provider-auth-monitor";
import { ExternalSecretManager } from "./external-secret-manager";
import type { ResolvedExternalCredentials } from "./credential-broker";
import { fileDigest } from "./file-digest";
import { mediaTypeForPath } from "./file-tabs";
import { shouldCheckForUpdates, updaterFeedChannel } from "./update-channel";
import {
  isTrustedRendererFrame,
  isTrustedRendererUrl,
  protectRendererNavigation,
  trustedDevelopmentRendererUrl,
} from "./renderer-security";
import {
	DeepLinkQueue,
  deepLinksFromArgv,
  parseKestrelDeepLink,
  parseWebUrl,
  urlsFromArgv,
} from "./deep-links";
import {
	externalPayloadIdFromDeepLink,
	filePathsFromArgv,
	parseExternalServicePayload,
} from "./external-intake";
import { MacMessagesSource } from "./mac-messages-source";
import {
  MacWidgetsStore,
  macWidgetsGroupContainerPath,
  widgetSnapshotFromWorkspace,
} from "./mac-widgets";
import {
  PetOverlayRequestAccess,
  petOverlayActivityForRuntimeEvent,
} from "./pet-overlay-security";
import {
  acquireSingleInstanceLock,
  developmentHeartbeatIsStale,
} from "./single-instance";
import { canShowMainWindow } from "./startup-window";
import {
  archiveProtectedProfile,
  startupRecoveryCopy,
} from "./startup-recovery";
import {
	canRegisterAsDefaultBrowser,
	isPackagedKestrelRuntime,
} from "./default-browser";
import {
	dockIconSvg,
	menuBarIconSvg,
	svgDataUrl,
	visualStateForAgentState,
} from "./macos-integration";
import { installMacFileIconCrashGuard } from "./mac-file-icon-guard";

// Chromium encrypts cookies with macOS Keychain under "Kestrel Safe Storage"
// unless this switch is set before ready. Kestrel stores its own secrets as
// local files and does not use Keychain.
app.commandLine.appendSwitch("use-mock-keychain");
installMacFileIconCrashGuard(app);

let mainWindow: BrowserWindow | null = null;
let petOverlayWindow: BrowserWindow | null = null;
const petOverlaysReturning = new WeakSet<BrowserWindow>();
const petOverlayAccess = new WeakMap<
  BrowserWindow,
  PetOverlayRequestAccess
>();
const pendingDeepLinks = new DeepLinkQueue();
let mainRendererDeepLinkReady = false;
let externalIntakeRendererReady = false;
const externalIntakeReadyWindows = new WeakSet<BrowserWindow>();
let tray: Tray | null = null;
let dockDefaultIcon: ReturnType<typeof nativeImage.createEmpty> | null = null;
let dockAnimationTimer: ReturnType<typeof setInterval> | undefined;
let dockCompletionTimer: ReturnType<typeof setTimeout> | undefined;
let dockAnimationGeneration = 0;
let quitting = false;
let coreStartupComplete = false;
let startupRecoveryWindowCreated = false;
let agentState: AgentState = "idle";
const activeAgentStreams = new Set<string>();
const recentAgentTasks: string[] = [];
let activeAgentTaskLabel = "";
let deliveringExternalIntakes = false;
const pendingExternalIntakes: Array<{
	kind: "ask" | "open";
	paths: string[];
	text?: string;
	targetService?: UserBrowserService;
	targetWindow?: BrowserWindow;
}> = [];
const browserService = new ElectronBrowserService();
let userBrowserService: UserBrowserService | null = null;
const browserWindowServices = new Map<BrowserWindow, UserBrowserService>();
const supervisor = new CoreSupervisor(
  (request, signal) => {
    if (isUserBrowserBackendWireRequest(request)) {
      if (request.operation === "visible-tabs") {
        return Promise.resolve(
          [...new Set(browserWindowServices.values())].flatMap((service) => {
            const state = service.getState();
            return state.tabs.map((tab) => ({
              id: tab.id,
              title: tab.title,
              url: tab.url,
              active: tab.id === state.activeTabId,
              loading: tab.loading,
              discarded: tab.discarded,
              trust: "untrusted_browser" as const,
            }));
          }),
        );
      }
      const service = browserServiceForTab(
        "tabId" in request ? request.tabId : undefined,
      );
      if (!service)
        throw new Error("The visible user browser is unavailable.");
      return service.handleAgentRequest(request, signal);
    }
    return browserService.handle(request, signal);
  },
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
const isPackagedKestrelApp = isPackagedKestrelRuntime(
  app.isPackaged,
  process.env.NODE_ENV_ELECTRON_VITE,
);
const execFileAsync = promisify(execFile);
let localGreetingNamePromise: Promise<string | undefined> | undefined;
let managedLocalRuntime: LocalRuntimeManager | null = null;
let appCredentialBroker: CredentialBroker | null = null;
let googleOAuthController: AbortController | null = null;
let chatGptOAuthController: AbortController | null = null;
let activeChatGptOAuthManager: ChatGptOAuthManager | null = null;
const macMessagesSource = new MacMessagesSource();
const pendingCommunicationScans = new Map<
  string,
  {
    tabId: string;
    domain: string;
    origin: string;
    candidates: CommunicationCodeCandidate[];
    expiresAt: number;
  }
>();

function safeGreetingName(value: string): string | undefined {
	const normalized = value.normalize("NFKC").trim();
	if (
		!normalized ||
		normalized.length > 80 ||
		!/^[\p{L}\p{M}'\-\s]+$/u.test(normalized)
	)
		return undefined;
	const token = normalized.split(/\s+/)[0];
	if (
		!token ||
		token.length > 40 ||
		!/^[\p{L}\p{M}][\p{L}\p{M}'-]*$/u.test(token)
	)
		return undefined;
	return token;
}

function localGreetingName(): Promise<string | undefined> {
	if (localGreetingNamePromise) return localGreetingNamePromise;
	localGreetingNamePromise = (async () => {
		let displayName = "";
		if (platform() === "darwin") {
			try {
				const result = await execFileAsync("/usr/bin/id", ["-F"], {
					maxBuffer: 4_096,
					timeout: 750,
				});
				displayName = String(result.stdout).trim();
			} catch {
				// Fall back to the local account name below.
			}
		}
		if (!displayName) {
			try {
				displayName = userInfo().username;
			} catch {
				return undefined;
			}
		}
		const safeDisplayName = safeGreetingName(displayName);
		if (safeDisplayName) return safeDisplayName;
		try {
			return safeGreetingName(userInfo().username);
		} catch {
			return undefined;
		}
	})();
	return localGreetingNamePromise;
}

function trustedRendererUrl(value: string): boolean {
  return isTrustedRendererUrl(
    value,
    RENDERER_ENTRY_PATH,
    DEVELOPMENT_RENDERER_URL,
  );
}

function browserServiceForWindow(
  window: BrowserWindow | null,
): UserBrowserService | null {
  return window ? browserWindowServices.get(window) ?? null : null;
}

function browserServiceForTab(tabId?: string): UserBrowserService | null {
  if (tabId) {
    for (const service of new Set(browserWindowServices.values())) {
      if (service.getState().tabs.some((tab) => tab.id === tabId)) return service;
    }
  }
  return userBrowserService;
}

function browserOwnerForDragSender(sender: Electron.WebContents):
	| { window: BrowserWindow; service: UserBrowserService; mainRenderer: boolean }
	| undefined {
	for (const [window, service] of browserWindowServices) {
		if (window.webContents === sender)
			return { window, service, mainRenderer: true };
	}
	for (const [window, service] of browserWindowServices) {
		if (service.ownsWebContents(sender))
			return { window, service, mainRenderer: false };
	}
	return undefined;
}

async function communicationSourceStatuses(): Promise<CommunicationSourceStatus[]> {
  const google = await googleWorkspaceOAuthManager().status();
  const gmail: CommunicationSourceStatus = google.connected
    ? google.scopes.includes(GMAIL_READONLY_SCOPE)
      ? {
          id: "gmail",
          label: "Connected Gmail",
          kind: "email",
          state: "connected",
          detail: "Recent verification messages can be searched on request.",
          ...(google.email ? { account: google.email } : {}),
        }
      : {
          id: "gmail",
          label: "Connected Gmail",
          kind: "email",
          state: "needs_reconnect",
          detail: "Reconnect Google Workspace to allow read-only code lookup.",
          ...(google.email ? { account: google.email } : {}),
        }
    : {
        id: "gmail",
        label: "Connected Gmail",
        kind: "email",
        state: "not_connected",
        detail: "Connect Google Workspace to search a mailbox on request.",
      };
  return [macMessagesSource.status(), gmail];
}

function activePageDomain(url: string): string {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password)
    throw new Error("The selected page does not have a safe web origin.");
  const domain = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!domain || domain.length > 253) throw new Error("The page domain is invalid.");
  return domain;
}

function activePageOrigin(url: string): string {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password)
    throw new Error("The selected page does not have a safe web origin.");
  return parsed.origin;
}

function trimCommunicationScans(): void {
  const now = Date.now();
  for (const [scanId, scan] of pendingCommunicationScans)
    if (scan.expiresAt <= now) pendingCommunicationScans.delete(scanId);
  while (pendingCommunicationScans.size > 50) {
    const oldest = pendingCommunicationScans.keys().next().value;
    if (typeof oldest !== "string") break;
    pendingCommunicationScans.delete(oldest);
  }
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

type SubscriptionCliId = "codex" | "claude" | "opencode";
interface RuntimePreferences {
  subscriptions?: Partial<
    Record<SubscriptionCliId, { enabled: boolean; path: string }>
  >;
}

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
  try {
    const value: unknown = JSON.parse(
      await readFile(runtimePreferencesPath(), "utf8"),
    );
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as RuntimePreferences)
      : {};
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      error instanceof SyntaxError
    )
      return {};
    throw error;
  }
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
      : id === "claude"
        ? process.env.KESTREL_CLAUDE_PATH
        : process.env.KESTREL_OPENCODE_PATH;
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
      : id === "claude"
        ? [
            configured,
            "/opt/homebrew/bin/claude",
            "/usr/local/bin/claude",
            join(home, ".local", "bin", "claude"),
            join(home, ".npm-global", "bin", "claude"),
          ]
        : [
            configured,
            "/opt/homebrew/bin/opencode",
            "/usr/local/bin/opencode",
            join(home, ".local", "bin", "opencode"),
            join(home, ".npm-global", "bin", "opencode"),
            join(home, "bin", "opencode"),
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
  const statuses = await Promise.all((["codex", "claude", "opencode"] as const).map(async (id) => {
    const path = detectedSubscriptionCli(id);
    const enabled = Boolean(
      path &&
        preferences.subscriptions?.[id]?.enabled &&
        preferences.subscriptions[id]?.path === path,
    );
    const label =
      id === "codex"
        ? "ChatGPT plan through Codex"
        : id === "claude"
          ? "Claude plan through Claude Code"
          : "OpenCode AI runtime";
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
          : id === "claude"
            ? "Enabled. Authentication remains in the vendor CLI and is checked without copying tokens."
            : "Enabled. Runs prompts and tasks through your local OpenCode environment."
        : path
          ? id === "codex"
            ? chatGptStatus?.connected
              ? `ChatGPT connected${chatGptAccount?.email ? ` as ${chatGptAccount.email}` : ""}${chatGptAccount?.planType ? ` · ${chatGptAccount.planType} plan` : ""}. Enable the persistent read-only Codex route when ready.`
              : chatGptStatus && "accountType" in chatGptStatus && chatGptStatus.accountType === "apiKey"
                ? "Codex is using an API key. Sign in with ChatGPT to use plan access instead."
                : "Codex found. Sign in with ChatGPT through the official browser OAuth flow."
            : id === "claude"
              ? "CLI found. Enable it to use the vendor's existing on-device sign-in for text-only tasks."
              : "OpenCode CLI found. Enable it to use your local OpenCode models and configuration."
          : `Install and sign in to the official ${id === "codex" ? "Codex" : id === "claude" ? "Claude Code" : "OpenCode"} CLI to make this route available.`,
    };
  }));
  return statuses;
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
  if (!isPackagedKestrelApp)
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
  publishMacWidgetAgentState("working");
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
		setAgentState(response.snapshot.agentState);
		publishMacWidgetSnapshot(response.snapshot);
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
	console.warn("Kestrel Agent Core recovery failed.", error.message);
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: `${PRODUCT_IDENTITY.productName} · Agent Core needs attention`,
    body: error.message,
  });
  notification.on("click", showMainWindow);
  notification.show();
});

// Keep the runtime name stable so the existing user-data directory continues
// to resolve without orphaning installed profiles.
app.setName(PRODUCT_IDENTITY.runtimeApplicationName);
if (process.env.KESTREL_DISABLE_GPU === "1") {
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("in-process-gpu");
  app.disableHardwareAcceleration();
}
app.setPath(
  "userData",
  process.env.KESTREL_TEST_USER_DATA ??
    join(app.getPath("appData"), PRODUCT_IDENTITY.userDataDirectoryName),
);

const singleInstance = acquireSingleInstanceLock(app);
const developmentHeartbeatPath = process.env.KESTREL_DEV_ELECTRON_HEARTBEAT;
if (process.env.NODE_ENV_ELECTRON_VITE === "development" && developmentHeartbeatPath) {
  const heartbeatMonitor = setInterval(() => {
    let lastHeartbeatAt: number;
    try {
      lastHeartbeatAt = statSync(developmentHeartbeatPath).mtimeMs;
    } catch {
      clearInterval(heartbeatMonitor);
      process.exit(0);
      return;
    }
    if (!developmentHeartbeatIsStale(lastHeartbeatAt, Date.now(), 1_000)) return;
    clearInterval(heartbeatMonitor);
    process.exit(0);
  }, 250);
  app.on("will-quit", () => clearInterval(heartbeatMonitor));
}

const initialDeepLinks = deepLinksFromArgv(process.argv);
const initialExternalIntakeLinks = initialDeepLinks.filter((deepLink) =>
	externalPayloadIdFromDeepLink(deepLink),
);
for (const deepLink of initialDeepLinks) {
	if (!externalPayloadIdFromDeepLink(deepLink)) pendingDeepLinks.enqueue(deepLink);
}
for (const path of filePathsFromArgv(process.argv))
	pendingExternalIntakes.push({ kind: "open", paths: [path] });

function showMainWindow(): void {
  if (!singleInstance) return;
  if (!coreStartupComplete) {
    // During secure-storage recovery there is no main window yet. A second
    // click on the Dock icon must bring the recovery dialog back to the front
    // instead of making the app look like it exited.
    app.focus({ steal: true });
    return;
  }
  if (!canShowMainWindow(app.isReady(), coreStartupComplete)) return;
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

export function isDefaultBrowser(): boolean {
  if (!canRegisterAsDefaultBrowser(isPackagedKestrelApp)) return false;
  if (process.platform !== "darwin" && process.platform !== "win32") {
    return app.isDefaultProtocolClient("http");
  }
  return (
    app.isDefaultProtocolClient("http") &&
    app.isDefaultProtocolClient("https")
  );
}

export function setAsDefaultBrowser(): boolean {
  if (!canRegisterAsDefaultBrowser(isPackagedKestrelApp)) return false;
  const httpOk = app.setAsDefaultProtocolClient("http");
  const httpsOk = app.setAsDefaultProtocolClient("https");
  return httpOk || httpsOk;
}

const pendingWebUrls: string[] = [];

function servicePayloadPath(id: string): string | undefined {
	if (!/^[a-f0-9-]{36}$/.test(id)) return undefined;
	return join(
		app.getPath("appData"),
		PRODUCT_IDENTITY.runtimeApplicationName,
		"external-intake",
		`${id}.json`,
	);
}

async function readServicePayload(
	id: string,
): Promise<{ kind: "ask" | "open"; paths: string[]; text?: string } | undefined> {
	const path = servicePayloadPath(id);
	if (!path) return undefined;
	try {
		const metadata = await lstat(path);
		if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 1_000_000)
			return undefined;
		const raw: unknown = JSON.parse(await readFile(path, "utf8"));
		await rm(path, { force: true });
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
		const parsed = parseExternalServicePayload(raw);
		if (!parsed) return undefined;
		return {
			kind: parsed.kind,
			paths: parsed.paths,
			...(parsed.text === undefined ? {} : { text: parsed.text }),
		};
	} catch {
		return undefined;
	}
}

function queueExternalIntake(
	paths: string[],
	options: {
		kind: "ask" | "open";
		text?: string;
		targetService?: UserBrowserService;
		targetWindow?: BrowserWindow;
	},
): void {
	const unique = [...new Set(paths)].slice(0, 8);
	if (unique.length === 0 && !options.text?.trim()) return;
	if (pendingExternalIntakes.length >= 16) pendingExternalIntakes.shift();
	pendingExternalIntakes.push({
		kind: options.kind,
		paths: unique,
		...(options.text ? { text: options.text } : {}),
		...(options.targetService ? { targetService: options.targetService } : {}),
		...(options.targetWindow ? { targetWindow: options.targetWindow } : {}),
	});
	showMainWindow();
	deliverPendingExternalIntakes();
}

async function deliverPendingExternalIntakes(): Promise<void> {
	if (deliveringExternalIntakes) return;
	deliveringExternalIntakes = true;
	try {
		while (pendingExternalIntakes.length > 0) {
			const next = pendingExternalIntakes[0]!;
			const targetService = next.targetService ?? userBrowserService;
			const targetWindow = next.targetWindow ?? mainWindow;
			if (
				!targetService ||
				!targetWindow ||
				targetWindow.isDestroyed() ||
				(!externalIntakeReadyWindows.has(targetWindow) &&
					!(targetWindow === mainWindow && externalIntakeRendererReady)) ||
				!trustedRendererUrl(targetWindow.webContents.getURL())
			)
				return;
			try {
				const opened = next.paths.length
					? await targetService.openFileTabs(next.paths, true)
					: { selectedAttachments: [] };
				if (next.kind === "open" && !next.text?.trim()) {
					pendingExternalIntakes.shift();
					continue;
				}
				const intake = ExternalIntakeSchema.parse({
					kind: next.kind,
					...(next.text ? { text: next.text } : {}),
					attachments: opened.selectedAttachments,
				});
				targetWindow.webContents.send("kestrel:external-intake", intake);
				pendingExternalIntakes.shift();
			} catch (error) {
				pendingExternalIntakes.shift();
				if (Notification.isSupported())
					new Notification({
						title: `${PRODUCT_IDENTITY.productName} · File intake failed`,
						body: error instanceof Error ? error.message : "The selected files could not be opened.",
					}).show();
			}
		}
	} finally {
		deliveringExternalIntakes = false;
	}
}

function handleIncomingFileDrop(paths: string[]): void {
	queueExternalIntake(paths, { kind: "ask" });
}

function openIncomingWebUrl(url: string): void {
  if (userBrowserService && mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow();
    void userBrowserService.createTab(url, true).catch(() => undefined);
  } else {
    if (!pendingWebUrls.includes(url) && pendingWebUrls.length < 32) {
      pendingWebUrls.push(url);
    }
    showMainWindow();
  }
}

function deliverPendingWebUrls(): void {
  if (!userBrowserService || !mainWindow || mainWindow.isDestroyed()) return;
  while (pendingWebUrls.length > 0) {
    const nextUrl = pendingWebUrls.shift()!;
    void userBrowserService.createTab(nextUrl, true).catch(() => undefined);
  }
}

function handleIncomingUrl(value: string): void {
	const payloadId = externalPayloadIdFromDeepLink(value);
	if (payloadId) {
		void readServicePayload(payloadId).then((payload) => {
			if (payload) queueExternalIntake(payload.paths, payload);
		});
		return;
	}
	const deepLink = parseKestrelDeepLink(value);
  if (deepLink) {
    queueDeepLink(deepLink);
    return;
  }
  const webUrl = parseWebUrl(value);
  if (webUrl) {
    openIncomingWebUrl(webUrl);
  }
}

function queueDeepLink(value: unknown): boolean {
  if (!pendingDeepLinks.enqueue(value)) return false;
  showMainWindow();
  deliverPendingDeepLinks();
  return true;
}

let macWidgetsStore: MacWidgetsStore | null = null;
let latestWorkspaceSnapshot: WorkspaceSnapshot | null = null;

function publishMacWidgetSnapshot(snapshot: WorkspaceSnapshot): void {
  latestWorkspaceSnapshot = snapshot;
  if (process.platform !== "darwin") return;
  macWidgetsStore ??= new MacWidgetsStore(
    macWidgetsGroupContainerPath(app.getPath("home")),
  );
  void macWidgetsStore
    .write(widgetSnapshotFromWorkspace(snapshot))
    .catch((error: unknown) => {
			console.warn(
				"Kestrel could not update its local macOS widget snapshot.",
				error instanceof Error ? error.message : String(error),
			);
    });
}

function publishMacWidgetAgentState(state: AgentState): void {
  if (!latestWorkspaceSnapshot || latestWorkspaceSnapshot.agentState === state)
    return;
  publishMacWidgetSnapshot({
    ...latestWorkspaceSnapshot,
    agentState: state,
    updatedAt: new Date().toISOString(),
  });
}

function refreshMacWidgetSnapshot(): void {
  void supervisor
    .request({ type: "snapshot" })
    .then((response) => {
      if (!response.ok || !response.snapshot) return;
      setAgentState(response.snapshot.agentState);
      publishMacWidgetSnapshot(response.snapshot);
      mainWindow?.webContents.send("kestrel:snapshot", response.snapshot);
    })
    .catch(() => undefined);
}

function finishMacWidgetRun(
  response: Awaited<ReturnType<CoreSupervisor["request"]>>,
): void {
  if (!response.ok) {
    publishMacWidgetAgentState("error");
    return;
  }
  const status = response.run?.status;
  if (!status) return;
  publishMacWidgetAgentState(
    status === "waiting_approval"
      ? "waiting_approval"
      : status === "failed"
        ? "error"
        : status === "running"
          ? "working"
          : "idle",
  );
  refreshMacWidgetSnapshot();
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 920,
    minHeight: 680,
    show: false,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0a0a0a",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: !DEVELOPMENT_RENDERER_URL,
      webSecurity: true,
      devTools: !isPackagedKestrelApp,
    },
  });
  if (process.platform === "darwin") window.setWindowButtonVisibility(false);
  if (userBrowserService) {
    userBrowserService.dispose();
    if (mainWindow) browserWindowServices.delete(mainWindow);
    userBrowserService = null;
  }
  userBrowserService =
    process.env.KESTREL_DISABLE_USER_BROWSER === "1"
      ? null
      : new UserBrowserService({
          window,
          statePath: join(app.getPath("userData"), "browser", "state.json"),
          downloadDirectory: process.env.KESTREL_TEST_USER_DATA
            ? join(app.getPath("userData"), "browser-downloads")
            : join(app.getPath("downloads"), PRODUCT_IDENTITY.productName),
          onEvent: (event) => {
            if (!window.isDestroyed())
              window.webContents.send("kestrel:browser-event", event);
          },
          onCommand: (command) => {
            if (!window.isDestroyed()) {
              // Native WebContentsView pages own focus while the user is browsing.
              // Return focus to the trusted renderer before asking it to focus the
              // address field, composer, or command center.
              window.webContents.focus();
              window.webContents.send("kestrel:browser-command", command);
            }
          },
        });
  if (userBrowserService) browserWindowServices.set(window, userBrowserService);
  deliverPendingWebUrls();
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.session.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const mediaTypes =
        "mediaTypes" in details && Array.isArray(details.mediaTypes)
          ? details.mediaTypes
          : [];
      const rendererWindow = BrowserWindow.fromWebContents(webContents);
      callback(
        Boolean(rendererWindow && browserWindowServices.has(rendererWindow)) &&
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
    const service = browserServiceForWindow(window);
    if (service) service.dispose();
    browserWindowServices.delete(window);
		if (mainWindow === window) {
			userBrowserService = null;
			mainWindow = null;
			mainRendererDeepLinkReady = false;
			externalIntakeRendererReady = false;
		}
  });
  if (DEVELOPMENT_RENDERER_URL)
    void window.loadURL(DEVELOPMENT_RENDERER_URL);
  else void window.loadFile(RENDERER_ENTRY_PATH);
  window.once("ready-to-show", () => {
    window.show();
  });
  return window;
}

function detachedBrowserState(
  sourceState: UserBrowserState,
  tab: UserBrowserTab,
): UserBrowserState {
  const state = structuredClone(sourceState);
  state.tabs = [
    {
      ...tab,
      loading: false,
      discarded: false,
      crashed: false,
      error: undefined,
    },
  ];
  state.activeTabId = tab.id;
  state.downloads = state.downloads.filter((download) => download.tabId === tab.id);
  return state;
}

function createDetachedBrowserWindow(
  sourceState: UserBrowserState,
  tab: UserBrowserTab,
): BrowserWindow {
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 920,
    minHeight: 680,
    show: false,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0a0a0a",
    title: tab.title || PRODUCT_IDENTITY.productName,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: !DEVELOPMENT_RENDERER_URL,
      webSecurity: true,
      devTools: !isPackagedKestrelApp,
    },
  });
  const statePath = join(
    app.getPath("userData"),
    "browser",
    "detached",
    `window-${randomUUID()}.json`,
  );
  const service = new UserBrowserService({
    window,
    statePath,
    initialState: detachedBrowserState(sourceState, tab),
    downloadDirectory: process.env.KESTREL_TEST_USER_DATA
      ? join(app.getPath("userData"), "browser-downloads")
      : join(app.getPath("downloads"), PRODUCT_IDENTITY.productName),
    onEvent: (event) => {
      if (!window.isDestroyed())
        window.webContents.send("kestrel:browser-event", event);
    },
    onCommand: (command) => {
      if (!window.isDestroyed()) {
        window.webContents.focus();
        window.webContents.send("kestrel:browser-command", command);
      }
    },
  });
  browserWindowServices.set(window, service);
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  protectRendererNavigation(window.webContents, trustedRendererUrl);
  window.on("closed", () => {
    service.dispose();
    browserWindowServices.delete(window);
    void rm(statePath, { force: true }).catch(() => undefined);
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
      sandbox: !DEVELOPMENT_RENDERER_URL,
      webSecurity: true,
      devTools: !isPackagedKestrelApp,
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

function nativeIconFromSvg(svg: string) {
	return nativeImage.createFromDataURL(svgDataUrl(svg));
}

function trayIcon(state = visualStateForAgentState(agentState)) {
	const icon = nativeIconFromSvg(menuBarIconSvg(state));
	icon.setTemplateImage(true);
	return icon;
}

function dockAnimationsAllowed(): boolean {
	if (process.platform !== "darwin") return false;
	try {
		return systemPreferences.getAnimationSettings().shouldRenderRichAnimation !== false;
	} catch {
		return true;
	}
}

function updateDock(): void {
	if (process.platform !== "darwin" || !app.dock) return;
	const dock = app.dock;
	const next = visualStateForAgentState(agentState);
	dockAnimationGeneration += 1;
	const generation = dockAnimationGeneration;
	if (dockAnimationTimer) {
		clearInterval(dockAnimationTimer);
		dockAnimationTimer = undefined;
	}
	if (dockCompletionTimer) {
		clearTimeout(dockCompletionTimer);
		dockCompletionTimer = undefined;
	}
	if (next === "idle") {
			if (dockDefaultIcon) dock.setIcon(dockDefaultIcon);
			return;
		}
	let frame = 0;
	const setFrame = () => {
		if (generation !== dockAnimationGeneration) return;
		dock.setIcon(nativeIconFromSvg(dockIconSvg(next, frame)));
		frame = (frame + 1) % 2;
	};
	setFrame();
	if (next === "waiting" || !dockAnimationsAllowed()) return;
	dockAnimationTimer = setInterval(setFrame, next === "acting" ? 720 : 1_050);
}

function showDockCompletion(): void {
	if (process.platform !== "darwin" || !app.dock || !dockAnimationsAllowed()) {
		updateDock();
		return;
	}
	const dock = app.dock;
	dockAnimationGeneration += 1;
	const generation = dockAnimationGeneration;
	if (dockAnimationTimer) {
		clearInterval(dockAnimationTimer);
		dockAnimationTimer = undefined;
	}
	if (dockCompletionTimer) clearTimeout(dockCompletionTimer);
	dock.setIcon(nativeIconFromSvg(dockIconSvg("completed", 0)));
	dockCompletionTimer = setTimeout(() => {
		if (generation !== dockAnimationGeneration) return;
		dockCompletionTimer = undefined;
		if (dockDefaultIcon) dock.setIcon(dockDefaultIcon);
	}, 620);
}

function initializeDock(): void {
	if (process.platform !== "darwin" || !app.dock) return;
	dockDefaultIcon = nativeIconFromSvg(dockIconSvg("idle", 0));
	updateDock();
}

function setAgentState(next: AgentState): void {
	const previous = agentState;
	if (agentState !== next && next === "idle" && activeAgentTaskLabel) {
		recentAgentTasks.unshift(activeAgentTaskLabel);
		recentAgentTasks.splice(5);
		activeAgentTaskLabel = "";
	}
	agentState = next;
	updateTray();
	if (
		next === "idle" &&
		["observing", "working", "updating"].includes(previous)
	)
		showDockCompletion();
	else updateDock();
}

function updateTray(): void {
	const visual = visualStateForAgentState(agentState);
	if (!tray) {
		tray = new Tray(trayIcon());
		tray.on("click", () => {
			showMainWindow();
			mainWindow?.focus();
		});
	}
	tray.setImage(trayIcon(visual));
	tray.setToolTip(`${PRODUCT_IDENTITY.productName} · ${agentState.replace("_", " ")}`);
	const isWorking = activeAgentStreams.size > 0 || ["working", "observing", "updating"].includes(agentState);
	const isWaiting = agentState === "waiting_approval";
	const statusLabel = isWorking
		? `Working${activeAgentTaskLabel ? ` · ${activeAgentTaskLabel}` : ""}`
		: isWaiting
			? "Needs your approval"
			: agentState === "paused"
				? "Paused"
				: "Idle";
	const recentItems = recentAgentTasks.length > 0
		? [
				{ type: "separator" as const },
				{
					label: "Recent",
					enabled: false,
				},
				...recentAgentTasks.map((task) => ({ label: `✓ ${task}`, enabled: false })),
		  ]
		: [];
	tray.setContextMenu(
		Menu.buildFromTemplate([
			{ label: `${PRODUCT_IDENTITY.productName} · ${statusLabel}`, enabled: false },
			...(activeAgentTaskLabel ? [{ label: activeAgentTaskLabel, enabled: false }] : []),
			{ type: "separator" },
			{
				label: `Open ${PRODUCT_IDENTITY.productName}`,
				click: () => {
					showMainWindow();
					mainWindow?.focus();
				},
			},
			...(activeAgentStreams.size > 0
				? [{
						label: "Stop active task",
						click: () => {
							for (const streamId of activeAgentStreams)
								void supervisor.request({ type: "runtime-cancel-stream", streamId });
						},
				  }]
				: []),
			{
				label: agentState === "paused" ? "Resume agent" : "Pause agent",
				click: async () => {
					const response = await supervisor.request({
						type: "set-paused",
						paused: agentState !== "paused",
					});
					if (response.ok && response.snapshot) {
						setAgentState(response.snapshot.agentState);
						publishMacWidgetSnapshot(response.snapshot);
						mainWindow?.webContents.send("kestrel:snapshot", response.snapshot);
					}
				},
			},
			...recentItems,
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
  const opencodePath = detectedSubscriptionCli("opencode");
  if (
    opencodePath &&
    preferences.subscriptions?.opencode?.enabled &&
    preferences.subscriptions.opencode.path === opencodePath
  ) {
    secureEnvironment.KESTREL_ENABLE_OPENCODE_SUBSCRIPTION = "1";
    secureEnvironment.KESTREL_OPENCODE_PATH = opencodePath;
  }
  try {
    const localRuntime = localRuntimeManager();
    await localRuntime.startManagedIfInstalled();
    const localModels = await listLocalModels(5_000);
    if (localModels.length > 0) {
      secureEnvironment.KESTREL_ENABLE_OLLAMA = "1";
      secureEnvironment.KESTREL_OLLAMA_MODEL ??=
        (await localRuntime.preferredModel(localModels)) ?? localModels[0]!.name;
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
  try {
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
    if (!response.ok)
      throw new Error(response.error || "Agent Core rejected its startup snapshot.");
    if (!response.snapshot)
      throw new Error("Agent Core returned no workspace state during startup.");
		setAgentState(response.snapshot.agentState);
    publishMacWidgetSnapshot(response.snapshot);
  } catch (error) {
    // A bootstrap can fail after the utility process has been created. Tear it
    // down before the recovery dialog retries, or the next attempt sees a
    // stale supervisor and reports only “Agent Core is unavailable.”
    await supervisor.stop().catch(() => undefined);
    throw error;
  }
  // Local runtime warmup is optional and must never tear down a started core.
  void Promise.resolve()
    .then(() => localRuntimeManager().ensureChatReady())
    .catch(() => undefined);
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

async function restartCoreAfterGrantChange(): Promise<WorkspaceGrant[]> {
  await supervisor.stop();
  await initializeCore();
  const response = await supervisor.request({ type: "snapshot" });
	if (response.ok && response.snapshot) {
		setAgentState(response.snapshot.agentState);
    publishMacWidgetSnapshot(response.snapshot);
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
	const setExternalIntakeReadiness = (event: Electron.IpcMainEvent) => {
		const senderWindow = BrowserWindow.fromWebContents(event.sender);
		if (
			!senderWindow ||
			!browserWindowServices.has(senderWindow) ||
			!isTrustedRendererFrame(
				event.senderFrame,
				event.sender.mainFrame,
				trustedRendererUrl,
			)
		)
			return;
		externalIntakeReadyWindows.add(senderWindow);
		if (senderWindow === mainWindow) externalIntakeRendererReady = true;
		void deliverPendingExternalIntakes();
	};
	ipcMain.on("kestrel:external-intake-ready", setExternalIntakeReadiness);
	ipcMain.on("kestrel:user-browser-file-drag", (event, raw) => {
		const owner = browserOwnerForDragSender(event.sender);
		if (!owner || owner.window.isDestroyed()) return;
		if (
			owner.mainRenderer &&
			!isTrustedRendererFrame(
				event.senderFrame,
				event.sender.mainFrame,
				trustedRendererUrl,
			)
		)
			return;
		const active =
			raw && typeof raw === "object" && !Array.isArray(raw)
			? (raw as { active?: unknown }).active
			: undefined;
		if (typeof active !== "boolean") return;
		if (trustedRendererUrl(owner.window.webContents.getURL()))
			owner.window.webContents.send("kestrel:file-drag", { active });
	});
	ipcMain.on("kestrel:user-browser-file-drop", (event, raw) => {
		const owner = browserOwnerForDragSender(event.sender);
		if (!owner || owner.window.isDestroyed()) return;
		if (
			owner.mainRenderer &&
			!isTrustedRendererFrame(
				event.senderFrame,
				event.sender.mainFrame,
				trustedRendererUrl,
			)
		)
			return;
		const paths =
			raw && typeof raw === "object" && !Array.isArray(raw) &&
			Array.isArray((raw as { paths?: unknown }).paths)
				? (raw as { paths: unknown[] }).paths.filter(
						(value): value is string =>
							typeof value === "string" &&
								value.startsWith("/") &&
								value.length <= 4_096 &&
								!/[\u0000-\u001f\u007f]/.test(value),
					  )
						.slice(0, 8)
				: [];
		queueExternalIntake(paths, {
			kind: "ask",
			targetService: owner.service,
			targetWindow: owner.window,
		});
	});

	ipcMain.handle("kestrel:request", async (event, raw) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (
      !senderWindow ||
      (!browserWindowServices.has(senderWindow) &&
        senderWindow !== petOverlayWindow) ||
      !isTrustedRendererFrame(
        event.senderFrame,
        event.sender.mainFrame,
        trustedRendererUrl,
      )
    )
      throw new Error("Kestrel rejected a request from an untrusted renderer.");
    const request = RendererRequestSchema.parse(raw);
    const requestBrowserService = browserServiceForWindow(senderWindow);
    if (request.type === "runtime-run-agent") {
      await localRuntimeManager()
        .ensureChatReady()
        .catch(() => undefined);
    }
    const overlayAccess =
      senderWindow === petOverlayWindow
        ? petOverlayAccess.get(senderWindow)
        : undefined;
    if (senderWindow === petOverlayWindow) {
      if (!overlayAccess)
        throw new Error("Kestrel rejected a stale pet overlay request.");
      overlayAccess.assertAllowed(request);
    }
    if (
      request.type === "window-minimize" ||
      request.type === "window-toggle-zoom" ||
      request.type === "window-close"
    ) {
      if (process.platform !== "darwin" || senderWindow !== mainWindow)
        throw new Error("Custom window controls are available only on macOS.");
      if (request.type === "window-minimize") {
        senderWindow.minimize();
      } else if (request.type === "window-toggle-zoom") {
        if (senderWindow.isFullScreen()) senderWindow.setFullScreen(false);
        else if (senderWindow.isMaximized()) senderWindow.unmaximize();
        else senderWindow.maximize();
      } else {
        senderWindow.close();
      }
      return { ok: true };
    }
    if (request.type === "communication-sources") {
      return {
        ok: true,
        communicationSources: await communicationSourceStatuses(),
      };
    }
    if (request.type === "communication-code-search") {
      throw new Error(
        "Code lookup is available only from an active verification page.",
      );
    }
    if (request.type === "communication-code-notify") {
      if (!requestBrowserService || !requestBrowserService.isActiveTab(request.tabId))
        return { ok: true };
      const context = await requestBrowserService.pageContext(request.tabId);
      if (!isLoginCodeChallenge(context)) return { ok: true };
      if (Notification.isSupported()) {
        const notification = new Notification({
          title: `${PRODUCT_IDENTITY.productName} · Verification code needed`,
          body: "A code field is open. Click to find a recent code in connected messages.",
        });
        notification.on("click", () => {
          showMainWindow();
          mainWindow?.focus();
        });
        notification.show();
      }
      return { ok: true };
    }
    if (request.type === "communication-code-scan") {
      if (!requestBrowserService || !requestBrowserService.isActiveTab(request.tabId))
        throw new Error("The verification page is no longer active.");
      const context = await requestBrowserService.pageContext(request.tabId);
      if (!isLoginCodeChallenge(context))
        throw new Error("This page is not asking for a verification code.");
      const domain = activePageDomain(context.url);
      const origin = activePageOrigin(context.url);
      const after = new Date(Date.now() - 30 * 60_000);
      const localResult = await macMessagesSource.searchLoginCodes();
      const coreResult = await supervisor
        .request({
          type: "communication-code-search",
          domain,
          after: after.toISOString(),
          maxResults: 5,
        })
        .catch(() => undefined);
      const matches = [
        ...localResult.matches,
        ...(coreResult?.ok ? (coreResult.communicationMatches ?? []) : []),
      ]
        .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))
        .filter(
          (match, index, all) =>
            all.findIndex(
              (candidate) =>
                candidate.sourceId === match.sourceId &&
                candidate.code === match.code &&
                candidate.receivedAt === match.receivedAt,
            ) === index,
        )
        .slice(0, 10);
      const candidates: CommunicationCodeCandidate[] = matches.map((match) => ({
        id: `candidate-${randomUUID()}`,
        ...match,
      }));
      const sources = await communicationSourceStatuses();
      const mergedSources = sources.map((source) => {
        if (source.id === "mac-messages") return localResult.status;
        if (source.id === "gmail" && source.state === "connected" && !coreResult?.ok)
          return {
            ...source,
            state: "unavailable" as const,
            detail: "Gmail could not be searched. Check the connection and try again.",
          };
        return source;
      });
      const scanId = `scan-${randomUUID()}`;
      const scan: CommunicationCodeScan = CommunicationCodeScanSchema.parse({
        scanId,
        domain,
        siteLabel: context.title.slice(0, 200),
        scannedAt: new Date().toISOString(),
        candidates,
        sources: mergedSources,
      });
      trimCommunicationScans();
      pendingCommunicationScans.set(scanId, {
        tabId: request.tabId,
        domain,
        origin,
        candidates,
        expiresAt: Date.now() + 2 * 60_000,
      });
      return { ok: true, communicationScan: scan };
    }
    if (request.type === "communication-code-use") {
      trimCommunicationScans();
      const scan = pendingCommunicationScans.get(request.scanId);
      if (!scan) throw new Error("That code lookup has expired.");
      if (!requestBrowserService || !requestBrowserService.isActiveTab(scan.tabId))
        throw new Error("The verification page is no longer active.");
      const context = await requestBrowserService.pageContext(scan.tabId);
      if (
        activePageDomain(context.url) !== scan.domain ||
        activePageOrigin(context.url) !== scan.origin
      )
        throw new Error("The page changed before the code was used.");
      const candidate = scan.candidates.find(
        (item) => item.id === request.candidateId,
      );
      if (!candidate) throw new Error("That code is no longer available.");
      await requestBrowserService.insertLoginCode(
        scan.tabId,
        candidate.code,
        scan.domain,
        scan.origin,
      );
      pendingCommunicationScans.delete(request.scanId);
      return { ok: true, communicationCodeInserted: true };
    }
    if (request.type === "communication-messages-open-settings") {
      if (process.platform !== "darwin")
        throw new Error("Messages access settings are available on macOS only.");
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
      );
      return { ok: true };
    }
	if (request.type === "browser-get-state") {
		if (!requestBrowserService)
			throw new Error("The visible user browser is unavailable.");
		return { ok: true, browserState: requestBrowserService.getState() };
	}
	if (request.type === "browser-open-file-tabs") {
		if (!requestBrowserService)
			throw new Error("The visible user browser is unavailable.");
		return {
			ok: true,
			...(await requestBrowserService.openFileTabs(request.paths, request.active)),
		};
	}
	if (request.type === "browser-file-preview") {
		if (!requestBrowserService)
			throw new Error("The visible user browser is unavailable.");
		return {
			ok: true,
			filePreview: await requestBrowserService.filePreview(request.tabId),
		};
	}
	if (request.type === "browser-open-file-default") {
		if (!requestBrowserService)
			throw new Error("The visible user browser is unavailable.");
		await requestBrowserService.openFileDefault(request.tabId);
		return { ok: true };
	}
	if (request.type === "browser-create-tab") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: await requestBrowserService.createTab(
          request.input,
          request.active,
        ),
      };
    }
    if (request.type === "browser-reopen-closed-tab") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: await requestBrowserService.reopenClosedTab(),
      };
    }
    if (request.type === "browser-close-tab") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: await requestBrowserService.closeTab(request.tabId),
      };
    }
    if (request.type === "browser-select-tab") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: await requestBrowserService.selectTab(request.tabId),
      };
    }
    if (request.type === "browser-navigate") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: await requestBrowserService.navigate(
          request.tabId,
          request.input,
        ),
      };
    }
    if (request.type === "browser-back") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: requestBrowserService.back(request.tabId),
      };
    }
    if (request.type === "browser-forward") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: requestBrowserService.forward(request.tabId),
      };
    }
    if (request.type === "browser-reload") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: requestBrowserService.reload(
          request.tabId,
          Boolean("ignoreCache" in request && request.ignoreCache),
        ),
      };
    }
    if (request.type === "browser-zoom-in") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: requestBrowserService.zoomIn(request.tabId),
      };
    }
    if (request.type === "browser-zoom-out") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: requestBrowserService.zoomOut(request.tabId),
      };
    }
    if (request.type === "browser-zoom-reset") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: requestBrowserService.zoomReset(request.tabId),
      };
    }
    if (request.type === "browser-stop") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: requestBrowserService.stop(request.tabId),
      };
    }
    if (request.type === "browser-get-context") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserContext: await requestBrowserService.pageContext(request.tabId),
      };
    }
    if (request.type === "browser-set-content-bounds") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      await requestBrowserService.setContentBounds(request.bounds, request.visible);
      return { ok: true };
    }
    if (request.type === "browser-update-settings") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: requestBrowserService.updateSettings(request.settings),
      };
    }
    if (request.type === "browser-clear-history") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: requestBrowserService.clearHistory(),
      };
    }
    if (request.type === "browser-clear-data") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: await requestBrowserService.clearBrowsingData({
          history: request.history,
          cookies: request.cookies,
          cache: request.cache,
        }),
      };
    }
    if (request.type === "browser-reveal-download") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      requestBrowserService.revealDownload(request.downloadId);
      return { ok: true };
    }
    if (request.type === "browser-open-download") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      await requestBrowserService.openDownload(request.downloadId);
      return { ok: true };
    }
    if (request.type === "browser-cancel-download") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: requestBrowserService.cancelDownload(request.downloadId),
      };
    }
    if (request.type === "browser-toggle-bookmark") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: requestBrowserService.toggleBookmark(
          request.url,
          request.title,
        ),
      };
    }
    if (request.type === "browser-remove-bookmark") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: requestBrowserService.removeBookmark(request.bookmarkId),
      };
    }
    if (request.type === "browser-pin-tab") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: requestBrowserService.pinTab(request.tabId, request.pinned),
      };
    }
    if (request.type === "browser-mute-tab") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: requestBrowserService.muteTab(request.tabId, request.muted),
      };
    }
    if (request.type === "browser-duplicate-tab") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: await requestBrowserService.duplicateTab(request.tabId),
      };
    }
    if (request.type === "browser-close-other-tabs") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: await requestBrowserService.closeOtherTabs(request.tabId),
      };
    }
    if (request.type === "browser-move-tab") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: requestBrowserService.moveTab(request.tabId, request.toIndex),
      };
    }
    if (request.type === "browser-detach-tab") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      const sourceState = requestBrowserService.getState();
      const tab = sourceState.tabs.find((candidate) => candidate.id === request.tabId);
      if (!tab || !tab.url || tab.error || tab.url.startsWith("kestrel://"))
        throw new Error("Only loaded web pages can open in a separate window.");
      const detachedWindow = createDetachedBrowserWindow(sourceState, tab);
      try {
        const browserState = await requestBrowserService.detachTab(request.tabId);
        return { ok: true, browserState };
      } catch (cause) {
        if (!detachedWindow.isDestroyed()) detachedWindow.close();
        throw cause;
      }
    }
    if (request.type === "browser-find-in-page") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: requestBrowserService.findInPage(
          request.tabId,
          request.query,
          {
            ...(request.findNext ? { findNext: true } : {}),
            ...(request.forward === false ? { forward: false } : {}),
          },
        ),
      };
    }
    if (request.type === "browser-stop-find-in-page") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: requestBrowserService.stopFindInPage(request.tabId),
      };
    }
    if (request.type === "browser-print") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: requestBrowserService.printTab(request.tabId),
      };
    }
    if (request.type === "browser-open-devtools") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: requestBrowserService.openDevTools(request.tabId),
      };
    }
    if (request.type === "browser-save-screenshot") {
      if (!userBrowserService)
        throw new Error("The visible user browser is unavailable.");
      const tab = userBrowserService
        .getState()
        .tabs.find((candidate) => candidate.id === request.tabId);
      const title = (tab?.title ?? "Kestrel page")
        .replace(/[^a-z0-9._-]+/gi, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80) || "Kestrel-page";
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace(/Z$/, "");
      const result = await dialog.showSaveDialog(senderWindow, {
        title: "Save page screenshot",
        defaultPath: join(app.getPath("downloads"), `${title}-${timestamp}.png`),
        filters: [{ name: "PNG image", extensions: ["png"] }],
      });
      if (result.canceled || !result.filePath)
        return { ok: true, cancelled: true };
      const filePath = result.filePath.toLowerCase().endsWith(".png")
        ? result.filePath
        : `${result.filePath}.png`;
      const frame = await userBrowserService.screenshot(request.tabId);
      if (!frame.png) throw new Error("The page screenshot was empty.");
      await writeFile(filePath, frame.png);
      return { ok: true, screenshotPath: filePath };
    }
    if (request.type === "browser-set-site-permission") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: requestBrowserService.setSitePermission(
          request.origin,
          request.permission,
          request.decision,
        ),
      };
    }
    if (request.type === "browser-list-extensions") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        extensions: requestBrowserService.listExtensions(),
      };
    }
    if (request.type === "browser-install-extension-url") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      const extension = await requestBrowserService.installExtensionUrl(
        request.urlOrId,
      );
      return { ok: true, extension };
    }
    if (request.type === "browser-install-extension-file") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      const result = await dialog.showOpenDialog(senderWindow, {
        title: "Install Extension",
        properties: ["openFile", "openDirectory"],
        filters: [{ name: "Extension Package", extensions: ["crx", "zip"] }],
      });
      if (result.canceled || !result.filePaths[0]) {
        return { ok: false, error: "Installation canceled" };
      }
      const selectedPath = result.filePaths[0];
      const stats = existsSync(selectedPath);
      if (!stats) return { ok: false, error: "File not found" };

      let extension: InstalledExtension;
      if (
        selectedPath.endsWith(".crx") ||
        selectedPath.endsWith(".zip")
      ) {
        extension = await requestBrowserService.installExtensionFile(selectedPath);
      } else {
        extension = await requestBrowserService.installExtensionFolder(
          selectedPath,
        );
      }
      return { ok: true, extension };
    }
    if (request.type === "browser-toggle-extension") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      const extension = await requestBrowserService.toggleExtension(
        request.extensionId,
        request.enabled,
      );
      return { ok: true, extension };
    }
    if (request.type === "browser-uninstall-extension") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      await requestBrowserService.uninstallExtension(request.extensionId);
      return { ok: true };
    }
    if (request.type === "browser-sleep-tab") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: requestBrowserService.sleepTab(request.tabId),
      };
    }
    if (request.type === "browser-sleep-inactive-tabs") {
      if (!requestBrowserService)
        throw new Error("The visible user browser is unavailable.");
      return {
        ok: true,
        browserState: requestBrowserService.sleepInactiveTabs(),
      };
    }
    if (request.type === "get-system-state") {
      const state = app.getLoginItemSettings();
      return {
        ok: true,
        launchAtLogin: state.openAtLogin,
        launchStatus:
          state.status ?? (state.openAtLogin ? "enabled" : "not-registered"),
        isDefaultBrowser: isDefaultBrowser(),
        userName: await localGreetingName(),
      };
    }
    if (request.type === "get-default-browser-status") {
      const canSetAsDefault = canRegisterAsDefaultBrowser(isPackagedKestrelApp);
      return {
        ok: true,
        isDefault: isDefaultBrowser(),
        canSetAsDefault,
      };
    }
    if (request.type === "set-default-browser") {
      const canSetAsDefault = canRegisterAsDefaultBrowser(isPackagedKestrelApp);
      const success = setAsDefaultBrowser();
      return {
        ok: true,
        isDefault: isDefaultBrowser(),
        canSetAsDefault,
        success,
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
          `${request.id === "codex" ? "Codex" : request.id === "claude" ? "Claude Code" : "OpenCode"} CLI was not found in a trusted local installation path.`,
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
    if (request.type === "list-workspace-files") {
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
          "Choose a currently granted task workspace before listing files.",
        );
      return {
        ok: true,
        workspaceFiles: await listWorkspaceFiles({
          workspaceRoot,
          ...(request.query ? { query: request.query } : {}),
          mediaTypeForPath,
        }),
      };
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
      await macWidgetsStore?.clear().catch(() => undefined);
      await rm(app.getPath("userData"), { recursive: true, force: true });
      app.relaunch();
      quitting = true;
      app.quit();
      return { ok: true };
    }
		if (request.type === "runtime-run-agent" && request.attachments?.some((attachment) => attachment.source === "external")) {
			if (!requestBrowserService)
				throw new Error("The selected file is no longer open in Kestrel.");
			for (const attachment of request.attachments) {
				if (attachment.source === "external" && !requestBrowserService.knownFilePath(attachment.path))
					throw new Error(
						"Kestrel only sends files that were explicitly opened or dropped into a file tab.",
					);
			}
		}
		const coreRequest = CoreRequestSchema.parse(request);
		const trackedStreamId =
			(request.type === "runtime-run-agent" ||
				request.type === "runtime-resume-agent" ||
				request.type === "runtime-retry-agent")
				? request.streamId
				: undefined;
		if (trackedStreamId) {
			activeAgentStreams.add(trackedStreamId);
			if (request.type === "runtime-run-agent")
				activeAgentTaskLabel = request.message.split(/\r?\n/, 1)[0]!.slice(0, 120);
			setAgentState("working");
		}
		if (
			request.type === "runtime-run-agent" ||
			request.type === "runtime-resume-agent" ||
			request.type === "runtime-retry-agent"
		)
			publishMacWidgetAgentState("working");
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
				const response = await supervisor.request(coreRequest);
				finishMacWidgetRun(response);
				return response;
			} finally {
				overlayAccess.finishStream(streamId);
				activeAgentStreams.delete(streamId);
			}
		}
		let response;
		try {
			response = await supervisor.request(coreRequest);
		} finally {
			if (trackedStreamId) activeAgentStreams.delete(trackedStreamId);
		}
		if (response.ok && response.snapshot) {
			setAgentState(response.snapshot.agentState);
			publishMacWidgetSnapshot(response.snapshot);
		}
		if (
			request.type === "runtime-run-agent" ||
			request.type === "runtime-resume-agent" ||
			request.type === "runtime-retry-agent"
		)
			finishMacWidgetRun(response);
    return response;
  });
}

async function initializeCoreForStartup(): Promise<boolean> {
  while (true) {
    try {
      await initializeCore();
      return true;
    } catch (cause) {
      const copy = startupRecoveryCopy(cause);
      if (!mainWindow && app.isReady()) {
        // Give the native recovery dialog an owning window. Without one,
        // macOS can leave the dialog behind the previously active app.
        mainWindow = createMainWindow();
        startupRecoveryWindowCreated = true;
      }
      mainWindow?.show();
      mainWindow?.focus();
      // Keep recovery visible and make a subsequent Dock click return here.
      app.focus({ steal: true });
      const options: Electron.MessageBoxOptions = {
        type: "error",
        title: `${PRODUCT_IDENTITY.productName} could not start`,
        message: copy.message,
        detail:
          copy.kind === "protected-database"
            ? `${copy.detail}\n\nBackup folder: ${join(app.getPath("userData"), "recovery")}`
            : copy.detail,
        buttons:
          copy.kind === "protected-database"
            ? ["Start fresh (keep backup)", "Try again", "Quit"]
            : ["Try again", "Quit"],
        defaultId: copy.kind === "protected-database" ? 1 : 0,
        cancelId: copy.kind === "protected-database" ? 2 : 1,
        noLink: true,
      };
      const result = mainWindow
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options);
      if (copy.kind === "protected-database" && result.response === 0) {
        try {
          await archiveProtectedProfile(app.getPath("userData"));
          // The failed attempt cached the old key. A new broker is required so
          // the first-run path creates a fresh protected key after the archive.
          appCredentialBroker = null;
          continue;
        } catch (archiveCause) {
          const detail =
            archiveCause instanceof Error
              ? archiveCause.message
              : "The protected profile could not be archived.";
          const archiveOptions: Electron.MessageBoxOptions = {
            type: "error",
            title: `${PRODUCT_IDENTITY.productName} could not create a backup`,
            message: "Kestrel left the existing profile unchanged.",
            detail: `${detail}\n\nFree disk space or close another Kestrel process, then try again.`,
            buttons: ["Try again", "Quit"],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
          };
          const archiveResult = mainWindow
            ? await dialog.showMessageBox(mainWindow, archiveOptions)
            : await dialog.showMessageBox(archiveOptions);
          if (archiveResult.response !== 0) return false;
          continue;
        }
      }
      const retryResponse = copy.kind === "protected-database" ? 1 : 0;
      if (result.response === retryResponse) continue;
      return false;
    }
  }
}

function replaceStartupRecoveryWindow(): void {
  const recoveryWindow = mainWindow;
  // Detach the recovery window before destroying it. Its asynchronous `closed`
  // handler must not clear or dispose the newly-created app window below.
  mainWindow = null;
  mainRendererDeepLinkReady = false;
  startupRecoveryWindowCreated = false;
  if (recoveryWindow && !recoveryWindow.isDestroyed()) recoveryWindow.destroy();
  mainWindow = createMainWindow();
}

app.on("second-instance", (_event, argv) => {
	const { deepLinks, webUrls } = urlsFromArgv(argv);
	const filePaths = filePathsFromArgv(argv);
	if (deepLinks.length === 0 && webUrls.length === 0 && filePaths.length === 0)
		showMainWindow();
	else {
		for (const deepLink of deepLinks) handleIncomingUrl(deepLink);
		for (const webUrl of webUrls) openIncomingWebUrl(webUrl);
		if (filePaths.length > 0)
			queueExternalIntake(filePaths, { kind: "open" });
	}
});

app.on("open-file", (event, path) => {
	event.preventDefault();
	queueExternalIntake([path], { kind: "open" });
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  handleIncomingUrl(url);
});
app.on("before-quit", () => {
  quitting = true;
});
app.on("will-quit", () => {
	providerAuthMonitor.stop();
		if (dockAnimationTimer) clearInterval(dockAnimationTimer);
		if (dockCompletionTimer) clearTimeout(dockCompletionTimer);
		tray?.destroy();
	tray = null;
	for (const service of new Set(browserWindowServices.values())) service.dispose();
  browserWindowServices.clear();
  userBrowserService = null;
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
    if (!singleInstance) return;
    if (canRegisterAsDefaultBrowser(isPackagedKestrelApp))
      app.setAsDefaultProtocolClient(PRODUCT_IDENTITY.protocol);
    registerIpc();
    if (!(await initializeCoreForStartup())) {
      quitting = true;
      app.quit();
      return;
    }
    coreStartupComplete = true;
    if (
      startupRecoveryWindowCreated &&
      mainWindow &&
      !mainWindow.isDestroyed()
    ) {
      // The recovery window may still be in its first load when the user
      // chooses Start fresh. Reloading during that navigation can strand an
      // Electron window on a blank page. Recreate it only after core startup
      // succeeds so the normal renderer gets one clean load.
      replaceStartupRecoveryWindow();
		}
		providerAuthMonitor.start();
		updateTray();
		initializeDock();
		const launchedAtLogin = app.getLoginItemSettings().wasOpenedAtLogin;
		if (!mainWindow) mainWindow = createMainWindow();
		for (const deepLink of initialExternalIntakeLinks)
			handleIncomingUrl(deepLink);
		deliverPendingWebUrls();
		void deliverPendingExternalIntakes();
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
        isPackagedKestrelApp,
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
    const copy = startupRecoveryCopy(cause);
    dialog.showErrorBox(
      `${PRODUCT_IDENTITY.productName} could not start`,
      `${copy.message}\n\n${copy.detail}`,
    );
    quitting = true;
    app.quit();
  });
