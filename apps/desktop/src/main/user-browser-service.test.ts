import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  class Emitter {
    handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    on(name: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
      return this;
    }
    once(name: string, handler: (...args: unknown[]) => void) {
      const once = (...args: unknown[]) => {
        this.off(name, once);
        handler(...args);
      };
      return this.on(name, once);
    }
    off(name: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(name, (this.handlers.get(name) ?? []).filter((item) => item !== handler));
      return this;
    }
    emit(name: string, ...args: unknown[]) {
      for (const handler of this.handlers.get(name) ?? []) handler(...args);
    }
  }

  let nextWebContentsId = 1;
  class MockWebContents extends Emitter {
    id = nextWebContentsId++;
    destroyed = false;
    url = "";
    mainFrame = { url: "" };
    passwordSnapshot: unknown = { fields: [] };
    title = "";
    loadURL = vi.fn(async (url: string) => {
      this.url = url;
      this.mainFrame.url = url;
    });
    send = vi.fn((channel: string, payload: unknown) => {
      if (
        channel !== "kestrel:user-browser-credential-command" ||
        !payload ||
        typeof payload !== "object" ||
        !["scan", "fill"].includes(String((payload as { type?: unknown }).type))
      )
        return;
      const requestId = (payload as { requestId?: unknown }).requestId;
      if (typeof requestId !== "string") return;
      queueMicrotask(() => {
        this.emit(
          "ipc-message",
          { senderFrame: this.mainFrame },
          "kestrel:user-browser-credential-response",
				(payload as { type?: unknown }).type === "scan"
					? { requestId, ok: true, snapshot: this.passwordSnapshot }
					: { requestId, ok: true, filled: 1 },
        );
      });
    });
    close = vi.fn(() => { this.destroyed = true; });
    reload = vi.fn();
    reloadIgnoringCache = vi.fn();
    zoomLevel = 0;
    zoomFactor = 1;
    getZoomLevel = vi.fn(() => this.zoomLevel);
    getZoomFactor = vi.fn(() => this.zoomFactor);
    setZoomLevel = vi.fn((level: number) => {
      this.zoomLevel = level;
      this.zoomFactor = Math.pow(1.2, level);
    });
    setZoomFactor = vi.fn((factor: number) => {
      this.zoomFactor = factor;
      this.zoomLevel = Math.log(factor) / Math.log(1.2);
    });
    stop = vi.fn();
    focus = vi.fn();
    insertText = vi.fn();
		sendInputEvent = vi.fn();
    executeJavaScript = vi.fn();
    invalidate = vi.fn();
    capturePage = vi.fn(async () => ({
      getSize: () => ({ width: 1, height: 1 }),
      toBitmap: () => Buffer.from([0, 0, 0, 255]),
      toPNG: () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    }));
    copyImageAt = vi.fn();
    copyVideoFrameAt = vi.fn();
    downloadURL = vi.fn();
    setWindowOpenHandler = vi.fn((handler) => { this.windowOpenHandler = (details) => {
      const result = handler(details);
      if (result.action === "allow") result.createWindow?.({ webPreferences: {} });
      return result;
    }; });
    windowOpenHandler: ((details: {
      url: string;
      disposition: "default" | "foreground-tab" | "background-tab" | "new-window" | "other";
      postBody?: {
        contentType: string;
        boundary?: string;
        data: Array<{ type: string; bytes: Buffer }>;
      };
      referrer?: { url: string; policy: string };
    }) => { action: string }) | undefined;
    isDestroyed = () => this.destroyed;
    getURL = () => this.url;
    getTitle = () => this.title;
    findInPage = vi.fn();
    stopFindInPage = vi.fn();
    print = vi.fn();
    openDevTools = vi.fn();
    setAudioMuted = vi.fn();
    navigationHistory = {
      canGoBack: vi.fn(() => false),
      canGoForward: vi.fn(() => false),
			getActiveIndex: vi.fn(() => 0),
			getEntryAtIndex: vi.fn(
				(_index: number): { url: string; title: string } | null => null,
			),
      goBack: vi.fn(),
      goForward: vi.fn(),
      clear: vi.fn(),
    };
    isCurrentlyAudible = vi.fn(() => false);
    debugger = { isAttached: vi.fn(() => false), attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn() };
  }
  class MockView {
    webContents = new MockWebContents();
    bounds: unknown;
    visible = false;
    constructor(public options: unknown) { state.views.push(this); }
    setBackgroundColor = vi.fn();
    setBounds = vi.fn((bounds: unknown) => { this.bounds = bounds; });
    setVisible = vi.fn((visible: boolean) => { this.visible = visible; });
  }
  class MockSession extends Emitter {
    requestHandler: ((details: {webContentsId: number; resourceType: string; url: string}, callback: (result: {cancel: boolean}) => void) => void) | undefined;
    webRequest = {onBeforeRequest: vi.fn((_filter, handler) => { this.requestHandler = handler; })};
    permissionCheckHandler: unknown;
    permissionRequestHandler: unknown;
    setPermissionCheckHandler = vi.fn((handler) => { this.permissionCheckHandler = handler; });
    setPermissionRequestHandler = vi.fn((handler) => { this.permissionRequestHandler = handler; });
    setSpellCheckerEnabled = vi.fn();
    setSpellCheckerLanguages = vi.fn();
    clearCache = vi.fn(async () => undefined);
    clearStorageData = vi.fn(async () => undefined);
    fetch = vi.fn();
  }
  const state: {
    views: MockView[];
    partitions: Array<{ name: string; options: unknown; instance: MockSession }>;
    menus: unknown[][];
    mediaAccess: ReturnType<typeof vi.fn>;
  } = { views: [], partitions: [], menus: [], mediaAccess: vi.fn(async () => true) };
  const buildFromTemplate = vi.fn((template: unknown[]) => {
    state.menus.push(template);
    return { popup: vi.fn() };
  });
  const fromPartition = vi.fn((name: string, options: unknown) => {
    const instance = new MockSession();
    state.partitions.push({ name, options, instance });
    return instance;
  });
  return { state, MockView, fromPartition, buildFromTemplate, reset: () => {
    state.views.length = 0;
    state.partitions.length = 0;
    state.menus.length = 0;
    state.mediaAccess.mockReset();
    state.mediaAccess.mockResolvedValue(true);
    nextWebContentsId = 1;
    fromPartition.mockClear();
    buildFromTemplate.mockClear();
  } };
});

vi.mock("electron", () => ({
  BrowserWindow: class {},
  WebContentsView: electron.MockView,
  session: { fromPartition: electron.fromPartition },
  Menu: { buildFromTemplate: electron.buildFromTemplate },
  clipboard: { writeText: vi.fn() },
  dialog: {
    showMessageBox: vi.fn(async () => ({ response: 1 })),
    showSaveDialog: vi.fn(async () => ({ canceled: true })),
  },
  systemPreferences: {
    askForMediaAccess: electron.state.mediaAccess,
  },
  nativeImage: {
    createFromBuffer: vi.fn(() => ({ isEmpty: () => true })),
    createFromDataURL: vi.fn(() => ({
      isEmpty: () => false,
      resize: () => ({ toDataURL: () => "data:image/png;base64,INLINE" }),
    })),
  },
  shell: {
    showItemInFolder: vi.fn(),
    openPath: vi.fn(async () => ""),
    openExternal: vi.fn(async () => undefined),
  },
}));

import { nativeImage } from "electron";
import { dialog } from "electron";
import { shell } from "electron";
import { BrowserTabStore } from "./browser-tab-store";
import {
  isAuthenticationFlowUrl,
  safeAppStoreUrl,
  safeZoomJoinUrl,
  safeTeamsUrl,
  UserBrowserService,
} from "./user-browser-service";
import type { BrowserThreatProvider } from "./browser-threat-provider";
import { UserBrowserSettingsSchema } from "@kestrel/shared-types";
import type {
  BrowserTabFolderName,
  BrowserTabFolderNamingGroup,
} from "@kestrel/shared-types";
import type {
	PaymentCardVault,
	SavePaymentCardInput,
} from "./payment-card-vault";
import type { PasswordVault, SavePasswordInput } from "./password-vault";

const directories: string[] = [];

afterEach(() => {
  electron.reset();
  vi.clearAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function createService(options: {
  partitionName?: string;
  now?: () => Date;
  allowDevTools?: boolean;
	onLastTabClosed?: () => void;
	passwordVault?: PasswordVault;
	onPasswordPrompt?: (prompt: unknown) => void;
	paymentCardVault?: PaymentCardVault;
  onPaymentPrompt?: (prompt: unknown) => void;
  confirmSitePermission?: (origin: string, permission: string) => Promise<boolean>;
  requestNativeMediaAccess?: (
    mediaType: "camera" | "microphone",
  ) => Promise<boolean>;
  nameTabFolders?: (
    groups: BrowserTabFolderNamingGroup[],
  ) => Promise<BrowserTabFolderName[]>;
	threatProvider?: BrowserThreatProvider;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "kestrel-user-browser-"));
  directories.push(directory);
  const children: unknown[] = [];
  const window = {
    getContentSize: vi.fn(() => [300, 200]),
    isDestroyed: vi.fn(() => false),
    webContents: { startDrag: vi.fn() },
    contentView: {
      children,
      addChildView: vi.fn((view: unknown) => children.push(view)),
      removeChildView: vi.fn((view: unknown) => {
        const index = children.indexOf(view);
        if (index >= 0) children.splice(index, 1);
      }),
    },
  };
  const events: unknown[] = [];
  const commands: string[] = [];
	const statePath = join(directory, "state.json");
	const service = new UserBrowserService({
		window: window as never,
		statePath,
		downloadDirectory: join(directory, "downloads"),
		onEvent: (event) => events.push(event),
		onCommand: (command) => commands.push(command),
		...(options.partitionName ? { partitionName: options.partitionName } : {}),
		...(options.now ? { now: options.now } : {}),
		...(options.allowDevTools === false ? { allowDevTools: false } : {}),
		...(options.onLastTabClosed
			? { onLastTabClosed: options.onLastTabClosed }
			: {}),
		...(options.onPasswordPrompt
			? { onPasswordPrompt: options.onPasswordPrompt }
			: {}),
		...(options.passwordVault
			? { passwordVault: options.passwordVault }
			: {}),
		...(options.onPaymentPrompt
			? { onPaymentPrompt: options.onPaymentPrompt }
			: {}),
		...(options.confirmSitePermission
			? { confirmSitePermission: options.confirmSitePermission }
			: {}),
		...(options.requestNativeMediaAccess
			? { requestNativeMediaAccess: options.requestNativeMediaAccess }
			: {}),
		...(options.paymentCardVault
			? { paymentCardVault: options.paymentCardVault }
			: {}),
		...(options.nameTabFolders
			? { nameTabFolders: options.nameTabFolders }
			: {}),
		...(options.threatProvider
			? { threatProvider: options.threatProvider }
			: {}),
	});
	return { service, window, events, commands, statePath };
}

async function navigateNewTab(service: UserBrowserService, url: string) {
  const state = await service.createTab(url, false);
  return state.tabs.at(-1)!;
}

function threatProvider(
	checkUrl: BrowserThreatProvider["checkUrl"],
): BrowserThreatProvider {
	return { id: "test-reputation", available: true, checkUrl };
}

function downloadItem(url: string, filename = "report.txt") {
	return {
		getFilename: vi.fn(() => filename),
		getURL: vi.fn(() => url),
		getReceivedBytes: vi.fn(() => 0),
		getTotalBytes: vi.fn(() => 10),
		setSavePath: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		on: vi.fn(),
		once: vi.fn(),
		cancel: vi.fn(),
	};
}

describe("UserBrowserService", () => {
	it("restores the committed page when a download event follows loadURL completion", async () => {
		const { service } = createService();
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://files.example/page");
		const contents = electron.state.views[0]!.webContents;
		contents.emit("did-navigate", {}, "https://files.example/page", 200, "OK");
		await service.navigate(tab.id, "https://files.example/report.pdf");
		const item = downloadItem("https://files.example/report.pdf", "report.pdf");
		electron.state.partitions[0]!.instance.emit("will-download", {}, item, contents);
		expect(service.getState().tabs.find((entry) => entry.id === tab.id)?.url).toBe("https://files.example/page");
		expect(item.setSavePath).toHaveBeenCalledOnce();
	});

	it("applies browser settings to the native session and persists them", async () => {
		const { service, statePath } = createService();
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://settings.example");
		const partition = electron.state.partitions[0]!.instance;
		const next = UserBrowserSettingsSchema.parse({
			...service.getState().settings,
			defaultZoomPercent: 125,
			minimumFontSize: 14,
			defaultFontFamily: "Georgia, serif",
			spellcheckEnabled: false,
			spellcheckLanguage: "fr-FR",
			historyRetentionDays: 30,
		});

		const updated = service.updateSettings(next);
		expect(updated.settings).toMatchObject({
			defaultZoomPercent: 125,
			minimumFontSize: 14,
			defaultFontFamily: "Georgia, serif",
			spellcheckEnabled: false,
			spellcheckLanguage: "fr-FR",
		});
		expect(partition.setSpellCheckerEnabled).toHaveBeenLastCalledWith(false);
		expect(partition.setSpellCheckerLanguages).toHaveBeenLastCalledWith([
			"fr-FR",
		]);
		expect(electron.state.views[0]!.webContents.setZoomFactor).toHaveBeenCalledWith(
			1.25,
		);
		expect(new BrowserTabStore(statePath).load().settings).toMatchObject({
			defaultZoomPercent: 125,
			minimumFontSize: 14,
			defaultFontFamily: "Georgia, serif",
			spellcheckEnabled: false,
			spellcheckLanguage: "fr-FR",
		});
	});

	it("canonicalizes and revokes site permissions without leaking paths in exports", async () => {
		const { service } = createService();
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://example.com/path");
		service.setSitePermission("https://example.com/path", "notifications", "allow");
		expect(service.getState().sitePermissions).toMatchObject([
			{ origin: "https://example.com", permission: "notifications" },
		]);

		const exported = service.exportBrowserData();
		expect(exported.settings.downloadDirectory).toBe("");
		service.clearSitePermission("https://example.com/other", "notifications");
		expect(service.getState().sitePermissions).toEqual([]);
	});

	it("pauses an ask-before-save download until the native location is chosen", async () => {
		const { service } = createService();
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://example.com");
		const contents = electron.state.views[0]!.webContents;
		const partition = electron.state.partitions[0]!.instance;
		service.updateSettings(
			UserBrowserSettingsSchema.parse({
				...service.getState().settings,
				downloadBehavior: "ask",
			}),
		);
		const chosenPath = join(tmpdir(), "kestrel-chosen-download.txt");
		vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({
			canceled: false,
			filePath: chosenPath,
		});
		const item = {
			getFilename: vi.fn(() => "report.txt"),
			getURL: vi.fn(() => "https://example.com/report.txt"),
			getReceivedBytes: vi.fn(() => 0),
			getTotalBytes: vi.fn(() => 10),
			setSavePath: vi.fn(),
			pause: vi.fn(),
			resume: vi.fn(),
			on: vi.fn(),
			once: vi.fn(),
			cancel: vi.fn(),
		};

		partition.emit("will-download", {}, item, contents);
		expect(item.pause).toHaveBeenCalledOnce();
		await vi.waitFor(() =>
			expect(item.setSavePath).toHaveBeenCalledWith(chosenPath),
		);
		expect(item.resume).toHaveBeenCalledOnce();
		expect(service.getState().downloads[0]?.filename).toBe("kestrel-chosen-download.txt");
	});

	it("reserves simultaneous download names and releases cancelled destinations", async () => {
		const { service } = createService();
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://example.com");
		const contents = electron.state.views[0]!.webContents;
		const partition = electron.state.partitions[0]!.instance;
		const startDownload = () => {
			const item = Object.assign(new EventEmitter(), {
				getFilename: () => "report.txt",
				getURL: () => "https://example.com/report.txt",
				getReceivedBytes: () => 0,
				getTotalBytes: () => 10,
				setSavePath: vi.fn(),
				cancel: vi.fn(),
			});
			partition.emit("will-download", {}, item, contents);
			return item;
		};
		const first = startDownload();
		const second = startDownload();
		expect(first.setSavePath).toHaveBeenCalledWith(expect.stringMatching(/\/report\.txt$/));
		expect(second.setSavePath).toHaveBeenCalledWith(expect.stringMatching(/\/report 2\.txt$/));
		first.emit("done", {}, "cancelled");
		const third = startDownload();
		expect(third.setSavePath).toHaveBeenCalledWith(first.setSavePath.mock.calls[0]![0]);
	});

	it("blocks a malicious typed navigation before loading and hides the native view", async () => {
		const provider = threatProvider(vi.fn(async () => ({
			verdict: "malicious" as const,
			provider: "test-reputation",
			threatTypes: ["malware" as const],
		})));
		const { service } = createService({ threatProvider: provider });
		const tab = service.getState().tabs[0]!;

		await service.navigate(tab.id, "https://malware.example/payload");
		const contents = electron.state.views[0]!.webContents;

		expect(provider.checkUrl).toHaveBeenCalledWith({
			url: "https://malware.example/payload",
			context: "navigation",
		});
		expect(contents.loadURL).not.toHaveBeenCalled();
		expect(contents.stop).toHaveBeenCalledOnce();
		expect(electron.state.views[0]!.setVisible).toHaveBeenLastCalledWith(false);
		expect(service.getState().tabs[0]?.blockedNavigation).toMatchObject({
			url: "https://malware.example/payload",
			source: "navigation",
			threatTypes: ["malware"],
		});
	});

	it("prevents and blocks a malicious page-initiated redirect", async () => {
		const provider = threatProvider(vi.fn(async ({ url }) => url.includes("malware")
			? { verdict: "malicious" as const, provider: "test-reputation", threatTypes: ["social-engineering" as const] }
			: { verdict: "safe" as const, provider: "test-reputation" }));
		const { service } = createService({ threatProvider: provider });
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://safe.example");
		const contents = electron.state.views[0]!.webContents;
		const event = { preventDefault: vi.fn() };

		contents.emit("will-redirect", event, "https://malware.example/redirect");
		const callback = vi.fn();
		electron.state.partitions[0]!.instance.requestHandler?.({webContentsId: contents.id, resourceType: "mainFrame", url: "https://malware.example/redirect"}, callback);
		await vi.waitFor(() => expect(service.getState().tabs[0]?.blockedNavigation).toMatchObject({
			url: "https://malware.example/redirect",
			source: "redirect",
		}));

		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(callback).toHaveBeenCalledWith({cancel: true});
		expect(contents.loadURL).not.toHaveBeenCalledWith("https://malware.example/redirect");
		expect(contents.stop).toHaveBeenCalledOnce();
	});

	it("blocks a malicious managed popup before its native page loads", async () => {
		const provider = threatProvider(
			vi.fn(async ({ url }) =>
				url.includes("malware")
					? {
							verdict: "malicious" as const,
							provider: "test-reputation",
							threatTypes: ["social-engineering" as const],
						}
					: { verdict: "safe" as const, provider: "test-reputation" },
			),
		);
		const { service } = createService({ threatProvider: provider });
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://safe.example");
		const contents = electron.state.views[0]!.webContents;

		const response = contents.windowOpenHandler?.({
			url: "https://malware.example/popup",
			disposition: "foreground-tab",
		});

		expect(response).toMatchObject({ action: "allow" });
		const child = electron.state.views.at(-1)!.webContents;
		const callback = vi.fn();
		electron.state.partitions[0]!.instance.requestHandler?.({webContentsId: child.id, resourceType: "mainFrame", url: "https://malware.example/popup"}, callback);
		await vi.waitFor(() =>
			expect(
				service
					.getState()
					.tabs.find((candidate) => candidate.blockedNavigation)?.blockedNavigation,
			).toMatchObject({
				url: "https://malware.example/popup",
				source: "popup",
			}),
		);
		expect(electron.state.views.at(-1)?.webContents.loadURL).not.toHaveBeenCalled();
	});

	it("redacts query and fragment data before an injected provider sees a URL", async () => {
		const provider = threatProvider(
			vi.fn(async () => ({
				verdict: "safe" as const,
				provider: "test-reputation",
			})),
		);
		const { service } = createService({ threatProvider: provider });
		const tab = service.getState().tabs[0]!;
		const target =
			"https://safe.example/callback?code=oauth-code&query=private#access_token=fragment-secret";

		await service.navigate(tab.id, target);

		expect(provider.checkUrl).toHaveBeenCalledWith({
			url: "https://safe.example/callback",
			context: "navigation",
		});
		expect(electron.state.views[0]!.webContents.loadURL).toHaveBeenCalledWith(
			target,
		);
	});

	it("checks a history target before a programmatic back navigation", async () => {
		const provider = threatProvider(
			vi.fn(async ({ url }) =>
				url.includes("malware")
					? {
							verdict: "malicious" as const,
							provider: "test-reputation",
							threatTypes: ["malware" as const],
						}
					: { verdict: "safe" as const, provider: "test-reputation" },
			),
		);
		const { service } = createService({ threatProvider: provider });
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://safe.example/current");
		const contents = electron.state.views[0]!.webContents;
		contents.navigationHistory.canGoBack.mockReturnValue(true);
		contents.navigationHistory.getActiveIndex.mockReturnValue(1);
		contents.navigationHistory.getEntryAtIndex.mockReturnValue({
			url: "https://malware.example/history",
			title: "Malware history",
		});

		service.back(tab.id);

		await vi.waitFor(() =>
			expect(service.getState().tabs[0]?.blockedNavigation).toMatchObject({
				url: "https://malware.example/history",
				source: "navigation",
			}),
		);
		expect(contents.navigationHistory.goBack).not.toHaveBeenCalled();
	});

	it("blocks a malicious download before choosing a destination", async () => {
		const provider = threatProvider(vi.fn(async () => ({
			verdict: "malicious" as const,
			provider: "test-reputation",
			threatTypes: ["potentially-harmful-application" as const],
		})));
		const { service } = createService({ threatProvider: provider });
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://safe.example");
		const item = downloadItem("https://malware.example/installer.dmg", "installer.dmg");

		electron.state.partitions[0]!.instance.emit("will-download", {}, item, electron.state.views[0]!.webContents);
		expect(item.pause).toHaveBeenCalledOnce();
		expect(item.setSavePath).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(item.cancel).toHaveBeenCalledOnce());

		expect(service.getState().downloads[0]).toMatchObject({
			status: "blocked",
			reputation: { verdict: "malicious", provider: "test-reputation", threatTypes: ["potentially-harmful-application"] },
		});
	});

	it("blocks a download when a redirect-chain URL is malicious", async () => {
		const provider = threatProvider(
			vi.fn(async ({ url }) =>
				url.includes("malware")
					? {
							verdict: "malicious" as const,
							provider: "test-reputation",
							threatTypes: ["malware" as const],
						}
					: { verdict: "safe" as const, provider: "test-reputation" },
			),
		);
		const { service } = createService({ threatProvider: provider });
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://safe.example");
		const item = {
			...downloadItem("https://safe.example/installer.dmg", "installer.dmg"),
			getURLChain: vi.fn(() => ["https://malware.example/redirect"]),
		};

		electron.state.partitions[0]!.instance.emit(
			"will-download",
			{},
			item,
			electron.state.views[0]!.webContents,
		);
		await vi.waitFor(() => expect(item.cancel).toHaveBeenCalledOnce());

		expect(provider.checkUrl).toHaveBeenCalledWith({
			url: "https://malware.example/redirect",
			context: "download",
		});
		expect(service.getState().downloads[0]).toMatchObject({
			status: "blocked",
			reputation: { verdict: "malicious", threatTypes: ["malware"] },
		});
	});

	it("resumes a safe download only after its reputation check", async () => {
		const provider = threatProvider(vi.fn(async () => ({ verdict: "safe" as const, provider: "test-reputation" })));
		const { service } = createService({ threatProvider: provider });
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://safe.example");
		const item = downloadItem("https://safe.example/report.txt");

		electron.state.partitions[0]!.instance.emit("will-download", {}, item, electron.state.views[0]!.webContents);
		expect(item.pause).toHaveBeenCalledOnce();
		await vi.waitFor(() => expect(item.resume).toHaveBeenCalledOnce());
		expect(item.setSavePath).toHaveBeenCalledOnce();
		expect(service.getState().downloads[0]).toMatchObject({
			status: "progressing",
			reputation: { verdict: "safe", provider: "test-reputation" },
		});
	});

	it("does not resume a download cancelled while its reputation check is pending", async () => {
		let resolveCheck: ((value: Awaited<ReturnType<BrowserThreatProvider["checkUrl"]>>) => void) | undefined;
		const checkUrl: BrowserThreatProvider["checkUrl"] = ({ context }) => context === "download"
			? new Promise((resolve) => { resolveCheck = resolve; })
			: Promise.resolve({ verdict: "safe" as const, provider: "test-reputation" });
		const provider = threatProvider(vi.fn(checkUrl));
		const { service } = createService({ threatProvider: provider });
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://safe.example");
		const item = downloadItem("https://safe.example/report.txt");

		electron.state.partitions[0]!.instance.emit("will-download", {}, item, electron.state.views[0]!.webContents);
		const id = service.getState().downloads[0]!.id;
		service.cancelDownload(id);
		resolveCheck?.({
			verdict: "malicious",
			provider: "test-reputation",
			threatTypes: ["malware"],
		});
		await Promise.resolve();

		expect(item.cancel).toHaveBeenCalledOnce();
		expect(item.resume).not.toHaveBeenCalled();
		expect(service.getState().downloads[0]?.status).toBe("cancelled");
	});

	it("does not resume a canceled download when its Save dialog resolves late", async () => {
		const provider = threatProvider(
			vi.fn(async () => ({ verdict: "safe" as const, provider: "test-reputation" })),
		);
		const { service } = createService({ threatProvider: provider });
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://safe.example");
		service.updateSettings(
			UserBrowserSettingsSchema.parse({
				...service.getState().settings,
				downloadBehavior: "ask",
			}),
		);
		type SaveDialogResult = Awaited<ReturnType<typeof dialog.showSaveDialog>>;
		let resolveDialog: ((result: SaveDialogResult) => void) | undefined;
		vi.mocked(dialog.showSaveDialog).mockImplementationOnce(
			() =>
				new Promise<SaveDialogResult>((resolve) => {
					resolveDialog = resolve;
				}),
		);
		const item = downloadItem("https://safe.example/report.txt");

		electron.state.partitions[0]!.instance.emit(
			"will-download",
			{},
			item,
			electron.state.views[0]!.webContents,
		);
		await vi.waitFor(() => expect(dialog.showSaveDialog).toHaveBeenCalledOnce());
		const id = service.getState().downloads[0]!.id;
		service.cancelDownload(id);
		resolveDialog?.({ canceled: false, filePath: join(tmpdir(), "late-save.txt") });
		await Promise.resolve();

		expect(item.cancel).toHaveBeenCalledOnce();
		expect(item.setSavePath).not.toHaveBeenCalled();
		expect(item.resume).not.toHaveBeenCalled();
		expect(service.getState().downloads[0]?.status).toBe("cancelled");
	});

	it("keeps the prior page when an address-bar navigation becomes a download", async () => {
		const { service, commands } = createService();
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://example.com");
		const contents = electron.state.views[0]!.webContents;
		contents.url = "https://example.com/";
		contents.title = "Example";
		contents.emit("did-navigate", {}, contents.url, 200, "OK");
		contents.emit("did-stop-loading");
		const partition = electron.state.partitions[0]!.instance;
		const downloadUrl = "https://files.example/report.pdf";
		const item = {
			getFilename: vi.fn(() => "report.pdf"),
			getURL: vi.fn(() => downloadUrl),
			getTotalBytes: vi.fn(() => 10),
			getReceivedBytes: vi.fn(() => 0),
			setSavePath: vi.fn(),
			on: vi.fn(),
			once: vi.fn(),
			cancel: vi.fn(),
		};
		contents.loadURL.mockImplementationOnce(async () => {
			throw new Error(`ERR_FAILED (-2) loading '${downloadUrl}'`);
		});

		const beforeDownloadEvent = await service.navigate(tab.id, downloadUrl);
		expect(beforeDownloadEvent.tabs[0]).toMatchObject({
			url: downloadUrl,
		});
		expect(beforeDownloadEvent.tabs[0]?.error).toMatch(/could not be opened/i);
		partition.emit("will-download", {}, item, contents);
		const state = service.getState();

		expect(state.tabs[0]).toMatchObject({
			url: "https://example.com/",
			title: "Example",
			loading: true,
			error: undefined,
		});
		expect(state.downloads[0]).toMatchObject({
			filename: "report.pdf",
			sourceUrl: downloadUrl,
			status: "progressing",
		});
		expect(commands).toContain("open-downloads");
		expect(contents.close).toHaveBeenCalledOnce();
		expect(electron.state.views.at(-1)!.webContents.loadURL).toHaveBeenCalledWith(
			"https://example.com/",
		);
	});

	 it("continues creating tabs beyond the legacy 32-tab boundary", async () => {
    const { service } = createService();
    const first = service.getState().tabs[0]!;
    await service.navigate(first.id, "https://first.example");
    const firstView = electron.state.views[0]?.webContents;

    for (let index = 0; index < 32; index += 1)
      await service.createTab(`https://tab-${index}.example`, false);

    expect(service.getState().tabs).toHaveLength(33);
    expect(service.getState().tabs.at(-1)?.url).toBe("https://tab-31.example/");

    expect(firstView?.windowOpenHandler?.({
      url: "https://opened-after-32.example/",
      disposition: "foreground-tab",
    })).toMatchObject({ action: "allow" });
    await vi.waitFor(() => expect(service.getState().tabs).toHaveLength(34));
  });

  it("creates, selects, and closes tabs, leaving no tabs when the last one closes", async () => {
    const onLastTabClosed = vi.fn();
    const { service } = createService({ onLastTabClosed });
    const first = service.getState().activeTabId!;
    const second = (await service.createTab()).activeTabId!;
    const third = (await service.createTab()).activeTabId!;

    await service.selectTab(second);
    expect(service.getState().activeTabId).toBe(second);

    await service.closeTab(second);
    expect(service.getState().activeTabId).toBe(third);
    await service.closeTab(third);
    await service.closeTab(first);
    const state = service.getState();
    expect(state.tabs).toHaveLength(0);
    expect(state.activeTabId).toBeNull();
    expect(onLastTabClosed).toHaveBeenCalledOnce();
  });

	it("closes other tabs as one state and native-view mutation", async () => {
		const { service, events, window } = createService();
		const keeper = service.getState().tabs[0]!;
		await service.navigate(keeper.id, "https://keeper.example/");
		const closing = [];
		for (let index = 0; index < 4; index += 1)
			closing.push(
				await navigateNewTab(service, `https://closing-${index}.example/`),
			);

		const eventCountBeforeClose = events.length;
		const closed = await service.closeOtherTabs(keeper.id);

		expect(closed.tabs.map((tab) => tab.id)).toEqual([keeper.id]);
		expect(service.getState().tabs.map((tab) => tab.id)).toEqual([keeper.id]);
		expect(events).toHaveLength(eventCountBeforeClose + 1);
		for (const tab of closing) {
			const view = electron.state.views.find(
				(candidate) => candidate.webContents.url === tab.url,
			);
			expect(view?.webContents.close).toHaveBeenCalledOnce();
		}
		expect(window.contentView.addChildView).toHaveBeenCalled();
	});

	it("ignores a duplicate close while the first close is still in flight", async () => {
		const { service } = createService();
		const tab = service.getState().tabs[0]!;
		const firstClose = service.closeTab(tab.id);
		const duplicateClose = service.closeTab(tab.id);

		await expect(duplicateClose).resolves.toMatchObject({ tabs: [] });
		await expect(firstClose).resolves.toMatchObject({ tabs: [] });
		expect(service.getState().tabs).toHaveLength(0);
	});

	it("opens kestrel app pages as tabs without creating a web view", async () => {
    const { service } = createService();
    const before = electron.state.views.length;
    const state = await service.createTab("kestrel://settings", true);
    const tab = state.tabs.find((item) => item.id === state.activeTabId)!;
    expect(tab).toMatchObject({
      title: "Settings",
      url: "kestrel://settings",
      loading: false,
	});

    expect(electron.state.views.length).toBe(before);
    await service.setContentBounds(
      { x: 0, y: 80, width: 800, height: 600 },
      true,
    );
			expect(electron.state.views.length).toBe(before);
	});

	it("opens local files as first-class tabs and exposes bounded external attachments", async () => {
		const { service } = createService();
		const root = mkdtempSync(join(tmpdir(), "kestrel-file-tab-fixture-"));
		directories.push(root);
		const path = join(root, "report.txt");
		writeFileSync(path, "A report from a local file tab.");

		const before = electron.state.views.length;
		const opened = await service.openFileTabs([path], true);
		const tab = opened.browserState.tabs.find(
			(item) => item.id === opened.browserState.activeTabId,
		)!;
		const preview = await service.filePreview(tab.id);

		expect(electron.state.views.length).toBe(before);
		expect(tab).toMatchObject({
			title: "report.txt",
			url: `kestrel://file/${tab.id}`,
			file: { path: realpathSync(path), name: "report.txt", status: "available" },
		});
		expect(opened.selectedAttachments).toMatchObject([
			{ path: realpathSync(path), name: "report.txt", source: "external" },
		]);
		expect(preview).toMatchObject({
			kind: "text",
			text: "A report from a local file tab.",
		});
	});

  it("attaches the web view before loading when navigating from a new tab", async () => {
    const { service, window } = createService();
    const tab = service.getState().tabs[0]!;
    const url = "https://www.google.com/search?q=ai%20tinkerers";
    await service.navigate(tab.id, url);
    const view = electron.state.views[0]!;
    expect(window.contentView.children).toContain(view);
    expect(view.visible).toBe(true);
    expect(view.webContents.loadURL).toHaveBeenCalledWith(url);
    const attachedAt = window.contentView.addChildView.mock.invocationCallOrder[0]!;
    const loadedAt = view.webContents.loadURL.mock.invocationCallOrder[0]!;
    expect(attachedAt).toBeLessThan(loadedAt);
  });

  it("starts a native drag for a completed download", async () => {
    const { service, window } = createService();
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://example.com");
    const contents = electron.state.views[0]!.webContents;
    const partition = electron.state.partitions[0]!.instance;
    let savePath = "";
    let done: ((event: unknown, status: string) => void) | undefined;
    const item = {
      getFilename: vi.fn(() => "report.txt"),
      getURL: vi.fn(() => "https://example.com/report.txt"),
      getReceivedBytes: vi.fn(() => 12),
      getTotalBytes: vi.fn(() => 12),
      setSavePath: vi.fn((path: string) => {
        savePath = path;
      }),
      on: vi.fn(),
      once: vi.fn(
        (_event: string, callback: (event: unknown, status: string) => void) => {
          done = callback;
        },
      ),
      cancel: vi.fn(),
    };

    partition.emit("will-download", {}, item, contents);
    writeFileSync(savePath, "downloaded file");
    done?.({}, "completed");
    const download = service.getState().downloads[0]!;

    service.startDownloadDrag(download.id);

    expect(window.webContents.startDrag).toHaveBeenCalledWith({
      file: savePath,
      icon: expect.anything(),
    });
  });

	it("locally converts HEIC browser uploads before replacing the file input", async () => {
		const { service } = createService();
		const sourceDirectory = mkdtempSync(join(tmpdir(), "kestrel-heic-upload-"));
		directories.push(sourceDirectory);
		const source = join(sourceDirectory, "camera-roll.HEIC");
		writeFileSync(
			source,
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
				"base64",
			),
		);
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://chatgpt.com/");
		const contents = electron.state.views[0]!.webContents;
		contents.debugger.sendCommand
			.mockResolvedValueOnce({ root: { nodeId: 1 } })
			.mockResolvedValueOnce({ nodeId: 2 })
			.mockResolvedValueOnce(undefined);

		contents.emit(
			"ipc-message",
			{ senderFrame: { url: "https://chatgpt.com/" } },
			"kestrel:user-browser-heic-upload",
			{ inputId: "heic-upload-123", paths: [source] },
		);

		await vi.waitFor(() =>
			expect(contents.debugger.sendCommand).toHaveBeenLastCalledWith(
				"DOM.setFileInputFiles",
				expect.objectContaining({ nodeId: 2 }),
			),
		);
		const replacedPaths = contents.debugger.sendCommand.mock.calls.at(-1)?.[1]
			?.files as string[];
		expect(replacedPaths).toHaveLength(1);
		expect(replacedPaths[0]).toMatch(/camera-roll\.jpeg$/i);
		expect(replacedPaths[0]).not.toEqual(source);
		expect(existsSync(replacedPaths[0]!)).toBe(true);
		expect(contents.send).not.toHaveBeenCalled();

		service.dispose();
		expect(existsSync(replacedPaths[0]!)).toBe(false);
	});

	it("offers to save submitted passwords only after a successful-looking navigation without exposing the secret", async () => {
		const save = vi.fn(async (_input: SavePasswordInput) => []);
		const passwordVault = {
			list: vi.fn(async () => []),
			listForOrigin: vi.fn(async () => []),
			save,
			getForOrigin: vi.fn(),
			remove: vi.fn(),
		} as unknown as PasswordVault;
		const prompts: unknown[] = [];
		const { service } = createService({
			passwordVault,
			onPasswordPrompt: (prompt) => prompts.push(prompt),
		});
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://login.example/sign-in");
		const contents = electron.state.views[0]!.webContents;

		contents.emit(
			"ipc-message",
			{ senderFrame: contents.mainFrame },
			"kestrel:user-browser-password-submission",
			{
				username: "person@example.test",
				password: "correct horse battery staple",
				passwordFieldRect: { x: 20, y: 80, width: 260, height: 42 },
			},
		);

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(prompts).toEqual([]);
		contents.url = "https://login.example/home";
		contents.mainFrame.url = contents.url;
		contents.emit("did-navigate", {}, contents.url, 200, "OK");
		await vi.waitFor(() => expect(prompts).toHaveLength(1));
		expect(prompts[0]).toMatchObject({
			mode: "save",
			origin: "https://login.example",
			candidate: { username: "person@example.test" },
		});
		expect(JSON.stringify(prompts[0])).not.toContain(
			"correct horse battery staple",
		);

		await service.savePasswordSuggestion();
		expect(save).toHaveBeenCalledWith({
			origin: "https://login.example",
			title: "login.example",
			username: "person@example.test",
			password: "correct horse battery staple",
		});
		expect(prompts.at(-1)).toBeNull();
	});

	it("offers a Microsoft-style credential save after the tracked return to its initiating site", async () => {
		const save = vi.fn(async (_input: SavePasswordInput) => []);
		const passwordVault = {
			list: vi.fn(async () => []),
			listForOrigin: vi.fn(async () => []),
			save,
			getForOrigin: vi.fn(),
			remove: vi.fn(),
		} as unknown as PasswordVault;
		const prompts: unknown[] = [];
		const { service } = createService({
			passwordVault,
			onPasswordPrompt: (prompt) => prompts.push(prompt),
		});
		const tab = service.getState().tabs[0]!;
		const contents = electron.state.views[0]?.webContents;
		await service.navigate(tab.id, "https://stlcc.example/login");
		const activeContents = contents ?? electron.state.views[0]!.webContents;
		activeContents.emit(
			"did-navigate",
			{},
			"https://stlcc.example/login",
			200,
			"OK",
		);
		await service.navigate(tab.id, "https://login.microsoftonline.com/sign-in");
		activeContents.emit(
			"did-navigate",
			{},
			"https://login.microsoftonline.com/sign-in",
			200,
			"OK",
		);
		activeContents.emit(
			"ipc-message",
			{ senderFrame: activeContents.mainFrame },
			"kestrel:user-browser-password-submission",
			{ username: "student@stlcc.example", password: "not-in-the-prompt" },
		);
		expect(
			(service as unknown as {
				pendingPasswordSave?: { flowInitiatingOrigin?: string; origin: string };
			}).pendingPasswordSave,
		).toMatchObject({
			origin: "https://login.microsoftonline.com",
			flowInitiatingOrigin: "https://stlcc.example",
		});
		activeContents.url = "https://stlcc.example/portal";
		activeContents.mainFrame.url = activeContents.url;
		activeContents.emit("did-navigate", {}, activeContents.url, 200, "OK");
		await vi.waitFor(() => expect(activeContents.send).toHaveBeenCalled());
		await vi.waitFor(() => expect(prompts).toHaveLength(1));
		expect(prompts[0]).toMatchObject({
			mode: "save",
			origin: "https://login.microsoftonline.com",
			candidate: { username: "student@stlcc.example" },
		});
		await service.savePasswordSuggestion();
		expect(save).toHaveBeenCalledWith(
			expect.objectContaining({
				origin: "https://login.microsoftonline.com",
				username: "student@stlcc.example",
			}),
		);
	});

	it("adds an origin to the never-save list from a successful save prompt", async () => {
		const passwordVault = {
			list: vi.fn(async () => []),
			listForOrigin: vi.fn(async () => []),
			getForOrigin: vi.fn(),
			save: vi.fn(),
			remove: vi.fn(),
		} as unknown as PasswordVault;
		const prompts: unknown[] = [];
		const { service } = createService({
			passwordVault,
			onPasswordPrompt: (prompt) => prompts.push(prompt),
		});
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://login.example/sign-in");
		const contents = electron.state.views[0]!.webContents;
		contents.emit(
			"ipc-message",
			{ senderFrame: contents.mainFrame },
			"kestrel:user-browser-password-submission",
			{ username: "person", password: "not-to-save" },
		);
		contents.passwordSnapshot = { fields: [] };
		contents.url = "https://login.example/home";
		contents.mainFrame.url = contents.url;
		contents.emit("did-navigate", {}, contents.url, 200, "OK");
		await vi.waitFor(() => expect(prompts.at(-1)).toMatchObject({ mode: "save" }));

		service.markNeverSavePasswordForActiveOrigin();
		expect(service.getState().settings.neverSavePasswordOrigins).toContain(
			"https://login.example",
		);
		expect(prompts.at(-1)).toBeNull();
	});

	it("continues a selected username-first login with the same opaque credential on the password page", async () => {
		const entry = {
			id: "password-00000000-0000-4000-8000-000000000001",
			origin: "https://login.microsoftonline.com",
			title: "Microsoft",
			username: "student@stlcc.example",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		};
		const passwordVault = {
			list: vi.fn(async () => [entry]),
			listForOrigin: vi.fn(async () => [entry]),
			getForOrigin: vi.fn(async () => ({ ...entry, password: "privileged-only" })),
			save: vi.fn(),
			remove: vi.fn(),
			markUsed: vi.fn(),
		} as unknown as PasswordVault;
		const prompts: unknown[] = [];
		const { service } = createService({
			passwordVault,
			onPasswordPrompt: (prompt) => prompts.push(prompt),
		});
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://login.microsoftonline.com/username");
		const contents = electron.state.views[0]!.webContents;
		contents.passwordSnapshot = {
			fields: [{
				id: "field-0",
				kind: "username",
				label: "Email, phone, or Skype",
				type: "email",
				autocomplete: "username",
				rect: { x: 10, y: 20, width: 260, height: 42 },
			}],
		};
		contents.emit("did-navigate", {}, contents.url, 200, "OK");
		await vi.waitFor(() =>
			expect(
				contents.send.mock.calls.filter(
					([channel, payload]) =>
						channel === "kestrel:user-browser-credential-command" &&
						(payload as { type?: unknown }).type === "fill",
				).length,
			).toBe(1),
		);
		await vi.waitFor(() => expect(passwordVault.markUsed).toHaveBeenCalledTimes(1));

		contents.passwordSnapshot = {
			fields: [{
				id: "field-0",
				kind: "password",
				label: "Password",
				type: "password",
				autocomplete: "current-password",
				rect: { x: 10, y: 20, width: 260, height: 42 },
			}],
		};
		contents.url = "https://login.microsoftonline.com/password";
		contents.mainFrame.url = contents.url;
		contents.emit("did-navigate", {}, contents.url, 200, "OK");
		await vi.waitFor(() =>
			expect(
				contents.send.mock.calls.filter(
					([channel, payload]) =>
						channel === "kestrel:user-browser-credential-command" &&
						(payload as { type?: unknown }).type === "fill",
				).length,
			).toBe(2),
		);
		expect(prompts).toEqual([]);
		expect(contents.sendInputEvent).not.toHaveBeenCalled();
		expect(passwordVault.getForOrigin).toHaveBeenCalledWith(
			entry.id,
			entry.origin,
		);
	});

	it("shows a credential picker instead of autofilling when an origin has multiple saved logins", async () => {
		const entries = [
			{
				id: "password-00000000-0000-4000-8000-000000000001",
				origin: "https://login.example",
				title: "Example",
				username: "personal@example.test",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
			{
				id: "password-00000000-0000-4000-8000-000000000002",
				origin: "https://login.example",
				title: "Example",
				username: "work@example.test",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		];
		const passwordVault = {
			list: vi.fn(async () => entries),
			listForOrigin: vi.fn(async () => entries),
			getForOrigin: vi.fn(),
			save: vi.fn(),
			remove: vi.fn(),
		} as unknown as PasswordVault;
		const prompts: unknown[] = [];
		const { service } = createService({
			passwordVault,
			onPasswordPrompt: (prompt) => prompts.push(prompt),
		});
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://login.example/sign-in");
		const contents = electron.state.views[0]!.webContents;
		contents.passwordSnapshot = {
			fields: [
				{
					id: "field-0",
					kind: "username",
					label: "Email",
					type: "email",
					autocomplete: "username",
					rect: { x: 10, y: 10, width: 260, height: 42 },
				},
				{
					id: "field-1",
					kind: "password",
					label: "Password",
					type: "password",
					autocomplete: "current-password",
					rect: { x: 10, y: 60, width: 260, height: 42 },
				},
			],
		};
		contents.emit("did-navigate", {}, contents.url, 200, "OK");

		await vi.waitFor(() => expect(prompts.at(-1)).toMatchObject({
			mode: "page",
			entries: entries.map((entry) => ({ id: entry.id, username: entry.username })),
		}));
		expect(
			contents.send.mock.calls.filter(
				([channel, payload]) =>
					channel === "kestrel:user-browser-credential-command" &&
					(payload as { type?: unknown }).type === "fill",
			).length,
		).toBe(0);
		expect(passwordVault.getForOrigin).not.toHaveBeenCalled();
		});

	it("lets an approved agent request an opaque matching-credential autofill", async () => {
		const entry = {
			id: "password-00000000-0000-4000-8000-000000000001",
			origin: "https://login.example",
			title: "Example",
			username: "person@example.test",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		};
		const passwordVault = {
			list: vi.fn(async () => [entry]),
			listForOrigin: vi.fn(async () => [entry]),
			getForOrigin: vi.fn(async () => ({ ...entry, password: "privileged-only" })),
			save: vi.fn(),
			remove: vi.fn(),
			markUsed: vi.fn(),
		} as unknown as PasswordVault;
		const { service } = createService({ passwordVault });
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://login.example/sign-in");
		const contents = electron.state.views[0]!.webContents;
		contents.passwordSnapshot = {
			fields: [
				{
					id: "field-0",
					kind: "username",
					label: "Email",
					type: "email",
					autocomplete: "username",
					rect: { x: 10, y: 10, width: 260, height: 42 },
				},
				{
					id: "field-1",
					kind: "password",
					label: "Password",
					type: "password",
					autocomplete: "current-password",
					rect: { x: 10, y: 60, width: 260, height: 42 },
				},
			],
		};

		const result = await service.handleAgentRequest(
			{ operation: "visible-autofill", tabId: tab.id },
			new AbortController().signal,
		);

		expect(result).toEqual({
			credentialAvailable: true,
			autofillResult: "filled",
			trust: "untrusted_browser",
		});
		expect(JSON.stringify(result)).not.toContain(entry.id);
		expect(JSON.stringify(result)).not.toContain(entry.username);
		expect(JSON.stringify(result)).not.toContain("privileged-only");
		expect(passwordVault.getForOrigin).toHaveBeenCalledWith(entry.id, entry.origin);
		expect(
			contents.send.mock.calls.some(
				([channel, payload]) =>
					channel === "kestrel:user-browser-credential-command" &&
					(payload as { type?: unknown }).type === "fill",
			),
		).toBe(true);
	});

	it("does not let an agent choose between multiple saved credentials", async () => {
		const entries = [
			{
				id: "password-00000000-0000-4000-8000-000000000001",
				origin: "https://login.example",
				title: "Example",
				username: "personal@example.test",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
			{
				id: "password-00000000-0000-4000-8000-000000000002",
				origin: "https://login.example",
				title: "Example",
				username: "work@example.test",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		];
		const passwordVault = {
			list: vi.fn(async () => entries),
			listForOrigin: vi.fn(async () => entries),
			getForOrigin: vi.fn(),
			save: vi.fn(),
			remove: vi.fn(),
		} as unknown as PasswordVault;
		const { service } = createService({ passwordVault });
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://login.example/sign-in");
		const contents = electron.state.views[0]!.webContents;
		contents.passwordSnapshot = {
			fields: [
				{
					id: "field-0",
					kind: "password",
					label: "Password",
					type: "password",
					autocomplete: "current-password",
					rect: { x: 10, y: 60, width: 260, height: 42 },
				},
			],
		};

		const result = await service.handleAgentRequest(
			{ operation: "visible-autofill", tabId: tab.id },
			new AbortController().signal,
		);

		expect(result).toEqual({
			credentialAvailable: true,
			autofillResult: "selection_required",
			trust: "untrusted_browser",
		});
		expect(JSON.stringify(result)).not.toContain(entries[0]!.username);
		expect(JSON.stringify(result)).not.toContain(entries[1]!.username);
		expect(passwordVault.getForOrigin).not.toHaveBeenCalled();
	});

	it("detects a dynamically inserted sign-in form through the preload bridge", async () => {
		const entry = {
			id: "password-00000000-0000-4000-8000-000000000001",
			origin: "https://login.example",
			title: "Example",
			username: "person@example.test",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		};
		const passwordVault = {
			list: vi.fn(async () => [entry]),
			listForOrigin: vi.fn(async () => [entry]),
			getForOrigin: vi.fn(async () => ({ ...entry, password: "privileged-only" })),
			save: vi.fn(),
			remove: vi.fn(),
			markUsed: vi.fn(),
		} as unknown as PasswordVault;
		const { service } = createService({ passwordVault });
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://login.example/sign-in");
		const contents = electron.state.views[0]!.webContents;
		contents.passwordSnapshot = {
			fields: [
				{
					id: "field-0",
					kind: "username",
					label: "Email",
					type: "email",
					autocomplete: "username",
					rect: { x: 10, y: 10, width: 260, height: 42 },
				},
				{
					id: "field-1",
					kind: "password",
					label: "Password",
					type: "password",
					autocomplete: "current-password",
					rect: { x: 10, y: 60, width: 260, height: 42 },
				},
			],
		};
		contents.emit(
			"ipc-message",
			{ senderFrame: contents.mainFrame },
			"kestrel:user-browser-password-form-changed",
		);

		await vi.waitFor(() =>
			expect(
				contents.send.mock.calls.some(
					([channel, payload]) =>
						channel === "kestrel:user-browser-credential-command" &&
						(payload as { type?: unknown }).type === "fill",
				),
			).toBe(true),
		);
	});

	it("fills a generated password into all new-password fields and stages it only after submit", async () => {
		const save = vi.fn(async (_input: SavePasswordInput) => []);
		const passwordVault = {
			list: vi.fn(async () => []),
			listForOrigin: vi.fn(async () => []),
			getForOrigin: vi.fn(),
			save,
			remove: vi.fn(),
		} as unknown as PasswordVault;
		const prompts: unknown[] = [];
		const { service } = createService({
			passwordVault,
			onPasswordPrompt: (prompt) => prompts.push(prompt),
		});
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://accounts.example/sign-up");
		const contents = electron.state.views[0]!.webContents;
		contents.passwordSnapshot = {
			fields: [
				{
					id: "field-0",
					kind: "username",
					label: "Email",
					type: "email",
					autocomplete: "username",
					rect: { x: 10, y: 10, width: 260, height: 42 },
				},
				{
					id: "field-1",
					kind: "new-password",
					label: "New password",
					type: "password",
					autocomplete: "new-password",
					rect: { x: 10, y: 60, width: 260, height: 42 },
				},
				{
					id: "field-2",
					kind: "new-password",
					label: "Confirm password",
					type: "password",
					autocomplete: "new-password",
					rect: { x: 10, y: 110, width: 260, height: 42 },
				},
			],
		};
		contents.emit("did-navigate", {}, contents.url, 200, "OK");
		await vi.waitFor(() => expect(prompts.at(-1)).toMatchObject({ mode: "generate" }));

		await service.generatePasswordForActiveForm();
		const fills = contents.send.mock.calls
			.filter(
				([channel, payload]) =>
					channel === "kestrel:user-browser-credential-command" &&
					(payload as { type?: unknown }).type === "fill",
			)
			.map(([, payload]) => payload as { password: string; fieldId: string });
		expect(fills).toHaveLength(2);
		expect(fills.map((fill) => fill.fieldId)).toEqual(["field-1", "field-2"]);
		const generated = fills[0]!.password;
		expect(fills.every((fill) => fill.password === generated)).toBe(true);
		expect(generated).toHaveLength(20);
		expect(generated).toMatch(/[A-Z]/);
		expect(generated).toMatch(/[a-z]/);
		expect(generated).toMatch(/[0-9]/);
		expect(generated).toMatch(/[^A-Za-z0-9]/);
		expect(JSON.stringify(prompts)).not.toContain(generated);

		contents.emit(
			"ipc-message",
			{ senderFrame: contents.mainFrame },
			"kestrel:user-browser-password-submission",
			{ username: "person@example.test", password: generated },
		);
		contents.passwordSnapshot = { fields: [] };
		contents.url = "https://accounts.example/welcome";
		contents.mainFrame.url = contents.url;
		contents.emit("did-navigate", {}, contents.url, 200, "OK");
		await vi.waitFor(() => expect(prompts.at(-1)).toMatchObject({ mode: "save" }));
		await service.savePasswordSuggestion();
		expect(save).toHaveBeenCalledWith(
			expect.objectContaining({
				origin: "https://accounts.example",
				username: "person@example.test",
				password: generated,
			}),
		);
	});

	it("does not offer or save a submitted password after a failed login navigation", async () => {
		const save = vi.fn(async (_input: SavePasswordInput) => []);
		const passwordVault = {
			list: vi.fn(async () => []),
			listForOrigin: vi.fn(async () => []),
			save,
			getForOrigin: vi.fn(),
			remove: vi.fn(),
		} as unknown as PasswordVault;
		const prompts: unknown[] = [];
		const { service } = createService({
			passwordVault,
			onPasswordPrompt: (prompt) => prompts.push(prompt),
		});
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://login.example/sign-in");
		const contents = electron.state.views[0]!.webContents;
		contents.emit(
			"ipc-message",
			{ senderFrame: contents.mainFrame },
			"kestrel:user-browser-password-submission",
			{ username: "person", password: "not-saved" },
		);
		contents.passwordSnapshot = {
			fields: [{
				id: "field-0",
				kind: "password",
				label: "Password",
				type: "password",
				autocomplete: "current-password",
				rect: { x: 20, y: 80, width: 260, height: 42 },
			}],
		};
		contents.url = "https://login.example/sign-in?error=invalid";
		contents.mainFrame.url = contents.url;
		contents.emit("did-navigate", {}, contents.url, 200, "OK");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(prompts).toEqual([]);

		await expect(service.savePasswordSuggestion()).rejects.toThrow(
			"no longer available",
		);
		expect(save).not.toHaveBeenCalled();
	});

	it("clears a submitted password when the tab goes to an unrelated HTTPS origin", async () => {
		const save = vi.fn(async (_input: SavePasswordInput) => []);
		const passwordVault = {
			list: vi.fn(async () => []),
			listForOrigin: vi.fn(async () => []),
			save,
			getForOrigin: vi.fn(),
			remove: vi.fn(),
		} as unknown as PasswordVault;
		const prompts: unknown[] = [];
		const { service } = createService({
			passwordVault,
			onPasswordPrompt: (prompt) => prompts.push(prompt),
		});
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://login.example/sign-in");
		const contents = electron.state.views[0]!.webContents;
		contents.emit(
			"ipc-message",
			{ senderFrame: contents.mainFrame },
			"kestrel:user-browser-password-submission",
			{ username: "person", password: "not-saved" },
		);
		contents.url = "https://unrelated.example/home";
		contents.mainFrame.url = contents.url;
		contents.emit("did-navigate", {}, contents.url, 200, "OK");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(prompts).toEqual([]);
		await expect(service.savePasswordSuggestion()).rejects.toThrow(
			"no longer available",
		);
		expect(save).not.toHaveBeenCalled();
	});

	it("keeps only the latest submitted secret pending until success confirmation", async () => {
		const save = vi.fn(async (_input: SavePasswordInput) => []);
		const passwordVault = {
			list: vi.fn(async () => []),
			listForOrigin: vi.fn(async () => []),
			save,
			getForOrigin: vi.fn(),
			remove: vi.fn(),
		} as unknown as PasswordVault;
		const prompts: unknown[] = [];
		const { service } = createService({
			passwordVault,
			onPasswordPrompt: (prompt) => prompts.push(prompt),
		});
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://login.example/sign-in");
		const contents = electron.state.views[0]!.webContents;
		const submission = (password: string) =>
			contents.emit(
				"ipc-message",
				{ senderFrame: contents.mainFrame },
				"kestrel:user-browser-password-submission",
				{ username: "person", password },
			);

		submission("first-secret");
		submission("second-secret");
		contents.url = "https://login.example/home";
		contents.mainFrame.url = contents.url;
		contents.emit("did-navigate", {}, contents.url, 200, "OK");
		await vi.waitFor(() => expect(prompts).toHaveLength(1));

		await service.savePasswordSuggestion();
		expect(save).toHaveBeenCalledWith(
			expect.objectContaining({ password: "second-secret" }),
		);
		expect(prompts).toHaveLength(2);
	});

	it("does not accept a password submission from another origin", async () => {
		const passwordVault = {
			list: vi.fn(async () => []),
			listForOrigin: vi.fn(async () => []),
			save: vi.fn(),
			getForOrigin: vi.fn(),
			remove: vi.fn(),
		} as unknown as PasswordVault;
		const prompts: unknown[] = [];
		const { service } = createService({
			passwordVault,
			onPasswordPrompt: (prompt) => prompts.push(prompt),
		});
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://login.example/sign-in");
		const contents = electron.state.views[0]!.webContents;

		contents.emit(
			"ipc-message",
			{ senderFrame: { url: "https://attacker.example/login" } },
			"kestrel:user-browser-password-submission",
			{ username: "person", password: "not-saved" },
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(prompts).toEqual([]);
		expect(passwordVault.listForOrigin).not.toHaveBeenCalled();
	});

  it("offers to save a complete card without exposing its number to the prompt", async () => {
		const save = vi.fn(async (_input: SavePaymentCardInput) => []);
    const paymentCardVault = {
      list: vi.fn(async () => []),
      save,
      get: vi.fn(),
      remove: vi.fn(),
    } as unknown as PaymentCardVault;
    const prompts: unknown[] = [];
    const { service } = createService({
      paymentCardVault,
      onPaymentPrompt: (prompt) => prompts.push(prompt),
    });
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://pay.example/checkout");
    const contents = electron.state.views[0]!.webContents;
    contents.executeJavaScript.mockResolvedValueOnce({
      fields: [{
        id: "payment-field-0",
        kind: "card-number",
        label: "Card number",
        type: "text",
        autocomplete: "cc-number",
        rect: { x: 20, y: 30, width: 300, height: 42 },
      }],
      candidate: {
        brand: "Mastercard",
        last4: "4444",
        expirationMonth: "03",
        expirationYear: "31",
      },
    });

    contents.emit("did-stop-loading");
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toMatchObject({
      mode: "save",
      candidate: { brand: "Mastercard", last4: "4444" },
    });
    expect(JSON.stringify(prompts[0])).not.toContain("5555555555554444");
  });

  it("reads card fields only in the main process and never includes the security code", async () => {
		const save = vi.fn(async (_input: SavePaymentCardInput) => []);
    const paymentCardVault = {
      save,
    } as unknown as PaymentCardVault;
    const { service } = createService({ paymentCardVault });
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://pay.example/checkout");
    const contents = electron.state.views[0]!.webContents;
    contents.executeJavaScript.mockResolvedValueOnce({
      fields: [
        {
          id: "payment-field-0",
          kind: "card-number",
          label: "Card number",
          type: "text",
          autocomplete: "cc-number",
          rect: { x: 20, y: 30, width: 300, height: 42 },
          value: "5555 5555 5555 4444",
        },
        {
          id: "payment-field-1",
          kind: "expiration",
          label: "Expiration",
          type: "text",
          autocomplete: "cc-exp",
          rect: { x: 20, y: 80, width: 120, height: 42 },
          value: "03/31",
        },
        {
          id: "payment-field-2",
          kind: "security-code",
          label: "Security code",
          type: "password",
          autocomplete: "cc-csc",
          rect: { x: 160, y: 80, width: 120, height: 42 },
          value: "123",
        },
      ],
    });

    await service.savePaymentCardFromActiveTab("https://pay.example");
    expect(save).toHaveBeenCalledWith({
      cardNumber: "5555 5555 5555 4444",
      expirationMonth: "03",
      expirationYear: "31",
      cardholderName: "",
      postalCode: "",
    });
    expect(save.mock.calls[0]?.[0]).not.toHaveProperty("securityCode");
  });

  it("retains one healthy web view and its navigation history across addresses", async () => {
    const { service } = createService();
    const tab = service.getState().tabs[0]!;

    await service.navigate(tab.id, "https://example.com/one");
    const view = electron.state.views[0]!;
    view.webContents.navigationHistory.canGoBack.mockReturnValue(true);

    await service.navigate(tab.id, "https://example.com/two");
    view.webContents.emit("did-stop-loading");

    expect(electron.state.views).toEqual([view]);
    expect(view.webContents.close).not.toHaveBeenCalled();
    expect(view.webContents.loadURL.mock.calls).toEqual([
      ["https://example.com/one"],
      ["https://example.com/two"],
    ]);
    expect(service.getState().tabs[0]).toMatchObject({
      url: "https://example.com/two",
      canGoBack: true,
    });
  });

  it("uses the production persistent partition by default and preserves an explicit custom partition", () => {
    const first = createService();
    expect(electron.state.partitions[0]).toMatchObject({
      name: "persist:kestrel-user-browser-v1",
      options: { cache: true },
    });
    first.service.dispose();

    const second = createService({ partitionName: "persist:customer-profile" });
    expect(electron.state.partitions[1]).toMatchObject({
      name: "persist:customer-profile",
      options: { cache: true },
    });
    expect(electron.state.views).toEqual([]);
    second.service.dispose();
  });

  it("rejects non-persistent or unsafe user profile partitions", () => {
    expect(() => createService({ partitionName: "temporary-profile" })).toThrow(
      "persistent profiles",
    );
    expect(() =>
      createService({ partitionName: "persist:profile/escape" }),
    ).toThrow("persistent profiles");
  });

  it("denies permission checks and requests by default", async () => {
    const { service } = createService();
    const partition = electron.state.partitions[0]!.instance as unknown as {
      permissionCheckHandler: (webContents: unknown, permission: string, requestingOrigin: string) => boolean;
      permissionRequestHandler: (webContents: unknown, permission: string, callback: (isAllowed: boolean) => void) => void;
    };
    expect(partition.permissionCheckHandler({}, "notifications", "https://example.com")).toBe(false);
    const callback = vi.fn();
    partition.permissionRequestHandler({}, "media", callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(false));
    service.dispose();
  });

  it("requests native camera and microphone access for a website media request", async () => {
    const confirmSitePermission = vi.fn(async () => true);
    const requestNativeMediaAccess = vi.fn(async () => true);
    const { service } = createService({
      confirmSitePermission,
      requestNativeMediaAccess,
    });
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://example.com/call");
    const contents = electron.state.views[0]!.webContents;
    const partition = electron.state.partitions[0]!.instance as unknown as {
      permissionRequestHandler: (
        webContents: unknown,
        permission: string,
        callback: (isAllowed: boolean) => void,
        details?: {
          requestingUrl?: string;
          securityOrigin?: string;
          mediaTypes?: string[];
        },
      ) => void;
    };
    const callback = vi.fn();

    partition.permissionRequestHandler(contents, "media", callback, {
      requestingUrl: "https://example.com/call",
      securityOrigin: "https://example.com",
      mediaTypes: ["audio", "video"],
    });

    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(true));
    expect(confirmSitePermission).toHaveBeenCalledWith(
      "https://example.com",
      "camera and microphone",
    );
    expect(requestNativeMediaAccess.mock.calls).toEqual([
      ["camera"],
      ["microphone"],
    ]);
    expect(service.getState().sitePermissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          origin: "https://example.com",
          permission: "camera",
          decision: "allow",
        }),
        expect.objectContaining({
          origin: "https://example.com",
          permission: "microphone",
          decision: "allow",
        }),
      ]),
    );
    service.dispose();
  });

  it("keeps camera and microphone site decisions separate", async () => {
    const { service } = createService();
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://example.com");
    const contents = electron.state.views[0]!.webContents;
    const partition = electron.state.partitions[0]!.instance as unknown as {
      permissionCheckHandler: (
        webContents: unknown,
        permission: string,
        requestingOrigin: string,
        details?: { mediaType?: string },
      ) => boolean;
    };

    service.setSitePermission("https://example.com", "camera", "allow");
    service.setSitePermission("https://example.com", "microphone", "deny");

    expect(
      partition.permissionCheckHandler(contents, "media", "https://example.com", {
        mediaType: "video",
      }),
    ).toBe(true);
    expect(
      partition.permissionCheckHandler(contents, "media", "https://example.com", {
        mediaType: "audio",
      }),
    ).toBe(false);
    service.dispose();
  });

  it("does not grant website media when native access is denied", async () => {
    const confirmSitePermission = vi.fn(async () => true);
    const requestNativeMediaAccess = vi.fn(async (mediaType: "camera" | "microphone") =>
      mediaType === "camera",
    );
    const { service } = createService({
      confirmSitePermission,
      requestNativeMediaAccess,
    });
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://example.com/camera");
    const contents = electron.state.views[0]!.webContents;
    const partition = electron.state.partitions[0]!.instance as unknown as {
      permissionRequestHandler: (
        webContents: unknown,
        permission: string,
        callback: (isAllowed: boolean) => void,
        details?: { requestingUrl?: string; mediaTypes?: string[] },
      ) => void;
    };
    const callback = vi.fn();

    partition.permissionRequestHandler(contents, "media", callback, {
      requestingUrl: "https://example.com/camera",
      mediaTypes: ["video", "audio"],
    });

    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(false));
    expect(requestNativeMediaAccess).toHaveBeenCalledWith("camera");
    expect(requestNativeMediaAccess).toHaveBeenCalledWith("microphone");
    service.dispose();
  });

  it("clamps visible content bounds to the BrowserWindow content area", async () => {
    const { service } = createService();
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "example.com");
    const view = electron.state.views[0]!;

    await service.setContentBounds({ x: 10.4, y: -7, width: 1_000, height: 1_000 }, true);
    expect(view.bounds).toEqual({ x: 10, y: 0, width: 290, height: 200 });
    expect(view.visible).toBe(true);

    await service.setContentBounds({ x: 500, y: 500, width: 100, height: 100 }, true);
    expect(view.bounds).toEqual({ x: 10, y: 0, width: 290, height: 200 });
    expect(view.visible).toBe(false);
  });

  it("captures the active page before releasing its native view for a menu", async () => {
    const { service } = createService();
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://example.com");
    const view = electron.state.views[0]!;

    const preview = await service.setContentBounds(
      { x: 0, y: 0, width: 300, height: 200 },
      false,
    );

    expect(preview).toMatch(/^data:image\/png;base64,/);
    expect(view.webContents.capturePage).toHaveBeenCalledOnce();
    expect(view.visible).toBe(false);
  });

  it("builds an Edge-like image context menu with safe native actions", async () => {
    const { service, commands } = createService();
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://example.com/article");
    const contents = electron.state.views[0]!.webContents;
    const imageURL = "https://cdn.example.test/hero.png";
    const savePath = join(tmpdir(), "kestrel-context-hero.png");

    contents.emit("context-menu", {}, {
      x: 42,
      y: 64,
      linkURL: "https://example.com/gallery",
      linkText: "Gallery",
      pageURL: "https://example.com/article",
      frameURL: "https://example.com/article",
      srcURL: imageURL,
      mediaType: "image",
      hasImageContents: true,
      isEditable: false,
      selectionText: "",
      titleText: "",
      altText: "Hero",
      suggestedFilename: "hero.png",
      selectionRect: { x: 0, y: 0, width: 0, height: 0 },
      selectionStartOffset: 0,
      referrerPolicy: "strict-origin-when-cross-origin",
      misspelledWord: "",
      dictionarySuggestions: [],
      frameCharset: "UTF-8",
      formControlType: "none",
      spellcheckEnabled: true,
      inputFieldType: "none",
      menuSourceType: "mouse",
    });

    const template = electron.state.menus.at(-1) as Array<{
      label?: string;
      role?: string;
      type?: string;
      submenu?: Array<{ label?: string; click?: () => void }>;
      click?: () => void;
    }>;
    const labels = template.map((item) => item.label ?? item.role ?? item.type);
    expect(labels).toEqual([
      "Open Image in New Tab",
      "Save Image As…",
      "Copy Image",
      "Copy Image Address",
      "separator",
      "Open Link in New Tab",
      "Save Link As…",
      "Copy Link",
      "separator",
      "Back",
      "Forward",
      "reload",
      "separator",
      "Bookmark This Page",
      "Print…",
      "Screenshot",
      "More tools",
      "separator",
      "Inspect",
    ]);
    expect(template.find((item) => item.label === "More tools")?.submenu?.map((item) => item.label)).toEqual([
      "Find in page",
      undefined,
      "Downloads",
      "Bookmarks",
      "Settings",
      "Command Center",
      "Keyboard shortcuts",
    ]);

    template.find((item) => item.label === "Copy Image")?.click?.();
    expect(contents.copyImageAt).toHaveBeenCalledWith(42, 64);

    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({
      canceled: false,
      filePath: savePath,
    });
    template.find((item) => item.label === "Save Image As…")?.click?.();
    await vi.waitFor(() =>
      expect(contents.downloadURL).toHaveBeenCalledWith(imageURL),
    );
    const item = {
      getFilename: vi.fn(() => "hero.png"),
      getURL: vi.fn(() => imageURL),
      getReceivedBytes: vi.fn(() => 0),
      getTotalBytes: vi.fn(() => 10),
      setSavePath: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
    };
    electron.state.partitions[0]!.instance.emit("will-download", {}, item, contents);
    await vi.waitFor(() => expect(item.setSavePath).toHaveBeenCalledWith(savePath));

    template.find((item) => item.label === "Screenshot")?.click?.();
    template
      .find((item) => item.label === "More tools")
      ?.submenu?.find((item) => item.label === "Find in page")
      ?.click?.();
    expect(commands).toEqual(["save-screenshot", "find-in-page"]);
  });

  it("removes a detached page from the source browser service", async () => {
    const { service, window } = createService();
    const first = service.getState().tabs[0]!;
    await service.navigate(first.id, "https://first.example");
    const second = await navigateNewTab(service, "https://second.example");
    const secondView = electron.state.views.at(-1)!;

    const state = await service.detachTab(second.id);

    expect(state.tabs.map((tab) => tab.id)).toEqual([first.id]);
    expect(state.activeTabId).toBe(first.id);
    expect(window.contentView.children).not.toContain(secondView);
    expect(secondView.webContents.close).toHaveBeenCalledWith({
      waitForBeforeUnload: false,
    });
  });

  it("can move a blank New Tab page between browser windows", async () => {
    const source = createService();
    const blankTab = source.service.getState().tabs[0]!;
    const transferred = source.service.getTabForTransfer(blankTab.id);

    expect(transferred).toMatchObject({
      id: blankTab.id,
      title: "New Tab",
      url: "",
    });

    const sourceState = await source.service.detachTab(blankTab.id);
    expect(sourceState.tabs).toHaveLength(1);
    expect(sourceState.tabs[0]?.id).not.toBe(blankTab.id);

    const target = createService();
    const targetState = await target.service.importTabForTransfer(transferred);
    expect(targetState.activeTabId).toBe(blankTab.id);
    expect(targetState.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: blankTab.id,
          title: "New Tab",
          url: "",
        }),
      ]),
    );
  });

  it("moves a web tab back between windows without treating it as closed", async () => {
    const source = createService();
    const target = createService();
    const sourceTab = await navigateNewTab(source.service, "https://second.example");
    const transferred = source.service.getTabForTransfer(sourceTab.id);

    await target.service.importTabForTransfer(transferred);
    const sourceState = await source.service.removeTabForTransfer(sourceTab.id);

    expect(sourceState.tabs.some((tab) => tab.id === sourceTab.id)).toBe(false);
    expect(sourceState.recentlyClosedTabs).toEqual([]);
    expect(target.service.getState().tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: sourceTab.id,
          url: "https://second.example/",
        }),
      ]),
    );

    source.service.dispose();
    target.service.dispose();
  });

  it("opens user-initiated safe links as a managed tab and denies unsafe urls", async () => {
    const { service } = createService();
    const first = service.getState().tabs[0]!;
    await service.navigate(first.id, "example.com");
    const source = electron.state.views[0]!.webContents;

    // Unsafe URLs (like file://, javascript:, etc.) are denied
    expect(source.windowOpenHandler?.({
      url: "file:///etc/passwd",
      disposition: "foreground-tab",
    })).toEqual({ action: "deny" });
    expect(service.getState().tabs).toHaveLength(1);

    // Safe page links open as a managed tab
    expect(source.windowOpenHandler?.({
      url: "https://open.example/path",
      disposition: "foreground-tab",
    })).toMatchObject({ action: "allow" });
    await vi.waitFor(() => expect(service.getState().tabs).toHaveLength(2));
    expect(service.getState()).toMatchObject({ activeTabId: expect.any(String) });
    expect(service.getState().tabs.at(-1)).toMatchObject({ url: "https://open.example/path" });
  });

  it("hands off allowlisted App Store links to macOS", async () => {
    const { service } = createService();
    const first = service.getState().tabs[0]!;
    await service.navigate(
      first.id,
      "https://apps.apple.com/us/app/speedtest-by-ookla/id113517709?mt=12",
    );
    const source = electron.state.views[0]!.webContents;
    const appStoreUrl =
      "macappstore://itunes.apple.com/us/app/speedtest-by-ookla/id113517709?mt=12";
    const preventDefault = vi.fn();

    source.emit("will-navigate", { preventDefault }, appStoreUrl);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(shell.openExternal).toHaveBeenCalledWith(appStoreUrl);
    expect(service.getState().tabs).toHaveLength(1);
  });

  it("hands off App Store popup links without creating a browser tab", async () => {
    const { service } = createService();
    const first = service.getState().tabs[0]!;
    await service.navigate(first.id, "https://apps.apple.com/");
    const source = electron.state.views[0]!.webContents;
    const appStoreUrl = "itms-apps://apps.apple.com/app/id113517709?mt=12";

    expect(
      source.windowOpenHandler?.({
        url: appStoreUrl,
        disposition: "foreground-tab",
      }),
    ).toEqual({ action: "deny" });
    expect(shell.openExternal).toHaveBeenCalledWith(appStoreUrl);
    expect(service.getState().tabs).toHaveLength(1);
  });

  it("accepts both Apple App Store URL forms and rejects other custom schemes", () => {
    expect(
      safeAppStoreUrl("macappstore://itunes.apple.com/app/id113517709?mt=12"),
    ).toBe("macappstore://itunes.apple.com/app/id113517709?mt=12");
    expect(
      safeAppStoreUrl("itms-apps://apps.apple.com/app/id113517709?mt=12"),
    ).toBe("itms-apps://apps.apple.com/app/id113517709?mt=12");
    for (const url of [
      "javascript:alert(1)",
      "my-app://itunes.apple.com/app/id113517709",
      "macappstore://evil.example/app/id113517709",
      "macappstore://itunes.apple.com:8080/app/id113517709",
      "macappstore://user:secret@itunes.apple.com/app/id113517709",
    ]) {
      expect(safeAppStoreUrl(url)).toBeUndefined();
    }
  });

  it("hands off a validated Zoom join link from navigation, redirects, and popups", async () => {
    const { service } = createService();
    const first = service.getState().tabs[0]!;
    await service.navigate(first.id, "https://zoom.us/join");
    const source = electron.state.views[0]!.webContents;
    const zoomJoinUrl =
      "zoommtg://zoom.us/join?confno=1234567890&action=join";
    const navigationPreventDefault = vi.fn();
    const redirectPreventDefault = vi.fn();

    expect(
      source.windowOpenHandler?.({
        url: zoomJoinUrl,
        disposition: "foreground-tab",
      }),
    ).toEqual({ action: "deny" });
    source.emit("will-navigate", { preventDefault: navigationPreventDefault }, zoomJoinUrl);
    source.emit("will-redirect", { preventDefault: redirectPreventDefault }, zoomJoinUrl);

    expect(navigationPreventDefault).toHaveBeenCalledOnce();
    expect(redirectPreventDefault).toHaveBeenCalledOnce();
    expect(shell.openExternal).toHaveBeenCalledTimes(3);
    expect(shell.openExternal).toHaveBeenNthCalledWith(1, zoomJoinUrl);
    expect(shell.openExternal).toHaveBeenNthCalledWith(2, zoomJoinUrl);
    expect(shell.openExternal).toHaveBeenNthCalledWith(3, zoomJoinUrl);
    expect(service.getState().tabs).toHaveLength(1);
  });

  it("accepts validated Zoom meeting join URLs", () => {
    const zoomJoinUrl =
      "zoommtg://zoom.us/join?confno=1234567890&action=join";
    expect(safeZoomJoinUrl(zoomJoinUrl)).toBe(zoomJoinUrl);
    expect(
      safeZoomJoinUrl(
        "zoommtg://zoom.us/join?confno=1234567890&pwd=example",
      ),
    ).toBe("zoommtg://zoom.us/join?confno=1234567890&pwd=example");
    for (const url of [
      "zoomus://zoom.us/join?confno=1234567890",
      "zoommtg://evil.example/join?confno=1234567890",
      "zoommtg://zoom.us:8080/join?confno=1234567890",
      "zoommtg://user:secret@zoom.us/join?confno=1234567890",
      "zoommtg://zoom.us/start?confno=1234567890",
      "zoommtg://zoom.us/join?confno=not-a-meeting-number",
      "zoommtg://zoom.us/join?confno=1234567890&action=start",
      "zoommtg://zoom.us/join?confno=1234567890&confno=1234567891",
      "zoommtg://zoom.us/join?confno=1234567890&pwd=one&pwd=two",
      "zoommtg://zoom.us/join?confno=1234567890#unexpected",
    ]) {
      expect(safeZoomJoinUrl(url)).toBeUndefined();
    }
  });

  it("hands off Teams meeting and team invitations and rejects unrelated schemes", async () => {
    const { service } = createService();
    await service.navigate(service.getState().tabs[0]!.id, "https://teams.microsoft.com");
    const source = electron.state.views[0]!.webContents;
    for (const url of [
      "msteams://teams.microsoft.com/l/meetup-join/19%3afixture/0?context=example",
      "msteams://teams.microsoft.com/l/team/19%3afixture/conversations?groupId=example",
      "msteams://teams.live.com/l/channel/fixture/general",
    ]) {
      expect(safeTeamsUrl(url)).toBe(url);
      const event = {preventDefault: vi.fn()};
      source.emit("will-navigate", event, url);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(shell.openExternal).toHaveBeenCalledWith(url);
    }
    for (const url of [
      "msteams://evil.example/l/team/fixture", "msteams://teams.microsoft.com.evil.example/l/team/fixture",
      "msteams://user@teams.microsoft.com/l/team/fixture", "msteams://teams.microsoft.com:8000/l/team/fixture",
      "msteams://teams.microsoft.com/l/call/fixture", "file:///tmp/test", "msteams://teams.microsoft.com/l/team/",
    ]) expect(safeTeamsUrl(url)).toBeUndefined();
  });

  it("allows native navigation and redirects without replaying requests", async () => {
    const {service} = createService({threatProvider: threatProvider(vi.fn(async () => ({verdict: "safe" as const, provider: "test"})))});
    await service.navigate(service.getState().tabs[0]!.id, "https://safe.example");
    const contents = electron.state.views[0]!.webContents;
    contents.loadURL.mockClear();
    for (const eventName of ["will-navigate", "will-redirect"]) {
      const event = {preventDefault: vi.fn()};
      contents.emit(eventName, event, "https://safe.example/callback");
      expect(event.preventDefault).not.toHaveBeenCalled();
      const callback = vi.fn();
      electron.state.partitions[0]!.instance.requestHandler?.({webContentsId: contents.id,resourceType:"mainFrame",url:"https://safe.example/callback"}, callback);
      await vi.waitFor(() => expect(callback).toHaveBeenCalledExactlyOnceWith({cancel:false}));
    }
    expect(contents.loadURL).not.toHaveBeenCalled();
  });

  it("cancels a pending reputation request when its tab closes", async () => {
    let resolveVerdict!: (value: {verdict:"safe";provider:string}) => void;
    const checkUrl = vi.fn(async () => ({verdict:"safe" as const,provider:"test"}));
    const {service} = createService({threatProvider: threatProvider(checkUrl)});
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://safe.example");
    checkUrl.mockImplementationOnce(() => new Promise(resolve => {resolveVerdict=resolve;}));
    const callback = vi.fn();
    electron.state.partitions[0]!.instance.requestHandler?.({webContentsId:electron.state.views[0]!.webContents.id,resourceType:"mainFrame",url:"https://safe.example/callback"},callback);
    await service.closeTab(tab.id);
    resolveVerdict({verdict:"safe",provider:"test"});
    await vi.waitFor(() => expect(callback).toHaveBeenCalledExactlyOnceWith({cancel:true}));
  });

  it("preserves target=_blank form POST bodies when opening managed tabs", async () => {
    const { service } = createService();
    const first = service.getState().tabs[0]!;
    await service.navigate(first.id, "https://canvas.example/course");
    const source = electron.state.views[0]!.webContents;
    const postData = Buffer.from(
      "iss=https%3A%2F%2Fcanvas.example&login_hint=student&target_link_uri=https%3A%2F%2Fcourseware.example%2Fmath",
      "utf8",
    );
    const postBody = {
      contentType: "application/x-www-form-urlencoded",
      data: [{ type: "rawData", bytes: postData }],
    };

    expect(
      source.windowOpenHandler?.({
        url: "https://courseware.example/api/lti/oidc",
        disposition: "foreground-tab",
        postBody,
        referrer: {
          url: "https://canvas.example/course",
          policy: "strict-origin-when-cross-origin",
        },
      }),
    ).toMatchObject({ action: "allow", createWindow: expect.any(Function) });

    await vi.waitFor(() => expect(service.getState().tabs).toHaveLength(2));
    expect(service.getState().tabs.at(-1)).toMatchObject({
      url: "https://courseware.example/api/lti/oidc",
    });
    const popup = electron.state.views.at(-1)!.webContents;
    expect(popup.loadURL).not.toHaveBeenCalled();
  });

  it("preserves UTF-8-qualified Microsoft sign-in POSTs when opening managed tabs", async () => {
    const { service } = createService();
    const first = service.getState().tabs[0]!;
    await service.navigate(first.id, "https://contoso.example/sign-in");
    const source = electron.state.views[0]!.webContents;
    const postBody = {
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
      data: [
        {
          type: "rawData",
          bytes: Buffer.from("login_hint=student%40contoso.example", "utf8"),
        },
      ],
    };
    const signInUrl =
      "https://login.microsoftonline.com/4cd64bfe-a7a1-4304-947b-1393797262a2/login";

    expect(
      source.windowOpenHandler?.({
        url: signInUrl,
        disposition: "foreground-tab",
        postBody,
      }),
    ).toMatchObject({ action: "allow", createWindow: expect.any(Function) });

    await vi.waitFor(() => expect(service.getState().tabs).toHaveLength(2));
    const popup = electron.state.views.at(-1)!.webContents;
    expect(popup.loadURL).not.toHaveBeenCalled();
  });

  it("awaits CDP clicks and opens a managed tab for new window links", async () => {
    const { service } = createService();
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://example.com");
    const contents = electron.state.views[0]!.webContents;
    contents.executeJavaScript.mockResolvedValueOnce({ x: 24, y: 36 });
    let popupResult: { action: string } | undefined;
    contents.debugger.sendCommand.mockImplementation(async (_method, params) => {
      if ((params as { type?: string }).type === "mouseReleased")
        setImmediate(() => {
          popupResult = contents.windowOpenHandler?.({
            url: "https://opened.example/path",
            disposition: "foreground-tab",
          });
        });
    });

    await service.act(
      tab.id,
      { type: "click", target: "#continue" },
      new AbortController().signal,
    );

    expect(contents.debugger.attach).toHaveBeenCalledWith("1.3");
    expect(contents.debugger.sendCommand.mock.calls).toEqual([
      ["Input.dispatchMouseEvent", expect.objectContaining({
        type: "mouseMoved",
        x: 24,
        y: 36,
        button: "none",
        buttons: 0,
      })],
      ["Input.dispatchMouseEvent", expect.objectContaining({
        type: "mousePressed",
        x: 24,
        y: 36,
        button: "left",
        buttons: 1,
      })],
      ["Input.dispatchMouseEvent", expect.objectContaining({
        type: "mouseReleased",
        x: 24,
        y: 36,
        button: "left",
        buttons: 0,
      })],
    ]);
    expect(contents.executeJavaScript).toHaveBeenCalledTimes(1);
    expect(popupResult).toMatchObject({ action: "allow" });
    await vi.waitFor(() => expect(service.getState().tabs).toHaveLength(2));
    expect(service.getState().tabs.at(-1)).toMatchObject({
      url: "https://opened.example/path",
    });
  });

  it("settles an approved click after the source document is destroyed", async () => {
    const { service } = createService();
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://example.com");
    const contents = electron.state.views[0]!.webContents;
    contents.executeJavaScript.mockResolvedValueOnce({ x: 12, y: 18 });
    contents.debugger.sendCommand.mockImplementation(async (_method, params) => {
      if ((params as { type?: string }).type === "mouseReleased")
        contents.destroyed = true;
    });

    await expect(service.act(
      tab.id,
      { type: "click", target: "a.navigate" },
      new AbortController().signal,
    )).resolves.toBeUndefined();
    expect(contents.debugger.sendCommand).toHaveBeenCalledTimes(3);
    expect(contents.executeJavaScript).toHaveBeenCalledTimes(1);
  });

  it("selects a native option in a visible tab through semantic CDP", async () => {
    const { service } = createService();
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://example.com");
    const contents = electron.state.views[0]!.webContents;
    contents.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") {
        expect(params).toEqual({ nodeId: 1, selector: "select[name=country]" });
        return { nodeId: 2 };
      }
      if (method === "DOM.describeNode")
        return { node: { backendNodeId: 24 } };
      if (method === "DOM.scrollIntoViewIfNeeded") return {};
      if (method === "DOM.resolveNode")
        return { object: { objectId: "country-select" } };
      if (method === "Runtime.callFunctionOn") {
        if (params.functionDeclaration?.includes("shouldFocus"))
          return { result: { value: { ok: true, x: 20, y: 30 } } };
        expect(params).toMatchObject({
          objectId: "country-select",
          arguments: [{ value: "ca" }],
          returnByValue: true,
          userGesture: true,
        });
        return { result: { value: { ok: true } } };
      }
      if (method === "Runtime.releaseObject") return {};
      throw new Error(`unexpected command ${method}`);
    });

    await service.act(
      tab.id,
      { type: "select", target: "select[name=country]", value: "ca" },
      new AbortController().signal,
    );

    expect(contents.debugger.attach).toHaveBeenCalledWith("1.3");
    expect(contents.debugger.sendCommand).toHaveBeenCalledWith(
      "DOM.scrollIntoViewIfNeeded",
      { backendNodeId: 24 },
    );
    await vi.waitFor(() =>
      expect(contents.debugger.sendCommand).toHaveBeenCalledWith(
        "Runtime.releaseObject",
        { objectId: "country-select" },
      ),
    );
  });

  it("discards the least-recent inactive live view once more than eight are open", async () => {
    let tick = 0;
    const { service } = createService({ now: () => new Date(`2026-08-11T12:00:${String(tick++).padStart(2, "0")}.000Z`) });
    const initial = service.getState().tabs[0]!;
    await service.navigate(initial.id, "https://first.example");
    const tabs = [initial];
    for (let index = 0; index < 8; index += 1)
      tabs.push(await navigateNewTab(service, `https://${index}.example`));

    await service.selectTab(tabs.at(-1)!.id);
    const state = service.getState();
    expect(state.tabs.find((tab) => tab.id === initial.id)).toMatchObject({
      discarded: false,
    });
    expect(state.tabs.find((tab) => tab.id === tabs[1]!.id)).toMatchObject({
      discarded: true,
    });
    expect(electron.state.views.filter((view) => !view.webContents.destroyed)).toHaveLength(8);
  });

  it("does not discard a tab while an agent snapshot holds a pin", async () => {
    let tick = 0;
    const { service } = createService({
      now: () =>
        new Date(`2026-08-11T12:00:${String(tick++).padStart(2, "0")}.000Z`),
    });
    const pinned = service as unknown as {
      pinAgentTab: (tabId: string) => void;
    };
    const initial = service.getState().tabs[0]!;
    await service.navigate(initial.id, "https://first.example");
    const tabs = [initial];
    for (let index = 0; index < 8; index += 1) {
      const tab = await navigateNewTab(service, `https://${index}.example`);
      tabs.push(tab);
      if (index === 0) pinned.pinAgentTab(tab.id);
    }

    await service.selectTab(tabs.at(-1)!.id);

    expect(
      service.getState().tabs.find((tab) => tab.id === tabs[1]!.id),
    ).toMatchObject({ discarded: false });
  });

	it("rejects close while an agent operation holds a tab pin", async () => {
    const { service } = createService();
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://example.com");
    (
      service as unknown as { pinAgentTab: (tabId: string) => void }
    ).pinAgentTab(tab.id);

    await expect(service.closeTab(tab.id)).rejects.toThrow(
      "Browser tab is in use by an agent operation and cannot be closed.",
    );
    await expect(
      service.handleAgentRequest(
        { operation: "visible-close", tabId: tab.id },
        new AbortController().signal,
      ),
    ).rejects.toThrow(
      "Browser tab is in use by an agent operation and cannot be closed.",
    );

    (
      service as unknown as { unpinAgentTab: (tabId: string) => void }
    ).unpinAgentTab(tab.id);
		await expect(service.closeTab(tab.id)).resolves.toBeDefined();
	});

	it("rejects detach while an agent operation holds a tab pin", async () => {
		const { service } = createService();
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://example.com");
		(
			service as unknown as { pinAgentTab: (tabId: string) => void }
		).pinAgentTab(tab.id);

		await expect(service.detachTab(tab.id)).rejects.toThrow(
			"Browser tab is in use by an agent operation and cannot be detached.",
		);
		expect(service.getState().tabs.some((item) => item.id === tab.id)).toBe(true);
		(
			service as unknown as { unpinAgentTab: (tabId: string) => void }
		).unpinAgentTab(tab.id);
	});

it("serializes closeTab behind an in-flight agent act", async () => {
    const { service } = createService();
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://example.com");
    const contents = electron.state.views[0]!.webContents;
    contents.url = "https://example.com/";
    contents.title = "Example";

    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    contents.debugger.sendCommand.mockImplementation(async () => {
      await snapshotGate;
      return { nodes: [] };
    });

    const snapshotPromise = service.handleAgentRequest(
      { operation: "visible-snapshot", tabId: tab.id },
      new AbortController().signal,
    );
    await vi.waitFor(() => {
      expect(contents.debugger.sendCommand).toHaveBeenCalled();
    });

    const closePromise = service.closeTab(tab.id);
    await Promise.resolve();
    expect(
      service.getState().tabs.some((item) => item.id === tab.id),
    ).toBe(true);

    releaseSnapshot();
    await snapshotPromise;
    const closeState = await closePromise;
    expect(
      closeState.tabs.some((item) => item.id === tab.id),
    ).toBe(false);
  });

  it("serializes closeTab behind an in-flight pageContext", async () => {
    const { service } = createService();
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://example.com");
    const contents = electron.state.views[0]!.webContents;
    contents.url = "https://example.com/";
    contents.title = "Example";

    let releaseContext!: () => void;
    const contextGate = new Promise<void>((resolve) => {
      releaseContext = resolve;
    });
    contents.executeJavaScript.mockImplementation(async () => {
      await contextGate;
      return {
        description: "Fixture",
        selectedText: "",
        visibleText: "Visible reference text",
        headings: ["Fixture"],
        links: [],
        forms: [],
        viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
      };
    });

    const contextPromise = service.pageContext(tab.id);
    await vi.waitFor(() => {
      expect(contents.executeJavaScript).toHaveBeenCalled();
    });

    const closePromise = service.closeTab(tab.id);
    await Promise.resolve();
    expect(
      service.getState().tabs.some((item) => item.id === tab.id),
    ).toBe(true);

    releaseContext();
    await contextPromise;
    const closeState = await closePromise;
    expect(
      closeState.tabs.some((item) => item.id === tab.id),
    ).toBe(false);
  });

  it("rejects queued agent requests aborted while waiting for the tab mutex", async () => {
    const { service } = createService();
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://example.com");
    const contents = electron.state.views[0]!.webContents;
    contents.url = "https://example.com/";

    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    contents.debugger.sendCommand.mockImplementation(async () => {
      await snapshotGate;
      return { nodes: [] };
    });

    const firstSnapshot = service.handleAgentRequest(
      { operation: "visible-snapshot", tabId: tab.id },
      new AbortController().signal,
    );
    await vi.waitFor(() => {
      expect(contents.debugger.sendCommand).toHaveBeenCalled();
    });

    const abort = new AbortController();
    const reason = new Error("agent-turn-aborted");
    const queued = service.handleAgentRequest(
      { operation: "visible-tabs" },
      abort.signal,
    );
    await Promise.resolve();
    abort.abort(reason);

    await expect(queued).rejects.toBe(reason);

    releaseSnapshot();
    await firstSnapshot;
		await expect(service.closeTab(tab.id)).resolves.toBeDefined();
	});

	it("keeps later operations queued behind an aborted waiter", async () => {
		const { service } = createService();
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://example.com");
		const contents = electron.state.views[0]!.webContents;
		contents.url = "https://example.com/";

		let releaseSnapshot!: () => void;
		const snapshotGate = new Promise<void>((resolve) => {
			releaseSnapshot = resolve;
		});
		contents.debugger.sendCommand.mockImplementation(async () => {
			await snapshotGate;
			return { nodes: [] };
		});

		const first = service.handleAgentRequest(
			{ operation: "visible-snapshot", tabId: tab.id },
			new AbortController().signal,
		);
		await vi.waitFor(() => {
			expect(contents.debugger.sendCommand).toHaveBeenCalled();
		});

		const abort = new AbortController();
		const second = service.handleAgentRequest(
			{ operation: "visible-tabs" },
			abort.signal,
		);
		let thirdSettled = false;
		const third = service
			.handleAgentRequest(
				{ operation: "visible-tabs" },
				new AbortController().signal,
			)
			.then((result) => {
				thirdSettled = true;
				return result;
			});

		abort.abort(new Error("queued operation cancelled"));
		await expect(second).rejects.toThrow("queued operation cancelled");
		await Promise.resolve();
		expect(thirdSettled).toBe(false);

		releaseSnapshot();
		await first;
		await expect(third).resolves.toEqual(expect.any(Array));
	});

	it("does not sleep a tab while an agent operation holds a pin", async () => {
    const { service } = createService();
    const first = service.getState().tabs[0]!;
    const second = await navigateNewTab(service, "https://second.example");
    await service.selectTab(second.id);
    await service.navigate(first.id, "https://first.example");
    (
      service as unknown as { pinAgentTab: (tabId: string) => void }
    ).pinAgentTab(first.id);

    service.sleepInactiveTabs();

    expect(
      service.getState().tabs.find((tab) => tab.id === first.id),
    ).toMatchObject({ discarded: false });
  });

	it("gates automatic tab sleeping with Memory Saver while retaining manual sleep", async () => {
		let now = new Date("2026-08-31T12:00:00.000Z");
		const { service } = createService({ now: () => now });
		const first = service.getState().tabs[0]!;
		await service.navigate(first.id, "https://first.example");
		const second = await navigateNewTab(service, "https://second.example");
		await service.selectTab(second.id);
		now = new Date("2026-08-31T13:00:00.000Z");

		service.updateSettings({
			...service.getState().settings,
			memorySaverMode: false,
		});
		(service as unknown as { checkSleepingTabs: () => void }).checkSleepingTabs();
		expect(service.getState().tabs.find((tab) => tab.id === first.id)).toMatchObject({
			discarded: false,
		});

		service.updateSettings({
			...service.getState().settings,
			memorySaverMode: true,
		});
		(service as unknown as { checkSleepingTabs: () => void }).checkSleepingTabs();
		expect(service.getState().tabs.find((tab) => tab.id === first.id)).toMatchObject({
			discarded: true,
		});
	});

	it("keeps authentication tabs alive while sleeping ordinary inactive tabs", async () => {
		let now = new Date("2026-08-31T12:00:00.000Z");
		const { service } = createService({ now: () => now });
		const ordinary = service.getState().tabs[0]!;
		await service.navigate(ordinary.id, "https://ordinary.example");

		now = new Date("2026-08-31T12:01:00.000Z");
		const authentication = await navigateNewTab(
			service,
			"https://accounts.google.com/o/oauth2/v2/auth?client_id=test-client",
		);
		now = new Date("2026-08-31T12:02:00.000Z");
		const active = await navigateNewTab(service, "https://active.example");
		await service.selectTab(active.id);
		now = new Date("2026-08-31T13:00:00.000Z");

		service.updateSettings({
			...service.getState().settings,
			memorySaverMode: true,
			sleepingTabTimeoutMinutes: 30,
		});
		(service as unknown as { checkSleepingTabs: () => void }).checkSleepingTabs();

		expect(service.getState().tabs.find((tab) => tab.id === ordinary.id)).toMatchObject({
			discarded: true,
		});
		expect(
			service.getState().tabs.find((tab) => tab.id === authentication.id),
		).toMatchObject({ discarded: false });
		expect(isAuthenticationFlowUrl(authentication.url)).toBe(true);
	});

  it("cleans up crashed views and recreates a destroyed view on the next navigation", async () => {
    const { service } = createService();
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://example.com");
    const first = electron.state.views[0]!;

    first.webContents.emit("render-process-gone");
    expect(first.webContents.close).toHaveBeenCalledWith({
      waitForBeforeUnload: false,
    });
    expect(service.getState().tabs[0]).toMatchObject({ crashed: true, discarded: true });

    await service.navigate(tab.id, "https://again.example");
    const replacement = electron.state.views.at(-1)!;
    expect(replacement).not.toBe(first);
    replacement.webContents.destroyed = true;
    await service.navigate(tab.id, "https://third.example");
    expect(electron.state.views.at(-1)).not.toBe(replacement);
  });

	it("recreates a view when its web contents disappear before navigation", async () => {
		const { service } = createService();
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://example.com");
		const first = electron.state.views[0]!;

		Object.defineProperty(first, "webContents", {
			configurable: true,
			value: undefined,
		});

		await expect(service.navigate(tab.id, "https://again.example")).resolves.toEqual(
			expect.anything(),
		);
		expect(electron.state.views.at(-1)).not.toBe(first);
	});

  it("retains recent history, prunes expired visits, and clears history when retention is disabled", async () => {
    let now = new Date("2026-08-11T12:00:00.000Z");
    const { service } = createService({ now: () => now });
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://example.com");
    const view = electron.state.views[0]!.webContents;
    view.url = "https://example.com/";
    view.title = "Example";
    view.emit("did-navigate", {}, view.url, 200, "OK");
    expect(service.getState().history).toHaveLength(1);

    now = new Date("2026-08-19T12:00:00.000Z");
    service.updateSettings({ ...service.getState().settings, historyRetentionDays: 7 });
    expect(service.getState().history).toEqual([]);

    service.updateSettings({ ...service.getState().settings, newTabBackground: "meadow" });
    expect(service.getState().settings.newTabBackground).toBe("meadow");

    view.emit("did-navigate", {}, "https://new.example/", 200, "OK");
    expect(service.getState().history).toHaveLength(1);
    service.updateSettings({ ...service.getState().settings, historyRetentionDays: 0 });
    expect(service.getState().history).toEqual([]);
  });

  it("redacts credential-like URL parameters from agent-visible metadata", async () => {
    const { service } = createService();
    const tab = service.getState().tabs[0]!;
    await service.navigate(
      tab.id,
      "https://example.com/callback?q=kestrel&code=do-not-share",
    );
    const contents = electron.state.views[0]!.webContents;
    contents.executeJavaScript.mockResolvedValue({
      description: "Fixture",
      selectedText: "",
      visibleText: "Visible reference text javascript:alert(1)",
      headings: ["Fixture"],
      links: [
        {
          text: "Safe result",
          url: "https://linked.example/result?q=kestrel&access_token=hidden-link",
        },
        { text: "Email", url: "mailto:person@example.com" },
      ],
      forms: [],
      viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
    });

    const tabs = (await service.handleAgentRequest(
      { operation: "visible-tabs" },
      new AbortController().signal,
    )) as Array<{ url: string }>;
    const context = await service.pageContext(tab.id);
    contents.debugger.sendCommand.mockResolvedValue({
      nodes: [{
        nodeId: "1",
        name: {
          value:
            "Open https://named.example/path?q=kestrel&code=hidden-ax-name",
        },
        properties: [{
          name: "url",
          value: {
            type: "string",
            value:
              "https://ax.example/path?q=kestrel&access_token=hidden-ax-link",
          },
        }],
      }],
    });
    const snapshot = await service.snapshot(tab.id);

    expect(service.getState().tabs[0]?.url).toBe(
      "https://example.com/callback?q=kestrel",
    );
    expect(tabs[0]?.url).toBe(
      "https://example.com/callback?q=kestrel",
    );
    expect(context.url).toBe("https://example.com/callback?q=kestrel");
    expect(context.links).toEqual([
      {
        text: "Safe result",
        url: "https://linked.example/result?q=kestrel",
      },
    ]);
    expect(snapshot.url).toBe("https://example.com/callback?q=kestrel");
    expect(snapshot.accessibilityTree).toMatchObject({
      nodes: [{
        name: { value: "Open https://named.example/path?q=kestrel" },
        properties: [{
          name: "url",
          value: {
            value: "https://ax.example/path?q=kestrel",
          },
        }],
      }],
    });
    expect(context.visibleText).toBe("Visible reference text [redacted URL]");
    expect(JSON.stringify({ tabs, context, snapshot })).not.toMatch(
      /do-not-share|hidden-link|hidden-ax-name|hidden-ax-link|javascript:/,
    );
  });

  it("returns an empty snapshot for a blank tab without a safe URL", async () => {
    const { service } = createService();
    const tab = service.getState().tabs[0]!;
    const snapshot = await service.snapshot(tab.id);
    expect(snapshot).toEqual({
      url: "about:blank",
      title: "New Tab",
      accessibilityTree: { nodes: [] },
      interactive: [],
    });
    expect(electron.state.views[0]?.webContents.debugger.attach).not.toHaveBeenCalled();
  });

  it("mints snapshot refs for interactive accessibility nodes", async () => {
    const { service } = createService();
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://example.com");
    const contents = electron.state.views[0]!.webContents;
    contents.url = "https://example.com/";
    contents.title = "Example";
    contents.debugger.sendCommand.mockResolvedValue({
      nodes: [
        {
          nodeId: "1",
          role: { value: "button" },
          name: { value: "Save" },
          backendDOMNodeId: 9,
        },
        {
          nodeId: "2",
          role: { value: "link" },
          name: { value: "Home" },
          backendDOMNodeId: 10,
        },
      ],
    });

    const snapshot = await service.snapshot(tab.id);
    expect(snapshot.interactive).toEqual([
      { ref: "e1", role: "button", name: "Save" },
      { ref: "e2", role: "link", name: "Home" },
    ]);
    expect(snapshot.accessibilityTree).toMatchObject({
      nodes: [{ ref: "e1" }, { ref: "e2" }],
    });
  });

  it("invalidates snapshot refs after main-frame navigation events", async () => {
    const { service } = createService();
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://example.com");
    const contents = electron.state.views[0]!.webContents;
    contents.url = "https://example.com/";
    contents.title = "Example";
    contents.debugger.sendCommand.mockResolvedValue({
      nodes: [
        {
          nodeId: "1",
          role: { value: "button" },
          name: { value: "Save" },
          backendDOMNodeId: 9,
        },
      ],
    });

    await service.snapshot(tab.id);
    contents.emit("did-navigate-in-page", {}, "https://example.com/next", true);

    await expect(
      service.handleAgentRequest(
        {
          operation: "visible-act",
          tabId: tab.id,
          action: { type: "click", target: "e1" },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Browser target ref is stale. Take a new snapshot.");
  });

	it("never lets an agent type into a sensitive accessibility ref or a selector", async () => {
		const { service } = createService();
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://example.com/login");
		const contents = electron.state.views[0]!.webContents;
		contents.url = "https://example.com/login";
		contents.mainFrame.url = contents.url;
		contents.debugger.sendCommand.mockResolvedValue({
			nodes: [
				{
					nodeId: "1",
					role: { value: "textbox" },
					name: { value: "Password" },
					value: { value: "never-share-this" },
					backendDOMNodeId: 9,
				},
			],
		});

		const snapshot = await service.snapshot(tab.id);
		expect(JSON.stringify(snapshot)).not.toContain("never-share-this");
		await expect(
			service.handleAgentRequest(
				{
					operation: "visible-act",
					tabId: tab.id,
					action: { type: "type", target: "e1", text: "not-for-agents" },
				},
				new AbortController().signal,
			),
		).rejects.toThrow("cannot type into a sensitive browser field");
		await expect(
			service.handleAgentRequest(
				{
					operation: "visible-act",
					tabId: tab.id,
					action: { type: "type", target: "#password", text: "not-for-agents" },
				},
				new AbortController().signal,
			),
		).rejects.toThrow("must use a current accessibility ref");
		expect(contents.insertText).not.toHaveBeenCalled();
	});

  it("inserts a selected code only into the active page's matching domain", async () => {
    const { service } = createService();
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://example.com/verify");
    const contents = electron.state.views[0]!.webContents;
    contents.executeJavaScript.mockResolvedValueOnce(true);

    await service.insertLoginCode(
      tab.id,
      "481902",
      "example.com",
      "https://example.com",
    );

    expect(contents.executeJavaScript).toHaveBeenCalledTimes(1);
    expect(contents.focus).toHaveBeenCalled();
    expect(contents.insertText).toHaveBeenCalledWith("481902");

    contents.url = "https://other.example/verify";
    await expect(
      service.insertLoginCode(
        tab.id,
        "481902",
        "example.com",
        "https://example.com",
      ),
    ).rejects.toThrow("page changed");
  });

  it("searches bounded history and lists visible downloads as untrusted data", async () => {
    const { service } = createService();
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://robotics.example/article");
    const contents = electron.state.views[0]!.webContents;
    contents.url = "https://robotics.example/article";
    contents.title = "Robotics notes";
    contents.emit("did-navigate", {}, contents.url, 200, "OK");

    await expect(
      service.handleAgentRequest(
        { operation: "visible-history", query: "robotics", limit: 10 },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      trust: "untrusted_browser",
      entries: [{ title: "Robotics notes" }],
    });
    await expect(
      service.handleAgentRequest(
        { operation: "visible-downloads" },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ downloads: [], trust: "untrusted_browser" });

    const poisoned = {
      id: "visit-00000000-0000-4000-8000-000000000000",
      tabId: tab.id,
      url: "https://example.com/notes?token=hidden-history",
      title: "Poison",
      visitedAt: "2026-08-19T12:00:00.000Z",
    };
    (
      service as unknown as {
        state: { history: Array<typeof poisoned> };
      }
    ).state.history.push(poisoned);
    await expect(
      service.handleAgentRequest(
        { operation: "visible-history", query: "hidden-history" },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ entries: [] });
    await expect(
      service.handleAgentRequest(
        { operation: "visible-history", query: "example.com/notes" },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      entries: [{ url: "https://example.com/notes", title: "Poison" }],
    });
    await expect(
      service.handleAgentRequest(
        { operation: "visible-screenshot" },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      width: 1,
      height: 1,
      trust: "untrusted_browser",
    });
    await expect(
      service.handleAgentRequest(
        { operation: "visible-navigate", tabId: tab.id, input: "https://robotics.example/next" },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ navigated: true });
  });

	it("blocks agent screenshots while a password or OTP field is present", async () => {
		const { service } = createService();
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://example.com/login");
		const contents = electron.state.views[0]!.webContents;
		contents.passwordSnapshot = {
			fields: [{
				id: "field-0",
				kind: "secret",
				label: "One-time code",
				type: "text",
				autocomplete: "one-time-code",
				rect: { x: 10, y: 20, width: 260, height: 42 },
			}],
		};

		await expect(
			service.handleAgentRequest(
				{ operation: "visible-screenshot", tabId: tab.id },
				new AbortController().signal,
			),
		).rejects.toThrow("does not share browser screenshots");
		expect(contents.capturePage).not.toHaveBeenCalled();
	});

  it("rejects oversized accessibility snapshots before returning them", async () => {
    const { service } = createService();
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://example.com");
    const contents = electron.state.views[0]!.webContents;
    contents.url = "https://example.com/";
    contents.debugger.sendCommand.mockResolvedValue({
      nodes: [{ name: { value: "x".repeat(1_500_000) } }],
    });

    await expect(service.snapshot(tab.id)).rejects.toThrow("exceeds 1.5 MB");
  });

  it("bounds a stalled Electron capture and retries after requesting a repaint", async () => {
    vi.useFakeTimers();
    try {
      const { service } = createService();
      const tab = service.getState().tabs[0]!;
      await service.navigate(tab.id, "https://example.com");
      const contents = electron.state.views[0]!.webContents;
      contents.capturePage
        .mockImplementationOnce(() => new Promise(() => undefined))
        .mockResolvedValueOnce({
          getSize: () => ({ width: 1, height: 1 }),
          toBitmap: () => Buffer.from([0, 0, 0, 255]),
          toPNG: () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        });
      const pending = service.handleAgentRequest(
        { operation: "visible-screenshot", tabId: tab.id },
        new AbortController().signal,
      );

      await vi.advanceTimersByTimeAsync(5_050);
      await expect(pending).resolves.toMatchObject({ width: 1, height: 1 });
      expect(contents.capturePage).toHaveBeenCalledTimes(2);
      expect(contents.invalidate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a stalled Electron capture without retrying it", async () => {
    const { service } = createService();
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://example.com");
    const contents = electron.state.views[0]!.webContents;
    contents.capturePage.mockImplementationOnce(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = service.handleAgentRequest(
      { operation: "visible-screenshot", tabId: tab.id },
      controller.signal,
    );
    const rejection = expect(pending).rejects.toThrow("stop screenshot");

    await vi.waitFor(() => expect(contents.capturePage).toHaveBeenCalledOnce());
    controller.abort(new Error("stop screenshot"));

    await rejection;
    expect(contents.capturePage).toHaveBeenCalledOnce();
    expect(contents.invalidate).not.toHaveBeenCalled();
  });

  it("handles browser shortcuts while native page content has focus", async () => {
    const { service, commands } = createService();
    const first = service.getState().tabs[0]!;
    await service.navigate(first.id, "https://first.example");
    const second = await navigateNewTab(service, "https://second.example");
    await service.selectTab(second.id);
    const inputEvent = { preventDefault: vi.fn() };
    const firstContents = electron.state.views[0]!.webContents;

    firstContents.emit("before-input-event", inputEvent, {
      meta: true,
      control: false,
      shift: false,
      type: "keyDown",
      key: "l",
    });
    firstContents.emit("before-input-event", inputEvent, {
      meta: true,
      control: false,
      shift: false,
      type: "keyDown",
      key: "n",
    });
    firstContents.emit("before-input-event", inputEvent, {
      meta: false,
      control: true,
      shift: false,
      type: "keyDown",
      key: "Tab",
    });
    await vi.waitFor(() =>
      expect(service.getState().activeTabId).toBe(first.id),
    );
    firstContents.emit("before-input-event", inputEvent, {
      meta: true,
      control: false,
      shift: false,
      type: "keyDown",
      key: "k",
    });
    firstContents.emit("before-input-event", inputEvent, {
      meta: true,
      control: false,
      shift: false,
      type: "keyDown",
      key: "h",
    });
    firstContents.emit("before-input-event", inputEvent, {
      meta: true,
      control: false,
      shift: false,
      type: "keyDown",
      key: "j",
    });
    firstContents.emit("before-input-event", inputEvent, {
      meta: true,
      control: false,
      shift: false,
      type: "keyDown",
      key: ",",
    });
    firstContents.emit("before-input-event", inputEvent, {
      meta: true,
      control: false,
      shift: false,
      type: "keyDown",
      key: "/",
    });
    firstContents.emit("before-input-event", inputEvent, {
      meta: false,
      control: true,
      shift: true,
      type: "keyDown",
      key: "Tab",
    });

    // Electron reports physical keyboard codes independently from characters.
    // Accept that form so Ctrl+= works on layouts that do not provide `=` here.
    firstContents.emit("before-input-event", inputEvent, {
      meta: false,
      control: true,
      shift: false,
      type: "keyDown",
      key: "Unidentified",
      code: "Equal",
    });
    await vi.waitFor(() =>
      expect(service.getState().activeTabId).toBe(second.id),
    );
    expect(firstContents.zoomLevel).toBe(0.5);

    expect(commands).toEqual([
      "focus-address",
      "new-agent",
      "open-commands",
      "open-history",
      "open-downloads",
      "open-settings",
      "show-shortcuts",
    ]);
    expect(inputEvent.preventDefault).toHaveBeenCalledTimes(10);
  });

  it("supports reopening closed tabs and direct tab index switching", async () => {
    const { service } = createService();
    const first = service.getState().tabs[0]!;
    await service.navigate(first.id, "https://first.example");
    const second = (await service.createTab("https://second.example", true)).tabs.at(-1)!;
    const third = (await service.createTab("https://third.example", true)).tabs.at(-1)!;

    expect(service.getState().tabs.length).toBe(3);
    expect(service.getState().activeTabId).toBe(third.id);

    // Switch to tab 1 (index 0)
    await service.selectTabByIndex(0);
    expect(service.getState().activeTabId).toBe(first.id);

    // Switch to last tab (-1)
    await service.selectTabByIndex(-1);
    expect(service.getState().activeTabId).toBe(third.id);

    // Close third tab
    await service.closeTab(third.id);
    expect(service.getState().tabs.length).toBe(2);
    expect(service.getState().recentlyClosedTabs).toHaveLength(1);

    // Reopen closed tab
    const restored = await service.reopenClosedTab();
    expect(restored.tabs.length).toBe(3);
    const lastTab = restored.tabs[restored.tabs.length - 1]!;
    expect(lastTab.url).toBe("https://third.example/");
    expect(restored.recentlyClosedTabs).toEqual([]);
  });

  it("reopens a selected recently closed tab and clears that list with history", async () => {
    const { service } = createService();
    const first = service.getState().tabs[0]!;
    await service.navigate(first.id, "https://first.example");
    const second = (await service.createTab("https://second.example", true)).tabs.at(-1)!;

    await service.closeTab(second.id);
    await service.closeTab(first.id);
    expect(service.getState().recentlyClosedTabs.map((tab) => tab.url)).toEqual([
      "https://first.example/",
      "https://second.example/",
    ]);

    const reopened = await service.reopenClosedTab(1);
    expect(reopened.tabs.at(-1)?.url).toBe("https://second.example/");
    expect(reopened.recentlyClosedTabs.map((tab) => tab.url)).toEqual([
      "https://first.example/",
    ]);

    service.clearHistory();
    expect(service.getState().recentlyClosedTabs).toEqual([]);
  });

  it("supports zoom in, zoom out, and zoom reset with visible percent feedback", async () => {
    const { service, events } = createService();
    const first = service.getState().tabs[0]!;
    await service.navigate(first.id, "https://first.example");

    const contents = electron.state.views[0]!.webContents;
    expect(contents.zoomLevel).toBe(0);

    service.zoomIn(first.id);
    expect(contents.zoomLevel).toBe(0.5);

    service.zoomIn(first.id);
    expect(contents.zoomLevel).toBe(1.0);

    service.zoomOut(first.id);
    expect(contents.zoomLevel).toBe(0.5);

    service.zoomReset(first.id);
    expect(contents.zoomLevel).toBe(0);
    expect(
      events.filter(
        (
          event,
        ): event is { type: "zoom"; zoom: { tabId: string; percent: number } } =>
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          event.type === "zoom",
      ),
    ).toEqual([
      { type: "zoom", zoom: { tabId: first.id, percent: 110 } },
      { type: "zoom", zoom: { tabId: first.id, percent: 120 } },
      { type: "zoom", zoom: { tabId: first.id, percent: 110 } },
      { type: "zoom", zoom: { tabId: first.id, percent: 100 } },
    ]);
  });

	it("bookmarks, pins, and finds in the active page", async () => {
    const { service } = createService();
    const first = service.getState().tabs[0]!;
    await service.navigate(first.id, "https://docs.example/path");
    const bookmarked = service.toggleBookmark();
    expect(bookmarked.bookmarks).toHaveLength(1);
    expect(bookmarked.bookmarks[0]?.url).toBe("https://docs.example/path");
    expect(service.toggleBookmark().bookmarks).toHaveLength(0);

    const pinned = service.pinTab(first.id, true);
    expect(pinned.tabs[0]?.pinned).toBe(true);

    const contents = electron.state.views[0]!.webContents;
    service.findInPage(first.id, "kestrel");
    expect(contents.findInPage).toHaveBeenCalledWith("kestrel", {
      forward: true,
      findNext: false,
    });
    service.openDevTools(first.id);
    expect(contents.openDevTools).toHaveBeenCalled();
    service.printTab(first.id);
		expect(contents.print).toHaveBeenCalled();
	});

	it("saves bookmark presentation choices and keeps folder operations reversible", async () => {
		const { service } = createService();
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://docs.example/guide");

		const created = service.createBookmarkFolder("Read later");
		const saved = service.saveBookmark({
			title: "A useful guide",
			displayMode: "title",
			folderId: created.folder.id,
		});
		const bookmark = saved.bookmarks[0]!;
		expect(bookmark).toMatchObject({
			title: "A useful guide",
			displayMode: "title",
			folderId: created.folder.id,
		});

		const renamed = service.renameBookmarkFolder(created.folder.id, "Reference");
		expect(renamed.bookmarkFolders[0]?.name).toBe("Reference");
		const updated = service.updateBookmark({
			bookmarkId: bookmark.id,
			title: "Guide icon",
			displayMode: "icon",
			folderId: null,
		});
		expect(updated.bookmarks[0]).toMatchObject({
			title: "Guide icon",
			displayMode: "icon",
		});
		expect(updated.bookmarks[0]?.folderId).toBeUndefined();

		const removedFolder = service.removeBookmarkFolder(created.folder.id);
		expect(removedFolder.bookmarkFolders).toEqual([]);
		expect(removedFolder.bookmarks[0]?.folderId).toBeUndefined();
	});

	it("routes Cmd+D through the presentation command for an unsaved page", async () => {
		const { service, commands } = createService();
		const tab = service.getState().tabs[0]!;
		await service.navigate(tab.id, "https://docs.example/guide");
		const contents = electron.state.views[0]!.webContents;
		const event = { preventDefault: vi.fn() };

		contents.emit("before-input-event", event, {
			type: "keyDown",
			key: "d",
			meta: true,
			control: false,
			shift: false,
			alt: false,
		});

		expect(event.preventDefault).toHaveBeenCalled();
		expect(commands).toContain("bookmark-page");
		expect(service.getState().bookmarks).toEqual([]);
	});

  it("does not open devtools when packaged production hardening disables them", async () => {
    const { service } = createService({ allowDevTools: false });
    const first = service.getState().tabs[0]!;
    await service.navigate(first.id, "https://docs.example/path");
    const contents = electron.state.views[0]!.webContents;
    service.openDevTools(first.id);
    expect(contents.openDevTools).not.toHaveBeenCalled();
  });

  it("organizes visible tabs into semantic folders without sorting them alphabetically", async () => {
    const { service } = createService();
    const first = service.getState().tabs[0]!;
    await service.navigate(first.id, "https://notion.so/team/roadmap");
    const second = await navigateNewTab(
      service,
      "https://notion.so/team/notes",
    );
    const third = await navigateNewTab(
      service,
      "https://www.google.com/search?q=browser",
    );
    const fourth = await navigateNewTab(service, "https://github.com/kestrel/app");
    const fifth = await navigateNewTab(
      service,
      "https://github.com/kestrel/app/issues",
    );

    const organized = await service.organizeTabs();

    expect(organized.tabFolders.map((folder) => folder.name)).toEqual([
      "Work",
      "Development",
    ]);
    expect(organized.tabs.map((tab) => tab.id)).toEqual([
      first.id,
      second.id,
      fourth.id,
      fifth.id,
      third.id,
    ]);
    expect(organized.tabs[0]?.tabFolderId).toBe(organized.tabFolders[0]?.id);
    expect(organized.tabs[1]?.tabFolderId).toBe(organized.tabFolders[0]?.id);
    expect(organized.tabs[2]?.tabFolderId).toBe(organized.tabFolders[1]?.id);
    expect(organized.tabs[3]?.tabFolderId).toBe(organized.tabFolders[1]?.id);
    expect(organized.tabs[4]?.tabFolderId).toBeUndefined();
  });

  it("uses AI labels from bounded tab metadata while retaining the grouping order", async () => {
    const nameTabFolders = vi.fn(
      async (groups: BrowserTabFolderNamingGroup[]) =>
        groups.map((group, index) => ({
          id: group.id,
          name: ["Project planning", "Kestrel code"][index]!,
        })),
    );
    const { service } = createService({ nameTabFolders });
    const first = service.getState().tabs[0]!;
    await service.navigate(first.id, "https://notion.so/team/roadmap");
    await navigateNewTab(service, "https://notion.so/team/notes");
    await navigateNewTab(service, "https://www.google.com/search?q=browser");
    await navigateNewTab(service, "https://github.com/kestrel/app");
    await navigateNewTab(service, "https://github.com/kestrel/app/issues");

    const preview = await service.previewOrganizeTabs();

    expect(preview.tabFolders.map((folder) => folder.name)).toEqual([
      "Project planning",
      "Kestrel code",
    ]);
    expect(nameTabFolders).toHaveBeenCalledOnce();
    expect(nameTabFolders.mock.calls[0]?.[0]).toHaveLength(2);
    expect(nameTabFolders.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fallbackName: "Work",
        }),
        expect.objectContaining({
          fallbackName: "Development",
        }),
      ]),
    );
    expect(JSON.stringify(nameTabFolders.mock.calls[0]?.[0])).not.toContain(
      "https://",
    );
    expect(service.getState().tabFolders).toEqual([]);
  });

  it("previews organization without mutating tabs and applies reviewed folder edits", async () => {
    const { service } = createService();
    const first = service.getState().tabs[0]!;
    await service.navigate(first.id, "https://notion.so/team/roadmap");
    const second = await navigateNewTab(
      service,
      "https://notion.so/team/notes",
    );
    const third = await navigateNewTab(
      service,
      "https://www.google.com/search?q=browser",
    );
    const fourth = await navigateNewTab(service, "https://github.com/kestrel/app");
    const fifth = await navigateNewTab(
      service,
      "https://github.com/kestrel/app/issues",
    );

    const preview = await service.previewOrganizeTabs();
    expect(service.getState().tabFolders).toEqual([]);

    const reviewedFolders = preview.tabFolders.map((folder, index) => ({
      ...folder,
      name: `Reviewed ${index + 1}`,
      color: "slate" as const,
    }));
    const applied = await service.applyTabOrganization({
      tabOrder: preview.tabs.map((tab) => tab.id),
      assignments: preview.tabs.map(({ id, tabFolderId }) => ({
        tabId: id,
        ...(tabFolderId ? { tabFolderId } : {}),
      })),
      tabFolders: reviewedFolders,
    });

    expect(applied.tabs.map((tab) => tab.id)).toEqual([
      first.id,
      second.id,
      fourth.id,
      fifth.id,
      third.id,
    ]);
    expect(applied.tabFolders.map((folder) => folder.name)).toEqual([
      "Reviewed 1",
      "Reviewed 2",
    ]);
    expect(applied.tabFolders.every((folder) => folder.color === "slate")).toBe(
      true,
    );
  });

  it("allows 'Continue with Google' and OAuth links to open as a managed tab", async () => {
    const { service } = createService();
    const first = service.getState().tabs[0]!;
    await service.navigate(first.id, "https://app.example.com/login");
    const source = electron.state.views[0]!.webContents;

    const googleAuthUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=test-client.apps.googleusercontent.com&redirect_uri=https://app.example.com/auth/callback&response_type=code&scope=openid%20email";

    expect(
      source.windowOpenHandler?.({
        url: googleAuthUrl,
        disposition: "foreground-tab",
      }),
    ).toMatchObject({ action: "allow", createWindow: expect.any(Function) });

    await vi.waitFor(() => expect(service.getState().tabs).toHaveLength(2));
    const createdTab = service.getState().tabs.at(-1);
    expect(createdTab).toMatchObject({
      url: googleAuthUrl,
    });
  });

  it("stores the page favicon for frequent tabs and forgets it with history", async () => {
    vi.mocked(nativeImage.createFromBuffer).mockReturnValue({
      isEmpty: () => false,
      resize: () => ({ toDataURL: () => "data:image/png;base64,AAAA" }),
    } as never);
    const { service } = createService();
    const partition = electron.state.partitions[0]!.instance as {
      fetch: ReturnType<typeof vi.fn>;
    };
    partition.fetch.mockResolvedValue({
      ok: true,
      headers: { get: () => "4" },
      arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
    });
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://example.com");
    const contents = electron.state.views[0]!.webContents;
    contents.url = "https://example.com/";
    contents.title = "Example";
    contents.emit("did-navigate", {}, contents.url, 200, "OK");
    contents.emit("page-favicon-updated", {}, ["https://example.com/favicon.ico"]);

    await vi.waitFor(() => {
      expect(service.getState().tabs[0]?.faviconDataUrl).toBe(
        "data:image/png;base64,AAAA",
      );
    });
    expect(service.getState().originFavicons).toEqual([
      {
        origin: "https://example.com",
        faviconDataUrl: "data:image/png;base64,AAAA",
        updatedAt: expect.any(String),
      },
    ]);

    service.clearHistory();
    expect(service.getState().history).toEqual([]);
    expect(service.getState().originFavicons).toEqual([]);
    vi.mocked(nativeImage.createFromBuffer).mockReturnValue({
      isEmpty: () => true,
    } as never);
  });

  it("accepts inline favicon data URLs and backfills frequent origins on startup", async () => {
    vi.mocked(nativeImage.createFromDataURL).mockReturnValue({
      isEmpty: () => false,
      resize: () => ({ toDataURL: () => "data:image/png;base64,INLINE" }),
    } as never);
    vi.mocked(nativeImage.createFromBuffer).mockReturnValue({
      isEmpty: () => false,
      resize: () => ({ toDataURL: () => "data:image/png;base64,BACKFILL" }),
    } as never);
    const { service } = createService();
    const partition = electron.state.partitions[0]!.instance as {
      fetch: ReturnType<typeof vi.fn>;
    };
    partition.fetch.mockResolvedValue({
      ok: true,
      headers: { get: () => "4" },
      arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
    });
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://example.com");
    const contents = electron.state.views[0]!.webContents;
    contents.url = "https://example.com/docs";
    contents.title = "Example";
    contents.emit("did-navigate", {}, contents.url, 200, "OK");
    contents.emit("page-favicon-updated", {}, [
      "data:image/png;base64,QUFB",
    ]);

    await vi.waitFor(() => {
      expect(service.getState().tabs[0]?.faviconDataUrl).toBe(
        "data:image/png;base64,INLINE",
      );
    });

    service["state"].history.push({
      id: "visit-00000000-0000-4000-8000-000000000099",
      tabId: tab.id,
      url: "https://docs.example.org/guide",
      title: "Docs",
      visitedAt: "2026-08-19T12:00:00.000Z",
    });
    service["state"].history.push({
      id: "visit-00000000-0000-4000-8000-000000000098",
      tabId: tab.id,
      url: "https://example.com/",
      title: "Example",
      visitedAt: "2026-08-18T12:00:00.000Z",
    });
    service["backfillOriginFaviconsFromHistory"](2);

    await vi.waitFor(() => {
      expect(
        service
          .getState()
          .originFavicons.some(
            (item) => item.origin === "https://docs.example.org",
          ),
      ).toBe(true);
    });
  });

  it("decodes Windows .ico favicons for frequent-tab backfill", async () => {
    const bytes = execSync(
      "curl -sL 'https://www.google.com/favicon.ico'",
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    vi.mocked(nativeImage.createFromBuffer).mockImplementation((buffer) => ({
      isEmpty: () => buffer.byteLength === 0,
      toDataURL: () => "data:image/png;base64,GOOGLE",
      resize: () => ({ toDataURL: () => "data:image/png;base64,GOOGLE" }),
    }) as never);
    const { service } = createService();
    const partition = electron.state.partitions[0]!.instance as {
      fetch: ReturnType<typeof vi.fn>;
    };
    partition.fetch.mockResolvedValue({
      ok: true,
      headers: { get: () => String(bytes.byteLength) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
    await service["loadFirstOriginFavicon"]("https://www.google.com", [
      "https://www.google.com/favicon.ico",
    ]);
    expect(service.getState().originFavicons).toEqual([
      expect.objectContaining({
        origin: "https://www.google.com",
        faviconDataUrl: "data:image/png;base64,GOOGLE",
      }),
    ]);
  });
});
