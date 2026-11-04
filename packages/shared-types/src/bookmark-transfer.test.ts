import { describe, expect, it } from "vitest";
import { NativeBookmarkTransferSchema, RendererRequestSchema, UserBrowserSettingsSchema, parseNativeBookmarkTransferFile } from "./contracts";

const valid = () => ({ format: "kestrel-bookmarks", version: 1, folders: [{ id: "f1", name: "Work" }],
	bookmarks: [{ url: "https://example.com/", title: "Example", folderId: "f1", displayMode: "icon" }] });

describe("portable native bookmarks", () => {
	it("accepts bounded bookmark-only data and typed preview requests", () => {
		expect(NativeBookmarkTransferSchema.parse(valid())).toEqual(valid());
		expect(RendererRequestSchema.safeParse({ type: "browser-plan-bookmark-import", data: valid() }).success).toBe(true);
		expect(RendererRequestSchema.safeParse({ type: "browser-apply-bookmark-import", planId: "00000000-0000-4000-8000-000000000000" }).success).toBe(true);
	});
	it.each([
		["unknown top-level settings", (v: any) => { v.settings = {}; }],
		["native folder identity", (v: any) => { v.folders[0].id = "bookmark-folder-00000000-0000-4000-8000-000000000000"; }],
		["native bookmark identity", (v: any) => { v.bookmarks[0].id = "123"; }],
		["timestamp", (v: any) => { v.bookmarks[0].createdAt = new Date().toISOString(); }],
		["credentials", (v: any) => { v.bookmarks[0].url = "https://name:secret@example.com/"; }],
		["file URL", (v: any) => { v.bookmarks[0].url = "file:///private/file"; }],
		["URL control", (v: any) => { v.bookmarks[0].url = "https://exam\nple.com/"; }],
		["untrimmed title", (v: any) => { v.bookmarks[0].title = " Example "; }],
		["blank title", (v: any) => { v.bookmarks[0].title = ""; }],
		["title control", (v: any) => { v.bookmarks[0].title = "bad\tname"; }],
		["unknown mode", (v: any) => { v.bookmarks[0].displayMode = "other"; }],
		["duplicate folder IDs", (v: any) => { v.folders.push({ ...v.folders[0] }); }],
		["missing bookmark parent", (v: any) => { v.bookmarks[0].folderId = "f2"; }],
		["missing folder parent", (v: any) => { v.folders[0].parentId = "f2"; }],
		["self cycle", (v: any) => { v.folders[0].parentId = "f1"; }],
		["two-node cycle", (v: any) => { v.folders[0].parentId = "f2"; v.folders.push({ id: "f2", parentId: "f1", name: "Loop" }); }],
		["folder capacity", (v: any) => { v.folders = Array.from({ length: 101 }, (_, i) => ({ id: `f${i}`, name: "Folder" })); }],
		["bookmark capacity", (v: any) => { v.bookmarks = Array.from({ length: 2001 }, () => ({ ...v.bookmarks[0] })); }],
		["UTF8 byte capacity", (v: any) => { v.bookmarks = Array.from({ length: 600 }, () => ({ ...v.bookmarks[0], title: "界".repeat(500) })); }],
	])("rejects %s", (_name, mutate) => {
		const value = valid(); mutate(value); expect(NativeBookmarkTransferSchema.safeParse(value).success).toBe(false);
	});
	it("allows eight folder levels and rejects nine", () => {
		const value: any = valid();
		value.folders = Array.from({ length: 8 }, (_, i) => ({ id: `f${i}`, name: "Folder", ...(i ? { parentId: `f${i - 1}` } : {}) }));
		expect(NativeBookmarkTransferSchema.safeParse(value).success).toBe(true);
		value.folders.push({ id: "f8", name: "Too deep", parentId: "f7" });
		expect(NativeBookmarkTransferSchema.safeParse(value).success).toBe(false);
	});
	it("rejects forged apply parameters and file payloads on an apply request", () => {
		for (const input of [{ type: "browser-apply-bookmark-import", planId: "forged" },
			{ type: "browser-apply-bookmark-import", planId: "00000000-0000-4000-8000-000000000000", data: valid() },
			{ type: "browser-plan-bookmark-import", data: valid(), destinationFolderId: null }]) {
			expect(RendererRequestSchema.safeParse(input).success).toBe(false);
		}
	});
});

describe("bookmark-only extraction from prior Electron browser exports", () => {
	const legacy = () => ({ format: "kestrel-browser-data", version: 1, exportedAt: "2026-01-01T00:00:00Z",
		bookmarkFolders: [{ id: "bookmark-folder-00000000-0000-4000-8000-000000000001", name: "Work", createdAt: "2025-01-01T00:00:00Z" }],
		bookmarks: [{ id: "bookmark-00000000-0000-4000-8000-000000000002", title: "Friendly", url: "https://example.com/", displayMode: "icon",
			folderId: "bookmark-folder-00000000-0000-4000-8000-000000000001", createdAt: "2025-02-01T00:00:00Z" }],
		history: [{ id: "visit-00000000-0000-4000-8000-000000000003", tabId: "tab-00000000-0000-4000-8000-000000000004", url: "https://history.example/", title: "History", visitedAt: "2025-01-01T00:00:00Z" }],
		sitePermissions: [{ origin: "https://example.com", permission: "camera", decision: "allow", updatedAt: "2025-01-01T00:00:00Z" }],
		settings: UserBrowserSettingsSchema.parse({}) });
	it("remaps folder identities, preserves presentation, and explicitly describes all excluded legacy categories", () => {
		const parsed = parseNativeBookmarkTransferFile(legacy());
		expect(parsed).toEqual({ source: "browser-data", data: { format: "kestrel-bookmarks", version: 1,
			folders: [{ id: "f0", name: "Work" }], bookmarks: [{ url: "https://example.com/", title: "Friendly", displayMode: "icon", folderId: "f0" }] },
			excluded: { history: 1, sitePermissions: 1, settings: true, bookmarkDates: true } });
		for (const forbidden of ["createdAt", "exportedAt", "bookmark-folder-", "history.example", "camera"]) expect(JSON.stringify(parsed.data)).not.toContain(forbidden);
	});
	it("accepts native files with no excluded legacy categories and supplies legacy missing display modes", () => {
		expect(parseNativeBookmarkTransferFile(valid())).toEqual({ source: "native", data: valid(), excluded: { history: 0, sitePermissions: 0, settings: false, bookmarkDates: false } });
		const value: any = legacy(); delete value.bookmarks[0].displayMode;
		expect(parseNativeBookmarkTransferFile(value).data.bookmarks[0]!.displayMode).toBe("title");
	});
	it.each([
		["wrong legacy version", (v: any) => { v.version = 2; }],
		["invalid required settings", (v: any) => { v.settings.startupBehavior = "unknown"; }],
		["credentialed bookmark", (v: any) => { v.bookmarks[0].url = "https://name:secret@example.com/"; }],
		["unknown top-level fields", (v: any) => { v.cookies = []; }],
		["unknown nested bookmark fields", (v: any) => { v.bookmarks[0].token = "secret"; }],
		["unknown nested settings fields", (v: any) => { v.settings.password = "secret"; }],
		["dangling folder", (v: any) => { v.bookmarks[0].folderId = "bookmark-folder-00000000-0000-4000-8000-000000000099"; }],
		["duplicate folder identity", (v: any) => { v.bookmarkFolders.push({ ...v.bookmarkFolders[0] }); }],
		["invalid history even though excluded", (v: any) => { v.history[0].visitedAt = "bad date"; }],
	])("rejects %s", (_name, mutate) => {
		const value = legacy(); mutate(value); expect(() => parseNativeBookmarkTransferFile(value)).toThrow();
	});
});
