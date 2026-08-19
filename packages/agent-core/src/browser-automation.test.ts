import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { describe, expect, it } from "vitest";
import {
	type BrowserAction,
	type BrowserAutomationBackend,
	BrowserController,
	installBrowserTools,
	type ScreenshotFrame,
	VisualValidator,
} from "./browser-automation";
import { AgentRuntime } from "./runtime";

class FakeBrowser implements BrowserAutomationBackend {
	actions: BrowserAction[] = [];
	viewport?: { name: string; width: number; height: number };
	uploaded: string[] = [];
	desktopActions: Array<{ type: string }> = [];
	visibleActions: BrowserAction[] = [];
	readonly visibleTabId = "tab-00000000-0000-4000-8000-000000000000";
	async createSession(input: {
		allowedOrigins: string[];
		isolated: true;
	}): Promise<string> {
		expect(input.isolated).toBe(true);
		return "backend-1";
	}
	async navigate(_id: string, _url: string): Promise<void> {}
	async act(_id: string, action: BrowserAction): Promise<void> {
		this.actions.push(action);
	}
	async snapshot(): Promise<{
		url: string;
		title: string;
		accessibilityTree: unknown;
	}> {
		return {
			url: "https://example.test/",
			title: "Example",
			accessibilityTree: { role: "document" },
		};
	}
	async screenshot(): Promise<ScreenshotFrame> {
		return { width: 1, height: 1, rgba: Uint8Array.from([0, 0, 0, 255]) };
	}
	async setViewport(
		_id: string,
		viewport: { name: string; width: number; height: number },
	): Promise<void> {
		this.viewport = viewport;
	}
	async diagnostics(): Promise<
		Array<{
			kind: "console";
			level: "error";
			message: string;
			timestamp: string;
		}>
	> {
		return [
			{
				kind: "console",
				level: "error",
				message: "render failed",
				timestamp: "2026-07-22T23:00:00.000Z",
			},
		];
	}
	async upload(_id: string, _selector: string, paths: string[]): Promise<void> {
		this.uploaded = paths;
	}
	async downloads(): Promise<
		Array<{
			id: string;
			filename: string;
			bytes: number;
			status: "completed";
			createdAt: string;
		}>
	> {
		return [
			{
				id: "download-1",
				filename: "report.pdf",
				bytes: 100,
				status: "completed",
				createdAt: "2026-07-22T23:00:00.000Z",
			},
		];
	}
	async desktopScreenshot(): Promise<ScreenshotFrame> {
		return {
			width: 1,
			height: 1,
			rgba: Uint8Array.from([0, 0, 0, 255]),
			png: Uint8Array.from([137, 80, 78, 71]),
		};
	}
	async desktopAct(action: { type: string }): Promise<void> {
		this.desktopActions.push(action);
	}
	async visibleTabs() {
		return [
			{
				id: this.visibleTabId,
				title: "Visible",
				url: "https://example.test/",
				active: true,
				loading: false,
				discarded: false,
				trust: "untrusted_browser" as const,
			},
		];
	}
	async visibleContext() {
		return {
			tabId: this.visibleTabId,
			url: "https://example.test/",
			title: "Visible",
			selectedText: "",
			visibleText: "Visible page",
			headings: ["Visible"],
			links: [],
			forms: [],
			viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
			capturedAt: "2026-08-11T12:00:00.000Z",
			trust: "untrusted_browser" as const,
		};
	}
	async visibleSnapshot() {
		return {
			url: "https://example.test/",
			title: "Visible",
			accessibilityTree: { role: "document" },
			trust: "untrusted_browser" as const,
		};
	}
	async visibleScreenshot() {
		return {
			width: 1,
			height: 1,
			rgba: Uint8Array.from([0, 0, 0, 255]),
			png: Uint8Array.from([137, 80, 78, 71]),
		};
	}
	async visibleHistory() {
		return {
			entries: [
				{
					id: "visit-00000000-0000-4000-8000-000000000000",
					tabId: this.visibleTabId,
					url: "https://example.test/notes",
					title: "Research notes",
					visitedAt: "2026-08-11T12:00:00.000Z",
				},
			],
			trust: "untrusted_browser" as const,
		};
	}
	async visibleDownloads() {
		return {
			downloads: [
				{
					id: "download-00000000-0000-4000-8000-000000000000",
					tabId: this.visibleTabId,
					filename: "notes.pdf",
					sourceUrl: "https://example.test/notes.pdf",
					receivedBytes: 100,
					totalBytes: 100,
					status: "completed" as const,
					startedAt: "2026-08-11T12:00:00.000Z",
					completedAt: "2026-08-11T12:00:01.000Z",
					canReveal: true,
				},
			],
			trust: "untrusted_browser" as const,
		};
	}
	async visibleAct(_tabId: string, action: BrowserAction) {
		this.visibleActions.push(action);
	}
	async visibleNavigate() {}
	async visibleCreate() {
		return { tabId: this.visibleTabId };
	}
	async visibleClose() {}
	async visibleSelect() {}
	async close(): Promise<void> {}
}

describe("isolated browser automation and visual validation", () => {
	it("accepts only HTTPS or exact loopback HTTP browser origins", async () => {
		const controller = new BrowserController(new FakeBrowser());
		for (const allowed of [
			"https://example.test",
			"http://localhost:4173",
			"http://127.0.0.1:4173",
			"http://[::1]:4173",
		])
			await expect(
				controller.create("owner", [allowed]),
			).resolves.toMatchObject({
				browserSessionId: expect.any(String),
			});
		for (const rejected of [
			"file://127.0.0.1/etc/hosts",
			"data://localhost/text/plain,private",
			"ftp://localhost/private",
			"ws://localhost/socket",
			"not-a-url",
			"http://localhost.evil.example",
			"https://user:secret@example.test",
		])
			await expect(controller.create("owner", [rejected])).rejects.toThrow(
				"must use HTTPS",
			);
	});

	it("scopes sessions and origins and approval-gates computer actions", async () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const root = mkdtempSync(join(tmpdir(), "kestrel-browser-workspace-"));
		writeFileSync(join(root, "upload.txt"), "safe");
		const backend = new FakeBrowser();
		const controller = new BrowserController(backend);
		const runtime = new AgentRuntime(database, [root]);
		const session = runtime.createSession({
			title: "Browser",
			workspaceRoot: root,
		});
		installBrowserTools(runtime, controller, session.id);
		expect(
			runtime
				.discoverTools(session.id)
				.find((tool) => tool.name === "browser.act")?.description,
		).toContain("snapshot ref like e12");
		const created = await runtime.callTool(
			session.id,
			"browser.create",
			{ allowedOrigins: ["https://example.test"] },
			{ approvalStatus: "approved", idempotencyKey: "browser" },
		);
		const browserSessionId = String(created.output?.browserSessionId);
		await expect(
			controller.navigate(
				session.id,
				browserSessionId,
				"https://evil.test/",
				new AbortController().signal,
			),
		).rejects.toThrow("outside");
		await expect(
			controller.navigate(
				session.id,
				browserSessionId,
				"not-a-url",
				new AbortController().signal,
			),
		).rejects.toThrow("Browser navigation URL is invalid.");
		expect(
			(
				await runtime.callTool(
					session.id,
					"browser.navigate",
					{ browserSessionId, url: "https://example.test/page" },
					{ idempotencyKey: "nav" },
				)
			).status,
		).toBe("blocked");
		expect(
			(
				await runtime.callTool(
					session.id,
					"browser.navigate",
					{ browserSessionId, url: "https://example.test/page" },
					{ approvalStatus: "approved", idempotencyKey: "nav" },
				)
			).status,
		).toBe("verified");
		const snapshot = await runtime.callTool(session.id, "browser.snapshot", {
			browserSessionId,
		});
		expect(snapshot).toMatchObject({
			output: { title: "Example", trust: "untrusted_browser" },
		});
		expect(
			(
				await runtime.callTool(
					session.id,
					"browser.upload",
					{
						browserSessionId,
						selector: "input[type=file]",
						paths: ["upload.txt"],
					},
					{ approvalStatus: "approved", idempotencyKey: "upload" },
				)
			).status,
		).toBe("verified");
		expect(backend.uploaded).toEqual([realpathSync(join(root, "upload.txt"))]);
		expect(
			await runtime.callTool(
				session.id,
				"browser.downloads",
				{ browserSessionId },
				{ approvalStatus: "approved" },
			),
		).toMatchObject({
			output: {
				downloads: [{ filename: "report.pdf", status: "completed" }],
				trust: "untrusted_browser",
			},
		});
		expect(
			(
				await runtime.callTool(
					session.id,
					"computer.act",
					{ action: { type: "click", x: 10, y: 20 } },
					{ approvalStatus: "approved", idempotencyKey: "desktop-click" },
				)
			).status,
		).toBe("verified");
		expect(backend.desktopActions).toEqual([{ type: "click", x: 10, y: 20 }]);
		database.close();
	});

	it("keeps visible tabs separate from autonomous sessions and approval-gates mutations", async () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const backend = new FakeBrowser();
		const runtime = new AgentRuntime(database);
		const session = runtime.createSession({ title: "Visible browser" });
		installBrowserTools(runtime, new BrowserController(backend), session.id);
		expect(
			runtime
				.discoverTools(session.id)
				.find((tool) => tool.name === "browser.visible-act")?.description,
		).toContain("snapshot ref like e12");

		const listed = await runtime.callTool(session.id, "browser.tabs", {});
		expect(listed).toMatchObject({
			status: "verified",
			output: {
				tabs: [
					{
						id: backend.visibleTabId,
						active: true,
						trust: "untrusted_browser",
					},
				],
			},
		});
		await expect(
			runtime.callTool(
				session.id,
				"browser.search-history",
				{ query: "research", limit: 10 },
				{ approvalStatus: "approved" },
			),
		).resolves.toMatchObject({
			status: "verified",
			output: {
				trust: "untrusted_browser",
				entries: [{ title: "Research notes" }],
			},
		});
		await expect(
			runtime.callTool(
				session.id,
				"browser.visible-downloads",
				{},
				{ approvalStatus: "approved" },
			),
		).resolves.toMatchObject({
			status: "verified",
			output: {
				trust: "untrusted_browser",
				downloads: [{ filename: "notes.pdf" }],
			},
		});

		const action = {
			tabId: backend.visibleTabId,
			action: { type: "click" as const, target: "#buy" },
		};
		expect(
			(
				await runtime.callTool(session.id, "browser.visible-act", action, {
					idempotencyKey: "visible-click",
				})
			).status,
		).toBe("blocked");
		expect(backend.visibleActions).toEqual([]);
		expect(
			(
				await runtime.callTool(session.id, "browser.visible-act", action, {
					approvalStatus: "approved",
					idempotencyKey: "visible-click",
				})
			).status,
		).toBe("verified");
		expect(backend.visibleActions).toEqual([{ type: "click", target: "#buy" }]);

		const autonomous = await new BrowserController(backend).create(session.id, [
			"https://example.test",
		]);
		await expect(
			new BrowserController(backend).visibleAct(
				autonomous.browserSessionId,
				{ type: "click", target: "#buy" },
				new AbortController().signal,
			),
		).rejects.toThrow("tab ID is invalid");
		database.close();
	});

	it("rejects accessibility trees that cannot be serialized", async () => {
		const backend = new FakeBrowser();
		backend.snapshot = async () => ({
			url: "https://example.test/",
			title: "Example",
			accessibilityTree: undefined,
		});
		const controller = new BrowserController(backend);
		const session = await controller.create("owner", ["https://example.test"]);

		await expect(
			controller.snapshot(
				"owner",
				session.browserSessionId,
				new AbortController().signal,
			),
		).rejects.toThrow("exceeds 2 MB");

		const circular: Record<string, unknown> = {};
		circular.self = circular;
		backend.snapshot = async () => ({
			url: "https://example.test/",
			title: "Example",
			accessibilityTree: circular,
		});
		await expect(
			controller.snapshot(
				"owner",
				session.browserSessionId,
				new AbortController().signal,
			),
		).rejects.toThrow("exceeds 2 MB");
	});

	it("records deterministic pixel comparisons with encrypted metadata", () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const validator = new VisualValidator(
			database,
			() => new Date("2026-07-22T23:00:00.000Z"),
		);
		const baseline = {
			width: 2,
			height: 1,
			rgba: Uint8Array.from([0, 0, 0, 255, 255, 255, 255, 255]),
		};
		const actual = {
			width: 2,
			height: 1,
			rgba: Uint8Array.from([0, 0, 0, 255, 250, 255, 255, 255]),
		};
		expect(validator.compare(baseline, actual, 0.4)).toMatchObject({
			changedPixels: 1,
			differenceRatio: 0.5,
			passed: false,
		});
		expect(() =>
			validator.compare(baseline, { ...actual, rgba: new Uint8Array(4) }),
		).toThrow("exactly width");
		expect(() => validator.compare(baseline, actual, Number.NaN)).toThrow(
			"between 0 and 1",
		);
		expect(validator.list()).toHaveLength(1);
		database.close();
	});

	it("caps browser sessions per owner", async () => {
		const backend = new FakeBrowser();
		const controller = new BrowserController(backend);
		const sessions = await Promise.all(
			Array.from({ length: 8 }, () =>
				controller.create("owner", ["https://example.test"]),
			),
		);

		await expect(
			controller.create("owner", ["https://example.test"]),
		).rejects.toThrow("at most 8 sessions");
		const other = await controller.create("another-owner", [
			"https://example.test",
		]);
		expect(other.browserSessionId).toEqual(expect.any(String));
		for (const session of sessions)
			await controller.close("owner", session.browserSessionId);
		await controller.close("another-owner", other.browserSessionId);
	});

	it("persists responsive baseline, actual, diff, and diagnostics artifacts and gates browser errors", async () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const root = mkdtempSync(join(tmpdir(), "kestrel-visual-"));
		const backend = new FakeBrowser();
		backend.screenshot = async () => ({
			width: 320,
			height: 240,
			rgba: new Uint8Array(320 * 240 * 4).fill(255),
		});
		const controller = new BrowserController(backend);
		const validator = new VisualValidator(
			database,
			root,
			() => new Date("2026-07-22T23:00:00.000Z"),
		);
		const runtime = new AgentRuntime(database);
		const session = runtime.createSession({ title: "Visual" });
		installBrowserTools(runtime, controller, session.id, validator);
		const created = await runtime.callTool(
			session.id,
			"browser.create",
			{ allowedOrigins: ["https://example.test"] },
			{ approvalStatus: "approved", idempotencyKey: "visual-browser" },
		);
		const result = await runtime.callTool(
			session.id,
			"visual.validate-matrix",
			{
				browserSessionId: String(created.output?.browserSessionId),
				suite: "homepage",
				viewports: [{ name: "mobile", width: 320, height: 240 }],
				updateBaselines: true,
				threshold: 0,
				failOnConsoleErrors: true,
				failOnNetworkErrors: true,
			},
			{ approvalStatus: "approved", idempotencyKey: "visual-matrix" },
		);
		expect(result).toMatchObject({
			status: "verified",
			output: {
				suite: "homepage",
				passed: false,
				results: [
					{
						viewport: { name: "mobile" },
						consoleErrors: 1,
						differenceRatio: 0,
					},
				],
			},
		});
		const stored = validator.results()[0]!;
		expect(existsSync(stored.baselinePath)).toBe(true);
		expect(existsSync(stored.actualPath)).toBe(true);
		expect(existsSync(stored.diffPath)).toBe(true);
		expect(existsSync(stored.diagnosticsPath)).toBe(true);
		expect(backend.viewport).toEqual({
			name: "mobile",
			width: 320,
			height: 240,
		});
		database.close();
	});

	it("rejects corrupted visual baseline metadata and pixel data", () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const root = mkdtempSync(join(tmpdir(), "kestrel-visual-corrupt-"));
		const validator = new VisualValidator(
			database,
			root,
			() => new Date("2026-07-22T23:00:00.000Z"),
		);
		const viewport = { name: "mobile", width: 2, height: 1 };
		const frame = {
			width: 2,
			height: 1,
			rgba: Uint8Array.from([0, 0, 0, 255, 255, 255, 255, 255]),
		};
		validator.baseline("homepage", viewport, frame);
		const directory = join(root, "visual-validation", "homepage", "mobile");
		writeFileSync(join(directory, "baseline.json"), "not json");
		expect(() => validator.validate("homepage", viewport, frame, [])).toThrow(
			"Visual baseline metadata is invalid.",
		);
		validator.baseline("homepage", viewport, frame);
		writeFileSync(join(directory, "baseline.rgba"), Buffer.alloc(0));
		expect(() => validator.validate("homepage", viewport, frame, [])).toThrow(
			"Visual baseline pixel data is invalid.",
		);
		database.close();
	});
});
