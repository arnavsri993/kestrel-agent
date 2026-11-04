import { describe, expect, it, vi } from "vitest";
import { InstalledExtensionSchema, UserBrowserStateSchema } from "../../../../packages/shared-types/src/contracts.ts";
import { createBrowserAdapter } from "./browser.mjs";
import { NATIVE_BROWSER_SETTINGS_URLS } from "../../../../packages/shared-types/src/native-browser-settings";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const uiUrl = `chrome-extension://${extensionId}/index.html`;
const sender = { id: extensionId, url: uiUrl, tab: { id: 91, windowId: 7 } };

function makeChrome() {
	const storage: Record<string, unknown> = {};
	const session: Record<string, unknown> = {};
	const handlers = new Map<string, (...args: any[]) => void>();
	const event = (name: string) => ({ addListener: (listener: (...args: any[]) => void) => handlers.set(name, listener) });
	const tabs = [
		{ id: 11, windowId: 7, active: true, status: "complete", title: "Home", url: uiUrl },
		{ id: 12, windowId: 7, active: false, status: "complete", title: "Settings", url: `${uiUrl}?app=settings` },
	];
	const bookmarks: any[] = [
		{ id: "1", parentId: "0", folderType: "bookmarks-bar", title: "Bookmarks bar", dateAdded: Date.parse("2026-01-01T00:00:00Z"), children: [
			{ id: "2", parentId: "1", title: "Example", url: "https://example.com/", dateAdded: Date.parse("2026-01-02T00:00:00Z") },
		] },
	];
	let bookmarkId = 3;
	let failBookmarkMove = false;
	let failMoveAfter = Infinity;
	let afterMove: (() => void) | undefined;
	let failBookmarkStorage = false;
	let failCreateAfter = Infinity;
	let failBookmarkUpdate = false;
	const allBookmarks = (): any[] => { const walk = (nodes: any[]): any[] => nodes.flatMap(node => [node, ...walk(node.children ?? [])]); return walk(bookmarks); };
	const findBookmark = (id: string) => { const node = allBookmarks().find(item => item.id === id); if (!node) throw new Error("missing"); return node; };
	const downloads = [{ id: 5, url: "https://example.com/file.zip", filename: "/Users/test/Downloads/file.zip", state: "in_progress", bytesReceived: 4, totalBytes: 10, startTime: "2026-01-02T00:00:00Z" }];
	const invoke = (fn: (...args: any[]) => unknown) => (...args: any[]) => {
		const callback = args.pop();
		try { const result = fn(...args); callback?.(result); return Promise.resolve(result); }
		catch (error) { throw error; }
	};
	const chrome = {
		runtime: { id: extensionId },
		storage: { onChanged: event("storage-changed"), session: {
			get: invoke((key: string) => ({ [key]: session[key] })),
			set: invoke((value: Record<string, unknown>) => Object.assign(session, value)),
		}, local: {
			get: invoke((key: string) => ({ [key]: storage[key] })),
			set: invoke((value: Record<string, unknown>) => { if (failBookmarkStorage && "kestrel.native.browser.bookmarkModes.v1" in value) throw new Error("fixture failure"); return Object.assign(storage, value); }),
		} },
		tabs: {
			get: invoke((id: number) => { const tab = tabs.find((item) => item.id === id); if (!tab) throw new Error("Missing tab"); return { ...tab }; }),
			query: invoke((query: Record<string, unknown> = {}) => tabs.filter((tab) =>
				(query.windowId === undefined || tab.windowId === query.windowId) &&
				(query.currentWindow !== true || tab.windowId === 7) &&
				(query.active !== true || tab.active),
			)),
			create: invoke((properties: Record<string, any>) => {
				if (properties.active !== false) for (const tab of tabs) tab.active = false;
				const tab = { id: tabs.reduce((max, item) => Math.max(max, item.id), 0) + 1, windowId: properties.windowId ?? 7, active: properties.active !== false, status: "complete", title: "New Tab", url: properties.url };
				tabs.push(tab); return tab;
			}),
			update: invoke((id: number, properties: Record<string, any>) => {
				const tab = tabs.find((item) => item.id === id)!;
				if (properties.active) for (const other of tabs) if (other.windowId === tab.windowId) other.active = other.id === id;
				Object.assign(tab, properties); return tab;
			}),
			remove: invoke((id: number) => { tabs.splice(tabs.findIndex((tab) => tab.id === id), 1); }),
			goBack: invoke(() => undefined), goForward: invoke(() => undefined), reload: invoke(() => undefined),
			duplicate: invoke((id: number) => { const original = tabs.find((tab) => tab.id === id)!; tabs.push({ ...original, id: Math.max(...tabs.map((tab) => tab.id)) + 1, active: false }); }),
			move: invoke(() => undefined),
			onCreated: event("tab-created"), onRemoved: event("tab-removed"), onActivated: event("tab-activated"),
			onUpdated: event("tab-updated"), onMoved: event("tab-moved"), onAttached: event("tab-attached"), onDetached: event("tab-detached"),
		},
		windows: {
			getLastFocused: invoke(() => ({ id: 7 })),
			getAll: invoke(() => [...new Set(tabs.map(tab => tab.windowId))].map(id => ({ id }))),
			update: invoke((id: number) => ({ id })),
			create: invoke(({ url }: { url: string | string[] }) => {
				const id = 8;
				const urls = Array.isArray(url) ? url : [url];
				for (const [index, address] of urls.entries()) tabs.push({ id: 100 + index, windowId: id, active: index === urls.length - 1, status: "complete", title: "New tab", url: address });
				return { id };
			}),
			onFocusChanged: event("window-focused"),
		},
		search: { query: vi.fn(invoke(({ text, tabId }: { text: string; tabId: number }) => {
			const tab = tabs.find(item => item.id === tabId);
			if (!tab) throw new Error("Missing search tab");
			tab.url = `https://native-provider.example/search?q=${encodeURIComponent(text)}`;
		})) },
		bookmarks: {
			getTree: invoke(() => [{ id: "0", children: bookmarks }]),
			get: invoke((id: string) => [{ ...findBookmark(id) }]),
			search: invoke((query: { url: string }) => allBookmarks().filter(item => item.url === query.url)),
			create: vi.fn(invoke((item: Record<string, any>) => { if (failCreateAfter-- <= 0) throw new Error("fixture failure"); const parent = findBookmark(item.parentId ?? "1"); const entry = { ...item, id: String(bookmarkId++), parentId: parent.id, dateAdded: Date.now(), ...(!item.url ? { children: [] } : {}) }; parent.children.push(entry); return entry; })),
			update: invoke((id: string, value: any) => { if (failBookmarkUpdate) throw new Error("fixture failure"); return Object.assign(findBookmark(id), value); }),
			move: invoke((id: string, value: any) => { if (failBookmarkMove || failMoveAfter-- <= 0) throw new Error("fixture failure"); const item = findBookmark(id), parent = findBookmark(item.parentId), target = findBookmark(value.parentId); parent.children = parent.children.filter((child: any) => child.id !== id); item.parentId = target.id; target.children.push(item); afterMove?.(); return item; }),
			remove: invoke((id: string) => { const item = findBookmark(id); if (item.children?.length) throw new Error("nonempty"); const parent = findBookmark(item.parentId); parent.children = parent.children.filter((child: any) => child.id !== id); }),
			onChanged: event("bookmark-changed"), onCreated: event("bookmark-created"), onRemoved: event("bookmark-removed"), onMoved: event("bookmark-moved"),
		},
		history: { search: invoke(() => [{ url: "https://example.com/", title: "Example", lastVisitTime: Date.parse("2026-01-03T00:00:00Z") }]), deleteAll: invoke(() => undefined), onVisited: event("history-visited") },
		downloads: { search: invoke(() => downloads), cancel: invoke(() => undefined), onChanged: event("download-changed") },
		management: { getAll: invoke(() => [{ id: "b".repeat(32), type: "extension", name: "Fixture", version: "1.0", enabled: true, installType: "normal" }]) },
	};
	return { chrome, tabs, storage, session, bookmarks, handlers, failMove: () => { failBookmarkMove = true; }, failStorage: () => { failBookmarkStorage = true; }, failAfterCreates: (count: number) => { failCreateAfter = count; }, failUpdate: () => { failBookmarkUpdate = true; }, failAfterMoves: (count: number) => { failMoveAfter = count; }, afterMove: (callback: () => void) => { afterMove = callback; } };
}

describe("native bookmark-only transfer", () => {
	const data = () => ({ format: "kestrel-bookmarks", version: 1,
		folders: [{ id: "f1", parentId: "f0", name: "Nested" }, { id: "f0", name: "Work" }],
		bookmarks: [{ url: "https://new.example/", title: "Friendly", folderId: "f1", displayMode: "icon" }] });
	const setup = () => { const fixture = makeChrome(); return { fixture, adapter: createBrowserAdapter(fixture.chrome, { uiUrl }) }; };
	async function preview(adapter: any, value: any = data(), extra: any = {}) {
		return adapter.request({ type: "browser-plan-bookmark-import", data: value, ...extra }, sender);
	}
	async function apply(adapter: any, planned: any) {
		return adapter.request({ type: "browser-apply-bookmark-import", planId: planned.bookmarkImportPlan.planId }, sender);
	}
	it("previews without native mutation, preserves hierarchy, and exports friendly labels without native metadata", async () => {
		const { fixture, adapter } = setup();
		const planned = await preview(adapter);
		expect(planned).toMatchObject({ ok: true, bookmarkImportPlan: { summary: { bookmarksToAdd: 1, duplicateBookmarks: 0, foldersToAdd: 2 } } });
		expect(fixture.chrome.bookmarks.create).not.toHaveBeenCalled();
		const result = await apply(adapter, planned);
		expect(result.bookmarkImportResult).toEqual({ bookmarksAdded: 1, duplicateBookmarks: 0, foldersAdded: 2, complete: true });
		const work = fixture.bookmarks[0].children.find((node: any) => node.title === "Work");
		expect(work.children[0]).toMatchObject({ title: "Nested", children: [{ title: "", url: "https://new.example/" }] });
		expect(result.browserState.bookmarks.find((item: any) => item.url === "https://new.example/")).toMatchObject({ title: "Friendly", displayMode: "icon" });
		const exported = await adapter.request({ type: "browser-export-bookmarks" }, sender);
		expect(exported.bookmarkTransfer).toMatchObject({ format: "kestrel-bookmarks", version: 1, folders: [
			{ id: "f0", name: "Work" }, { id: "f1", parentId: "f0", name: "Nested" }], bookmarks: [
			{ title: "Example", url: "https://example.com/", displayMode: "title" },
			{ title: "Friendly", url: "https://new.example/", folderId: "f1", displayMode: "icon" }] });
		const serialized = JSON.stringify(exported.bookmarkTransfer);
		for (const forbidden of ["createdAt", "dateAdded", "parentId\":\"1", "bookmark-folder-", "settings", "history", "permissions"]) expect(serialized).not.toContain(forbidden);
		expect((await apply(adapter, planned)).ok).toBe(false);
	});
	it("recovers full-mode friendly titles and rejects forged stored presentation on export", async () => {
		const { fixture, adapter } = setup(); fixture.tabs[0].url = "https://example.com/";
		await adapter.request({ type: "browser-save-bookmark", title: "Personal label", displayMode: "full" }, sender);
		expect(fixture.bookmarks[0].children[0].title).toBe("https://example.com/");
		expect((await adapter.request({ type: "browser-export-bookmarks" }, sender)).bookmarkTransfer.bookmarks[0]).toMatchObject({ title: "Personal label", displayMode: "full" });
		fixture.bookmarks[0].children[0].title = "External label";
		expect((await adapter.request({ type: "browser-export-bookmarks" }, sender)).bookmarkTransfer.bookmarks[0]).toMatchObject({ title: "External label", displayMode: "title" });
	});
	it("deduplicates normalized URLs across native and incoming records without overwriting labels or merging folders", async () => {
		const { fixture, adapter } = setup();
		fixture.bookmarks[0].children.push({ id: "same-name", parentId: "1", title: "Work", children: [] });
		const value: any = data();
		value.bookmarks.unshift({ url: "HTTPS://EXAMPLE.COM:443", title: "Overwrite attempt", displayMode: "icon" });
		value.bookmarks.push({ ...value.bookmarks[1], url: "https://NEW.example:443/", title: "Duplicate" });
		const planned = await preview(adapter, value);
		expect(planned.bookmarkImportPlan.summary).toEqual({ bookmarksToAdd: 1, duplicateBookmarks: 2, foldersToAdd: 2 });
		const result = await apply(adapter, planned);
		expect(result.bookmarkImportResult).toMatchObject({ bookmarksAdded: 1, duplicateBookmarks: 2, foldersAdded: 2, complete: true });
		expect(fixture.bookmarks[0].children.find((node: any) => node.id === "2").title).toBe("Example");
		expect(fixture.bookmarks[0].children.filter((node: any) => node.title === "Work")).toHaveLength(2);
		expect(fixture.bookmarks[0].children.find((node: any) => node.id === "same-name").children).toEqual([]);
	});
	it("creates folders only beneath the selected writable destination", async () => {
		const { fixture, adapter } = setup();
		const folder = await adapter.request({ type: "browser-create-bookmark-folder", name: "Destination" }, sender);
		const result = await apply(adapter, await preview(adapter, data(), { destinationFolderId: folder.bookmarkFolderId }));
		expect(result.bookmarkImportResult.complete).toBe(true);
		expect(fixture.bookmarks[0].children.find((node: any) => node.title === "Destination").children[0].title).toBe("Work");
	});
	it("refuses a destination that would make the resulting hierarchy exceed eight levels", async () => {
		const { fixture, adapter } = setup();
		const destination = await adapter.request({ type: "browser-create-bookmark-folder", name: "Destination" }, sender);
		const value: any = data(); value.bookmarks = [];
		value.folders = Array.from({ length: 8 }, (_, i) => ({ id: `f${i}`, name: `Level ${i}`, ...(i ? { parentId: `f${i - 1}` } : {}) }));
		fixture.chrome.bookmarks.create.mockClear();
		expect(await preview(adapter, value, { destinationFolderId: destination.bookmarkFolderId })).toMatchObject({ ok: false, error: expect.stringContaining("eight folder levels") });
		expect(fixture.chrome.bookmarks.create).not.toHaveBeenCalled();
	});
	it.each(["native", "presentation", "destination"])("refuses stale %s snapshots without mutations and consumes the plan", async kind => {
		const { fixture, adapter } = setup();
		const folder = await adapter.request({ type: "browser-create-bookmark-folder", name: "Destination" }, sender);
		const planned = await preview(adapter, data(), { destinationFolderId: folder.bookmarkFolderId });
		fixture.chrome.bookmarks.create.mockClear();
		if (kind === "native") fixture.bookmarks[0].children[0].title = "External edit";
		if (kind === "presentation") fixture.storage["kestrel.native.browser.bookmarkModes.v1"] = { changed: { title: "External" } };
		if (kind === "destination") fixture.bookmarks[0].children.find((node: any) => node.title === "Destination").unmodifiable = "managed";
		expect((await apply(adapter, planned)).ok).toBe(false);
		expect(fixture.chrome.bookmarks.create).not.toHaveBeenCalled();
		expect((await apply(adapter, planned)).ok).toBe(false);
	});
	it("invalidates plans on new preview, discard, forged apply, expiry, and worker restart", async () => {
		const { fixture, adapter } = setup();
		const first = await preview(adapter), second = await preview(adapter);
		expect((await apply(adapter, first)).ok).toBe(false);
		expect((await apply(adapter, second)).ok).toBe(false); // Forged/stale apply consumed it.
		const discarded = await preview(adapter);
		expect(await adapter.request({ type: "browser-discard-bookmark-import", planId: discarded.bookmarkImportPlan.planId }, sender)).toEqual({ ok: true });
		expect((await apply(adapter, discarded)).ok).toBe(false);
		const expired = await preview(adapter);
		const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(expired.bookmarkImportPlan.expiresAt));
		try { expect(await apply(adapter, expired)).toMatchObject({ ok: false, error: expect.stringContaining("expired") }); } finally { clock.mockRestore(); }
		const restarted = await preview(adapter);
		expect((await apply(createBrowserAdapter(fixture.chrome, { uiUrl }), restarted)).ok).toBe(false);
		expect(fixture.chrome.bookmarks.create).not.toHaveBeenCalled();
	});
	it.each(["bookmarks", "folders"])("checks combined %s capacity before creating anything", async kind => {
		const { fixture, adapter } = setup();
		if (kind === "bookmarks") for (let i = 0; i < 1999; i++) fixture.bookmarks[0].children.push({ id: `b${i}`, parentId: "1", url: `https://capacity.example/${i}`, title: "Existing" });
		else for (let i = 0; i < 99; i++) fixture.bookmarks[0].children.push({ id: `d${i}`, parentId: "1", title: "Existing", children: [] });
		expect(await preview(adapter)).toMatchObject({ ok: false, error: expect.stringContaining("exceed") });
		expect(fixture.chrome.bookmarks.create).not.toHaveBeenCalled();
	});
	it.each(["storage", "label"])("counts a native bookmark as added when its presentation %s fails", async kind => {
		const { fixture, adapter } = setup();
		const value: any = data(); value.folders = []; delete value.bookmarks[0].folderId;
		value.bookmarks.push({ url: "https://never-created.example/", title: "Never created", displayMode: "title" });
		const planned = await preview(adapter, value);
		if (kind === "storage") fixture.failStorage(); else fixture.failUpdate();
		const result = await apply(adapter, planned);
		expect(result).toMatchObject({ ok: true, bookmarkImportResult: { bookmarksAdded: 1, foldersAdded: 0, duplicateBookmarks: 0, complete: false } });
		expect(fixture.bookmarks[0].children.find((node: any) => node.url === "https://new.example/").title).toBe("Friendly");
		expect(fixture.bookmarks[0].children.some((node: any) => node.url === "https://never-created.example/")).toBe(false);
		expect((await apply(adapter, planned)).ok).toBe(false);
	});
	it("stops at a folder creation failure, preserves created folders, and performs no retry/removal", async () => {
		const { fixture, adapter } = setup(), planned = await preview(adapter);
		fixture.failAfterCreates(1);
		expect(await apply(adapter, planned)).toMatchObject({ ok: true, bookmarkImportResult: { bookmarksAdded: 0, foldersAdded: 1, complete: false } });
		expect(fixture.bookmarks[0].children.find((node: any) => node.title === "Work").children).toEqual([]);
		expect(fixture.chrome.bookmarks.create).toHaveBeenCalledTimes(2);
	});
	it("stops with accurate partial counts when an external edit appears during import", async () => {
		const { fixture, adapter } = setup(), planned = await preview(adapter);
		const create = fixture.chrome.bookmarks.create;
		fixture.chrome.bookmarks.create = vi.fn((...args: any[]) => {
			const result = create(...args);
			if (create.mock.calls.length === 1) fixture.bookmarks[0].children[0].title = "External edit";
			return result;
		});
		expect(await apply(adapter, planned)).toMatchObject({ ok: true, bookmarkImportResult: { bookmarksAdded: 0, foldersAdded: 1, complete: false } });
		expect(fixture.bookmarks[0].children[0].title).toBe("External edit");
		expect(fixture.chrome.bookmarks.create).toHaveBeenCalledTimes(1);
	});
	it("returns accurate counts even if the fresh post-import state becomes unavailable", async () => {
		const { fixture, adapter } = setup(), planned = await preview(adapter);
		const create = fixture.chrome.bookmarks.create;
		fixture.chrome.bookmarks.create = vi.fn((...args: any[]) => {
			const result = create(...args);
			if (create.mock.calls.length === 3) fixture.chrome.bookmarks.getTree = () => { throw Error("unavailable"); };
			return result;
		});
		const result = await apply(adapter, planned);
		expect(result).toMatchObject({ ok: true, bookmarkImportResult: { bookmarksAdded: 1, foldersAdded: 2, complete: false } });
		expect(result.browserState).toBeUndefined();
	});
	it("copies the validated preview payload rather than retaining mutable caller data", async () => {
		const { adapter } = setup(), value = data(), planned = await preview(adapter, value);
		value.bookmarks[0].title = "Altered after preview";
		const result = await apply(adapter, planned);
		expect(result.browserState.bookmarks.some((item: any) => item.title === "Friendly")).toBe(true);
	});
	it("serializes CRUD with apply so an intervening edit invalidates the preview", async () => {
		const { fixture, adapter } = setup(), planned = await preview(adapter);
		const changed = adapter.request({ type: "browser-create-bookmark-folder", name: "Concurrent" }, sender);
		const applied = apply(adapter, planned);
		expect((await changed).ok).toBe(true); expect((await applied).ok).toBe(false);
		expect(fixture.chrome.bookmarks.create).toHaveBeenCalledTimes(1);
	});
	it("rejects malformed data and untrusted callers for every transfer request", async () => {
		const { fixture, adapter } = setup();
		const value: any = data(); value.folders[0].parentId = "f1";
		expect((await preview(adapter, value)).ok).toBe(false);
		for (const input of [{ type: "browser-export-bookmarks" }, { type: "browser-plan-bookmark-import", data: data() },
			{ type: "browser-apply-bookmark-import", planId: crypto.randomUUID() }, { type: "browser-discard-bookmark-import", planId: crypto.randomUUID() }]) {
			expect((await adapter.request(input, { ...sender, id: "untrusted" })).ok).toBe(false);
		}
		expect(fixture.chrome.bookmarks.create).not.toHaveBeenCalled();
	});
	it("excludes managed branches and unsafe/non-HTTP URLs from the bookmark-only export", async () => {
		const { fixture, adapter } = setup();
		fixture.bookmarks[0].children.push({ id: "managed", parentId: "1", title: "Policy", unmodifiable: "managed", children: [{ id: "child", parentId: "managed", title: "Private", url: "https://policy.example/" }] },
			{ id: "file", parentId: "1", title: "Local", url: "file:///private/file" }, { id: "credential", parentId: "1", title: "Secret", url: "https://name:secret@example.com/" });
		const exported = await adapter.request({ type: "browser-export-bookmarks" }, sender);
		expect(exported.bookmarkTransfer.bookmarks).toHaveLength(1); expect(exported.bookmarkTransfer.folders).toEqual([]);
		expect(exported.bookmarkExportExcluded).toEqual({ bookmarks: 3, folders: 1 });
	});
	it.each(["overlong title", "untrimmed title", "control title", "overlong folder"])("fails the whole export rather than silently changing an %s", async kind => {
		const { fixture, adapter } = setup();
		if (kind === "overlong title") fixture.bookmarks[0].children[0].title = "a".repeat(501);
		if (kind === "untrimmed title") fixture.bookmarks[0].children[0].title = " Example ";
		if (kind === "control title") fixture.bookmarks[0].children[0].title = "Example\nlabel";
		if (kind === "overlong folder") fixture.bookmarks[0].children.push({ id: "folder", parentId: "1", title: "a".repeat(81), children: [] });
		expect(await adapter.request({ type: "browser-export-bookmarks" }, sender)).toMatchObject({ ok: false, error: expect.stringContaining("cannot be preserved") });
	});
	it("fails a deep native export with a precise representation limit", async () => {
		const { fixture, adapter } = setup(); let parent = fixture.bookmarks[0];
		for (let i = 0; i < 9; i++) { const node: any = { id: `depth${i}`, parentId: parent.id, title: "Level", children: [] }; parent.children.push(node); parent = node; }
		expect(await adapter.request({ type: "browser-export-bookmarks" }, sender)).toMatchObject({ ok: false, error: expect.stringContaining("eight folder levels") });
	});
});

describe("native first-party browser adapter", () => {
	it("returns shared-schema state with stable tab IDs, internal routes, and native collections", async () => {
		const { chrome } = makeChrome();
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		const [first, concurrent] = await Promise.all([
			adapter.request({ type: "browser-get-state" }, sender),
			adapter.request({ type: "browser-get-state" }, sender),
		]);
		expect(first.ok).toBe(true);
		const state = UserBrowserStateSchema.parse(first.browserState);
		expect(state.tabs.map((tab) => tab.url)).toEqual(["", "kestrel://settings"]);
		expect(state.tabs.map((tab) => tab.id)).toEqual(concurrent.browserState.tabs.map((tab: any) => tab.id));
		expect(new Set(state.tabs.map((tab) => tab.id)).size).toBe(2);
		expect(state.bookmarks[0]?.id).toMatch(/^bookmark-[a-f0-9-]{36}$/);
		expect(state.bookmarkFolders).toEqual([]);
		expect(state.downloads[0]?.id).toMatch(/^download-[a-f0-9-]{36}$/);
		expect(state.bookmarks[0]?.id).toBe(concurrent.browserState.bookmarks[0]?.id);
		expect(state.downloads[0]?.id).toBe(concurrent.browserState.downloads[0]?.id);
		expect(state.settingsOwnership).toBe("chromium");
	});

	it("round-trips internal routes and delegates each search to Chromium's selected provider in the exact tab", async () => {
		const { chrome, tabs } = makeChrome();
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		const initial = await adapter.request({ type: "browser-get-state" }, sender);
		const tabId = initial.browserState.tabs[0].id;
		await adapter.request({ type: "browser-navigate", tabId, input: "kestrel://settings" }, sender);
		expect(tabs[0].url).toBe(`${uiUrl}?app=settings`);
		expect((await adapter.request({ type: "browser-get-state" }, sender)).browserState.tabs[0].url).toBe("kestrel://settings");
		await adapter.request({ type: "browser-create-tab", input: "cats and dogs" }, sender);
		expect(tabs.at(-1)?.url).toBe("https://native-provider.example/search?q=cats%20and%20dogs");
		expect(chrome.search.query.mock.calls[0]?.[0]).toEqual({ text: "cats and dogs", tabId: tabs.at(-1)?.id });
		await adapter.request({ type: "browser-navigate", tabId, input: "one & two" }, sender);
		expect(tabs[0].url).toBe("https://native-provider.example/search?q=one%20%26%20two");
		expect(chrome.search.query.mock.calls[1]?.[0]).toEqual({ text: "one & two", tabId: 11 });
	});
	it("fails unavailable search before creating a tab and never substitutes a provider", async () => {
		const { chrome, tabs } = makeChrome();
		delete (chrome as any).search;
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		expect(await adapter.request({ type: "browser-create-tab", input: "private query" }, sender)).toMatchObject({ ok: false, error: expect.stringContaining("Native search is unavailable") });
		expect(tabs).toHaveLength(2);
	});

	it("handles bookmark and download actions without requiring a tab ID", async () => {
		const { chrome } = makeChrome();
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		const state = (await adapter.request({ type: "browser-get-state" }, sender)).browserState;
		expect((await adapter.request({ type: "browser-remove-bookmark", bookmarkId: state.bookmarks[0].id }, sender)).ok).toBe(true);
		expect((await adapter.request({ type: "browser-cancel-download", downloadId: state.downloads[0].id }, sender)).ok).toBe(true);
	});

	it("edits bookmarks and folders while preserving identities, display mode, and children across restart", async () => {
		const { chrome, tabs, bookmarks } = makeChrome(); tabs[0].url = "https://example.com/";
		let adapter = createBrowserAdapter(chrome, { uiUrl });
		const initial = (await adapter.request({ type: "browser-get-state" }, sender)).browserState;
		const bookmarkId = initial.bookmarks[0].id;
		const created = await adapter.request({ type: "browser-create-bookmark-folder", name: "Work" }, sender);
		expect(created.ok).toBe(true); const folderId = created.bookmarkFolderId;
		expect((await adapter.request({ type: "browser-save-bookmark", title: "Edited", displayMode: "icon", folderId }, sender)).ok).toBe(true);
		let state = (await adapter.request({ type: "browser-get-state" }, sender)).browserState;
		expect(state.bookmarks).toHaveLength(1); expect(state.bookmarks[0]).toMatchObject({ id: bookmarkId, title: "Edited", displayMode: "icon", folderId });
		expect(bookmarks[0].children.find((node: any) => node.title === "Work").children[0].title).toBe("");
		expect((await adapter.request({ type: "browser-update-bookmark", bookmarkId, title: "Again", displayMode: "title" }, sender)).ok).toBe(true);
		adapter = createBrowserAdapter(chrome, { uiUrl }); state = (await adapter.request({ type: "browser-get-state" }, sender)).browserState;
		expect(state.bookmarks[0]).toMatchObject({ id: bookmarkId, title: "Again", folderId, displayMode: "title" });
		expect(bookmarks[0].children.find((node: any) => node.title === "Work").children[0].title).toBe("Again");
		expect((await adapter.request({ type: "browser-update-bookmark", bookmarkId, title: "Again", displayMode: "title", folderId: null }, sender)).ok).toBe(true);
		expect((await adapter.request({ type: "browser-get-state" }, sender)).browserState.bookmarks[0].folderId).toBeUndefined();
		expect((await adapter.request({ type: "browser-update-bookmark", bookmarkId, title: "Again", displayMode: "title", folderId }, sender)).ok).toBe(true);
		expect((await adapter.request({ type: "browser-rename-bookmark-folder", folderId, name: "Renamed" }, sender)).ok).toBe(true);
		expect((await adapter.request({ type: "browser-remove-bookmark-folder", folderId }, sender)).ok).toBe(true);
		state = (await adapter.request({ type: "browser-get-state" }, sender)).browserState;
		expect(state.bookmarks[0]).toMatchObject({ id: bookmarkId, displayMode: "title" }); expect(state.bookmarks[0].folderId).toBeUndefined();
		expect(bookmarks[0].children.some((node: any) => node.id === "2")).toBe(true);
		expect((await adapter.request({ type: "browser-update-bookmark", bookmarkId, title: "Root", displayMode: "full", folderId: null }, sender)).ok).toBe(true);
		expect(bookmarks[0].children.find((node: any) => node.id === "2").title).toBe("https://example.com/");
		state = (await createBrowserAdapter(chrome, { uiUrl }).request({ type: "browser-get-state" }, sender)).browserState;
		expect(state.bookmarks[0]).toMatchObject({ title: "Root", displayMode: "full" });
		bookmarks[0].children.find((node: any) => node.id === "2").title = "External edit";
		state = (await adapter.request({ type: "browser-get-state" }, sender)).browserState;
		expect(state.bookmarks[0]).toMatchObject({ title: "External edit", displayMode: "title" });
		expect((await adapter.request({ type: "browser-rename-bookmark-folder", folderId, name: "Stale" }, sender)).ok).toBe(false);
	});
	it("refuses permanent roots and preserves children when a folder move fails", async () => {
		const fixture = makeChrome(), adapter = createBrowserAdapter(fixture.chrome, { uiUrl });
		const created = await adapter.request({ type: "browser-create-bookmark-folder", name: "Work" }, sender), folderId = created.bookmarkFolderId;
		const state = (await adapter.request({ type: "browser-get-state" }, sender)).browserState;
		expect((await adapter.request({ type: "browser-update-bookmark", bookmarkId: state.bookmarks[0].id, title: "Example", displayMode: "full", folderId }, sender)).ok).toBe(true);
		const ids = fixture.storage["kestrel.native.browser.bookmarkIds.v1"] as Record<string, string>;
		const rootId = "bookmark-folder-00000000-0000-4000-8000-000000000000"; ids["folder:1"] = rootId;
		expect((await adapter.request({ type: "browser-remove-bookmark-folder", folderId: rootId }, sender)).ok).toBe(false);
		fixture.failMove();
		expect((await adapter.request({ type: "browser-remove-bookmark-folder", folderId }, sender)).ok).toBe(false);
		const after = (await adapter.request({ type: "browser-get-state" }, sender)).browserState;
		expect(after.bookmarks[0]).toMatchObject({ folderId }); expect(after.bookmarkFolders.some((item: any) => item.id === folderId)).toBe(true);
		expect((await adapter.request({ type: "browser-create-bookmark-folder", name: "No" }, { ...sender, id: "untrusted" })).ok).toBe(false);
	});
	it("keeps all child bookmarks when a folder removal stops after a partial move", async () => {
		const fixture = makeChrome(), adapter = createBrowserAdapter(fixture.chrome, { uiUrl });
		const created = await adapter.request({ type: "browser-create-bookmark-folder", name: "Work" }, sender);
		const folderId = created.bookmarkFolderId;
		fixture.tabs[0].url = "https://first.example/";
		await adapter.request({ type: "browser-save-bookmark", title: "First", displayMode: "full", folderId }, sender);
		fixture.tabs[0].url = "https://second.example/";
		await adapter.request({ type: "browser-save-bookmark", title: "Second", displayMode: "full", folderId }, sender);
		fixture.failAfterMoves(1);
		const result = await adapter.request({ type: "browser-remove-bookmark-folder", folderId }, sender);
		expect(result).toMatchObject({ ok: false, error: expect.stringContaining("incomplete") });
		const after = (await adapter.request({ type: "browser-get-state" }, sender)).browserState;
		expect(after.bookmarks.map((item: any) => item.title)).toEqual(expect.arrayContaining(["First", "Second"]));
		expect(after.bookmarkFolders.some((folder: any) => folder.id === folderId)).toBe(true);
	});
	it("does not move a child that another actor moved out during folder removal", async () => {
		const fixture = makeChrome(), adapter = createBrowserAdapter(fixture.chrome, { uiUrl });
		const created = await adapter.request({ type: "browser-create-bookmark-folder", name: "Work" }, sender), folderId = created.bookmarkFolderId;
		fixture.tabs[0].url = "https://first.example/"; await adapter.request({ type: "browser-save-bookmark", title: "First", displayMode: "full", folderId }, sender);
		fixture.tabs[0].url = "https://second.example/"; await adapter.request({ type: "browser-save-bookmark", title: "Second", displayMode: "full", folderId }, sender);
		const folder = fixture.bookmarks[0].children.find((item: any) => item.title === "Work");
		const outside = { id: "outside", parentId: "1", title: "Outside", children: [] as any[] }; fixture.bookmarks[0].children.push(outside);
		fixture.afterMove(() => { const child = folder.children.find((item: any) => item.url === "https://second.example/"); if (child) { folder.children = folder.children.filter((item: any) => item !== child); child.parentId = outside.id; outside.children.push(child); } });
		const result = await adapter.request({ type: "browser-remove-bookmark-folder", folderId }, sender);
		expect(result).toMatchObject({ ok: false, error: expect.stringContaining("incomplete") });
		expect(outside.children.map(item => item.url)).toEqual(["https://second.example/"]);
		expect(fixture.bookmarks[0].children).toContain(folder);
	});
	it.each([null, []])("ignores malformed display metadata during state reads", async value => {
		const fixture = makeChrome(); fixture.storage["kestrel.native.browser.bookmarkModes.v1"] = value;
		const result = await createBrowserAdapter(fixture.chrome, { uiUrl }).request({ type: "browser-get-state" }, sender);
		expect(result.ok).toBe(true); expect(result.browserState.bookmarks[0].displayMode).toBe("title");
	});
	it("broadcasts the persisted display mode before completing a bookmark edit", async () => {
		const fixture = makeChrome(); fixture.tabs[0].url = "https://example.com/";
		const emitted: any[] = [];
		const adapter = createBrowserAdapter(fixture.chrome, { uiUrl, emit: (_channel: string, event: any) => emitted.push(event) });
		const before = (await adapter.request({ type: "browser-get-state" }, sender)).browserState;
		fixture.handlers.get("bookmark-changed")?.();
		const result = await adapter.request({ type: "browser-update-bookmark", bookmarkId: before.bookmarks[0].id, title: "Example", displayMode: "icon" }, sender);
		expect(result.ok).toBe(true);
		expect(result.browserState.bookmarks[0].displayMode).toBe("icon");
		expect(emitted.at(-1).state.bookmarks[0].displayMode).toBe("icon");
		fixture.bookmarks[0].children[0].title = "External";
		fixture.storage["kestrel.native.browser.bookmarkModes.v1"] = { "2": { mode: "title", title: "External", dateAdded: fixture.bookmarks[0].children[0].dateAdded } };
		fixture.handlers.get("storage-changed")?.({ "kestrel.native.browser.bookmarkModes.v1": {} }, "local");
		await vi.waitFor(() => expect(emitted.at(-1).state.bookmarks[0].displayMode).toBe("title"));
	});
	it("reports uncertain results when display mode storage fails after a mutation", async () => {
		const fixture = makeChrome(), adapter = createBrowserAdapter(fixture.chrome, { uiUrl });
		fixture.tabs[0].url = "https://example.com/"; fixture.failStorage();
		const result = await adapter.request({ type: "browser-save-bookmark", title: "Changed", displayMode: "icon" }, sender);
		expect(result).toMatchObject({ ok: false, error: expect.stringContaining("incomplete") });
		expect(fixture.bookmarks[0].children[0].title).toBe("Example");
	});
	it("keeps a new bookmark friendly title when presentation storage fails", async () => {
		const fixture = makeChrome(), adapter = createBrowserAdapter(fixture.chrome, { uiUrl });
		fixture.tabs[0].url = "https://new.example/"; fixture.failStorage();
		const result = await adapter.request({ type: "browser-save-bookmark", title: "Friendly", displayMode: "icon" }, sender);
		expect(result).toMatchObject({ ok: false, error: expect.stringContaining("result may be incomplete") });
		expect(fixture.bookmarks[0].children.find((item: any) => item.url === "https://new.example/").title).toBe("Friendly");
	});
	it("refuses a new folder before creating at capacity, while allowing rename and removal", async () => {
		const fixture = makeChrome();
		for (let i = 0; i < 100; i++) fixture.bookmarks[0].children.push({ id: `folder-${i}`, parentId: "1", title: `Folder ${i}`, children: [] });
		const adapter = createBrowserAdapter(fixture.chrome, { uiUrl });
		let state = (await adapter.request({ type: "browser-get-state" }, sender)).browserState;
		expect(state.bookmarkFolders).toHaveLength(100);
		expect(await adapter.request({ type: "browser-create-bookmark-folder", name: "Too many" }, sender)).toMatchObject({ ok: false, error: "Kestrel supports up to 100 bookmark folders." });
		expect(fixture.chrome.bookmarks.create).not.toHaveBeenCalled();
		const folderId = state.bookmarkFolders[0].id;
		expect((await adapter.request({ type: "browser-rename-bookmark-folder", folderId, name: "Renamed" }, sender)).ok).toBe(true);
		expect((await adapter.request({ type: "browser-remove-bookmark-folder", folderId }, sender)).ok).toBe(true);
		state = (await adapter.request({ type: "browser-get-state" }, sender)).browserState; expect(state.bookmarkFolders).toHaveLength(99);
	});
	it("refuses new bookmarks before creating at capacity but permits editing and removal", async () => {
		const fixture = makeChrome();
		for (let i = 0; i < 1999; i++) fixture.bookmarks[0].children.push({ id: `item-${i}`, parentId: "1", title: `Item ${i}`, url: `https://example.com/${i}` });
		const adapter = createBrowserAdapter(fixture.chrome, { uiUrl });
		const state = (await adapter.request({ type: "browser-get-state" }, sender)).browserState;
		expect(state.bookmarks).toHaveLength(2000);
		fixture.tabs[0].url = "https://new.example/";
		expect(await adapter.request({ type: "browser-save-bookmark", title: "New", displayMode: "full" }, sender)).toMatchObject({ ok: false, error: "Kestrel supports up to 2,000 bookmarks." });
		expect((await adapter.request({ type: "browser-toggle-bookmark" }, sender)).ok).toBe(false);
		expect(fixture.chrome.bookmarks.create).not.toHaveBeenCalled();
		fixture.tabs[0].url = "https://example.com/";
		expect((await adapter.request({ type: "browser-save-bookmark", title: "Changed", displayMode: "icon" }, sender)).ok).toBe(true);
		expect((await adapter.request({ type: "browser-update-bookmark", bookmarkId: state.bookmarks[0].id, title: "Changed again", displayMode: "title" }, sender)).ok).toBe(true);
		expect((await adapter.request({ type: "browser-remove-bookmark", bookmarkId: state.bookmarks[0].id }, sender)).ok).toBe(true);
	});
	it("prunes deleted bookmark identity and mode metadata without removing root IDs", async () => {
		const fixture = makeChrome(), adapter = createBrowserAdapter(fixture.chrome, { uiUrl });
		fixture.tabs[0].url = "https://example.com/";
		await adapter.request({ type: "browser-save-bookmark", title: "Example", displayMode: "icon" }, sender);
		const state = (await adapter.request({ type: "browser-get-state" }, sender)).browserState;
		const ids = fixture.storage["kestrel.native.browser.bookmarkIds.v1"] as Record<string, string>;
		ids["folder:1"] = "bookmark-folder-00000000-0000-4000-8000-000000000000";
		expect((await adapter.request({ type: "browser-remove-bookmark", bookmarkId: state.bookmarks[0].id }, sender)).ok).toBe(true);
		expect(ids["2"]).toBeUndefined(); expect(ids["folder:1"]).toBeDefined();
		expect((fixture.storage["kestrel.native.browser.bookmarkModes.v1"] as Record<string, string>)["2"]).toBeUndefined();
	});
	it("serializes overlapping bookmark snapshots before pruning stable identities", async () => {
		const fixture = makeChrome();
		const getTree = vi.fn((callback: (value: unknown) => void) => {
			const snapshot = structuredClone([{ id: "0", children: fixture.bookmarks }]);
			callback(snapshot);
			return Promise.resolve(snapshot);
		});
		fixture.chrome.bookmarks.getTree = getTree;
		const originalGet = fixture.chrome.storage.local.get;
		let release: (() => void) | undefined;
		let delayed = false;
		fixture.chrome.storage.local.get = (key: string, callback: (value: unknown) => void) => {
			if (key === "kestrel.native.browser.bookmarkModes.v1" && !delayed) {
				delayed = true;
				return new Promise(resolve => { release = () => { const value = { [key]: fixture.storage[key] }; callback(value); resolve(value); }; });
			}
			return originalGet(key, callback);
		};
		const historySearch = vi.fn(fixture.chrome.history.search);
		fixture.chrome.history.search = historySearch;
		const adapter = createBrowserAdapter(fixture.chrome, { uiUrl });
		const older = adapter.request({ type: "browser-get-state" }, sender);
		await vi.waitFor(() => expect(release).toBeDefined());
		fixture.bookmarks[0].children.push({ id: "new", parentId: "1", title: "New", url: "https://new.example/", dateAdded: Date.now() });
		const newer = adapter.request({ type: "browser-get-state" }, sender);
		try {
			await vi.waitFor(() => expect(historySearch).toHaveBeenCalledTimes(2));
			expect(getTree).toHaveBeenCalledTimes(1);
		} finally { release?.(); }
		await older;
		const newState = (await newer).browserState;
		const id = newState.bookmarks.find((item: any) => item.url === "https://new.example/").id;
		const later = (await adapter.request({ type: "browser-get-state" }, sender)).browserState;
		expect(later.bookmarks.find((item: any) => item.url === "https://new.example/").id).toBe(id);
	});
	it("rejects unsafe bookmark URLs and invalid names", async () => {
		const { chrome, tabs } = makeChrome(), adapter = createBrowserAdapter(chrome, { uiUrl });
		for (const url of ["https://user:secret@example.com/", "https:garbage", "javascript:alert(1)"]) {
			tabs[0].url = url; expect((await adapter.request({ type: "browser-save-bookmark", title: "test", displayMode: "full" }, sender)).ok).toBe(false);
		}
		expect((await adapter.request({ type: "browser-create-bookmark-folder", name: "bad\nname" }, sender)).ok).toBe(false);
	});

	it("persists Kestrel Home changes while rejecting unapplied Chromium preferences", async () => {
		const { chrome, storage } = makeChrome();
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		const original = (await adapter.request({ type: "browser-get-state" }, sender)).browserState.settings;
		const homeSettings = { ...original, newTabBackground: "paper" };
		expect((await adapter.request({ type: "browser-update-settings", settings: homeSettings }, sender)).ok).toBe(true);
		const after = UserBrowserStateSchema.parse((await adapter.request({ type: "browser-get-state" }, sender)).browserState);
		expect(after.settings.newTabBackground).toBe("paper");
		expect((await adapter.request({ type: "browser-update-settings", settings: { ...after.settings, searchEngine: "bing" } }, sender)).ok).toBe(false);
		expect((await adapter.request({ type: "browser-get-state" }, sender)).browserState.settings.searchEngine).toBe(original.searchEngine);
		const image = "data:image/png;base64,aGVsbG8=";
		expect((await adapter.request({ type: "browser-update-settings", settings: { ...after.settings, newTabBackground: "custom", newTabBackgroundCustomDataUrl: image, newTabShortcuts: [{ title: "Example", url: "https://example.com/" }] } }, sender)).ok).toBe(true);
		expect(storage["kestrel.native.browser.settings.v1"]).toMatchObject({ newTabBackground: "custom", newTabBackgroundCustomDataUrl: image, newTabShortcuts: [{ title: "Example", url: "https://example.com/" }] });
		expect(storage["kestrel.native.browser.settings.v1"]).not.toHaveProperty("searchEngine");
		const restored = createBrowserAdapter(chrome, { uiUrl });
		const saved = (await restored.request({ type: "browser-get-state" }, sender)).browserState.settings;
		expect(saved.newTabBackgroundCustomDataUrl).toBe(image);
		expect((await restored.request({ type: "browser-update-settings", settings: { ...saved, newTabBackground: "graphite", newTabBackgroundCustomDataUrl: undefined } }, sender)).ok).toBe(true);
		expect((await restored.request({ type: "browser-get-state" }, sender)).browserState.settings).not.toHaveProperty("newTabBackgroundCustomDataUrl");
	});

	it("limits privileged navigation to native settings pages", async () => {
		const { chrome, tabs } = makeChrome();
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		for (const input of NATIVE_BROWSER_SETTINGS_URLS) {
			expect((await adapter.request({ type: "browser-create-tab", input }, sender)).ok).toBe(true);
			expect(tabs.at(-1)?.url).toBe(input);
		}
		for (const input of ["chrome://flags/", "chrome://settings/?injected=1", "chrome://settings/../flags", "chrome://settings/search#extra", "file:///Users/test/private", "javascript:alert(1)", "https://user:password@example.com/"]) {
			expect((await adapter.request({ type: "browser-create-tab", input }, sender)).ok).toBe(false);
		}
	});
	it("opens an OS link in the existing normal browser window and rejects privileged or credentialed input", async () => {
		const { chrome, tabs } = makeChrome();
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		const result = await adapter.openExternalUrl("https://example.com/from-system?q=1#part");
		expect(result).toMatchObject({ tabId: expect.any(Number), windowId: 7 });
		expect(tabs.at(-1)).toMatchObject({ windowId: 7, active: true, url: "https://example.com/from-system?q=1#part" });
		const count = tabs.length;
		for (const value of ["a search", "example.com", "chrome://settings/", "kestrel://settings", "https://user:secret@example.com/", "https://example.com/\n", "https://example.com/" + "x".repeat(8192)])
			await expect(adapter.openExternalUrl(value)).rejects.toThrow();
		expect(tabs).toHaveLength(count);
	});
	it("keeps restored Home duplicates and public tabs while removing only the owned marker", async () => {
		const { chrome, tabs } = makeChrome();
		tabs.splice(0);
		const originalCreate = chrome.windows.create;
		chrome.windows.create = vi.fn((properties: any, callback: any) => {
			expect(properties.url).toMatch(/^about:blank#kestrel-window-[a-f0-9-]+$/);
			const result = originalCreate(properties, callback);
			tabs.push({ id: 201, windowId: 8, active: false, status: "complete", title: "Restored Home", url: uiUrl });
			tabs.push({ id: 202, windowId: 8, active: false, status: "complete", title: "Another Home", url: uiUrl });
			tabs.push({ id: 203, windowId: 8, active: false, status: "complete", title: "Website", url: "https://example.com/" });
			tabs.push({ id: 204, windowId: 8, active: false, status: "complete", title: "Blank", url: "about:blank" });
			return result;
		}) as any;
		const result = await createBrowserAdapter(chrome, { uiUrl }).openNativeWindow();
		expect(result).toEqual({ windowId: 8, tabId: 201 });
		expect(chrome.windows.create).toHaveBeenCalledOnce();
		expect(tabs.map(tab => tab.id)).toEqual([201, 202, 203, 204]);
		expect(tabs[0].active).toBe(true);
	});

	it("converts only the owned marker when no Home is restored", async () => {
		const { chrome, tabs } = makeChrome();
		tabs.splice(0);
		vi.useFakeTimers();
		try {
			const originalCreate = chrome.windows.create;
			chrome.windows.create = vi.fn((properties: any, callback: any) => {
				const result = originalCreate(properties, callback);
				tabs.push({ id: 201, windowId: 8, active: false, status: "complete", title: "Blank", url: "about:blank" });
				return result;
			}) as any;
			const opening = createBrowserAdapter(chrome, { uiUrl }).openNativeWindow();
			await vi.runAllTimersAsync();
			expect(await opening).toEqual({ windowId: 8, tabId: 100 });
			expect(tabs.map(tab => tab.url)).toEqual([uiUrl, "about:blank"]);
			expect(chrome.windows.create).toHaveBeenCalledOnce();
		} finally { vi.useRealTimers(); }
	});

	it("leaves a marker that a user navigated untouched and reports uncertainty", async () => {
		const { chrome, tabs } = makeChrome();
		tabs.splice(0);
		const originalCreate = chrome.windows.create;
		chrome.windows.create = ((properties: any, callback: any) => {
			const result = originalCreate(properties, callback);
			tabs.push({ id: 201, windowId: 8, active: false, status: "complete", title: "Home", url: uiUrl });
			return result;
		}) as any;
		const originalGet = chrome.tabs.get;
		chrome.tabs.get = ((id: number, callback: any) => {
			if (id === 100) tabs.find(tab => tab.id === 100)!.url = "https://example.com/changed";
			return originalGet(id, callback);
		}) as any;
		await expect(createBrowserAdapter(chrome, { uiUrl }).openNativeWindow()).rejects.toThrow(/changed.*Check Kestrel/);
		expect(tabs.map(tab => tab.url)).toEqual(["https://example.com/changed", uiUrl]);
	});

	it("does not treat a different extension or an app route as Kestrel Home", async () => {
		const { chrome, tabs } = makeChrome();
		tabs.splice(0);
		vi.useFakeTimers();
		try {
			const originalCreate = chrome.windows.create;
			chrome.windows.create = ((properties: any, callback: any) => {
				const result = originalCreate(properties, callback);
				tabs.push({ id: 201, windowId: 8, active: false, status: "complete", title: "Other extension", url: `chrome-extension://${"b".repeat(32)}/index.html` });
				tabs.push({ id: 202, windowId: 8, active: false, status: "complete", title: "Settings", url: `${uiUrl}?app=settings` });
				return result;
			}) as any;
			const opening = createBrowserAdapter(chrome, { uiUrl }).openNativeWindow();
			await vi.runAllTimersAsync();
			expect(await opening).toEqual({ windowId: 8, tabId: 100 });
			expect(tabs.map(tab => tab.id)).toEqual([100, 201, 202]);
			expect(tabs[0].url).toBe(uiUrl);
		} finally { vi.useRealTimers(); }
	});

	it("lets Chromium create the external tab without adding a duplicate Home to its restored session", async () => {
		const { chrome, tabs } = makeChrome();
		tabs.splice(0);
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		const result = await adapter.openExternalUrl("https://example.com/reopen");
		expect(result).toEqual({ windowId: 8, tabId: 100 });
		expect(tabs.map(tab => tab.url)).toEqual(["https://example.com/reopen"]);
	});
	it("keeps every document tab available without a background UI request changing actual focus", async () => {
		const { chrome, tabs } = makeChrome();
		tabs.push({ id: 13, windowId: 8, active: true, status: "complete", title: "Other window", url: "https://example.com/other" });
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		const response = await adapter.request({ type: "browser-get-state" }, { ...sender, tab: { id: 13, windowId: 8 } });
		expect(response.browserState.tabs).toHaveLength(3);
		expect(response.browserState.activeTabId).toBe(response.browserState.tabs[0].id);
		expect((await adapter.backend({ operation: "visible-tabs" }))[0]).toMatchObject({ url: "https://example.com/other", active: false });
		expect((await adapter.request({ type: "browser-select-tab", tabId: response.browserState.tabs[2].id }, sender)).ok).toBe(true);
		expect((await adapter.request({ type: "browser-get-state" }, sender)).browserState.activeTabId).toBe(response.browserState.tabs[2].id);
	});

	it("routes Core tools to exact native tabs and excludes protected UI pages", async () => {
		const { chrome, tabs } = makeChrome();
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		const initial = (await adapter.request({ type: "browser-get-state" }, sender)).browserState;
		expect(await adapter.backend({ operation: "visible-tabs" })).toEqual([]);
		const created = await Promise.all([
			adapter.backend({ operation: "visible-create", input: "https://one.example/" }),
			adapter.backend({ operation: "visible-create", input: "https://two.example/" }),
		]);
		expect(new Set(created.map((tab: any) => tab.tabId)).size).toBe(2);
		const visible = await adapter.backend({ operation: "visible-tabs" });
		expect(visible.map((tab: any) => tab.id)).toEqual(created.map((tab: any) => tab.tabId));
		expect(visible.every((tab: any) => tab.trust === "untrusted_browser")).toBe(true);
		await adapter.backend({ operation: "visible-navigate", tabId: created[0].tabId, input: "https://updated.example/" });
		expect(tabs[2].url).toBe("https://updated.example/");
		await expect(adapter.backend({ operation: "visible-close", tabId: initial.tabs[0].id })).rejects.toThrow(/protected/);
		await expect(adapter.backend({ operation: "visible-create", input: "chrome://extensions/" })).rejects.toThrow(/HTTP/);
		await expect(adapter.backend({ operation: "visible-navigate", tabId: created[0].tabId, input: "kestrel://settings" })).rejects.toThrow(/HTTP/);
		await adapter.backend({ operation: "visible-close", tabId: created[0].tabId });
		expect((await adapter.backend({ operation: "visible-tabs" })).map((tab: any) => tab.id)).toEqual([created[1].tabId]);
	});

	it("does not execute a Core operation cancelled before dispatch", async () => {
		const { chrome, tabs } = makeChrome();
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		const controller = new AbortController();
		controller.abort();
		await expect(adapter.backend({ operation: "visible-create", input: "https://one.example/" }, controller.signal)).rejects.toThrow();
		expect(tabs).toHaveLength(2);
	});

	it("pins context reads to one main document in Chrome's isolated world", async () => {
		const { chrome, tabs } = makeChrome();
		tabs[0].url = "https://example.com/page?token=private";
		const getFrame = vi.fn(async () => ({ documentId: "document-one", documentLifecycle: "active", url: tabs[0].url }));
		const executeScript = vi.fn(async (options: any) => [{ frameId: 0, documentId: "document-one", result: {
			sourceUrl: tabs[0].url, context: { tabId: options.args[0], url: "https://example.com/page", title: "Example", selectedText: "", visibleText: "Read the page",
				headings: [], links: [], forms: [], viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 }, capturedAt: new Date().toISOString(), trust: "untrusted_browser" },
		} }]);
		Object.assign(chrome, { webNavigation: { getFrame }, scripting: { executeScript } });
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		const tabId = (await adapter.backend({ operation: "visible-tabs" }))[0].id;
		const context = await adapter.backend({ operation: "visible-context", tabId });
		expect(context.url).toBe("https://example.com/page");
		expect(executeScript.mock.calls[0][0]).toMatchObject({ target: { tabId: 11, documentIds: ["document-one"] }, world: "ISOLATED", args: [tabId] });
		expect(getFrame).toHaveBeenCalledTimes(2);
		const fromUi = await adapter.request({ type: "browser-get-context", tabId }, sender);
		expect(fromUi).toMatchObject({ ok: true, browserContext: { ...context, capturedAt: expect.any(String) } });
	});

	it("discards context after same-URL navigation and fails before reading protected pages", async () => {
		const { chrome, tabs } = makeChrome();
		const executeScript = vi.fn(async () => [{ frameId: 0, documentId: "document-one", result: { sourceUrl: "https://example.com/", context: {} } }]);
		const getFrame = vi.fn().mockResolvedValueOnce({ documentId: "document-one", documentLifecycle: "active", url: "https://example.com/" })
			.mockResolvedValue({ documentId: "document-two", documentLifecycle: "active", url: "https://example.com/" });
		Object.assign(chrome, { webNavigation: { getFrame }, scripting: { executeScript } });
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		const protectedId = (await adapter.request({ type: "browser-get-state" }, sender)).browserState.tabs[0].id;
		await expect(adapter.backend({ operation: "visible-context", tabId: protectedId })).rejects.toThrow(/HTTP/);
		expect(executeScript).not.toHaveBeenCalled();
		tabs[0].url = "https://example.com/";
		await expect(adapter.backend({ operation: "visible-context", tabId: protectedId })).rejects.toThrow(/changed while/);
		expect(executeScript).toHaveBeenCalledTimes(1);
	});

	it("does not release a context read cancelled during native script execution", async () => {
		const { chrome, tabs } = makeChrome();
		tabs[0].url = "https://example.com/";
		const controller = new AbortController();
		const getFrame = vi.fn(async () => ({ documentId: "document-one", documentLifecycle: "active", url: tabs[0].url }));
		Object.assign(chrome, { webNavigation: { getFrame }, scripting: { executeScript: async () => { controller.abort(); return []; } } });
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		await expect(adapter.backend({ operation: "visible-context" }, controller.signal)).rejects.toThrow();
		expect(getFrame).toHaveBeenCalledTimes(1);
	});

	it("rejects stale tool IDs when Chrome reuses numeric tab IDs after restart", async () => {
		const { chrome, tabs, session } = makeChrome();
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		const opened = await adapter.backend({ operation: "visible-create", input: "https://before.example/" });
		for (const key of Object.keys(session)) delete session[key];
		tabs[2].url = "https://different.example/"; // Same Chrome number in a new session.
		const restarted = createBrowserAdapter(chrome, { uiUrl });
		await expect(restarted.backend({ operation: "visible-close", tabId: opened.tabId })).rejects.toThrow(/no longer open/);
		expect(tabs[2].url).toBe("https://different.example/");
		expect((await restarted.backend({ operation: "visible-tabs" }))[0].id).not.toBe(opened.tabId);
	});

	it("returns the shared installed-extension shape and rejects other extension pages", async () => {
		const { chrome } = makeChrome();
		const adapter = createBrowserAdapter(chrome, { uiUrl });
		const listed = await adapter.request({ type: "browser-list-extensions" }, sender);
		expect(InstalledExtensionSchema.parse(listed.extensions[0]).source).toBe("chrome_web_store");
		expect((await adapter.request({ type: "browser-get-state" }, { ...sender, url: `chrome-extension://${extensionId}/other.html` })).ok).toBe(false);
		expect(adapter.handles("browser-set-content-bounds")).toBe(false);
	});
});
