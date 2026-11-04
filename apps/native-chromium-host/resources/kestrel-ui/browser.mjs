import { UserBrowserSettingsSchema, UserBrowserPageContextSchema, RendererRequestSchema } from "../../../../packages/shared-types/src/contracts.ts";
import { NativeLoginCodeBrowserRequestSchema } from "../../../../packages/shared-types/src/native-login-code.ts";
import { loginCodeField } from "./login-code-fields.mjs";
import { capturePageContext } from "./page-context.mjs";
import { createNativeAutomation } from "./native-automation.mjs";
import { isNativeBrowserSettingsUrl } from "../../../../packages/shared-types/src/native-browser-settings.ts";

const TAB_IDS_KEY = "kestrel.native.browser.tabIds.v1";
const SETTINGS_KEY = "kestrel.native.browser.settings.v1";
const BOOKMARK_IDS_KEY = "kestrel.native.browser.bookmarkIds.v1";
const BOOKMARK_MODES_KEY = "kestrel.native.browser.bookmarkModes.v1";
const BOOKMARK_REQUESTS = new Set(["browser-toggle-bookmark", "browser-save-bookmark", "browser-update-bookmark", "browser-remove-bookmark", "browser-create-bookmark-folder", "browser-rename-bookmark-folder", "browser-remove-bookmark-folder"]);
const INSTALL_DATES_KEY = "kestrel.native.browser.extensionInstallDates.v1";
class BookmarkLimitError extends Error {}

const HOME_SETTINGS_KEYS = ["newTabBackground", "newTabBackgroundCustomDataUrl", "newTabShortcuts", "newTabGreetingActivity", "newTabWidgets"];

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
	...BOOKMARK_REQUESTS, "browser-clear-history",
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

function normalizeAddress(input) {
	const value = String(input ?? "").trim();
	if (!value || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value))
		throw new Error("Enter a valid address or search.");
	if (isNativeBrowserSettingsUrl(value)) return { url: value };
	if (/^kestrel:\/\//i.test(value)) return { url: value };
	const loopback = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?(?:[/?#]|$)/i.test(value);
	const explicit = /^[A-Za-z][A-Za-z\d+.-]*:/.test(value) && !loopback;
	if (explicit && !/^https?:/i.test(value)) throw new Error("Kestrel tabs support HTTP and HTTPS pages only.");
	const hostLike = loopback || /^(?:[A-Za-z\d](?:[A-Za-z\d-]{0,62}[A-Za-z\d])?\.)+[A-Za-z]{2,63}(?::\d{1,5})?(?:[/?#]|$)/.test(value) || /^(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:[/?#]|$)/.test(value);
	if (!explicit && !hostLike) return { query: value };
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
	let bookmarkQueue = Promise.resolve();
	let focusedWindowId;
	const loginCodeCaptures = new Map();
	const loginCodeRevisions = new Map();
	// Chrome reports same-document history changes even when a URL later returns
	// to its original value. Captures are deliberately lost on worker restart.
	const invalidateLoginCodeTab = details => {
		if (details?.frameId !== 0) return;
		if (loginCodeRevisions.has(details.tabId)) loginCodeRevisions.set(details.tabId, loginCodeRevisions.get(details.tabId) + 1);
		for (const [id, capture] of loginCodeCaptures) if (capture.tabId === details.tabId) loginCodeCaptures.delete(id);
	};
	for (const event of [chromeApi.webNavigation?.onHistoryStateUpdated, chromeApi.webNavigation?.onReferenceFragmentUpdated, chromeApi.webNavigation?.onCommitted])
		event?.addListener(invalidateLoginCodeTab);
	chromeApi.tabs.onRemoved?.addListener(tabId => {
		loginCodeRevisions.delete(tabId);
		for (const [id, capture] of loginCodeCaptures) if (capture.tabId === tabId) loginCodeCaptures.delete(id);
	});

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
		// Every first-party document needs its own tab even when another window
		// has focus. activeTabId continues to describe the real focused window.
		const tabs = await invoke(chromeApi.tabs, "query", {});
		const windowId = await focusedWindow();
		const map = await tabMap(tabs);
		const settings = await homeSettings();
		const [bookmarkData, history, downloads] = await Promise.all([readBookmarks(), readHistory(), readDownloads()]);
		const normalized = tabs.map((tab) => ({
			id: map[String(tab.id)], title: (tab.title || "New Tab").slice(0, 500), url: displayUrl(tab.url || "").slice(0, 8192),
			loading: Boolean(tab.status === "loading"), canGoBack: false, canGoForward: false,
			discarded: Boolean(tab.discarded), crashed: false, pinned: Boolean(tab.pinned), muted: Boolean(tab.mutedInfo?.muted),
			createdAt: now(), lastActiveAt: now(),
		}));
		return {
			tabs: normalized, tabFolders: [], activeTabId: map[String(tabs.find((tab) => tab.active && tab.windowId === windowId)?.id)] || null,
			history, originFavicons: [], downloads, bookmarks: bookmarkData.bookmarks,
			bookmarkFolders: bookmarkData.folders, recentlyClosedTabs: [],
			sitePermissions: [], settings, settingsOwnership: "chromium",
		};
	}
	async function homeSettings() {
		const value = await stored(SETTINGS_KEY, {});
		// Ignore old compatibility fields in storage. They were never applied to
		// Chromium, and must not override native browser preferences or searches.
		return UserBrowserSettingsSchema.parse({ ...DEFAULT_SETTINGS,
			...Object.fromEntries(HOME_SETTINGS_KEYS.filter(key => value && Object.hasOwn(value, key)).map(key => [key, value[key]])),
		});
	}
	function assertSearchAvailable(address) {
		if (address.query && typeof chromeApi.search?.query !== "function")
			throw new Error("Native search is unavailable. Open Search settings or enter a website address.");
	}
	async function navigateAddress(tabId, address) {
		if (address.query) {
			// Chromium owns provider choice and query encoding. Never silently
			// send a search to a provider inferred from compatibility defaults.
			await invoke(chromeApi.search, "query", { text: address.query, tabId });
		} else await invoke(chromeApi.tabs, "update", tabId, { url: address.url.startsWith("kestrel://") ? uiUrlFor(address.url) : address.url });
	}
	async function createAddress(address, active) {
		assertSearchAvailable(address);
		const windowId = await focusedWindow();
		const url = address.query ? "about:blank" : address.url?.startsWith("kestrel://") || !address.url ? uiUrlFor(address.url) : address.url;
		const tab = await invoke(chromeApi.tabs, "create", { url, active, ...(windowId === undefined ? {} : { windowId }) });
		if (address.query) await navigateAddress(tab.id, address);
		return tab;
	}
	async function emitState() {
		try { emit("browser-event", { type: "state", state: await state() }); } catch { /* event refresh is best-effort; request callers receive errors */ }
	}
	function scheduleEmit() {
		changeQueue = changeQueue.then(emitState, emitState);
		return changeQueue;
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
	chromeApi.storage.onChanged?.addListener?.((changes, area) => {
		if (area === "local" && Object.hasOwn(changes || {}, BOOKMARK_MODES_KEY)) scheduleEmit();
	});
	chromeApi.bookmarks?.onChanged?.addListener?.(scheduleEmit);
	chromeApi.bookmarks?.onCreated?.addListener?.(scheduleEmit);
	chromeApi.bookmarks?.onRemoved?.addListener?.(scheduleEmit);
	chromeApi.bookmarks?.onMoved?.addListener?.(scheduleEmit);
	chromeApi.history?.onVisited?.addListener?.(scheduleEmit);
	chromeApi.downloads?.onChanged?.addListener?.(scheduleEmit);

	async function readBookmarks() {
		if (!chromeApi.bookmarks?.getTree) return { bookmarks: [], folders: [] };
		const tree = await invoke(chromeApi.bookmarks, "getTree");
		const output = [];
		const folders = [];
		const storedModes = await stored(BOOKMARK_MODES_KEY, {});
		const modes = storedModes && typeof storedModes === "object" && !Array.isArray(storedModes) ? storedModes : {};
		return mutateStoredMap(BOOKMARK_IDS_KEY, (ids) => {
			let idsChanged = false;
			const liveKeys = new Set();
			const collect = nodes => { for (const node of asArray(nodes)) { liveKeys.add(String(node.id)); liveKeys.add(`folder:${node.id}`); collect(node.children); } };
			collect(tree);
			for (const key of Object.keys(ids)) if (!liveKeys.has(key)) { delete ids[key]; idsChanged = true; }
			const stableId = (key, prefix) => {
				if (!new RegExp(`^${prefix}[a-f0-9-]{36}$`).test(ids[key] || "")) {
					ids[key] = `${prefix}${crypto.randomUUID()}`;
					idsChanged = true;
				}
				return ids[key];
			};
			const rootIds = new Set(asArray(tree?.[0]?.children).map(node => node.id));
			const walk = (nodes, depth = 0, locked = false) => { for (const node of asArray(nodes)) {
				const immutable = locked || Boolean(node.unmodifiable);
				if (immutable) continue;
				if (node.url && node.url.length <= 8192 && /^https?:/i.test(node.url)) output.push({
					id: stableId(node.id, "bookmark-"), url: node.url, title: (node.title || node.url).slice(0, 500),
					...(!rootIds.has(node.parentId) && node.parentId ? { folderId: stableId(`folder:${node.parentId}`, "bookmark-folder-") } : {}), displayMode: ["full", "title", "icon"].includes(modes[node.id]) ? modes[node.id] : "full", createdAt: node.dateAdded ? new Date(node.dateAdded).toISOString() : now(),
				});
				else if (node.children && depth > 1 && !node.folderType) folders.push({
					id: stableId(`folder:${node.id}`, "bookmark-folder-"), name: (node.title || "Bookmarks").slice(0, 80) || "Bookmarks",
					createdAt: node.dateAdded ? new Date(node.dateAdded).toISOString() : now(),
				});
				walk(node.children, depth + 1, immutable);
			} };
			walk(tree);
			return { value: { bookmarks: output.slice(0, 2000), folders: folders.slice(0, 100) }, changed: idsChanged };
		});
	}
	function safeBookmarkUrl(value) {
		if (typeof value !== "string" || value.length > 8192 || !/^https?:\/\//i.test(value) || /[\u0000-\u001f\u007f]/.test(value)) throw new Error();
		const url = new URL(value);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
		return url.href;
	}
	function bookmarkText(value, max, fallback = "") {
		if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error();
		return value.trim() || fallback;
	}
	async function changeBookmark(input) {
		const tree = await invoke(chromeApi.bookmarks, "getTree");
		const root = tree?.[0];
		if (!root || root.url || !Array.isArray(root.children)) throw new Error();
		const roots = root.children.filter(node => !node.url && !node.unmodifiable);
		const defaultRoot = roots.find(node => node.folderType === "bookmarks-bar") || roots[0];
		if (!defaultRoot) throw new Error();
		const nodes = new Map();
		const walk = (node, depth, locked) => {
			const immutable = locked || Boolean(node.unmodifiable) || depth <= 1 || Boolean(node.folderType);
			nodes.set(String(node.id), { node, immutable, locked: locked || Boolean(node.unmodifiable), depth });
			for (const child of asArray(node.children)) walk(child, depth + 1, locked || Boolean(node.unmodifiable));
		};
		walk(root, 0, false);
		await readBookmarks();
		const ids = await stored(BOOKMARK_IDS_KEY, {});
		const lookup = (stable, folder) => {
			const key = Object.keys(ids).find(key => key.startsWith("folder:") === folder && ids[key] === stable);
			const entry = key && nodes.get(folder ? key.slice(7) : key);
			if (!entry || Boolean(entry.node.url) === folder) throw new Error();
			return entry;
		};
		const targetFolder = id => {
			if (id == null) return defaultRoot;
			const entry = lookup(id, true);
			if (entry.locked || entry.depth === 0) throw new Error();
			return entry.node;
		};
		const modes = await stored(BOOKMARK_MODES_KEY, {});
		if (!modes || typeof modes !== "object" || Array.isArray(modes) || Object.keys(modes).length > 4000) throw new Error();
		for (const id of Object.keys(modes)) if (!nodes.has(id)) delete modes[id];
		const saveMode = async (id, mode) => { modes[id] = mode; await persist(BOOKMARK_MODES_KEY, modes); };
		if (input.type === "browser-create-bookmark-folder") {
			const name = bookmarkText(input.name, 80); if (!name) throw new Error();
			const folderCount = [...nodes.values()].filter(({ node, depth, locked }) => !locked && depth > 1 && !node.url && Array.isArray(node.children) && !node.folderType).length;
			if (folderCount >= 100) throw new BookmarkLimitError("Kestrel supports up to 100 bookmark folders.");
			const created = await invoke(chromeApi.bookmarks, "create", { parentId: defaultRoot.id, title: name });
			const stateResult = await response();
			const idMap = await stored(BOOKMARK_IDS_KEY, {});
			const folder = stateResult.browserState?.bookmarkFolders.find(item => item.id === idMap[`folder:${created.id}`]);
			if (!folder) throw new Error();
			return { ...stateResult, bookmarkFolderId: folder.id };
		}
		if (input.type === "browser-rename-bookmark-folder" || input.type === "browser-remove-bookmark-folder") {
			const entry = lookup(input.folderId, true); if (entry.immutable) throw new Error();
			if (input.type === "browser-rename-bookmark-folder") {
				const name = bookmarkText(input.name, 80); if (!name) throw new Error();
				await invoke(chromeApi.bookmarks, "update", entry.node.id, { title: name });
			} else {
				const currentFolder = async () => {
					const current = await invoke(chromeApi.bookmarks, "get", entry.node.id);
					const folder = asArray(current)[0];
					if (current?.length !== 1 || !folder || folder.url || folder.unmodifiable || folder.folderType || folder.parentId !== entry.node.parentId) throw new Error();
				};
				await currentFolder();
				for (const child of asArray(entry.node.children)) {
					const result = await invoke(chromeApi.bookmarks, "get", child.id);
					const current = asArray(result)[0];
					if (result?.length !== 1 || !current || current.parentId !== entry.node.id || current.unmodifiable || current.folderType) throw new Error();
					await invoke(chromeApi.bookmarks, "move", current.id, { parentId: defaultRoot.id });
				}
				await currentFolder();
				await invoke(chromeApi.bookmarks, "remove", entry.node.id);
			}
			return response();
		}
		if (input.type === "browser-remove-bookmark") {
			const entry = lookup(input.bookmarkId, false); if (entry.immutable) throw new Error();
			await invoke(chromeApi.bookmarks, "remove", entry.node.id); delete modes[entry.node.id]; await persist(BOOKMARK_MODES_KEY, modes); return response();
		}
		if (input.type === "browser-update-bookmark") {
			const entry = lookup(input.bookmarkId, false); if (entry.immutable) throw new Error();
			const folder = input.folderId === undefined ? undefined : targetFolder(input.folderId);
			const title = bookmarkText(input.title, 500, entry.node.url);
			await invoke(chromeApi.bookmarks, "update", entry.node.id, { title });
			if (folder && folder.id !== entry.node.parentId) await invoke(chromeApi.bookmarks, "move", entry.node.id, { parentId: folder.id });
			await saveMode(entry.node.id, input.displayMode); return response();
		}
		const current = (await visibleTabs()).find(tab => tab.active);
		const url = safeBookmarkUrl(input.type === "browser-toggle-bookmark" ? input.url || current?.url : current?.url);
		const matches = await invoke(chromeApi.bookmarks, "search", { url });
		const match = asArray(matches).find(item => nodes.has(String(item.id)) && !nodes.get(String(item.id)).immutable);
		if (input.type === "browser-toggle-bookmark" && match) { await invoke(chromeApi.bookmarks, "remove", match.id); delete modes[match.id]; await persist(BOOKMARK_MODES_KEY, modes); return response(); }
		const folder = targetFolder(input.type === "browser-save-bookmark" ? input.folderId : null);
		const fallback = typeof current?.title === "string" ? current.title.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500) : "";
		const title = bookmarkText(input.title || "", 500, fallback || url);
		let item;
		if (match) { item = match; await invoke(chromeApi.bookmarks, "update", item.id, { title }); if (item.parentId !== folder.id) await invoke(chromeApi.bookmarks, "move", item.id, { parentId: folder.id }); }
		else {
			const bookmarkCount = [...nodes.values()].filter(({ node, locked }) => !locked && typeof node.url === "string" && node.url.length <= 8192 && /^https?:/i.test(node.url)).length;
			if (bookmarkCount >= 2000) throw new BookmarkLimitError("Kestrel supports up to 2,000 bookmarks.");
			item = await invoke(chromeApi.bookmarks, "create", { parentId: folder.id, title, url });
		}
		await saveMode(item.id, input.type === "browser-save-bookmark" ? input.displayMode : "full");
		return response();
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
		try {
			if (input.type === "browser-get-context") return { ok: true, browserContext: await pageContext(input.tabId) };
			if (input.type === "browser-update-settings") {
				const allowed = new Set(HOME_SETTINGS_KEYS);
				const current = await homeSettings();
				const next = UserBrowserSettingsSchema.parse(input.settings);
				const changed = Object.keys(next).filter(key => JSON.stringify(next[key]) !== JSON.stringify(current[key]));
				if (changed.some(key => !allowed.has(key)))
					throw new Error("Use the native browser settings to change this preference.");
				await persist(SETTINGS_KEY, Object.fromEntries(HOME_SETTINGS_KEYS.filter(key => next[key] !== undefined).map(key => [key, next[key]])));
				await emitState();
				return response();
			}
			if (input.type === "browser-get-state") return response();
			if (input.type === "browser-list-extensions") return listExtensions();
			if (input.type === "browser-clear-history") {
				await invoke(chromeApi.history, "deleteAll");
				return response();
			}
			if (BOOKMARK_REQUESTS.has(input.type)) {
				const parsed = RendererRequestSchema.safeParse(input);
				if (!parsed.success) return { ok: false, error: "Invalid bookmark request." };
				const work = bookmarkQueue.then(async () => {
					const result = await changeBookmark(parsed.data);
					// Drain earlier Chrome events before publishing a final post-write state.
					await scheduleEmit();
					const fresh = await response();
					return { ...fresh, ...("bookmarkFolderId" in result ? { bookmarkFolderId: result.bookmarkFolderId } : {}) };
				});
				bookmarkQueue = work.catch(() => undefined);
				try { return await work; } catch (error) { return { ok: false, error: error instanceof BookmarkLimitError ? error.message : "Bookmark changes could not be completed. The result may be incomplete; check bookmarks before trying again." }; }
			}
			if (input.type === "browser-create-tab") {
				await createAddress(input.input ? normalizeAddress(input.input) : { url: "" }, input.active !== false);
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

			const tab = await nativeId(input.tabId);
			switch (input.type) {
				case "browser-close-tab": await invoke(chromeApi.tabs, "remove", tab.id); break;
				case "browser-select-tab":
					await invoke(chromeApi.tabs, "update", tab.id, { active: true });
					await invoke(chromeApi.windows, "update", tab.windowId, { focused: true });
					focusedWindowId = tab.windowId;
					break;
				case "browser-navigate": {
					const address = normalizeAddress(input.input);
					assertSearchAvailable(address);
					await navigateAddress(tab.id, address);
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
	const automation = createNativeAutomation(chromeApi, { invoke, resolveTab: async tabId => tabId ? nativeId(tabId) : (await visibleTabs()).find(tab => tab.active) });
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
	async function loginCode(input, signal) {
		// Keep all errors static: neither page content nor the code enters logs.
		try {
			const request = NativeLoginCodeBrowserRequestSchema.parse(input);
			signal?.throwIfAborted();
			const authority = request.authority;
			const capture = authority && loginCodeCaptures.get(authority.fieldId);
			if (request.operation === "fill") loginCodeCaptures.delete(authority.fieldId);
			if (authority && (!capture || capture.expires <= Date.now() || capture.tabId !== authority.chromeTabId ||
				JSON.stringify(capture.authority) !== JSON.stringify(authority))) throw new Error();
			const tab = await nativeId(request.operation === "inspect" ? request.tabId : authority.tabId);
			const check = async () => {
				const window = await invoke(chromeApi.windows, "getLastFocused", { windowTypes: ["normal"] });
				const current = await invoke(chromeApi.tabs, "get", tab.id);
				signal?.throwIfAborted();
				if (!window?.focused || window.id !== tab.windowId || !current?.active || current.windowId !== tab.windowId ||
					current.pendingUrl || current.status !== "complete" || current.discarded || current.url !== tab.url) throw new Error();
				const url = new URL(current.url);
				if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
				const frame = await invoke(chromeApi.webNavigation, "getFrame", { tabId: tab.id, frameId: 0 });
				signal?.throwIfAborted();
				if (!frame?.documentId || frame.documentLifecycle !== "active" || frame.url !== current.url) throw new Error();
				return { frame, origin: url.origin };
			};
			if (!loginCodeRevisions.has(tab.id)) {
				while (loginCodeRevisions.size >= 32) {
					const oldest = loginCodeRevisions.keys().next().value;
					loginCodeRevisions.delete(oldest);
					for (const [id, item] of loginCodeCaptures) if (item.tabId === oldest) loginCodeCaptures.delete(id);
				}
				loginCodeRevisions.set(tab.id, 0);
			}
			const revision = loginCodeRevisions.get(tab.id);
			const before = await check();
			if (loginCodeRevisions.get(tab.id) !== revision || (authority && capture.revision !== revision)) throw new Error();
			if (authority && (authority.chromeTabId !== tab.id || authority.windowId !== tab.windowId ||
				authority.documentId !== before.frame.documentId || authority.origin !== before.origin)) throw new Error();
			if (loginCodeRevisions.get(tab.id) !== revision) throw new Error();
			const results = await invoke(chromeApi.scripting, "executeScript", {
				target: { tabId: tab.id, documentIds: [before.frame.documentId] }, world: "ISOLATED",
				func: loginCodeField, args: [request.operation, authority?.fieldId ?? null, request.code ?? null],
			});
			signal?.throwIfAborted();
			const after = await check();
			const result = results?.[0];
			if (results?.length !== 1 || result.frameId !== 0 || result.documentId !== before.frame.documentId ||
				after.frame.documentId !== before.frame.documentId || after.frame.url !== before.frame.url ||
				loginCodeRevisions.get(tab.id) !== revision || result.result?.ok !== true) throw new Error();
			if (request.operation === "inspect") {
				const value = { tabId: request.tabId, chromeTabId: tab.id, windowId: tab.windowId,
					documentId: before.frame.documentId, origin: before.origin, fieldId: result.result.fieldId };
				const parsed = NativeLoginCodeBrowserRequestSchema.parse({ operation: "validate", authority: value }).authority;
				for (const [id, item] of loginCodeCaptures) if (item.expires <= Date.now()) loginCodeCaptures.delete(id);
				while (loginCodeCaptures.size >= 32) loginCodeCaptures.delete(loginCodeCaptures.keys().next().value);
				loginCodeCaptures.set(parsed.fieldId, { authority: parsed, tabId: tab.id, revision, expires: Date.now() + 120000 });
				return parsed;
			}
			return request.operation === "validate" ? { valid: true } : { filled: true };
		} catch { throw new Error("The verification code field is unavailable or has changed."); }
	}
	async function backend(input, signal) {
		signal?.throwIfAborted();
		if (input.operation === "visible-context") return pageContext(input.tabId, signal);
		if (input.operation === "visible-snapshot") return automation.snapshot(input.tabId, signal);
		if (input.operation === "visible-act") return automation.act(input.tabId, input.action, signal);
		if (input.operation === "visible-screenshot") return automation.screenshot(input.tabId, signal);
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
			return { entries: history.filter(item => !query || `${item.title} ${item.url}`.toLowerCase().includes(query)).slice(0, input.limit || 50), trust: "untrusted_browser" };
		}
		if (input.operation === "visible-downloads") {
			const downloads = await readDownloads();
			signal?.throwIfAborted();
			return { downloads, trust: "untrusted_browser" };
		}
		function publicAddress(value) {
			const address = normalizeAddress(value);
			if (!address.query && !/^https?:\/\//i.test(address.url)) throw new Error("Core browser tools may navigate only HTTP(S) user pages.");
			assertSearchAvailable(address);
			return address;
		}
		if (input.operation === "visible-create") {
			const address = input.input ? publicAddress(input.input) : { url: "about:blank" };
			signal?.throwIfAborted();
			const tab = await createAddress(address, true);
			const map = await tabMap([tab]);
			return { tabId: map[String(tab.id)] };
		}
		if (!["visible-navigate", "visible-select", "visible-close"].includes(input.operation))
			throw new Error("This native browser tool is not connected yet.");
		const tab = await nativeId(input.tabId);
		if (!publicTab(tab)) throw new Error("Core browser tools cannot control protected Kestrel or browser pages.");
		signal?.throwIfAborted();
		if (input.operation === "visible-navigate") {
			await navigateAddress(tab.id, publicAddress(input.input));
			return { navigated: true };
		}
		if (input.operation === "visible-select") {
			await invoke(chromeApi.tabs, "update", tab.id, { active: true });
			await invoke(chromeApi.windows, "update", tab.windowId, { focused: true });
			focusedWindowId = tab.windowId;
			return { selected: true };
		}
		await invoke(chromeApi.tabs, "remove", tab.id);
		return { closed: true };
	}
	async function openNativeWindow() {
		// This unique tab is the only tab this operation may navigate or close.
		// Chromium may simultaneously restore any number of user-owned tabs.
		const marker = `about:blank#kestrel-window-${crypto.randomUUID()}`;
		const window = await invoke(chromeApi.windows, "create", { type: "normal", focused: true, url: marker });
		if (!Number.isInteger(window?.id) || window.id < 0) throw new Error("Kestrel's new browser window could not be confirmed. Check Kestrel before retrying.");
		const homeUrl = new URL(uiUrl);
		const currentUrl = (tab) => tab?.pendingUrl || tab?.url || "";
		const isHome = (tab) => {
			try {
				if (!tab?.url || (tab.pendingUrl && tab.pendingUrl !== tab.url)) return false;
				const url = new URL(tab.url);
				return url.protocol === homeUrl.protocol && url.hostname === homeUrl.hostname &&
					url.pathname === homeUrl.pathname && !url.search && !url.hash;
			} catch { return false; }
		};
		const validId = (tab) => Number.isInteger(tab?.id) && tab.id >= 0 && tab.windowId === window.id;
		const uncertain = () => new Error("The new browser window changed before Kestrel could confirm it. Check Kestrel before retrying.");
		let markerId;
		let home;
		// Give session restoration time to surface before deciding that a Home
		// needs to be created. Never infer ownership from an ordinary blank tab.
		for (let attempt = 0; attempt < 10; attempt++) {
			const tabs = await invoke(chromeApi.tabs, "query", { windowId: window.id });
			if (!Array.isArray(tabs)) throw uncertain();
			if (markerId === undefined) {
				const markers = tabs.filter((tab) => validId(tab) && currentUrl(tab) === marker);
				if (markers.length > 1) throw uncertain();
				if (markers.length === 1) markerId = markers[0].id;
			}
			if (markerId !== undefined) {
				const owned = tabs.find((tab) => tab.id === markerId);
				if (!validId(owned) || currentUrl(owned) !== marker) throw uncertain();
				home = tabs.find((tab) => validId(tab) && tab.id !== markerId && isHome(tab));
				if (home) break;
			}
			if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 100));
		}
		if (markerId === undefined) throw uncertain();
		// Re-read immediately before every destructive operation. A changed tab
		// belongs to the user now and must be left untouched.
		const readMarker = async () => {
			const tab = await invoke(chromeApi.tabs, "get", markerId);
			if (!validId(tab) || currentUrl(tab) !== marker) throw uncertain();
			return tab;
		};
		if (home) {
			const freshHome = await invoke(chromeApi.tabs, "get", home.id);
			if (!validId(freshHome) || !isHome(freshHome)) throw uncertain();
			await readMarker();
			await invoke(chromeApi.tabs, "update", home.id, { active: true });
			await readMarker();
			await invoke(chromeApi.tabs, "remove", markerId);
			const confirmed = await invoke(chromeApi.tabs, "get", home.id);
			if (!validId(confirmed) || !isHome(confirmed)) throw uncertain();
			focusedWindowId = window.id;
			return { tabId: home.id, windowId: window.id };
		}
		await readMarker();
		await invoke(chromeApi.tabs, "update", markerId, { url: homeUrl.toString(), active: true });
		for (let attempt = 0; attempt < 10; attempt++) {
			const tab = await invoke(chromeApi.tabs, "get", markerId);
			if (!validId(tab)) throw uncertain();
			if (isHome(tab)) {
				focusedWindowId = window.id;
				return { tabId: markerId, windowId: window.id };
			}
			if (currentUrl(tab) !== marker && currentUrl(tab) !== homeUrl.toString()) throw uncertain();
			if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw uncertain();
	}

	async function openExternalUrl(value) {
		// Only the private browser-owner channel calls this method. A received
		// OS URL must never become a search, internal route, or a new app window.
		if (typeof value !== "string" || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value) || !/^https?:\/\//i.test(value)) throw new Error("External links must use HTTP or HTTPS.");
		const address = normalizeAddress(value);
		if (!address.url || !/^https?:\/\//i.test(address.url)) throw new Error("External links must use HTTP or HTTPS.");
		const windows = await invoke(chromeApi.windows, "getAll", { windowTypes: ["normal"] });
		if (!windows.length) {
			// Chromium restores the existing session when opening its first
			// window. Supply only the new link; adding another Home here would
			// duplicate the person's restored Home tab. New Tab opens Kestrel.
			const window = await invoke(chromeApi.windows, "create", { url: address.url, type: "normal", focused: true });
			if (!Number.isInteger(window?.id) || window.id < 0) throw new Error("Kestrel's new browser window could not be confirmed. Check Kestrel before retrying.");
			const members = await invoke(chromeApi.tabs, "query", { windowId: window.id });
			const tab = members.find(tab => (tab.url || tab.pendingUrl) === address.url);
			if (!Number.isInteger(tab?.id) || tab.windowId !== window.id) throw new Error("Kestrel's new browser tab could not be confirmed. Check Kestrel before retrying.");
			focusedWindowId = window.id;
			return { tabId: tab.id, windowId: window.id };
		}
		const window = await invoke(chromeApi.windows, "getLastFocused", { windowTypes: ["normal"] });
		if (!Number.isInteger(window?.id) || window.id < 0) throw new Error("Kestrel's browser window is not ready.");
		const tab = await invoke(chromeApi.tabs, "create", { url: address.url, active: true, windowId: window.id });
		if (!Number.isInteger(tab?.id) || tab.windowId !== window.id) throw new Error("The external link's browser tab could not be confirmed. Check Kestrel before retrying.");
		focusedWindowId = window.id;
		return { tabId: tab.id, windowId: window.id };
	}
	return { handles: (type) => SUPPORTED.has(type), request, backend, loginCode, openExternalUrl, openNativeWindow };
}
