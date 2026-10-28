import { UserBrowserSettingsSchema, UserBrowserPageContextSchema } from "../../../../packages/shared-types/src/contracts.ts";
import { capturePageContext } from "./page-context.mjs";

const TAB_IDS_KEY = "kestrel.native.browser.tabIds.v1";
const SETTINGS_KEY = "kestrel.native.browser.settings.v1";
const INSTALL_DATES_KEY = "kestrel.native.browser.extensionInstallDates.v1";

const SEARCH_ENGINES = {
	duckduckgo: "https://duckduckgo.com/?q=%s",
	google: "https://www.google.com/search?q=%s",
	bing: "https://www.bing.com/search?q=%s",
	brave: "https://search.brave.com/search?q=%s",
	ecosia: "https://www.ecosia.org/search?q=%s",
	startpage: "https://www.startpage.com/sp/search?query=%s",
	yahoo: "https://search.yahoo.com/search?p=%s",
	kagi: "https://kagi.com/search?q=%s",
	qwant: "https://www.qwant.com/?q=%s",
	mojeek: "https://www.mojeek.com/search?q=%s",
	baidu: "https://www.baidu.com/s?wd=%s",
	yandex: "https://yandex.com/search/?text=%s",
};

// Normalize the Kestrel UI's complete settings shape. Chromium-owned
// preferences remain native; unsupported writes fail rather than reporting
// an unapplied preference as saved.
const DEFAULT_SETTINGS = UserBrowserSettingsSchema.parse({
	startupBehavior: "restore", homepageUrl: "", startupPages: [], searchEngine: "google",
	tabLayout: "horizontal", tabSizing: "scrolling", newTabBackground: "graphite",
	newTabGreetingActivity: { version: 1, days: [] },
	newTabWidgets: { version: 1, enabled: ["frequent-tabs", "recent-work", "route-usage", "recent-memories"], layouts: {}, routeUsageVisible: [] },
	restoreSession: true, historyRetentionDays: 90, sleepingTabsEnabled: true,
	sleepingTabTimeoutMinutes: 30, sleepingTabExcludedDomains: [], memorySaverMode: true,
	showBookmarksBar: true, addressBarSuggestionsEnabled: true, passwordAutofillEnabled: true,
	offerToSavePasswords: true, autoSavePasswords: false, autofillProfileEnabled: true,
	autoSaveFormInfo: true, autofillPasswords: true, autofillUsernames: true,
	offerStrongPasswords: true, neverSavePasswordOrigins: [], paymentAutofillEnabled: true,
	defaultZoomPercent: 100, minimumFontSize: 0, defaultFontFamily: "system-ui",
	spellcheckEnabled: true, spellcheckLanguage: "en-US", hardwareAccelerationEnabled: true,
	downloadBehavior: "automatic", downloadDirectory: "",
});

const SUPPORTED = new Set([
	"browser-get-state", "browser-create-tab", "browser-close-tab", "browser-select-tab",
	"browser-navigate", "browser-back", "browser-forward", "browser-reload",
	"browser-pin-tab", "browser-mute-tab", "browser-duplicate-tab", "browser-move-tab",
	"browser-toggle-bookmark", "browser-remove-bookmark", "browser-clear-history",
	"browser-list-extensions", "browser-cancel-download",
	"browser-update-settings",
	"browser-get-context",
]);
const APP_ROUTES = new Set([
	"settings", "history", "bookmarks", "downloads", "commands", "writing", "agent", "projects",
	"readiness", "approvals", "memory", "connections", "research", "artifacts", "work", "events",
	"activity", "extensions",
]);

const now = () => new Date().toISOString();
const uuid = () => `tab-${crypto.randomUUID()}`;
const asArray = (value) => Array.isArray(value) ? value : [];

function invoke(api, method, ...args) {
	return new Promise((resolve, reject) => {
		if (typeof api?.[method] !== "function") {
			reject(new Error(`Chrome API ${method} is unavailable.`));
			return;
		}
		try {
			const callback = (result) => {
				const error = globalThis.chrome?.runtime?.lastError;
				if (error) reject(new Error(error.message || `Chrome API ${method} failed.`));
				else resolve(result);
			};
			const result = api[method](...args, callback);
			if (result && typeof result.then === "function") result.then(resolve, reject);
		} catch (error) {
			reject(error);
		}
	});
}

function normalizeAddress(input, settings) {
	const value = String(input ?? "").trim();
	if (!value || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value))
		throw new Error("Enter a valid address or search.");
	if (new Set(["chrome://extensions/", "chrome://settings/", "chrome://downloads/", "chrome://history/", "chrome://bookmarks/"]).has(value)) return { url: value };
	if (/^kestrel:\/\//i.test(value)) return { url: value };
	const loopback = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?(?:[/?#]|$)/i.test(value);
	const explicit = /^[A-Za-z][A-Za-z\d+.-]*:/.test(value) && !loopback;
	if (explicit && !/^https?:/i.test(value)) throw new Error("Kestrel tabs support HTTP and HTTPS pages only.");
	const hostLike = loopback || /^(?:[A-Za-z\d](?:[A-Za-z\d-]{0,62}[A-Za-z\d])?\.)+[A-Za-z]{2,63}(?::\d{1,5})?(?:[/?#]|$)/.test(value) || /^(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:[/?#]|$)/.test(value);
	if (!explicit && !hostLike) {
		const template = settings.searchEngine === "custom" ? settings.customSearchUrl : SEARCH_ENGINES[settings.searchEngine] || SEARCH_ENGINES.google;
		if (settings.searchEngine === "custom" && (!template || !/^https?:\/\//i.test(template)))
			throw new Error("Custom search URL is not configured.");
		const encoded = encodeURIComponent(value);
		return { url: template.includes("%s") ? template.replace(/%s/g, encoded) : `${template}${template.includes("?") ? "&q=" : "?q="}${encoded}` };
	}
	const url = new URL(explicit ? value : `${loopback ? "http" : "https"}://${value}`);
	if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password)
		throw new Error("Enter an HTTP(S) address without embedded credentials.");
	return { url: url.toString() };
}

export function createBrowserAdapter(chromeApi, { emit = () => {}, uiUrl } = {}) {
	if (!chromeApi?.tabs || !chromeApi?.storage?.local || typeof uiUrl !== "string")
		throw new TypeError("Chrome tabs, local storage, and the Kestrel UI URL are required.");
	const ui = new URL(uiUrl);
	if (ui.protocol !== "chrome-extension:" || !ui.hostname) throw new TypeError("Kestrel UI must use its private extension origin.");
	let changeQueue = Promise.resolve();
	let idMapQueue = Promise.resolve();
	let focusedWindowId;

	async function stored(key, fallback) {
		const area = key === TAB_IDS_KEY ? chromeApi.storage.session : chromeApi.storage.local;
		if (!area) throw new Error("Native browser session storage is unavailable.");
		const result = await invoke(area, "get", key);
		return result?.[key] ?? fallback;
	}
	async function persist(key, value) {
		// Chrome tab numbers are reused after restart. Their Kestrel identities
		// must expire with that browser session so saved tool targets cannot
		// silently select or close an unrelated tab after restart.
		const area = key === TAB_IDS_KEY ? chromeApi.storage.session : chromeApi.storage.local;
		await invoke(area, "set", { [key]: value });
	}
	async function mutateStoredMap(key, mutate) {
		const work = idMapQueue.then(async () => {
			const map = await stored(key, {});
			const { value, changed } = mutate(map);
			if (changed) await persist(key, map);
			return value;
		});
		idMapQueue = work.catch(() => undefined);
		return work;
	}
	async function tabMap(tabs) {
		return mutateStoredMap(TAB_IDS_KEY, (map) => {
			let changed = false;
			for (const tab of tabs) {
				const key = String(tab.id);
				if (!/^tab-[a-f0-9-]{36}$/.test(map[key] || "")) { map[key] = uuid(); changed = true; }
			}
			return { value: map, changed };
		});
	}
	async function nativeId(id) {
		const tabs = await invoke(chromeApi.tabs, "query", {});
		const map = await tabMap(tabs);
		const found = tabs.find((tab) => map[String(tab.id)] === id);
		if (!found) throw new Error("That browser tab is no longer open.");
		return found;
	}
	async function focusedWindow() {
		if (focusedWindowId !== undefined) return focusedWindowId;
		if (chromeApi.windows?.getLastFocused) {
			const window = await invoke(chromeApi.windows, "getLastFocused");
			focusedWindowId = window?.id;
		}
		return focusedWindowId;
	}
	async function visibleTabs() {
		const windowId = await focusedWindow();
		return invoke(chromeApi.tabs, "query", windowId === undefined ? { currentWindow: true } : { windowId });
	}
	function displayUrl(url) {
		if (typeof url !== "string") return "";
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== ui.protocol || parsed.hostname !== ui.hostname) return url;
			const app = parsed.searchParams.get("app");
			if (!app) return "";
			if (!APP_ROUTES.has(app)) return "";
			const scope = parsed.searchParams.get("scope");
			if (parsed.searchParams.size > (scope ? 2 : 1) || (scope && (!new Set(["memory", "connections"]).has(app) || !/^session-[a-zA-Z0-9-]{1,160}$/.test(scope)))) return "";
			const route = new URL(`kestrel://${app}`);
			if (scope) route.searchParams.set("scope", scope);
			return route.toString();
		} catch { return url; }
	}
	function uiUrlFor(route) {
		const target = new URL(uiUrl);
		target.searchParams.delete("app");
		target.searchParams.delete("scope");
		if (!route || route === "kestrel://newtab") return target.toString();
		let parsed;
		try { parsed = new URL(route); } catch { throw new Error("That Kestrel page is not available."); }
		if (parsed.protocol !== "kestrel:" || parsed.username || parsed.password || parsed.port || parsed.hash || parsed.pathname !== "" || !APP_ROUTES.has(parsed.hostname))
			throw new Error("That Kestrel page is not available.");
		target.searchParams.set("app", parsed.hostname);
		const scope = parsed.searchParams.get("scope");
		if (parsed.searchParams.size && (!scope || new Set(["memory", "connections"]).has(parsed.hostname) === false || [...parsed.searchParams.keys()].some((key) => key !== "scope") || !/^session-[a-zA-Z0-9-]{1,160}$/.test(scope)))
			throw new Error("That Kestrel page is not available.");
		if (scope) target.searchParams.set("scope", scope);
		return target.toString();
	}
	async function state() {
		const tabs = await visibleTabs();
		const map = await tabMap(tabs);
		const settings = await stored(SETTINGS_KEY, DEFAULT_SETTINGS);
		const [bookmarkData, history, downloads] = await Promise.all([readBookmarks(), readHistory(), readDownloads()]);
		const normalized = tabs.map((tab) => ({
			id: map[String(tab.id)], title: (tab.title || "New Tab").slice(0, 500), url: displayUrl(tab.url || "").slice(0, 8192),
			loading: Boolean(tab.status === "loading"), canGoBack: false, canGoForward: false,
			discarded: Boolean(tab.discarded), crashed: false, pinned: Boolean(tab.pinned), muted: Boolean(tab.mutedInfo?.muted),
			createdAt: now(), lastActiveAt: now(),
		}));
		return {
			tabs: normalized, tabFolders: [], activeTabId: map[String(tabs.find((tab) => tab.active)?.id)] || null,
			history, originFavicons: [], downloads, bookmarks: bookmarkData.bookmarks,
			bookmarkFolders: bookmarkData.folders, recentlyClosedTabs: [],
			sitePermissions: [], settings: { ...DEFAULT_SETTINGS, ...settings },
		};
	}
	async function emitState() {
		try { emit("browser-event", { type: "state", state: await state() }); } catch { /* event refresh is best-effort; request callers receive errors */ }
	}
	function scheduleEmit() {
		changeQueue = changeQueue.then(emitState, emitState);
	}
	for (const event of [chromeApi.tabs.onCreated, chromeApi.tabs.onActivated, chromeApi.tabs.onUpdated, chromeApi.tabs.onMoved, chromeApi.tabs.onAttached, chromeApi.tabs.onDetached])
		event?.addListener?.(scheduleEmit);
	chromeApi.tabs.onRemoved?.addListener?.((tabId) => {
		changeQueue = changeQueue.then(async () => {
			await mutateStoredMap(TAB_IDS_KEY, (map) => {
				const changed = Object.hasOwn(map, String(tabId));
				delete map[String(tabId)];
				return { value: undefined, changed };
			});
			await emitState();
		}, emitState);
	});
	chromeApi.windows?.onFocusChanged?.addListener?.((windowId) => {
		if (windowId >= 0) focusedWindowId = windowId;
		scheduleEmit();
	});
	chromeApi.bookmarks?.onChanged?.addListener?.(scheduleEmit);
	chromeApi.bookmarks?.onCreated?.addListener?.(scheduleEmit);
	chromeApi.bookmarks?.onRemoved?.addListener?.(scheduleEmit);
	chromeApi.history?.onVisited?.addListener?.(scheduleEmit);
	chromeApi.downloads?.onChanged?.addListener?.(scheduleEmit);

	async function readBookmarks() {
		if (!chromeApi.bookmarks?.getTree) return { bookmarks: [], folders: [] };
		const tree = await invoke(chromeApi.bookmarks, "getTree");
		const output = [];
		const folders = [];
		return mutateStoredMap("kestrel.native.browser.bookmarkIds.v1", (ids) => {
			let idsChanged = false;
			const stableId = (key, prefix) => {
				if (!new RegExp(`^${prefix}[a-f0-9-]{36}$`).test(ids[key] || "")) {
					ids[key] = `${prefix}${crypto.randomUUID()}`;
					idsChanged = true;
				}
				return ids[key];
			};
			const walk = (nodes) => { for (const node of asArray(nodes)) {
				if (node.url && node.url.length <= 8192 && /^https?:/i.test(node.url)) output.push({
					id: stableId(node.id, "bookmark-"), url: node.url, title: (node.title || node.url).slice(0, 500),
					...(node.parentId ? { folderId: stableId(`folder:${node.parentId}`, "bookmark-folder-") } : {}), createdAt: node.dateAdded ? new Date(node.dateAdded).toISOString() : now(),
				});
				else if (node.children && node.id !== "0") folders.push({
					id: stableId(`folder:${node.id}`, "bookmark-folder-"), name: (node.title || "Bookmarks").slice(0, 80) || "Bookmarks",
					createdAt: node.dateAdded ? new Date(node.dateAdded).toISOString() : now(),
				});
				walk(node.children);
			} };
			walk(tree);
			return { value: { bookmarks: output.slice(0, 2000), folders: folders.slice(0, 100) }, changed: idsChanged };
		});
	}
	async function readHistory() {
		if (!chromeApi.history?.search) return [];
		const entries = await invoke(chromeApi.history, "search", { text: "", startTime: 0, maxResults: 5000 });
		const tabs = await invoke(chromeApi.tabs, "query", {});
		const map = await tabMap(tabs);
		const activeId = map[String(tabs.find((tab) => tab.active)?.id)] || uuid();
		return asArray(entries).filter((entry) => entry.url?.length <= 8192 && /^https?:/i.test(entry.url || "")).map((entry) => ({
			id: `visit-${crypto.randomUUID()}`, tabId: activeId, url: entry.url.slice(0, 8192),
			title: (entry.title || entry.url).slice(0, 500), visitedAt: new Date(entry.lastVisitTime || Date.now()).toISOString(),
		})).slice(0, 5000);
	}
	async function readDownloads() {
		if (!chromeApi.downloads?.search) return [];
		const items = await invoke(chromeApi.downloads, "search", { limit: 500, orderBy: ["-startTime"] });
		return mutateStoredMap("kestrel.native.browser.downloadIds.v1", (ids) => {
			let changed = false;
			const result = asArray(items).filter((item) => item.url?.length <= 8192 && /^https?:/i.test(item.url || "")).map((item) => {
				if (!ids[item.id]) { ids[item.id] = `download-${crypto.randomUUID()}`; changed = true; }
				return {
			id: ids[item.id], filename: (item.filename?.split(/[\\/]/).pop() || "Download").slice(0, 255),
			sourceUrl: item.url.slice(0, 8192), receivedBytes: Math.max(0, Math.trunc(item.bytesReceived || 0)),
			totalBytes: Math.max(0, Math.trunc(item.totalBytes || 0)),
			status: item.state === "complete" ? "completed" : item.state === "interrupted" ? "failed" : item.state === "in_progress" ? "progressing" : "cancelled",
			startedAt: item.startTime ? new Date(item.startTime).toISOString() : now(),
			...(item.endTime ? { completedAt: new Date(item.endTime).toISOString() } : {}), canReveal: false,
				};
			});
			return { value: result, changed };
		});
	}
	async function response() { return { ok: true, browserState: await state() }; }
	async function listExtensions() {
		if (!chromeApi.management?.getAll) return { ok: false, error: "Extension management is unavailable in this Chromium build." };
		const [all, dates] = await Promise.all([invoke(chromeApi.management, "getAll"), stored(INSTALL_DATES_KEY, {})]);
		let datesChanged = false;
		const extensions = asArray(all).filter((item) => item.type === "extension").map((item) => {
			if (!dates[item.id]) { dates[item.id] = now(); datesChanged = true; }
			return {
			id: item.id, name: (item.name || item.id).slice(0, 200), version: (item.version || "unknown").slice(0, 50),
			...(item.description ? { description: item.description.slice(0, 2000) } : {}), enabled: Boolean(item.enabled),
			...(item.icons?.length ? { iconUrl: item.icons.at(-1).url } : {}),
			source: item.installType === "normal" ? "chrome_web_store" : item.installType === "development" ? "unpacked" : "other",
			installedAt: dates[item.id],
			};
		});
		if (datesChanged) await persist(INSTALL_DATES_KEY, dates);
		return { ok: true, extensions };
	}
	async function request(input, sender) {
		if (!input || typeof input !== "object" || Array.isArray(input) || !SUPPORTED.has(input.type))
			return { ok: false, error: "This native browser request is not supported." };
		let senderUrl;
		try { senderUrl = new URL(sender?.url || ""); } catch { /* reject below */ }
		if (!sender || sender.id !== chromeApi.runtime.id || senderUrl?.protocol !== ui.protocol || senderUrl?.hostname !== ui.hostname || senderUrl?.pathname !== ui.pathname)
			return { ok: false, error: "Only the Kestrel UI can control native browser tabs." };
		if (Number.isInteger(sender.tab?.windowId)) focusedWindowId = sender.tab.windowId;
		try {
			if (input.type === "browser-get-context") return { ok: true, browserContext: await pageContext(input.tabId) };
			if (input.type === "browser-update-settings") {
				const allowed = new Set(["newTabBackground", "newTabBackgroundDataUrl", "newTabGreetingActivity", "newTabWidgets"]);
				const current = UserBrowserSettingsSchema.parse({ ...DEFAULT_SETTINGS, ...await stored(SETTINGS_KEY, DEFAULT_SETTINGS) });
				const next = UserBrowserSettingsSchema.parse(input.settings);
				const changed = Object.keys(next).filter(key => JSON.stringify(next[key]) !== JSON.stringify(current[key]));
				if (changed.some(key => !allowed.has(key)))
					throw new Error("Use the native browser settings to change this preference.");
				await persist(SETTINGS_KEY, next);
				await emitState();
				return response();
			}
			if (input.type === "browser-get-state") return response();
			if (input.type === "browser-list-extensions") return listExtensions();
			if (input.type === "browser-clear-history") {
				await invoke(chromeApi.history, "deleteAll");
				return response();
			}
			if (input.type === "browser-toggle-bookmark") {
				const windowId = await focusedWindow();
				const currentTabs = await invoke(chromeApi.tabs, "query", { active: true, ...(windowId === undefined ? { currentWindow: true } : { windowId }) });
				const current = currentTabs[0];
				const url = input.url || current?.url;
				if (!url || !/^https?:/i.test(url)) throw new Error("Only HTTP(S) pages can be bookmarked.");
				const matches = await invoke(chromeApi.bookmarks, "search", { url });
				if (matches.length) await invoke(chromeApi.bookmarks, "remove", matches[0].id);
				else await invoke(chromeApi.bookmarks, "create", { title: input.title || current?.title || url, url });
				return response();
			}
			if (input.type === "browser-create-tab") {
				const settings = await stored(SETTINGS_KEY, DEFAULT_SETTINGS);
				const requestedUrl = input.input ? normalizeAddress(input.input, settings).url : "";
				const url = requestedUrl.startsWith("kestrel://") || !requestedUrl ? uiUrlFor(requestedUrl) : requestedUrl;
				const windowId = await focusedWindow();
				await invoke(chromeApi.tabs, "create", { url, active: input.active !== false, ...(windowId === undefined ? {} : { windowId }) });
				return response();
			}
			if (input.type === "browser-cancel-download") {
				if (!chromeApi.downloads?.cancel) throw new Error("Native download cancellation is unavailable.");
				const items = await invoke(chromeApi.downloads, "search", { limit: 500 });
				const ids = await stored("kestrel.native.browser.downloadIds.v1", {});
				const item = items.find((download) => ids[download.id] === input.downloadId);
				if (!item) throw new Error("That download is no longer available.");
				await invoke(chromeApi.downloads, "cancel", item.id);
				return response();
			}
			if (input.type === "browser-remove-bookmark") {
				const ids = await stored("kestrel.native.browser.bookmarkIds.v1", {});
				const nativeBookmarkId = Object.keys(ids).find((key) => !key.startsWith("folder:") && ids[key] === input.bookmarkId);
				if (!nativeBookmarkId) throw new Error("That bookmark is no longer available.");
				await invoke(chromeApi.bookmarks, "remove", nativeBookmarkId);
				return response();
			}
			const tab = await nativeId(input.tabId);
			switch (input.type) {
				case "browser-close-tab": await invoke(chromeApi.tabs, "remove", tab.id); break;
				case "browser-select-tab": await invoke(chromeApi.tabs, "update", tab.id, { active: true }); break;
				case "browser-navigate": {
					const settings = await stored(SETTINGS_KEY, DEFAULT_SETTINGS);
					const url = normalizeAddress(input.input, settings).url;
					await invoke(chromeApi.tabs, "update", tab.id, { url: url.startsWith("kestrel://") ? uiUrlFor(url) : url });
					break;
				}
				case "browser-back": await invoke(chromeApi.tabs, "goBack", tab.id); break;
				case "browser-forward": await invoke(chromeApi.tabs, "goForward", tab.id); break;
				case "browser-reload": await invoke(chromeApi.tabs, "reload", tab.id, { bypassCache: input.ignoreCache === true }); break;
				case "browser-pin-tab": await invoke(chromeApi.tabs, "update", tab.id, { pinned: Boolean(input.pinned) }); break;
				case "browser-mute-tab": await invoke(chromeApi.tabs, "update", tab.id, { muted: Boolean(input.muted) }); break;
				case "browser-duplicate-tab": await invoke(chromeApi.tabs, "duplicate", tab.id); break;
				case "browser-move-tab": await invoke(chromeApi.tabs, "move", tab.id, { index: Math.max(0, Math.trunc(input.toIndex)) }); break;
				default: return { ok: false, error: "This native browser request is not supported." };
			}
			return response();
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message.slice(0, 500) : "The native browser request failed." };
		}
	}
	const publicTab = (tab) => tab.url === "about:blank" || /^https?:\/\//i.test(tab.url || "");
	async function pageContext(tabId, signal) {
		signal?.throwIfAborted();
		const tab = tabId ? await nativeId(tabId) : (await visibleTabs()).find(tab => tab.active);
		if (!tab || !/^https?:\/\//i.test(tab.url || "") || tab.pendingUrl && tab.pendingUrl !== tab.url)
			throw new Error("Select a loaded HTTP(S) user page before reading it.");
		const map = await tabMap([tab]);
		const frame = await invoke(chromeApi.webNavigation, "getFrame", { tabId: tab.id, frameId: 0 });
		signal?.throwIfAborted();
		if (!frame?.documentId || frame.documentLifecycle !== "active" || frame.url !== tab.url)
			throw new Error("The page changed before it could be read. Read the current page again.");
		const results = await invoke(chromeApi.scripting, "executeScript", {
			target: { tabId: tab.id, documentIds: [frame.documentId] }, world: "ISOLATED",
			func: capturePageContext, args: [map[String(tab.id)]],
		});
		signal?.throwIfAborted();
		const current = await invoke(chromeApi.webNavigation, "getFrame", { tabId: tab.id, frameId: 0 });
		const result = results?.[0];
		if (results?.length !== 1 || result.frameId !== 0 || result.documentId !== frame.documentId ||
			current?.documentId !== frame.documentId || current.documentLifecycle !== "active" || current.url !== frame.url || result.result?.sourceUrl !== frame.url)
			throw new Error("The page changed while being read. Discard this result and read the current page again.");
		signal?.throwIfAborted();
		return UserBrowserPageContextSchema.parse(result.result.context);
	}
	async function backend(input, signal) {
		signal?.throwIfAborted();
		if (input.operation === "visible-context") return pageContext(input.tabId, signal);
		// This method is called only over the authenticated Core channel. It is
		// intentionally absent from the renderer request protocol.
		if (input.operation === "visible-tabs") {
			const tabs = await invoke(chromeApi.tabs, "query", {});
			const map = await tabMap(tabs);
			const windowId = await focusedWindow();
			signal?.throwIfAborted();
			return tabs.filter(publicTab).map(tab => ({ id: map[String(tab.id)],
				title: (tab.title || "New Tab").slice(0, 500), url: (tab.url || "").slice(0, 8192),
				active: Boolean(tab.active && tab.windowId === windowId), loading: tab.status === "loading",
				discarded: Boolean(tab.discarded), trust: "untrusted_browser" }));
		}
		if (input.operation === "visible-history") {
			const history = await readHistory();
			signal?.throwIfAborted();
			const query = (input.query || "").toLowerCase();
			return history.filter(item => !query || `${item.title} ${item.url}`.toLowerCase().includes(query)).slice(0, input.limit || 50);
		}
		if (input.operation === "visible-downloads") {
			const downloads = await readDownloads();
			signal?.throwIfAborted();
			return downloads;
		}
		function publicAddress(value) {
			const address = normalizeAddress(value, DEFAULT_SETTINGS).url;
			if (!/^https?:\/\//i.test(address)) throw new Error("Core browser tools may navigate only HTTP(S) user pages.");
			return address;
		}
		if (input.operation === "visible-create") {
			const url = input.input ? publicAddress(input.input) : "about:blank";
			const windowId = await focusedWindow();
			signal?.throwIfAborted();
			const tab = await invoke(chromeApi.tabs, "create", { url, active: true, ...(windowId === undefined ? {} : { windowId }) });
			const map = await tabMap([tab]);
			return { tabId: map[String(tab.id)] };
		}
		if (!["visible-navigate", "visible-select", "visible-close"].includes(input.operation))
			throw new Error("This native browser tool is not connected yet.");
		const tab = await nativeId(input.tabId);
		if (!publicTab(tab)) throw new Error("Core browser tools cannot control protected Kestrel or browser pages.");
		signal?.throwIfAborted();
		if (input.operation === "visible-navigate") {
			await invoke(chromeApi.tabs, "update", tab.id, { url: publicAddress(input.input) });
			return { navigated: true };
		}
		if (input.operation === "visible-select") {
			await invoke(chromeApi.tabs, "update", tab.id, { active: true });
			return { selected: true };
		}
		await invoke(chromeApi.tabs, "remove", tab.id);
		return { closed: true };
	}
	return { handles: (type) => SUPPORTED.has(type), request, backend };
}
