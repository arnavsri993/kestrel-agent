import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import {
	annotateAccessibilityTree,
	type BrowserAction,
	type BrowserSnapshot,
	normalizeBrowserElementRef,
	type ScreenshotFrame,
} from "@kestrel/agent-core";
import {
	type UserBrowserCommand,
	type UserBrowserDownload,
	type UserBrowserEvent,
	type UserBrowserHistoryEntry,
	type UserBrowserPageContext,
	UserBrowserPageContextSchema,
	type UserBrowserSettings,
	type UserBrowserState,
	UserBrowserStateSchema,
	type UserBrowserTab,
	type InstalledExtension,
	type FilePreview,
	type SelectedAttachment,
	emptyNewTabGreetingActivity,
} from "@kestrel/shared-types";
import {
	BrowserWindow,
	clipboard,
	dialog,
	session as electronSession,
	Menu,
	nativeImage,
	type Rectangle,
	type Session,
	shell,
	type WebContents,
	WebContentsView,
} from "electron";
import decodeIco from "decode-ico";
import sharp from "sharp";
import {
	publicInteractiveRefs,
	rememberElementRefs,
	targetPointFromBackendNode,
} from "./browser-backend-node-target";
import { BrowserExtensionManager } from "./browser-extension-manager";
import {
	isUserBrowserBackendWireRequest,
	type UserBrowserBackendWireRequest,
} from "./browser-backend-wire";
import {
	BrowserTabStore,
	createEmptyBrowserTab,
	MAX_AX_SNAPSHOT_BYTES,
	MAX_AX_SNAPSHOT_NODES,
	MAX_INTERACTIVE_REFS,
	normalizeBrowserAddress,
	redactUntrustedBrowserText,
	sanitizeBrowserUrl,
	sanitizeUntrustedBrowserValue,
	upsertOriginFavicon,
} from "./browser-tab-store";
import {
	fileAttachment,
	fileStillExists,
	fileTabUrl,
	inspectFilePath,
	previewFile,
} from "./file-tabs";
import {
	isKestrelAppPageUrl,
	parseKestrelAppPage,
} from "../utility/browser-app-pages";

const MAX_LIVE_TABS = 8;
const MAX_HISTORY_ENTRIES = 5_000;
const MAX_DOWNLOAD_ENTRIES = 500;
const POPUP_GESTURE_WINDOW_MS = 1_500;
const USER_BROWSER_PARTITION = "persist:kestrel-user-browser-v1";
const MAX_BOOKMARKS = 2_000;
const ALWAYS_ALLOW_PERMISSIONS = new Set([
	"fullscreen",
	"clipboard-sanitized-write",
]);
const ALWAYS_DENY_PERMISSIONS = new Set([
	"usb",
	"hid",
	"serial",
	"fileSystem",
	"windowManagement",
]);

export { isUserBrowserBackendWireRequest };
export type { UserBrowserBackendWireRequest };

export interface UserBrowserServiceOptions {
	window: BrowserWindow;
	statePath: string;
	downloadDirectory: string;
	initialState?: UserBrowserState;
	partitionName?: string;
	now?: () => Date;
	onEvent(event: UserBrowserEvent): void;
	onCommand?(command: UserBrowserCommand): void;
	onLastTabClosed?(): void;
	confirmSitePermission?(origin: string, permission: string): Promise<boolean>;
}

interface ViewRecord {
	view: WebContentsView;
	navigatingTo?: string;
}

function safePageUrl(value: string): URL | undefined {
	if (!value || value.length > 8_192) return undefined;
	try {
		const url = new URL(value);
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password
		)
			return undefined;
		return url;
	} catch {
		return undefined;
	}
}

function pageDomain(value: string): string | undefined {
	const url = safePageUrl(value);
	return url?.hostname.toLowerCase().replace(/^www\./, "") || undefined;
}

function hostnameTitle(value: string): string {
	try {
		return new URL(value).hostname.replace(/^www\./, "") || "New Tab";
	} catch {
		return "New Tab";
	}
}

function isFaviconDataUrl(value: string): boolean {
	return value.startsWith("data:image/") && value.length <= 200_000;
}

function resolveFaviconReference(
	pageUrl: string,
	value: string,
): string | undefined {
	if (isFaviconDataUrl(value)) return value;
	const direct = safePageUrl(value);
	if (direct) return direct.toString();
	if (!pageUrl) return undefined;
	try {
		const resolved = new URL(value, pageUrl);
		if (
			!["http:", "https:"].includes(resolved.protocol) ||
			resolved.username ||
			resolved.password
		)
			return undefined;
		return resolved.toString();
	} catch {
		return undefined;
	}
}

function cloneState(state: UserBrowserState): UserBrowserState {
	return UserBrowserStateSchema.parse(structuredClone(state));
}

interface BrowserPartitionParticipant {
	ownsWebContents(webContents: WebContents): boolean;
	isPermissionAllowed(origin: string, permission: string): boolean;
	resolvePermissionRequest(
		webContents: WebContents,
		permission: string,
		requestingUrl?: string,
	): Promise<boolean>;
	handleWillDownload(
		event: Electron.Event,
		item: Electron.DownloadItem,
		webContents: WebContents,
	): void;
}

/**
 * Electron exposes one permission/download handler per Session. Detached
 * Kestrel windows still use the same browser profile, so route those events to
 * the service that owns the requesting WebContents instead of letting the
 * newest window replace the main window's handlers.
 */
class BrowserPartitionCoordinator {
	private readonly participants = new Set<BrowserPartitionParticipant>();

	constructor(private readonly partition: Session) {
		partition.setPermissionCheckHandler(
			(webContents, permission, requestingOrigin) => {
				const participant = this.find(webContents);
				return (
					participant?.isPermissionAllowed(
						requestingOrigin,
						String(permission),
					) ?? false
				);
			},
		);
		partition.setPermissionRequestHandler(
			(webContents, permission, callback, details) => {
				const participant = this.find(webContents);
				if (!participant) {
					callback(false);
					return;
				}
				void participant
					.resolvePermissionRequest(
						webContents,
						String(permission),
						details?.requestingUrl,
					)
					.then(callback)
					.catch(() => callback(false));
			},
		);
		partition.on("will-download", (event, item, webContents) => {
			const participant = this.find(webContents);
			if (!participant) {
				item.cancel();
				return;
			}
			participant.handleWillDownload(event, item, webContents);
		});
	}

	register(participant: BrowserPartitionParticipant): void {
		this.participants.add(participant);
	}

	unregister(participant: BrowserPartitionParticipant): void {
		this.participants.delete(participant);
	}

	private find(
		webContents: WebContents | null,
	): BrowserPartitionParticipant | undefined {
		if (!webContents) return undefined;
		return [...this.participants].find((participant) =>
			participant.ownsWebContents(webContents),
		);
	}
}

const browserPartitionCoordinators = new WeakMap<
	Session,
	BrowserPartitionCoordinator
>();

function browserPartitionCoordinator(
	partition: Session,
): BrowserPartitionCoordinator {
	let coordinator = browserPartitionCoordinators.get(partition);
	if (!coordinator) {
		coordinator = new BrowserPartitionCoordinator(partition);
		browserPartitionCoordinators.set(partition, coordinator);
	}
	return coordinator;
}

export class UserBrowserService {
	private readonly window: BrowserWindow;
	private readonly store: BrowserTabStore;
	private readonly partition: Session;
	private readonly extensionManager: BrowserExtensionManager;
	private readonly views = new Map<string, ViewRecord>();
	private readonly elementRefs = new Map<string, Map<string, number>>();
	private readonly downloadPaths = new Map<string, string>();
	private readonly activeDownloads = new Map<string, Electron.DownloadItem>();
	private readonly webContentsToTab = new Map<number, string>();
	private readonly confirmSitePermission: NonNullable<
		UserBrowserServiceOptions["confirmSitePermission"]
	>;
	private readonly now: () => Date;
	private readonly downloadDirectory: string;
	private readonly partitionName: string;
	private readonly partitionCoordinator: BrowserPartitionCoordinator;
	private readonly partitionParticipant: BrowserPartitionParticipant;
	private readonly onEvent: UserBrowserServiceOptions["onEvent"];
	private readonly onCommand?: UserBrowserServiceOptions["onCommand"];
	private readonly onLastTabClosed?: UserBrowserServiceOptions["onLastTabClosed"];
	private readonly recentlyClosedTabs: Array<{ url: string; title: string }> = [];
	private sleepingTabsInterval?: ReturnType<typeof setInterval>;
	private state: UserBrowserState;
	private contentBounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
	private contentVisible = false;
	private disposed = false;

	constructor(options: UserBrowserServiceOptions) {
		this.window = options.window;
		this.store = new BrowserTabStore(options.statePath);
		this.state =
			options.initialState && !existsSync(options.statePath)
				? cloneState(options.initialState)
				: this.store.load(options.now);
		this.now = options.now ?? (() => new Date());
		this.downloadDirectory = options.downloadDirectory;
		this.onEvent = options.onEvent;
		this.onCommand = options.onCommand;
		this.onLastTabClosed = options.onLastTabClosed;
		this.confirmSitePermission =
			options.confirmSitePermission ??
			(async (origin, permission) => {
				const response = await dialog.showMessageBox(this.window, {
					type: "question",
					buttons: ["Allow", "Block"],
					defaultId: 1,
					cancelId: 1,
					title: "Site permission",
					message: `${origin} wants to use ${permission}.`,
					detail:
						"Allow only if you trust this site. The choice is remembered for this profile.",
				});
				return response.response === 0;
			});
		mkdirSync(this.downloadDirectory, { recursive: true, mode: 0o700 });
		this.extensionManager = new BrowserExtensionManager(
			dirname(options.statePath),
		);
		this.partitionName = options.partitionName ?? USER_BROWSER_PARTITION;
		if (!/^persist:[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(this.partitionName))
			throw new Error(
				"User browser partitions must be named persistent profiles.",
			);
		this.partition = electronSession.fromPartition(this.partitionName, {
			cache: true,
		});
		void this.extensionManager.loadAll(this.partition);
		this.startSleepingTabsMonitor();
		this.partitionCoordinator = browserPartitionCoordinator(this.partition);
		this.partitionParticipant = {
			ownsWebContents: (webContents) =>
				this.webContentsToTab.has(webContents.id),
			isPermissionAllowed: (origin, permission) =>
				this.isPermissionAllowed(origin, permission),
			resolvePermissionRequest: (webContents, permission, requestingUrl) =>
				this.resolvePermissionRequest(
					webContents,
					permission,
					requestingUrl,
				),
			handleWillDownload: (event, item, webContents) =>
				this.handleWillDownload(event, item, webContents),
		};
		this.partitionCoordinator.register(this.partitionParticipant);
		void this.backfillOriginFaviconsFromHistory();
		void this.refreshFileStatuses();
	}

	private async refreshFileStatuses(): Promise<void> {
		let changed = false;
		for (const tab of this.state.tabs) {
			if (!tab.file) continue;
			const available = await fileStillExists(tab.file.path);
			const next = available ? "available" : "missing";
			if (tab.file.status !== next) {
				tab.file.status = next;
				changed = true;
			}
		}
		if (changed) this.commit();
	}

	getState(): UserBrowserState {
		return cloneState(this.state);
	}

	/**
	 * Open a bounded, atomically inspected batch of local files. File tabs do
	 * not create WebContentsViews; they remain trusted renderer objects whose
	 * bytes are fetched through the main-process preview boundary.
	 */
	async openFileTabs(
		paths: string[],
		active = true,
	): Promise<{
		browserState: UserBrowserState;
		selectedAttachments: SelectedAttachment[];
	}> {
		this.assertAvailable();
		const uniquePaths = [...new Set(paths)];
		if (uniquePaths.length === 0) throw new Error("Choose at least one file.");
		if (uniquePaths.length > 8)
			throw new Error("Kestrel accepts up to 8 files at a time.");
		const inspected = await Promise.all(uniquePaths.map((path) => inspectFilePath(path)));
		const existing = new Map(
			this.state.tabs.flatMap((tab) =>
				tab.file?.path ? [[tab.file.path, tab] as const] : [],
			),
		);
		const newFiles = inspected.filter((file) => !existing.has(file.path));
		if (this.state.tabs.length + newFiles.length > 32)
			throw new Error("Kestrel supports up to 32 open tabs.");

		const opened: UserBrowserTab[] = [];
		for (const file of inspected) {
			const alreadyOpen = existing.get(file.path);
			if (alreadyOpen) {
				alreadyOpen.file = file;
				alreadyOpen.title = file.name;
				alreadyOpen.url = fileTabUrl(alreadyOpen.id);
				alreadyOpen.loading = false;
				alreadyOpen.error = undefined;
				opened.push(alreadyOpen);
				continue;
			}
			const timestamp = this.now().toISOString();
			const tab = createEmptyBrowserTab(() => new Date(timestamp));
			tab.title = file.name;
			tab.url = fileTabUrl(tab.id);
			tab.file = file;
			this.state.tabs.push(tab);
			existing.set(file.path, tab);
			opened.push(tab);
		}
		if (active) {
			const target = opened.at(-1);
			if (target) {
				this.state.activeTabId = target.id;
				target.lastActiveAt = this.now().toISOString();
			}
		}
		this.commit();
		await this.syncActiveView();
		return {
			browserState: this.getState(),
			selectedAttachments: inspected.flatMap((file) => {
				const attachment = fileAttachment(file);
				return attachment ? [attachment] : [];
			}),
		};
	}

	async filePreview(tabId: string): Promise<FilePreview> {
		const tab = this.requireTab(tabId);
		if (!tab.file) throw new Error("This tab is not a local file.");
		return previewFile(tab.id, tab.file);
	}

	async openFileDefault(tabId: string): Promise<void> {
		const tab = this.requireTab(tabId);
		if (!tab.file) throw new Error("This tab is not a local file.");
		if (!(await fileStillExists(tab.file.path)))
			throw new Error(`${tab.file.name} is no longer available.`);
		const error = await shell.openPath(tab.file.path);
		if (error) throw new Error(error);
	}

	knownFilePath(path: string): boolean {
		return this.state.tabs.some((tab) => tab.file?.path === path);
	}

	ownsWebContents(webContents: WebContents): boolean {
		return this.webContentsToTab.has(webContents.id);
	}

	async createTab(input?: string, active = true): Promise<UserBrowserState> {
		this.assertAvailable();
		if (this.state.tabs.length >= 32)
			throw new Error("Kestrel supports up to 32 open tabs.");
		const timestamp = this.now().toISOString();
		const tab = createEmptyBrowserTab(() => new Date(timestamp));
		this.state.tabs.push(tab);
		if (active || !this.state.activeTabId) this.state.activeTabId = tab.id;
		this.commit();
		if (input) await this.navigate(tab.id, input);
		else await this.syncActiveView();
		return this.getState();
	}

	async selectTab(tabId: string): Promise<UserBrowserState> {
		const tab = this.requireTab(tabId);
		this.state.activeTabId = tabId;
		tab.lastActiveAt = this.now().toISOString();
		this.commit();
		await this.syncActiveView();
		this.discardLeastRecentViews();
		return this.getState();
	}

	async closeTab(tabId: string): Promise<UserBrowserState> {
		const tab = this.requireTab(tabId);
		const url = sanitizeBrowserUrl(tab.url);
		if (url && safePageUrl(url) && !tab.error) {
			this.state.recentlyClosedTabs.unshift({
				url,
				title: redactUntrustedBrowserText(tab.title, 500) || hostnameTitle(url),
				closedAt: this.now().toISOString(),
			});
			this.state.recentlyClosedTabs = this.state.recentlyClosedTabs.slice(0, 32);
		}
		const index = this.state.tabs.findIndex((item) => item.id === tabId);
		this.closeView(tabId);
		this.state.tabs.splice(index, 1);
		if (this.state.tabs.length === 0) {
			this.state.activeTabId = null;
		} else if (this.state.activeTabId === tabId) {
			this.state.activeTabId =
				this.state.tabs[Math.min(index, this.state.tabs.length - 1)]!.id;
		}
		this.commit();
		if (this.state.tabs.length === 0) {
			this.onLastTabClosed?.();
			return this.getState();
		}
		await this.syncActiveView();
		return this.getState();
	}

	async reopenClosedTab(index = 0): Promise<UserBrowserState> {
		if (
			!Number.isInteger(index) ||
			index < 0 ||
			index >= this.state.recentlyClosedTabs.length
		)
			return this.getState();
		const recent = this.state.recentlyClosedTabs.splice(index, 1)[0];
		if (!recent) return this.getState();
		this.commit();
		return this.createTab(recent.url, true);
	}

	async selectTabByIndex(index: number): Promise<UserBrowserState> {
		const tabs = this.state.tabs;
		if (tabs.length === 0) return this.getState();
		const targetIndex =
			index < 0 ? tabs.length - 1 : Math.min(index, tabs.length - 1);
		const target = tabs[targetIndex];
		if (!target) return this.getState();
		return this.selectTab(target.id);
	}

	zoomIn(tabId?: string): UserBrowserState {
		const targetId = tabId ?? this.state.activeTabId;
		if (!targetId) return this.getState();
		const record = this.views.get(targetId);
		if (record && !record.view.webContents.isDestroyed()) {
			const current =
				typeof record.view.webContents.getZoomLevel === "function"
					? record.view.webContents.getZoomLevel()
					: 0;
			if (typeof record.view.webContents.setZoomLevel === "function") {
				record.view.webContents.setZoomLevel(Math.min(current + 0.5, 3.0));
			}
		}
		return this.getState();
	}

	zoomOut(tabId?: string): UserBrowserState {
		const targetId = tabId ?? this.state.activeTabId;
		if (!targetId) return this.getState();
		const record = this.views.get(targetId);
		if (record && !record.view.webContents.isDestroyed()) {
			const current =
				typeof record.view.webContents.getZoomLevel === "function"
					? record.view.webContents.getZoomLevel()
					: 0;
			if (typeof record.view.webContents.setZoomLevel === "function") {
				record.view.webContents.setZoomLevel(Math.max(current - 0.5, -3.0));
			}
		}
		return this.getState();
	}

	zoomReset(tabId?: string): UserBrowserState {
		const targetId = tabId ?? this.state.activeTabId;
		if (!targetId) return this.getState();
		const record = this.views.get(targetId);
		if (record && !record.view.webContents.isDestroyed()) {
			if (typeof record.view.webContents.setZoomLevel === "function") {
				record.view.webContents.setZoomLevel(0);
			}
		}
		return this.getState();
	}

	async navigate(tabId: string, input: string): Promise<UserBrowserState> {
		const tab = this.requireTab(tabId);
		const appPage = parseKestrelAppPage(input);
		if (appPage) {
			this.closeView(tabId);
			delete tab.file;
			tab.error = undefined;
			tab.crashed = false;
			tab.discarded = false;
			tab.loading = false;
			tab.canGoBack = false;
			tab.canGoForward = false;
			tab.url = appPage.url;
			tab.title = appPage.title;
			this.commit();
			await this.syncActiveView();
			return this.getState();
		}
		const normalized = normalizeBrowserAddress(
			input,
			this.state.settings.searchEngine,
			this.state.settings.customSearchUrl,
		);
		delete tab.file;
		// Keep a healthy WebContentsView alive across normal web navigations so
		// Electron can retain the tab's native back/forward history. App pages,
		// file tabs, discarded views, and crashed renderers still cross an
		// explicit lifecycle boundary and receive a fresh view when needed.
		const record = this.ensureView(tab, false);
		this.elementRefs.delete(tabId);
		tab.error = undefined;
		tab.crashed = false;
		tab.discarded = false;
		tab.loading = true;
		// The actual WebContents still receives the complete navigation URL, but
		// renderer state, persistence, history, and model-visible metadata never
		// receive credential-like query or fragment values.
		tab.url = sanitizeBrowserUrl(normalized.url);
		tab.title = hostnameTitle(normalized.url);
		record.navigatingTo = normalized.url;
		this.commit();
		if (tabId === this.state.activeTabId) this.revealActiveWebContent();
		this.attachActiveWebView();
		try {
			await record.view.webContents.loadURL(normalized.url);
		} catch (cause) {
			if (record.navigatingTo !== normalized.url) return this.getState();
			tab.loading = false;
			tab.error =
				cause instanceof Error
					? cause.message.slice(0, 500)
					: "This page could not be opened.";
			this.commit();
		} finally {
			if (record.navigatingTo === normalized.url) delete record.navigatingTo;
		}
		this.discardLeastRecentViews();
		return this.getState();
	}

	back(tabId: string): UserBrowserState {
		const tab = this.requireTab(tabId);
		if (isKestrelAppPageUrl(tab.url)) return this.getState();
		const record = this.requireView(tabId);
		if (record.view.webContents.navigationHistory.canGoBack())
			record.view.webContents.navigationHistory.goBack();
		return this.getState();
	}

	forward(tabId: string): UserBrowserState {
		const tab = this.requireTab(tabId);
		if (isKestrelAppPageUrl(tab.url)) return this.getState();
		const record = this.requireView(tabId);
		if (record.view.webContents.navigationHistory.canGoForward())
			record.view.webContents.navigationHistory.goForward();
		return this.getState();
	}

	reload(tabId: string, ignoreCache = false): UserBrowserState {
		const tab = this.requireTab(tabId);
		if (!tab.url || isKestrelAppPageUrl(tab.url)) return this.getState();
		tab.error = undefined;
		tab.crashed = false;
		const record = this.ensureView(tab);
		if (tabId === this.state.activeTabId) this.revealActiveWebContent();
		this.attachActiveWebView();
		const loadedUrl = record.view.webContents.getURL?.() ?? "";
		if (!loadedUrl) {
			void record.view.webContents.loadURL(tab.url).catch((cause) => {
				if (record.view.webContents.isDestroyed()) return;
				tab.loading = false;
				tab.error =
					cause instanceof Error
						? cause.message.slice(0, 500)
						: "This page could not be opened.";
				this.commit();
			});
			return this.getState();
		}
		if (
			ignoreCache &&
			typeof record.view.webContents.reloadIgnoringCache === "function"
		) {
			record.view.webContents.reloadIgnoringCache();
		} else {
			record.view.webContents.reload();
		}
		return this.getState();
	}

	stop(tabId: string): UserBrowserState {
		const tab = this.requireTab(tabId);
		if (isKestrelAppPageUrl(tab.url)) return this.getState();
		this.requireView(tabId).view.webContents.stop();
		return this.getState();
	}

	async setContentBounds(bounds: Rectangle, visible: boolean): Promise<void> {
		this.assertAvailable();
		const size = this.window.getContentSize();
		const windowWidth = size[0] ?? 0;
		const windowHeight = size[1] ?? 0;
		const x = Math.min(Math.max(0, Math.round(bounds.x)), windowWidth);
		const y = Math.min(Math.max(0, Math.round(bounds.y)), windowHeight);
		const width = Math.min(
			Math.max(0, Math.round(bounds.width)),
			Math.max(0, windowWidth - x),
		);
		const height = Math.min(
			Math.max(0, Math.round(bounds.height)),
			Math.max(0, windowHeight - y),
		);
		this.contentBounds = { x, y, width, height };
		this.contentVisible = visible && width >= 160 && height >= 120;
		await this.syncActiveView();
	}

	updateSettings(settings: UserBrowserSettings): UserBrowserState {
		this.state.settings = { ...settings };
		this.pruneHistory();
		this.commit();
		return this.getState();
	}

	clearHistory(): UserBrowserState {
		this.state.history = [];
		this.state.originFavicons = [];
		this.state.recentlyClosedTabs = [];
		this.state.settings = {
			...this.state.settings,
			newTabGreetingActivity: emptyNewTabGreetingActivity(),
		};
		for (const record of this.views.values())
			record.view.webContents.navigationHistory.clear();
		this.commit();
		return this.getState();
	}

	revealDownload(downloadId: string): void {
		const download = this.state.downloads.find(
			(item) => item.id === downloadId,
		);
		const path = this.downloadPaths.get(downloadId);
		if (!download || !path || !download.canReveal || !existsSync(path))
			throw new Error("This download is no longer available to reveal.");
		shell.showItemInFolder(path);
	}

	async openDownload(downloadId: string): Promise<void> {
		const download = this.state.downloads.find(
			(item) => item.id === downloadId,
		);
		const path = this.downloadPaths.get(downloadId);
		if (!download || !path || !download.canReveal || !existsSync(path))
			throw new Error("This download is no longer available to open.");
		const error = await shell.openPath(path);
		if (error) throw new Error(error);
	}

	cancelDownload(downloadId: string): UserBrowserState {
		const item = this.activeDownloads.get(downloadId);
		if (!item) throw new Error("This download is not in progress.");
		item.cancel();
		return this.getState();
	}

	async clearBrowsingData(options: {
		history?: boolean;
		cookies?: boolean;
		cache?: boolean;
	}): Promise<UserBrowserState> {
		this.assertAvailable();
		if (options.history) {
			this.state.history = [];
			this.state.originFavicons = [];
			this.state.recentlyClosedTabs = [];
			this.state.settings = {
				...this.state.settings,
				newTabGreetingActivity: emptyNewTabGreetingActivity(),
			};
		}
		if (options.cache && typeof this.partition.clearCache === "function")
			await this.partition.clearCache();
		if (
			options.cookies &&
			typeof this.partition.clearStorageData === "function"
		) {
			await this.partition.clearStorageData();
			this.state.sitePermissions = [];
		}
		this.commit();
		return this.getState();
	}

	toggleBookmark(url?: string, title?: string): UserBrowserState {
		const tab = url
			? undefined
			: this.state.tabs.find((item) => item.id === this.state.activeTabId);
		const targetUrl = sanitizeBrowserUrl(url ?? tab?.url ?? "");
		if (!safePageUrl(targetUrl))
			throw new Error("Only HTTP and HTTPS pages can be bookmarked.");
		const existing = this.state.bookmarks.find((item) => item.url === targetUrl);
		if (existing) {
			this.state.bookmarks = this.state.bookmarks.filter(
				(item) => item.id !== existing.id,
			);
			this.commit();
			return this.getState();
		}
		if (this.state.bookmarks.length >= MAX_BOOKMARKS)
			throw new Error("Kestrel supports up to 2,000 bookmarks.");
		this.state.bookmarks.unshift({
			id: `bookmark-${randomUUID()}`,
			url: targetUrl,
			title: (title ?? tab?.title ?? hostnameTitle(targetUrl))
				.trim()
				.slice(0, 500) || hostnameTitle(targetUrl),
			createdAt: this.now().toISOString(),
		});
		this.commit();
		return this.getState();
	}

	removeBookmark(bookmarkId: string): UserBrowserState {
		this.state.bookmarks = this.state.bookmarks.filter(
			(item) => item.id !== bookmarkId,
		);
		this.commit();
		return this.getState();
	}

	pinTab(tabId: string, pinned: boolean): UserBrowserState {
		const tab = this.requireTab(tabId);
		tab.pinned = pinned;
		const pinnedTabs = this.state.tabs.filter((item) => item.pinned);
		const rest = this.state.tabs.filter((item) => !item.pinned);
		this.state.tabs = [...pinnedTabs, ...rest];
		this.commit();
		return this.getState();
	}

	muteTab(tabId: string, muted: boolean): UserBrowserState {
		const tab = this.requireTab(tabId);
		tab.muted = muted;
		const record = this.views.get(tabId);
		if (
			record &&
			!record.view.webContents.isDestroyed() &&
			typeof record.view.webContents.setAudioMuted === "function"
		) {
			record.view.webContents.setAudioMuted(muted);
		}
		this.commit();
		return this.getState();
	}

	async duplicateTab(tabId: string): Promise<UserBrowserState> {
		const tab = this.requireTab(tabId);
		if (tab.file) return (await this.openFileTabs([tab.file.path], true)).browserState;
		return this.createTab(tab.url || undefined, true);
	}

	async closeOtherTabs(tabId: string): Promise<UserBrowserState> {
		this.requireTab(tabId);
		const closing = this.state.tabs
			.filter((tab) => tab.id !== tabId && !tab.pinned)
			.map((tab) => tab.id);
		for (const id of closing) await this.closeTab(id);
		return this.getState();
	}

	moveTab(tabId: string, toIndex: number): UserBrowserState {
		const fromIndex = this.state.tabs.findIndex((tab) => tab.id === tabId);
		if (fromIndex < 0) throw new Error("Browser tab is unavailable.");
		const [tab] = this.state.tabs.splice(fromIndex, 1);
		if (!tab) throw new Error("Browser tab is unavailable.");
		const bounded = Math.min(Math.max(0, toIndex), this.state.tabs.length);
		this.state.tabs.splice(bounded, 0, tab);
		this.commit();
		return this.getState();
	}

	async detachTab(tabId: string): Promise<UserBrowserState> {
		const tab = this.requireTab(tabId);
		if (!tab.url || tab.file || tab.error || isKestrelAppPageUrl(tab.url)) {
			throw new Error("Only loaded web pages can open in a separate window.");
		}
		this.closeView(tabId);
		const index = this.state.tabs.findIndex((item) => item.id === tabId);
		this.state.tabs.splice(index, 1);
		if (this.state.tabs.length === 0) {
			const replacement = createEmptyBrowserTab(this.now);
			this.state.tabs.push(replacement);
			this.state.activeTabId = replacement.id;
		} else if (this.state.activeTabId === tabId) {
			this.state.activeTabId =
				this.state.tabs[Math.min(index, this.state.tabs.length - 1)]!.id;
		}
		this.commit();
		await this.syncActiveView();
		return this.getState();
	}

	findInPage(
		tabId: string,
		query: string,
		options: { findNext?: boolean; forward?: boolean } = {},
	): UserBrowserState {
		const record = this.requireView(tabId);
		const text = query.trim();
		if (!text) {
			this.stopFindInPage(tabId);
			return this.getState();
		}
		record.view.webContents.findInPage(text, {
			forward: options.forward ?? true,
			findNext: Boolean(options.findNext),
		});
		return this.getState();
	}

	stopFindInPage(tabId: string): UserBrowserState {
		const record = this.views.get(tabId);
		if (record && !record.view.webContents.isDestroyed())
			record.view.webContents.stopFindInPage("clearSelection");
		return this.getState();
	}

	printTab(tabId: string): UserBrowserState {
		const record = this.requireView(tabId);
		record.view.webContents.print({});
		return this.getState();
	}

	openDevTools(tabId: string): UserBrowserState {
		const record = this.requireView(tabId);
		record.view.webContents.openDevTools({ mode: "detach" });
		return this.getState();
	}

	setSitePermission(
		origin: string,
		permission: string,
		decision: "allow" | "deny",
	): UserBrowserState {
		const next = this.state.sitePermissions.filter(
			(item) => !(item.origin === origin && item.permission === permission),
		);
		next.push({
			origin,
			permission,
			decision,
			updatedAt: this.now().toISOString(),
		});
		this.state.sitePermissions = next.slice(-500);
		this.commit();
		return this.getState();
	}

	async pageContext(tabId?: string): Promise<UserBrowserPageContext> {
		const tab = this.requireTab(tabId ?? this.requireActiveTab().id);
		if (!tab.url || tab.error || isKestrelAppPageUrl(tab.url))
			throw new Error("The selected tab does not have a readable web page.");
		const record = this.ensureView(tab);
		const raw = (await record.view.webContents.executeJavaScript(`(() => {
      const limit = (value, maximum) => String(value ?? "").replace(/\\s+/g, " ").trim().slice(0, maximum);
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0;
      };
      const nodes = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,table,article,main")).filter(visible);
      const visibleText = nodes.map((node) => limit(node.innerText || node.textContent, 4000)).filter(Boolean).join("\\n").slice(0, 40000);
      const links = Array.from(document.querySelectorAll("a[href]")).filter(visible).slice(0, 100).map((node) => ({ text: limit(node.innerText || node.textContent, 500), url: node.href }));
      const forms = Array.from(document.querySelectorAll("input,textarea,select,button")).filter(visible).slice(0, 60).map((node) => ({ label: limit(node.labels?.[0]?.innerText || node.getAttribute("aria-label") || node.placeholder || node.innerText, 500), type: limit(node.type || node.tagName.toLowerCase(), 100), name: limit(node.name || node.id, 500) }));
      return {
        description: limit(document.querySelector('meta[name="description"]')?.content, 2000),
        selectedText: limit(getSelection()?.toString(), 20000),
        visibleText: visibleText || limit(document.body?.innerText, 40000),
        headings: Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).filter(visible).slice(0, 60).map((node) => limit(node.innerText || node.textContent, 500)).filter(Boolean),
        links,
        forms,
        viewport: { width: Math.max(1, Math.round(innerWidth)), height: Math.max(1, Math.round(innerHeight)), scrollX, scrollY }
      };
    })()`)) as Omit<
			UserBrowserPageContext,
			"tabId" | "url" | "title" | "capturedAt" | "trust"
		>;
		const links = Array.isArray(raw.links)
			? raw.links.flatMap((link) => {
					if (!link || typeof link !== "object") return [];
					const candidate = link as { text?: unknown; url?: unknown };
					const url = sanitizeBrowserUrl(String(candidate.url ?? ""));
					return url
						? [
								{
									text: redactUntrustedBrowserText(candidate.text, 500),
									url,
								},
							]
						: [];
				})
			: [];
		const forms = Array.isArray(raw.forms)
			? raw.forms.flatMap((form) => {
					if (!form || typeof form !== "object") return [];
					const candidate = form as {
						label?: unknown;
						type?: unknown;
						name?: unknown;
					};
					return [
						{
							label: redactUntrustedBrowserText(candidate.label, 500),
							type: redactUntrustedBrowserText(candidate.type, 100),
							name: redactUntrustedBrowserText(candidate.name, 500),
						},
					];
				})
			: [];
		const url =
			sanitizeBrowserUrl(record.view.webContents.getURL()) ||
			sanitizeBrowserUrl(tab.url);
		if (!url)
			throw new Error("The selected tab does not have a safe readable URL.");
		return UserBrowserPageContextSchema.parse({
			tabId: tab.id,
			url,
			title: redactUntrustedBrowserText(
				record.view.webContents.getTitle() || tab.title,
				500,
			),
			description: redactUntrustedBrowserText(raw.description, 2000),
			selectedText: redactUntrustedBrowserText(raw.selectedText, 20_000),
			visibleText: redactUntrustedBrowserText(raw.visibleText, 40_000),
			headings: Array.isArray(raw.headings)
				? raw.headings
						.map((heading) => redactUntrustedBrowserText(heading, 500))
						.filter(Boolean)
				: [],
			links,
			forms,
			viewport: raw.viewport,
			capturedAt: this.now().toISOString(),
			trust: "untrusted_browser",
		});
	}

	isActiveTab(tabId: string): boolean {
		return this.state.activeTabId === tabId;
	}

	async insertLoginCode(
		tabId: string,
		code: string,
		expectedDomain: string,
		expectedOrigin: string,
	): Promise<void> {
		if (!/^[A-Z0-9][A-Z0-9-]{3,15}$/.test(code))
			throw new Error("The login code is invalid.");
		if (!this.isActiveTab(tabId))
			throw new Error("The verification page is no longer active.");
		const domain = pageDomain(`https://${expectedDomain}`);
		const originUrl = safePageUrl(expectedOrigin);
		if (!domain || !originUrl || originUrl.origin !== expectedOrigin)
			throw new Error("The verification page domain is invalid.");
		const tab = this.requireTab(tabId);
		const record = this.requireView(tab.id);
		const webContents = record.view.webContents;
		if (
			pageDomain(webContents.getURL()) !== domain ||
			safePageUrl(webContents.getURL())?.origin !== expectedOrigin
		)
			throw new Error("The page changed before the code was used.");
		const focusedCodeField = await webContents.executeJavaScript(`(() => {
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0;
      };
      const explicitSelector = [
        'input[autocomplete="one-time-code"]',
        'input[name*="code" i]',
        'input[id*="code" i]',
        'input[placeholder*="code" i]',
        'input[name*="otp" i]',
        'input[id*="otp" i]',
      ].join(",");
      const explicitTarget = Array.from(document.querySelectorAll(explicitSelector)).find(visible);
      const target = explicitTarget ?? Array.from(document.querySelectorAll('input[type="tel"]')).find(visible);
      if (!target) return false;
      target.focus();
      if (typeof target.select === "function") target.select();
      return true;
    })()`);
		if (!focusedCodeField)
			throw new Error("The page changed; Kestrel could not find its code field.");
		if (
			pageDomain(webContents.getURL()) !== domain ||
			safePageUrl(webContents.getURL())?.origin !== expectedOrigin
		)
			throw new Error("The page changed before the code was used.");
		webContents.focus();
		webContents.insertText(code);
	}

	async snapshot(
		tabId?: string,
		signal?: AbortSignal,
	): Promise<BrowserSnapshot> {
		const tab = this.requireTab(tabId ?? this.requireActiveTab().id);
		const webContents = this.ensureView(tab).view.webContents;
		if (signal?.aborted) throw signal.reason;
		const url =
			sanitizeBrowserUrl(webContents.getURL()) ||
			sanitizeBrowserUrl(tab.url);
		if (!url) {
			this.elementRefs.set(tab.id, new Map());
			return {
				url: "about:blank",
				title: (webContents.getTitle() || tab.title || "New Tab").slice(
					0,
					500,
				),
				accessibilityTree: { nodes: [] },
				interactive: [],
			};
		}
		if (!webContents.debugger.isAttached()) webContents.debugger.attach("1.3");
		const result = (await webContents.debugger.sendCommand(
			"Accessibility.getFullAXTree",
		)) as { nodes?: unknown[] };
		const nodes = result.nodes ?? [];
		const annotated = annotateAccessibilityTree({
			nodes: nodes.slice(0, MAX_AX_SNAPSHOT_NODES),
		});
		const interactive = annotated.interactive.slice(0, MAX_INTERACTIVE_REFS);
		const accessibilityTree = sanitizeUntrustedBrowserValue(
			annotated.accessibilityTree,
		);
		if (
			Buffer.byteLength(JSON.stringify(accessibilityTree), "utf8") >
			MAX_AX_SNAPSHOT_BYTES
		) {
			this.elementRefs.set(tab.id, new Map());
			throw new Error("Visible browser accessibility snapshot exceeds 1.5 MB.");
		}
		this.elementRefs.set(tab.id, rememberElementRefs(interactive));
		return {
			url,
			title: redactUntrustedBrowserText(webContents.getTitle(), 500),
			accessibilityTree,
			interactive: publicInteractiveRefs(interactive).map((item) => ({
				ref: item.ref,
				role: item.role,
				...(item.name
					? { name: redactUntrustedBrowserText(item.name, 500) }
					: {}),
			})),
			truncated:
				nodes.length > MAX_AX_SNAPSHOT_NODES ||
				annotated.interactive.length > MAX_INTERACTIVE_REFS,
		};
	}

	searchHistory(
		query = "",
		limit = 30,
	): {
		entries: UserBrowserHistoryEntry[];
		trust: "untrusted_browser";
	} {
		const needle = query.trim().toLocaleLowerCase();
		const entries = [...this.state.history]
			.reverse()
			.flatMap((entry) => {
				const url = sanitizeBrowserUrl(entry.url);
				if (!url) return [];
				const sanitized = {
					...entry,
					url,
					title: redactUntrustedBrowserText(entry.title, 500),
				};
				if (
					needle &&
					!`${sanitized.title}\n${sanitized.url}`
						.toLocaleLowerCase()
						.includes(needle)
				)
					return [];
				return [sanitized];
			})
			.slice(0, Math.min(100, Math.max(1, Math.trunc(limit))));
		return { entries: structuredClone(entries), trust: "untrusted_browser" };
	}

	visibleDownloads(): {
		downloads: UserBrowserDownload[];
		trust: "untrusted_browser";
	} {
		return {
			downloads: structuredClone([...this.state.downloads].reverse()),
			trust: "untrusted_browser",
		};
	}

	async screenshot(
		tabId?: string,
		signal?: AbortSignal,
	): Promise<ScreenshotFrame> {
		const tab = this.requireTab(tabId ?? this.requireActiveTab().id);
		const webContents = this.ensureView(tab).view.webContents;
		if (signal?.aborted) throw signal.reason;
		const image = await webContents.capturePage();
		const { width, height } = image.getSize();
		const bgra = image.toBitmap();
		const rgba = new Uint8Array(bgra.byteLength);
		for (let offset = 0; offset < bgra.length; offset += 4) {
			rgba[offset] = bgra[offset + 2]!;
			rgba[offset + 1] = bgra[offset + 1]!;
			rgba[offset + 2] = bgra[offset]!;
			rgba[offset + 3] = bgra[offset + 3]!;
		}
		return { width, height, rgba, png: image.toPNG() };
	}

	async act(
		tabId: string,
		action: BrowserAction,
		signal: AbortSignal,
	): Promise<void> {
		const record = this.ensureView(this.requireTab(tabId));
		const webContents = record.view.webContents;
		if (signal.aborted) throw signal.reason;
		if (action.type === "click") {
			const point = await this.targetPoint(
				webContents,
				action.target,
				false,
				tabId,
			);
			if (signal.aborted) throw signal.reason;
			if (!webContents.debugger.isAttached())
				webContents.debugger.attach("1.3");
			const pointer = {
				x: point.x,
				y: point.y,
				modifiers: 0,
				pointerType: "mouse",
			};
			await webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
				...pointer,
				type: "mouseMoved",
				button: "none",
				buttons: 0,
				clickCount: 0,
			});
			if (signal.aborted) throw signal.reason;
			let pressed = false;
			try {
				await webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
					...pointer,
					type: "mousePressed",
					button: "left",
					buttons: 1,
					clickCount: 1,
				});
				pressed = true;
				if (signal.aborted) throw signal.reason;
				await webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
					...pointer,
					type: "mouseReleased",
					button: "left",
					buttons: 0,
					clickCount: 1,
				});
				pressed = false;
			} finally {
				if (pressed)
					await webContents.debugger
						.sendCommand("Input.dispatchMouseEvent", {
							...pointer,
							type: "mouseReleased",
							button: "left",
							buttons: 0,
							clickCount: 1,
						})
						.catch(() => undefined);
			}
			await new Promise<void>((resolveSettle) => setImmediate(resolveSettle));
		} else if (action.type === "type") {
			await this.targetPoint(webContents, action.target, true, tabId);
			if (signal.aborted) throw signal.reason;
			webContents.insertText(action.text);
		} else if (action.type === "key") {
			if (
				!/^[A-Za-z0-9]{1,20}$/.test(action.key) &&
				![
					"Enter",
					"Escape",
					"Tab",
					"Backspace",
					"ArrowUp",
					"ArrowDown",
					"ArrowLeft",
					"ArrowRight",
				].includes(action.key)
			)
				throw new Error("Browser key is not allowed.");
			webContents.sendInputEvent({ type: "keyDown", keyCode: action.key });
			webContents.sendInputEvent({ type: "keyUp", keyCode: action.key });
		} else {
			webContents.sendInputEvent({
				type: "mouseWheel",
				x: 0,
				y: 0,
				deltaX: Math.trunc(action.x),
				deltaY: Math.trunc(action.y),
				canScroll: true,
			});
		}
	}

	async handleAgentRequest(
		request: UserBrowserBackendWireRequest,
		signal: AbortSignal,
	): Promise<unknown> {
		if (signal.aborted) throw signal.reason;
		switch (request.operation) {
			case "visible-tabs":
				return this.getState().tabs.map((tab) => ({
					id: tab.id,
					title: tab.title,
					url: sanitizeBrowserUrl(tab.url),
					active: tab.id === this.state.activeTabId,
					loading: tab.loading,
					discarded: tab.discarded,
					trust: "untrusted_browser" as const,
				}));
			case "visible-context":
				return this.pageContext(request.tabId);
			case "visible-snapshot":
				return {
					...(await this.snapshot(request.tabId, signal)),
					trust: "untrusted_browser",
				};
			case "visible-screenshot":
				return {
					...(await this.screenshot(request.tabId, signal)),
					trust: "untrusted_browser",
				};
			case "visible-history":
				return this.searchHistory(request.query, request.limit);
			case "visible-downloads":
				return this.visibleDownloads();
			case "visible-act":
				await this.act(request.tabId, request.action, signal);
				return { performed: true };
			case "visible-navigate":
				await this.navigate(request.tabId, request.input);
				return { navigated: true };
			case "visible-create": {
				const state = await this.createTab(request.input, true);
				return { tabId: state.activeTabId };
			}
			case "visible-close":
				await this.closeTab(request.tabId);
				return { closed: true };
			case "visible-select":
				await this.selectTab(request.tabId);
				return { selected: true };
			default: {
				const unsupported: never = request;
				throw new Error(
					`Unsupported visible-browser operation: ${String(unsupported)}`,
				);
			}
		}
	}

	sleepTab(tabId: string): UserBrowserState {
		if (tabId === this.state.activeTabId) return this.getState();
		const tab = this.requireTab(tabId);
		if (!tab.url || isKestrelAppPageUrl(tab.url)) return this.getState();
		this.closeView(tabId);
		tab.discarded = true;
		this.commit();
		return this.getState();
	}

	sleepInactiveTabs(): UserBrowserState {
		for (const tab of this.state.tabs) {
			if (
				tab.id === this.state.activeTabId ||
				!tab.url ||
				tab.discarded ||
				isKestrelAppPageUrl(tab.url)
			)
				continue;
			const record = this.views.get(tab.id);
			if (
				record &&
				!record.view.webContents.isDestroyed() &&
				record.view.webContents.isCurrentlyAudible()
			) {
				continue;
			}
			this.closeView(tab.id);
			tab.discarded = true;
		}
		this.commit();
		return this.getState();
	}

	private startSleepingTabsMonitor(): void {
		if (this.sleepingTabsInterval) clearInterval(this.sleepingTabsInterval);
		this.sleepingTabsInterval = setInterval(() => {
			this.checkSleepingTabs();
		}, 30_000);
	}

	private checkSleepingTabs(): void {
		if (this.disposed || !this.state.settings.sleepingTabsEnabled) return;
		const timeoutMinutes = this.state.settings.sleepingTabTimeoutMinutes || 30;
		const timeoutMs = timeoutMinutes * 60 * 1000;
		const nowTime = this.now().getTime();
		let changed = false;

		for (const tab of this.state.tabs) {
			if (
				tab.id === this.state.activeTabId ||
				!tab.url ||
				tab.discarded ||
				isKestrelAppPageUrl(tab.url)
			)
				continue;
			const lastActive = Date.parse(tab.lastActiveAt);
			if (isNaN(lastActive) || nowTime - lastActive < timeoutMs) continue;

			// Do not sleep tabs that are playing audio
			const record = this.views.get(tab.id);
			if (
				record &&
				!record.view.webContents.isDestroyed() &&
				record.view.webContents.isCurrentlyAudible()
			) {
				continue;
			}

			// Do not sleep tabs matching excluded domains
			try {
				const hostname = new URL(tab.url).hostname.toLowerCase();
				if (
					this.state.settings.sleepingTabExcludedDomains?.some((domain) =>
						hostname.includes(domain.toLowerCase().trim()),
					)
				) {
					continue;
				}
			} catch {
				// Ignore parse error
			}

			this.closeView(tab.id);
			tab.discarded = true;
			changed = true;
		}

		if (changed) {
			this.commit();
		}
	}

	listExtensions(): InstalledExtension[] {
		return this.extensionManager.list();
	}

	async installExtensionUrl(urlOrId: string): Promise<InstalledExtension> {
		return this.extensionManager.installFromChromeWebStore(
			urlOrId,
			this.partition,
		);
	}

	async installExtensionFile(filePath: string): Promise<InstalledExtension> {
		return this.extensionManager.installFromCrxOrZipFile(
			filePath,
			this.partition,
		);
	}

	async installExtensionFolder(
		folderPath: string,
	): Promise<InstalledExtension> {
		return this.extensionManager.installFromUnpacked(
			folderPath,
			this.partition,
		);
	}

	async toggleExtension(
		id: string,
		enabled: boolean,
	): Promise<InstalledExtension> {
		return this.extensionManager.toggle(id, enabled, this.partition);
	}

	async uninstallExtension(id: string): Promise<void> {
		return this.extensionManager.uninstall(id, this.partition);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.sleepingTabsInterval) clearInterval(this.sleepingTabsInterval);
		this.partitionCoordinator.unregister(this.partitionParticipant);
		for (const tabId of [...this.views.keys()]) this.closeView(tabId);
		this.elementRefs.clear();
	}

	private handleWillDownload(
		_event: Electron.Event,
		item: Electron.DownloadItem,
		webContents: WebContents,
	): void {
		const tabId = this.webContentsToTab.get(webContents.id);
		if (!tabId) {
			item.cancel();
			return;
		}
		const id = `download-${randomUUID()}`;
		const filename = this.availableDownloadName(item.getFilename(), id);
		const path = join(this.downloadDirectory, filename);
		const startedAt = this.now().toISOString();
		item.setSavePath(path);
		this.downloadPaths.set(id, path);
		this.activeDownloads.set(id, item);
		this.state.downloads.push({
			id,
			tabId,
			filename,
			sourceUrl: sanitizeBrowserUrl(item.getURL()) || "https://invalid.local/",
			receivedBytes: 0,
			totalBytes: Math.max(0, item.getTotalBytes()),
			status: "progressing",
			startedAt,
			canReveal: false,
		});
		this.state.downloads.splice(
			0,
			Math.max(0, this.state.downloads.length - MAX_DOWNLOAD_ENTRIES),
		);
		this.commit();
		item.on("updated", () => {
			const record = this.state.downloads.find(
				(download) => download.id === id,
			);
			if (!record) return;
			record.receivedBytes = Math.max(0, item.getReceivedBytes());
			record.totalBytes = Math.max(0, item.getTotalBytes());
			this.emit();
		});
		item.once("done", (_doneEvent, status) => {
			this.activeDownloads.delete(id);
			const record = this.state.downloads.find(
				(download) => download.id === id,
			);
			if (!record) return;
			record.receivedBytes = Math.max(0, item.getReceivedBytes());
			record.totalBytes = Math.max(0, item.getTotalBytes());
			record.status =
				status === "completed"
					? "completed"
					: status === "cancelled"
						? "cancelled"
						: "failed";
			record.completedAt = this.now().toISOString();
			record.canReveal = status === "completed" && existsSync(path);
			this.commit();
		});
	}

	private ensureView(
		tab: UserBrowserTab,
		loadStoredUrl = true,
	): ViewRecord {
		if (tab.file || isKestrelAppPageUrl(tab.url))
			throw new Error("App pages do not use a web view.");
		const existing = this.views.get(tab.id);
		if (existing && !existing.view.webContents.isDestroyed()) return existing;
		if (existing) this.closeView(tab.id, false);
		const view = new WebContentsView({
			webPreferences: {
				preload: join(__dirname, "../preload/userBrowser.cjs"),
				partition: this.partitionName,
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				webSecurity: true,
				javascript: true,
				devTools: false,
				backgroundThrottling: true,
				spellcheck: true,
			},
		});
		view.setBackgroundColor("#ffffff");
		const record: ViewRecord = { view };
		this.views.set(tab.id, record);
		this.webContentsToTab.set(view.webContents.id, tab.id);
		this.configureView(tab, record);
		if (
			tab.muted &&
			typeof view.webContents.setAudioMuted === "function"
		) {
			view.webContents.setAudioMuted(true);
		}
		if (loadStoredUrl && tab.url) {
			tab.discarded = false;
			tab.loading = true;
			void view.webContents.loadURL(tab.url).catch((cause) => {
				if (view.webContents.isDestroyed()) return;
				tab.loading = false;
				tab.error =
					cause instanceof Error
						? cause.message.slice(0, 500)
						: "This page could not be opened.";
				this.commit();
			});
		}
		return record;
	}

	private configureView(tab: UserBrowserTab, record: ViewRecord): void {
		const { webContents } = record.view;
		webContents.setWindowOpenHandler(({ url, disposition }) => {
			if (safePageUrl(url) && this.state.tabs.length < 32) {
				void this.createTab(url, disposition !== "background-tab").catch(
					() => undefined,
				);
			}
			return { action: "deny" };
		});
		webContents.on("will-navigate", (event, url) => {
			if (!safePageUrl(url)) event.preventDefault();
		});
		webContents.on("will-redirect", (event, url) => {
			if (!safePageUrl(url)) event.preventDefault();
		});
		webContents.on("did-start-loading", () => {
			tab.loading = true;
			tab.error = undefined;
			this.updateNavigationState(tab, webContents);
		});
		webContents.on("did-stop-loading", () => {
			tab.loading = false;
			this.updateNavigationState(tab, webContents);
			if (!tab.faviconDataUrl && tab.url) {
				const origin = safePageUrl(tab.url)?.origin;
				if (origin) void this.loadFavicon(tab, `${origin}/favicon.ico`);
			}
		});
		webContents.on("page-title-updated", (_event, title) => {
			tab.title = title.trim().slice(0, 500) || hostnameTitle(tab.url);
			const recent = [...this.state.history]
				.reverse()
				.find((entry) => entry.tabId === tab.id && entry.url === tab.url);
			if (recent) recent.title = tab.title;
			this.commit();
		});
		webContents.on("page-favicon-updated", (_event, favicons) => {
			const favicon = favicons.find(
				(value) => isFaviconDataUrl(value) || safePageUrl(value),
			);
			if (favicon) void this.loadFavicon(tab, favicon);
		});
		webContents.on(
			"did-navigate",
			(_event, url, _httpResponseCode, _httpStatusText) => {
				this.didNavigate(tab, webContents, url);
			},
		);
		webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
			if (isMainFrame) this.didNavigate(tab, webContents, url);
		});
		webContents.on(
			"did-fail-load",
			(_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
				if (!isMainFrame || errorCode === -3) return;
				tab.loading = false;
				tab.error = `${errorDescription} (${errorCode})`.slice(0, 500);
				this.updateNavigationState(tab, webContents);
			},
		);
		webContents.on("render-process-gone", () => {
			tab.loading = false;
			tab.crashed = true;
			tab.error = "This tab stopped responding. Reload it to continue.";
			this.closeView(tab.id);
			tab.discarded = Boolean(tab.url);
			this.commit();
		});
		webContents.on("found-in-page", (_event, result) => {
			this.onEvent({
				type: "find-in-page",
				match: {
					tabId: tab.id,
					activeMatchOrdinal: result.activeMatchOrdinal,
					matches: result.matches,
					finalUpdate: result.finalUpdate,
				},
			});
		});
		webContents.on("context-menu", (_event, params) => {
			const template: Electron.MenuItemConstructorOptions[] = [];
			if (params.linkURL && safePageUrl(params.linkURL)) {
				template.push(
					{
						label: "Open Link in New Tab",
						click: () => void this.createTab(params.linkURL, true),
					},
					{
						label: "Copy Link",
						click: () => clipboard.writeText(params.linkURL),
					},
					{ type: "separator" },
				);
			}
			if (params.hasImageContents && params.srcURL && safePageUrl(params.srcURL)) {
				template.push(
					{
						label: "Open Image in New Tab",
						click: () => void this.createTab(params.srcURL, true),
					},
					{
						label: "Copy Image Address",
						click: () => clipboard.writeText(params.srcURL),
					},
					{ type: "separator" },
				);
			}
			if (params.isEditable)
				template.push(
					{ role: "cut" },
					{ role: "copy" },
					{ role: "paste" },
					{ role: "selectAll" },
				);
			else if (params.selectionText) {
				template.push({ role: "copy" });
				const query = params.selectionText.trim().slice(0, 200);
				if (query) {
					template.push({
						label: `Search for “${query.slice(0, 40)}”`,
						click: () => void this.createTab(query, true),
					});
				}
			}
			template.push(
				...(template.length ? [{ type: "separator" } as const] : []),
				{
					label: "Back",
					enabled: tab.canGoBack,
					click: () => this.back(tab.id),
				},
				{
					label: "Forward",
					enabled: tab.canGoForward,
					click: () => this.forward(tab.id),
				},
				{ role: "reload" },
				{ type: "separator" },
				{
					label: "Bookmark This Page",
					enabled: Boolean(safePageUrl(tab.url)),
					click: () => this.toggleBookmark(tab.url, tab.title),
				},
				{
					label: "Print…",
					click: () => this.printTab(tab.id),
				},
				{
					label: "Inspect",
					click: () => this.openDevTools(tab.id),
				},
			);
			Menu.buildFromTemplate(template).popup({ window: this.window });
		});
		webContents.on("before-input-event", (event, input) => {
			if (input.type !== "keyDown") return;

			// Escape: Stop loading if currently loading
			if (input.key === "Escape") {
				if (tab.loading) {
					event.preventDefault();
					this.stop(tab.id);
				}
				return;
			}

			// F5 / Shift+F5: Reload / Hard reload
			if (input.key === "F5") {
				event.preventDefault();
				this.reload(tab.id, input.shift);
				return;
			}

			// F1: Show shortcuts
			if (input.key === "F1") {
				event.preventDefault();
				this.onCommand?.("show-shortcuts");
				return;
			}

			// Alt + Left / Alt + Right / Alt + D (Standard navigation)
			if (input.alt && !input.meta && !input.control) {
				if (input.key === "ArrowLeft") {
					event.preventDefault();
					this.back(tab.id);
					return;
				}
				if (input.key === "ArrowRight") {
					event.preventDefault();
					this.forward(tab.id);
					return;
				}
				if (input.key.toLowerCase() === "d") {
					event.preventDefault();
					this.onCommand?.("focus-address");
					return;
				}
			}

			const command = input.meta || input.control;
			if (!command) return;
			const key = input.key.toLowerCase();

			// Tab switching: Cmd/Ctrl + 1..8, Cmd/Ctrl + 9
			if (/^[1-8]$/.test(input.key)) {
				event.preventDefault();
				const index = parseInt(input.key, 10) - 1;
				void this.selectTabByIndex(index);
				return;
			}
			if (input.key === "9") {
				event.preventDefault();
				void this.selectTabByIndex(-1);
				return;
			}

			// Tab cycle: Ctrl+Tab, Ctrl+Shift+Tab, Cmd+Alt+Left/Right, Cmd+Shift+[/]
			if (
				(key === "tab" && (input.control || input.meta) && input.shift) ||
				(key === "pageup" && (input.control || input.meta)) ||
				(key === "[" && input.shift) ||
				(input.alt && input.key === "ArrowLeft")
			) {
				event.preventDefault();
				void this.cycleTab(-1);
				return;
			}
			if (
				(key === "tab" && (input.control || input.meta)) ||
				(key === "pagedown" && (input.control || input.meta)) ||
				(key === "]" && input.shift) ||
				(input.alt && input.key === "ArrowRight")
			) {
				event.preventDefault();
				void this.cycleTab(1);
				return;
			}

			// Zoom controls: Cmd/Ctrl + (+, =, -, _, 0)
			if (["=", "+", "add", "numpadadd"].includes(key)) {
				event.preventDefault();
				this.zoomIn(tab.id);
				return;
			}
			if (["-", "_", "subtract", "numpadsubtract"].includes(key)) {
				event.preventDefault();
				this.zoomOut(tab.id);
				return;
			}
			if (["0", "numpad0"].includes(key)) {
				event.preventDefault();
				this.zoomReset(tab.id);
				return;
			}

			// Primary browser & application shortcuts
			if (key === "t") {
				event.preventDefault();
				if (input.shift) {
					void this.reopenClosedTab();
				} else {
					void this.createTab(undefined, true);
				}
			} else if (key === "w" || (input.control && input.key === "F4")) {
				event.preventDefault();
				void this.closeTab(tab.id);
			} else if (key === "r") {
				event.preventDefault();
				this.reload(tab.id, input.shift);
			} else if (key === "l" || (input.control && key === "e")) {
				event.preventDefault();
				this.onCommand?.("focus-address");
			} else if (key === "n" && !input.shift) {
				event.preventDefault();
				this.onCommand?.("new-agent");
			} else if (key === "k" || (key === "p" && input.shift)) {
				event.preventDefault();
				this.onCommand?.("open-commands");
			} else if (key === "p") {
				event.preventDefault();
				this.printTab(tab.id);
			} else if (key === "f") {
				event.preventDefault();
				this.onCommand?.("find-in-page");
			} else if (key === "d") {
				event.preventDefault();
				if (input.shift) this.onCommand?.("open-bookmarks");
				else {
					try {
						this.toggleBookmark();
					} catch {
						this.onCommand?.("open-bookmarks");
					}
				}
			} else if (key === "i" && input.shift) {
				event.preventDefault();
				this.openDevTools(tab.id);
			} else if (key === "h" || key === "y") {
				event.preventDefault();
				this.onCommand?.("open-history");
			} else if (key === "j") {
				event.preventDefault();
				this.onCommand?.("open-downloads");
			} else if (key === ",") {
				event.preventDefault();
				this.onCommand?.("open-settings");
			} else if (key === "/" || key === "?") {
				event.preventDefault();
				this.onCommand?.("show-shortcuts");
			} else if (key === "b") {
				event.preventDefault();
				if (input.shift) {
					this.updateSettings({
						...this.state.settings,
						showBookmarksBar: !this.state.settings.showBookmarksBar,
					});
				} else {
					this.onCommand?.("toggle-sidebar");
				}
			} else if (key === "s" && input.shift) {
				event.preventDefault();
				this.onCommand?.("toggle-sidebar");
			} else if (input.key === "[" || (input.meta && input.key === "ArrowLeft")) {
				event.preventDefault();
				this.back(tab.id);
			} else if (input.key === "]" || (input.meta && input.key === "ArrowRight")) {
				event.preventDefault();
				this.forward(tab.id);
			}
		});
	}

	private didNavigate(
		tab: UserBrowserTab,
		webContents: WebContents,
		value: string,
	): void {
		const url = safePageUrl(value);
		if (!url) return;
		tab.url = sanitizeBrowserUrl(url.toString());
		tab.title =
			webContents.getTitle().trim().slice(0, 500) || hostnameTitle(tab.url);
		tab.crashed = false;
		tab.error = undefined;
		tab.discarded = false;
		this.updateNavigationState(tab, webContents, false);
		if (this.state.settings.historyRetentionDays !== 0) {
			const last = this.state.history.at(-1);
			if (
				last &&
				last.tabId === tab.id &&
				last.url === tab.url &&
				Date.parse(this.now().toISOString()) - Date.parse(last.visitedAt) <
					2_000
			) {
				last.title = tab.title;
			} else {
				this.state.history.push({
					id: `visit-${randomUUID()}`,
					tabId: tab.id,
					url: sanitizeBrowserUrl(tab.url),
					title: tab.title,
					visitedAt: this.now().toISOString(),
				});
			}
		}
		this.pruneHistory();
		this.commit();
	}

	private async cycleTab(direction: -1 | 1): Promise<void> {
		const tabs = this.state.tabs;
		if (tabs.length < 2) return;
		const current = tabs.findIndex((tab) => tab.id === this.state.activeTabId);
		const next =
			tabs[(Math.max(0, current) + direction + tabs.length) % tabs.length];
		if (next) await this.selectTab(next.id);
	}

	private updateNavigationState(
		tab: UserBrowserTab,
		webContents: WebContents,
		commit = true,
	): void {
		if (webContents.isDestroyed()) return;
		tab.canGoBack = webContents.navigationHistory.canGoBack();
		tab.canGoForward = webContents.navigationHistory.canGoForward();
		if (commit) this.commit();
	}

	private async syncActiveView(): Promise<void> {
		this.attachActiveWebView();
	}

	private revealActiveWebContent(): void {
		if (this.contentBounds.width >= 160 && this.contentBounds.height >= 120) {
			this.contentVisible = true;
			return;
		}
		const size = this.window.getContentSize();
		const width = Math.max(0, size[0] ?? 0);
		const height = Math.max(0, size[1] ?? 0);
		if (width < 160 || height < 120) return;
		this.contentBounds = { x: 0, y: 0, width, height };
		this.contentVisible = true;
	}

	private attachActiveWebView(): void {
		if (this.disposed || this.window.isDestroyed()) return;
		for (const { view } of this.views.values()) {
			if (this.window.contentView.children.includes(view))
				this.window.contentView.removeChildView(view);
			view.setVisible(false);
		}
		const tab = this.state.tabs.find(
			(candidate) => candidate.id === this.state.activeTabId,
		);
		if (!this.contentVisible || !tab || !tab.url || tab.error) return;
		if (isKestrelAppPageUrl(tab.url)) return;
		const { view } = this.ensureView(tab);
		this.window.contentView.addChildView(view);
		view.setBounds(this.contentBounds);
		view.setVisible(true);
		view.webContents.focus();
	}

	private discardLeastRecentViews(): void {
		if (this.views.size <= MAX_LIVE_TABS) return;
		const candidates = this.state.tabs
			.filter(
				(tab) => tab.id !== this.state.activeTabId && this.views.has(tab.id),
			)
			.sort((left, right) =>
				left.lastActiveAt.localeCompare(right.lastActiveAt),
			);
		while (this.views.size > MAX_LIVE_TABS && candidates.length) {
			const tab = candidates.shift()!;
			this.closeView(tab.id);
			tab.discarded = Boolean(tab.url);
		}
		this.commit();
	}

	private closeView(tabId: string, closeWebContents = true): void {
		const record = this.views.get(tabId);
		if (!record) return;
		this.views.delete(tabId);
		this.elementRefs.delete(tabId);
		this.webContentsToTab.delete(record.view.webContents.id);
		if (
			!this.window.isDestroyed() &&
			this.window.contentView.children.includes(record.view)
		)
			this.window.contentView.removeChildView(record.view);
		if (closeWebContents && !record.view.webContents.isDestroyed()) {
			if (record.view.webContents.debugger.isAttached())
				record.view.webContents.debugger.detach();
			record.view.webContents.close({ waitForBeforeUnload: false });
		}
	}

	private requireTab(tabId: string): UserBrowserTab {
		this.assertAvailable();
		const tab = this.state.tabs.find((candidate) => candidate.id === tabId);
		if (!tab) throw new Error("Browser tab is unavailable.");
		return tab;
	}

	private requireActiveTab(): UserBrowserTab {
		if (!this.state.activeTabId) throw new Error("No browser tab is active.");
		return this.requireTab(this.state.activeTabId);
	}

	private requireView(tabId: string): ViewRecord {
		const tab = this.requireTab(tabId);
		if (!tab.url || isKestrelAppPageUrl(tab.url))
			throw new Error("This tab has not navigated yet.");
		return this.ensureView(tab);
	}

	private isPermissionAllowed(originValue: string, permission: string): boolean {
		if (ALWAYS_ALLOW_PERMISSIONS.has(permission)) return true;
		if (ALWAYS_DENY_PERMISSIONS.has(permission)) return false;
		const origin = this.permissionOrigin(originValue);
		if (!origin) return false;
		return (
			this.state.sitePermissions.find(
				(item) => item.origin === origin && item.permission === permission,
			)?.decision === "allow"
		);
	}

	private async resolvePermissionRequest(
		webContents: WebContents,
		permission: string,
		requestingUrl?: string,
	): Promise<boolean> {
		if (ALWAYS_ALLOW_PERMISSIONS.has(permission)) return true;
		if (ALWAYS_DENY_PERMISSIONS.has(permission)) return false;
		const origin = this.permissionOrigin(
			requestingUrl ||
				(typeof webContents?.isDestroyed === "function" &&
				!webContents.isDestroyed()
					? webContents.getURL()
					: "") ||
				"",
		);
		if (!origin) return false;
		const stored = this.state.sitePermissions.find(
			(item) => item.origin === origin && item.permission === permission,
		);
		if (stored) return stored.decision === "allow";
		const allowed = await this.confirmSitePermission(origin, permission);
		this.setSitePermission(origin, permission, allowed ? "allow" : "deny");
		return allowed;
	}

	private permissionOrigin(value: string): string | undefined {
		try {
			const url = new URL(value);
			if (!["http:", "https:"].includes(url.protocol)) return undefined;
			return url.origin;
		} catch {
			return undefined;
		}
	}

	private assertAvailable(): void {
		if (this.disposed || this.window.isDestroyed())
			throw new Error("The user browser is unavailable.");
	}

	private commit(): void {
		this.store.save(this.state);
		this.emit();
	}

	private emit(): void {
		if (!this.disposed) this.onEvent({ type: "state", state: this.getState() });
	}

	private pruneHistory(): void {
		const days = this.state.settings.historyRetentionDays;
		if (days === 0) {
			this.state.history = [];
			this.state.originFavicons = [];
			return;
		}
		const cutoff = this.now().getTime() - days * 24 * 60 * 60 * 1_000;
		this.state.history = this.state.history
			.filter((entry) => Date.parse(entry.visitedAt) >= cutoff)
			.slice(-MAX_HISTORY_ENTRIES);
	}

	private availableDownloadName(original: string, id: string): string {
		const cleaned =
			basename(original)
				.replace(/[^A-Za-z0-9 ._()-]/g, "-")
				.replace(/^\.+/, "")
				.slice(0, 180) || `${id}.download`;
		const extension = extname(cleaned);
		const stem = cleaned.slice(0, cleaned.length - extension.length);
		let candidate = cleaned;
		let index = 2;
		while (existsSync(join(this.downloadDirectory, candidate))) {
			candidate = `${stem} ${index}${extension}`;
			index += 1;
		}
		return candidate;
	}

	private rememberOriginFavicon(
		origin: string,
		faviconDataUrl: string,
	): boolean {
		const existing = this.state.originFavicons.find(
			(item) => item.origin === origin,
		);
		if (existing?.faviconDataUrl === faviconDataUrl) return false;
		this.state.originFavicons = upsertOriginFavicon(
			this.state.originFavicons,
			origin,
			faviconDataUrl,
			this.now().toISOString(),
		);
		return true;
	}

	private backfillOriginFaviconsFromHistory(limit = 7): void {
		const known = new Set(
			this.state.originFavicons.map((item) => item.origin),
		);
		const grouped = new Map<
			string,
			{ visits: number; lastVisitedAt: string }
		>();
		for (const entry of this.state.history) {
			const parsed = safePageUrl(entry.url);
			if (!parsed || known.has(parsed.origin)) continue;
			const current = grouped.get(parsed.origin);
			if (!current) {
				grouped.set(parsed.origin, {
					visits: 1,
					lastVisitedAt: entry.visitedAt,
				});
				continue;
			}
			current.visits += 1;
			if (entry.visitedAt > current.lastVisitedAt) {
				current.lastVisitedAt = entry.visitedAt;
			}
		}
		const origins = [...grouped.entries()]
			.sort(
				(left, right) =>
					right[1].visits - left[1].visits ||
					right[1].lastVisitedAt.localeCompare(left[1].lastVisitedAt),
			)
			.slice(0, Math.max(0, limit))
			.map(([origin]) => origin);
		for (const origin of origins) {
			void this.loadOriginFavicon(origin);
		}
	}

	private loadOriginFavicon(origin: string): void {
		const candidates = [
			`${origin}/favicon.ico`,
			`${origin}/favicon.png`,
			`${origin}/apple-touch-icon.png`,
		];
		void this.loadFirstOriginFavicon(origin, candidates);
	}

	private async loadFirstOriginFavicon(
		origin: string,
		candidates: string[],
	): Promise<void> {
		for (const candidate of candidates) {
			const faviconDataUrl = await this.resolveFaviconDataUrl(
				`${origin}/`,
				candidate,
			);
			if (!faviconDataUrl) continue;
			if (this.rememberOriginFavicon(origin, faviconDataUrl)) this.commit();
			else this.emit();
			return;
		}
	}

	private async loadFavicon(
		target: Pick<UserBrowserTab, "url" | "faviconDataUrl">,
		value: string,
	): Promise<void> {
		try {
			const faviconDataUrl = await this.resolveFaviconDataUrl(
				target.url,
				value,
			);
			if (!faviconDataUrl) return;
			target.faviconDataUrl = faviconDataUrl;
			const origin =
				safePageUrl(target.url)?.origin ??
				safePageUrl(resolveFaviconReference(target.url, value) ?? "")?.origin;
			if (origin && this.rememberOriginFavicon(origin, faviconDataUrl))
				this.commit();
			else this.emit();
		} catch {
			// Favicons are optional and must never affect navigation.
		}
	}

	private async resolveFaviconDataUrl(
		pageUrl: string,
		value: string,
	): Promise<string | undefined> {
		if (isFaviconDataUrl(value)) return this.normalizeInlineFavicon(value);
		const resolved = resolveFaviconReference(pageUrl, value);
		if (!resolved) return undefined;
		return this.fetchFaviconDataUrl(resolved);
	}

	private normalizeInlineFavicon(value: string): string | undefined {
		if (!isFaviconDataUrl(value)) return undefined;
		const image = nativeImage.createFromDataURL(value);
		if (image.isEmpty()) return undefined;
		return image.resize({ width: 32, height: 32 }).toDataURL();
	}

	private async encodeFaviconBytes(bytes: Buffer): Promise<string | undefined> {
		try {
			const png = await sharp(bytes, { failOn: "none" })
				.resize(32, 32, {
					fit: "contain",
					background: { r: 0, g: 0, b: 0, alpha: 0 },
				})
				.png()
				.toBuffer();
			if (png.byteLength === 0 || png.byteLength > 200_000) return undefined;
			const image = nativeImage.createFromBuffer(png);
			if (!image.isEmpty()) return image.toDataURL();
		} catch {
			// Fall back to ICO decoding and Electron's native decoder.
		}
		try {
			const icons = decodeIco(bytes);
			const largest = [...icons].sort((left, right) => right.width - left.width)[0];
			if (largest) {
				const png = await sharp(largest.data, {
					raw: {
						width: largest.width,
						height: largest.height,
						channels: 4,
					},
				})
					.resize(32, 32, {
						fit: "contain",
						background: { r: 0, g: 0, b: 0, alpha: 0 },
					})
					.png()
					.toBuffer();
				if (png.byteLength > 0 && png.byteLength <= 200_000) {
					const image = nativeImage.createFromBuffer(png);
					if (!image.isEmpty()) return image.toDataURL();
				}
			}
		} catch {
			// Optional favicon formats must never affect navigation.
		}
		const image = nativeImage.createFromBuffer(bytes);
		if (image.isEmpty()) return undefined;
		return image.resize({ width: 32, height: 32 }).toDataURL();
	}

	private async fetchFaviconDataUrl(value: string): Promise<string | undefined> {
		const response = await this.partition.fetch(value, {
			signal: AbortSignal.timeout(5_000),
		});
		const length = Number(response.headers.get("content-length") ?? 0);
		if (!response.ok || length > 512_000) return undefined;
		const bytes = Buffer.from(await response.arrayBuffer());
		if (bytes.byteLength > 512_000) return undefined;
		return this.encodeFaviconBytes(bytes);
	}

	private async targetPoint(
		webContents: WebContents,
		selector: string,
		focus: boolean,
		tabId: string,
	): Promise<{ x: number; y: number }> {
		if (!selector || selector.length > 2_000)
			throw new Error("Browser selector is invalid.");
		const ref = normalizeBrowserElementRef(selector);
		if (ref) {
			const backendNodeId = this.elementRefs.get(tabId)?.get(ref);
			if (backendNodeId === undefined)
				throw new Error("Browser target ref is stale. Take a new snapshot.");
			return targetPointFromBackendNode(webContents, backendNodeId, focus);
		}
		return webContents.executeJavaScript(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!(node instanceof Element)) throw new Error("Browser target was not found.");
      node.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      if (box.width <= 0 || box.height <= 0 || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) <= 0) throw new Error("Browser target is not visible.");
      if (node.matches(":disabled") || node.getAttribute("aria-disabled") === "true") throw new Error("Browser target is disabled.");
      const x = Math.round(Math.max(0, Math.min(innerWidth - 1, box.left + box.width / 2)));
      const y = Math.round(Math.max(0, Math.min(innerHeight - 1, box.top + box.height / 2)));
      const hit = document.elementFromPoint(x, y);
      if (!(hit instanceof Element) || (hit !== node && !node.contains(hit))) {
        throw new Error("Browser target is obscured or cannot receive pointer input.");
      }
      ${focus ? "if (node instanceof HTMLElement) node.focus();" : ""}
      return { x, y };
    })()`);
	}
}
