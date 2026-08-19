import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type {
	BrowserAction,
	BrowserSnapshot,
	ScreenshotFrame,
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
	type SavedPassword,
	type SavedAddress,
	type SavedPaymentCard,
	type AutofillPrompt,
} from "@kestrel/shared-types";
import {
	type BrowserWindow,
	clipboard,
	session as electronSession,
	Menu,
	nativeImage,
	type Rectangle,
	type Session,
	shell,
	type WebContents,
	WebContentsView,
} from "electron";
import {
	generateAutofillApplyScript,
	generateFormDetectionScript,
} from "./browser-autofill-injector";
import { BrowserAutofillStore } from "./browser-autofill-store";
import { BrowserExtensionManager } from "./browser-extension-manager";
import {
	BrowserTabStore,
	normalizeBrowserAddress,
	sanitizeBrowserUrl,
} from "./browser-tab-store";

const MAX_LIVE_TABS = 8;
const MAX_HISTORY_ENTRIES = 5_000;
const MAX_DOWNLOAD_ENTRIES = 500;
const MAX_AX_SNAPSHOT_BYTES = 1_500_000;
export const POPUP_GESTURE_WINDOW_MS = 3_000;
const USER_BROWSER_PARTITION = "persist:kestrel-user-browser-v1";

export function sanitizeBrowserUserAgent(sourceUserAgent?: string): string {
	const raw = (sourceUserAgent || "").trim();
	if (!raw) {
		return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
	}
	const cleaned = raw
		.replace(/Electron\/[0-9.]+\s*/gi, "")
		.replace(/kestrel\/[0-9.]+\s*/gi, "")
		.replace(/\s+/g, " ")
		.trim();
	return (
		cleaned ||
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
	);
}

export function isOAuthUrl(value: string | URL): boolean {
	try {
		const parsed = typeof value === "string" ? new URL(value) : value;
		const host = parsed.hostname.toLowerCase();
		return (
			host === "accounts.google.com" ||
			host.endsWith(".accounts.google.com") ||
			host === "accounts.youtube.com" ||
			host === "appleid.apple.com" ||
			(host === "github.com" && parsed.pathname.startsWith("/login/oauth")) ||
			host === "login.microsoftonline.com" ||
			host.endsWith(".auth0.com") ||
			(host.endsWith(".supabase.co") && parsed.pathname.includes("/auth/")) ||
			host === "auth0.openai.com"
		);
	} catch {
		return false;
	}
}

export type UserBrowserBackendWireRequest =
	| { operation: "visible-tabs" }
	| { operation: "visible-context"; tabId?: string }
	| { operation: "visible-snapshot"; tabId?: string }
	| { operation: "visible-screenshot"; tabId?: string }
	| { operation: "visible-history"; query?: string; limit?: number }
	| { operation: "visible-downloads" }
	| { operation: "visible-act"; tabId: string; action: BrowserAction }
	| { operation: "visible-navigate"; tabId: string; input: string }
	| { operation: "visible-create"; input?: string }
	| { operation: "visible-close"; tabId: string }
	| { operation: "visible-select"; tabId: string };

export function isUserBrowserBackendWireRequest(request: {
	operation?: unknown;
}): request is UserBrowserBackendWireRequest {
	return new Set<UserBrowserBackendWireRequest["operation"]>([
		"visible-tabs",
		"visible-context",
		"visible-snapshot",
		"visible-screenshot",
		"visible-history",
		"visible-downloads",
		"visible-act",
		"visible-navigate",
		"visible-create",
		"visible-close",
		"visible-select",
	]).has(request.operation as UserBrowserBackendWireRequest["operation"]);
}

export interface UserBrowserServiceOptions {
	window: BrowserWindow;
	statePath: string;
	downloadDirectory: string;
	partitionName?: string;
	now?: () => Date;
	onEvent(event: UserBrowserEvent): void;
	onCommand?(command: UserBrowserCommand): void;
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

function hostnameTitle(value: string): string {
	try {
		return new URL(value).hostname.replace(/^www\./, "") || "New Tab";
	} catch {
		return "New Tab";
	}
}

const ACCESSIBILITY_URL_VALUE =
	/\b(?:https?|file|ftp|data|javascript|blob):[^\s<>"'{}[\]]+/gi;

function sanitizeAccessibilityTree(value: unknown): unknown {
	if (typeof value === "string")
		return value.replace(ACCESSIBILITY_URL_VALUE, (candidate) => {
			return sanitizeBrowserUrl(candidate) || "[redacted URL]";
		});
	if (Array.isArray(value)) return value.map(sanitizeAccessibilityTree);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [
			key,
			sanitizeAccessibilityTree(item),
		]),
	);
}

function cloneState(state: UserBrowserState): UserBrowserState {
	return UserBrowserStateSchema.parse(structuredClone(state));
}

export class UserBrowserService {
	private readonly window: BrowserWindow;
	private readonly store: BrowserTabStore;
	private readonly partition: Session;
	private readonly extensionManager: BrowserExtensionManager;
	private readonly autofillStore: BrowserAutofillStore;
	private readonly views = new Map<string, ViewRecord>();
	private readonly downloadPaths = new Map<string, string>();
	private readonly webContentsToTab = new Map<number, string>();
	private readonly now: () => Date;
	private readonly downloadDirectory: string;
	private readonly partitionName: string;
	private readonly onEvent: UserBrowserServiceOptions["onEvent"];
	private readonly onCommand?: UserBrowserServiceOptions["onCommand"];
	private readonly onWillDownload: Parameters<Session["on"]>[1];
	private readonly recentlyClosedTabs: Array<{ url: string; title: string }> = [];
	private sleepingTabsInterval?: ReturnType<typeof setInterval>;
	private state: UserBrowserState;
	private contentBounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
	private contentVisible = false;
	private disposed = false;

	constructor(options: UserBrowserServiceOptions) {
		this.window = options.window;
		this.store = new BrowserTabStore(options.statePath);
		this.state = this.store.load(options.now);
		this.now = options.now ?? (() => new Date());
		this.downloadDirectory = options.downloadDirectory;
		this.onEvent = options.onEvent;
		this.onCommand = options.onCommand;
		mkdirSync(this.downloadDirectory, { recursive: true, mode: 0o700 });
		this.extensionManager = new BrowserExtensionManager(
			dirname(options.statePath),
		);
		this.autofillStore = new BrowserAutofillStore(
			dirname(options.statePath),
			this.now,
		);
		this.partitionName = options.partitionName ?? USER_BROWSER_PARTITION;
		if (!/^persist:[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(this.partitionName))
			throw new Error(
				"User browser partitions must be named persistent profiles.",
			);
		this.partition = electronSession.fromPartition(this.partitionName, {
			cache: true,
		});
		const cleanUserAgent = sanitizeBrowserUserAgent(
			this.partition.getUserAgent?.(),
		);
		this.partition.setUserAgent?.(cleanUserAgent);
		this.partition.webRequest?.onBeforeSendHeaders?.((details, callback) => {
			const headers = { ...details.requestHeaders };
			const current =
				headers["User-Agent"] || headers["user-agent"] || cleanUserAgent;
			headers["User-Agent"] = sanitizeBrowserUserAgent(current);
			callback({ requestHeaders: headers });
		});
		void this.extensionManager.loadAll(this.partition);
		this.startSleepingTabsMonitor();
		this.partition.setPermissionCheckHandler(() => false);
		this.partition.setPermissionRequestHandler(
			(_webContents, _permission, callback) => callback(false),
		);
		this.onWillDownload = (_event, item, webContents) => {
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
			this.state.downloads.push({
				id,
				tabId,
				filename,
				sourceUrl:
					sanitizeBrowserUrl(item.getURL()) || "https://invalid.local/",
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
		};
		this.partition.on("will-download", this.onWillDownload);
	}

	getState(): UserBrowserState {
		return cloneState(this.state);
	}

	async createTab(input?: string, active = true): Promise<UserBrowserState> {
		this.assertAvailable();
		const timestamp = this.now().toISOString();
		const tab: UserBrowserTab = {
			id: `tab-${randomUUID()}`,
			title: "New Tab",
			url: "",
			loading: false,
			canGoBack: false,
			canGoForward: false,
			discarded: false,
			crashed: false,
			createdAt: timestamp,
			lastActiveAt: timestamp,
		};
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
		if (tab.url && !tab.error) {
			this.recentlyClosedTabs.unshift({ url: tab.url, title: tab.title });
			if (this.recentlyClosedTabs.length > 32) {
				this.recentlyClosedTabs.pop();
			}
		}
		const index = this.state.tabs.findIndex((item) => item.id === tabId);
		this.closeView(tabId);
		this.state.tabs.splice(index, 1);
		if (this.state.tabs.length === 0) {
			this.state.activeTabId = null;
			this.commit();
			await this.syncActiveView();
			if (!this.window.isDestroyed()) {
				this.window.close();
			}
			return this.getState();
		} else if (this.state.activeTabId === tabId) {
			this.state.activeTabId =
				this.state.tabs[Math.min(index, this.state.tabs.length - 1)]!.id;
		}
		this.commit();
		await this.syncActiveView();
		return this.getState();
	}

	async reopenClosedTab(): Promise<UserBrowserState> {
		const recent = this.recentlyClosedTabs.shift();
		if (!recent) return this.getState();
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
		const normalized = normalizeBrowserAddress(
			input,
			this.state.settings.searchEngine,
			this.state.settings.customSearchUrl,
		);
		const record = this.ensureView(tab);
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
		await this.syncActiveView();
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
		const record = this.requireView(tabId);
		if (record.view.webContents.navigationHistory.canGoBack())
			record.view.webContents.navigationHistory.goBack();
		return this.getState();
	}

	forward(tabId: string): UserBrowserState {
		const record = this.requireView(tabId);
		if (record.view.webContents.navigationHistory.canGoForward())
			record.view.webContents.navigationHistory.goForward();
		return this.getState();
	}

	reload(tabId: string, ignoreCache = false): UserBrowserState {
		const tab = this.requireTab(tabId);
		if (!tab.url) return this.getState();
		const record = this.ensureView(tab);
		tab.error = undefined;
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

	async pageContext(tabId?: string): Promise<UserBrowserPageContext> {
		const tab = this.requireTab(tabId ?? this.requireActiveTab().id);
		if (!tab.url || tab.error)
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
						? [{ text: String(candidate.text ?? "").slice(0, 500), url }]
						: [];
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
			title: (record.view.webContents.getTitle() || tab.title).slice(0, 500),
			...raw,
			links,
			capturedAt: this.now().toISOString(),
			trust: "untrusted_browser",
		});
	}

	async snapshot(
		tabId?: string,
		signal?: AbortSignal,
	): Promise<BrowserSnapshot> {
		const tab = this.requireTab(tabId ?? this.requireActiveTab().id);
		const webContents = this.ensureView(tab).view.webContents;
		if (signal?.aborted) throw signal.reason;
		if (!webContents.debugger.isAttached()) webContents.debugger.attach("1.3");
		const result = (await webContents.debugger.sendCommand(
			"Accessibility.getFullAXTree",
		)) as { nodes?: unknown[] };
		const accessibilityTree = sanitizeAccessibilityTree({
			nodes: (result.nodes ?? []).slice(0, 5_000),
		});
		if (
			Buffer.byteLength(JSON.stringify(accessibilityTree), "utf8") >
			MAX_AX_SNAPSHOT_BYTES
		)
			throw new Error("Visible browser accessibility snapshot exceeds 1.5 MB.");
		const url = sanitizeBrowserUrl(webContents.getURL());
		if (!url)
			throw new Error("The selected tab does not have a safe readable URL.");
		return {
			url,
			title: webContents.getTitle().slice(0, 500),
			accessibilityTree,
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
			.filter(
				(entry) =>
					!needle ||
					`${entry.title}\n${entry.url}`.toLocaleLowerCase().includes(needle),
			)
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
			const point = await this.targetPoint(webContents, action.target, false);
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
			await this.targetPoint(webContents, action.target, true);
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
				return this.screenshot(request.tabId, signal);
			case "visible-history":
				return this.searchHistory(request.query, request.limit);
			case "visible-downloads":
				return this.visibleDownloads();
			case "visible-act":
				await this.act(request.tabId, request.action, signal);
				return { performed: true };
			case "visible-navigate":
				return this.navigate(request.tabId, request.input);
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
		if (!tab.url) return this.getState();
		this.closeView(tabId);
		tab.discarded = true;
		this.commit();
		return this.getState();
	}

	sleepInactiveTabs(): UserBrowserState {
		for (const tab of this.state.tabs) {
			if (tab.id === this.state.activeTabId || !tab.url || tab.discarded) continue;
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
			if (tab.id === this.state.activeTabId || !tab.url || tab.discarded) continue;
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
		this.partition.off("will-download", this.onWillDownload);
		for (const tabId of [...this.views.keys()]) this.closeView(tabId);
	}

	private ensureView(tab: UserBrowserTab): ViewRecord {
		const existing = this.views.get(tab.id);
		if (existing && !existing.view.webContents.isDestroyed()) return existing;
		const view = new WebContentsView({
			webPreferences: {
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
		const cleanUserAgent = sanitizeBrowserUserAgent(
			this.partition.getUserAgent?.(),
		);
		view.webContents.setUserAgent?.(cleanUserAgent);
		const record: ViewRecord = { view };
		this.views.set(tab.id, record);
		this.webContentsToTab.set(view.webContents.id, tab.id);
		this.configureView(tab, record);
		if (tab.url) {
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
			if (safePageUrl(url)) {
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
			const favicon = favicons.find((value) => safePageUrl(value));
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
			if (params.isEditable)
				template.push(
					{ role: "cut" },
					{ role: "copy" },
					{ role: "paste" },
					{ role: "selectAll" },
				);
			else if (params.selectionText) template.push({ role: "copy" });
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
			} else if (key === "b" || (key === "s" && input.shift)) {
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
		if (!tab.url) throw new Error("This tab has not navigated yet.");
		return this.ensureView(tab);
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

	private async loadFavicon(tab: UserBrowserTab, value: string): Promise<void> {
		try {
			const response = await this.partition.fetch(value, {
				signal: AbortSignal.timeout(5_000),
			});
			const length = Number(response.headers.get("content-length") ?? 0);
			if (!response.ok || length > 512_000) return;
			const bytes = Buffer.from(await response.arrayBuffer());
			if (bytes.byteLength > 512_000) return;
			const image = nativeImage.createFromBuffer(bytes);
			if (image.isEmpty()) return;
			tab.faviconDataUrl = image.resize({ width: 32, height: 32 }).toDataURL();
			this.emit();
		} catch {
			// Favicons are optional and must never affect navigation.
		}
	}

	private async targetPoint(
		webContents: WebContents,
		selector: string,
		focus: boolean,
	): Promise<{ x: number; y: number }> {
		if (!selector || selector.length > 2_000)
			throw new Error("Browser selector is invalid.");
		return webContents.executeJavaScript(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!(node instanceof Element)) throw new Error("Browser target was not found.");
      node.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      if (box.width <= 0 || box.height <= 0 || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) <= 0) throw new Error("Browser target is not visible.");
      if (node.matches(":disabled") || node.getAttribute("aria-disabled") === "true") throw new Error("Browser target is disabled.");
      ${focus ? "if (node instanceof HTMLElement) node.focus();" : ""}
      return { x: Math.round(Math.max(0, Math.min(innerWidth - 1, box.left + box.width / 2))), y: Math.round(Math.max(0, Math.min(innerHeight - 1, box.top + box.height / 2))) };
    })()`);
	}

	// --------------------------------------------------------------------------
	// Autofill & Credential Methods
	// --------------------------------------------------------------------------

	listPasswords(query?: string): SavedPassword[] {
		return this.autofillStore.listPasswords(query);
	}

	savePassword(data: {
		id?: string;
		url: string;
		domain?: string;
		username: string;
		password: string;
		name?: string;
	}): SavedPassword {
		return this.autofillStore.savePassword(data);
	}

	deletePassword(id: string): boolean {
		return this.autofillStore.deletePassword(id);
	}

	listAddresses(query?: string): SavedAddress[] {
		return this.autofillStore.listAddresses(query);
	}

	saveAddress(data: {
		id?: string;
		label?: string;
		fullName: string;
		organization?: string;
		streetAddress: string;
		streetAddressLine2?: string;
		city: string;
		state?: string;
		postalCode?: string;
		country?: string;
		phone?: string;
		email?: string;
	}): SavedAddress {
		return this.autofillStore.saveAddress(data);
	}

	deleteAddress(id: string): boolean {
		return this.autofillStore.deleteAddress(id);
	}

	listPaymentCards(query?: string): SavedPaymentCard[] {
		return this.autofillStore.listPaymentCards(query, false);
	}

	savePaymentCard(data: {
		id?: string;
		cardholderName: string;
		cardNumber: string;
		cardBrand?: string;
		expirationMonth: string;
		expirationYear: string;
		nickname?: string;
		billingAddressId?: string;
	}): SavedPaymentCard {
		return this.autofillStore.savePaymentCard(data);
	}

	deletePaymentCard(id: string): boolean {
		return this.autofillStore.deletePaymentCard(id);
	}

	async queryAutofill(
		tabId?: string,
		urlOverride?: string,
	): Promise<{
		passwords: SavedPassword[];
		addresses: SavedAddress[];
		paymentMethods: SavedPaymentCard[];
		detectedForms: string[];
	}> {
		const targetTab = tabId
			? this.state.tabs.find((tab) => tab.id === tabId)
			: this.state.tabs.find((tab) => tab.id === this.state.activeTabId);
		const targetUrl = urlOverride || targetTab?.url || "";
		const matches = this.autofillStore.queryAutofill(targetUrl);
		let detectedForms: string[] = [];

		if (targetTab && targetTab.url && !targetTab.error) {
			try {
				const record = this.ensureView(targetTab);
				const forms = (await record.view.webContents.executeJavaScript(
					generateFormDetectionScript(),
				)) as string[];
				if (Array.isArray(forms)) {
					detectedForms = forms;
				}
			} catch {
				// Ignore form detection error
			}
		}

		return {
			...matches,
			detectedForms,
		};
	}

	async applyAutofill(
		tabId: string | undefined,
		fillType: "password" | "address" | "payment",
		itemId: string,
	): Promise<{ success: boolean; filledCount: number }> {
		const targetTab = this.requireTab(tabId ?? this.requireActiveTab().id);
		if (!targetTab.url || targetTab.error) {
			throw new Error("The selected tab is not available for autofill.");
		}
		const record = this.ensureView(targetTab);

		let fillData: Record<string, string> = {};
		if (fillType === "password") {
			const pwd = this.autofillStore.getPassword(itemId);
			if (!pwd) throw new Error("Password entry not found.");
			fillData = {
				username: pwd.username,
				password: pwd.password,
			};
			this.autofillStore.markPasswordUsed(itemId);
		} else if (fillType === "address") {
			const addr = this.autofillStore.getAddress(itemId);
			if (!addr) throw new Error("Address entry not found.");
			fillData = {
				fullName: addr.fullName,
				streetAddress: addr.streetAddress,
				...(addr.streetAddressLine2 ? { streetAddressLine2: addr.streetAddressLine2 } : {}),
				city: addr.city,
				...(addr.state ? { state: addr.state } : {}),
				...(addr.postalCode ? { postalCode: addr.postalCode } : {}),
				...(addr.country ? { country: addr.country } : {}),
				...(addr.phone ? { phone: addr.phone } : {}),
				...(addr.email ? { email: addr.email } : {}),
				...(addr.organization ? { organization: addr.organization } : {}),
			};
		} else if (fillType === "payment") {
			const card = this.autofillStore.getPaymentCard(itemId, true);
			if (!card) throw new Error("Payment card not found.");
			fillData = {
				cardholderName: card.cardholderName,
				cardNumber: card.cardNumber,
				expirationMonth: card.expirationMonth,
				expirationYear: card.expirationYear,
			};
		}

		const result = (await record.view.webContents.executeJavaScript(
			generateAutofillApplyScript(fillType, fillData),
		)) as { success: boolean; filledCount?: number; error?: string };

		return {
			success: Boolean(result?.success),
			filledCount: Number(result?.filledCount ?? 0),
		};
	}
}
