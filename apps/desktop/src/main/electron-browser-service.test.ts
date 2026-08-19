import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	app: {},
	BrowserWindow: class {},
	desktopCapturer: {},
	session: {},
	systemPreferences: {},
}));

import {
	ElectronBrowserService,
	isolatedBrowserShouldCancelRequest,
	MAX_BROWSER_DOWNLOAD_RECORDS,
	retainRecentBrowserDownloads,
} from "./electron-browser-service";

function download(id: string, status: "completed" | "progressing") {
	return {
		id,
		filename: `${id}.txt`,
		bytes: 1,
		status,
		createdAt: new Date().toISOString(),
	};
}

describe("isolated browser origin policy", () => {
	const allowed = new Set(["https://example.test"]);

	it("cancels opaque and unallowlisted navigations, including data and blob holes", () => {
		expect(
			isolatedBrowserShouldCancelRequest("https://example.test/app", allowed),
		).toBe(false);
		expect(isolatedBrowserShouldCancelRequest("about:blank", allowed)).toBe(
			false,
		);
		expect(
			isolatedBrowserShouldCancelRequest("data:text/html,pwn", allowed),
		).toBe(true);
		expect(
			isolatedBrowserShouldCancelRequest("about:srcdoc", allowed),
		).toBe(true);
		expect(
			isolatedBrowserShouldCancelRequest(
				"blob:https://evil.test/11111111-1111-4111-8111-111111111111",
				allowed,
			),
		).toBe(true);
		expect(
			isolatedBrowserShouldCancelRequest(
				"blob:https://example.test/11111111-1111-4111-8111-111111111111",
				allowed,
			),
		).toBe(false);
		expect(
			isolatedBrowserShouldCancelRequest("https://evil.test/", allowed),
		).toBe(true);
	});
});

describe("Electron browser download history", () => {
	it("retains active downloads and the newest terminal records", () => {
		const downloads = Array.from(
			{ length: MAX_BROWSER_DOWNLOAD_RECORDS },
			(_, index) => download(`old-${index}`, "completed"),
		);
		const active = download("active", "progressing");
		const newest = download("newest", "completed");
		downloads.push(active, newest);

		retainRecentBrowserDownloads(downloads);

		expect(downloads).toHaveLength(MAX_BROWSER_DOWNLOAD_RECORDS);
		expect(downloads).toContain(active);
		expect(downloads).toContain(newest);
		expect(downloads.some((candidate) => candidate.id === "old-0")).toBe(false);
	});
});

describe("Electron browser action cancellation", () => {
	it("does not type after cancellation while resolving the target", async () => {
		let resolveTarget: (point: { x: number; y: number }) => void = () =>
			undefined;
		const target = new Promise<{ x: number; y: number }>((resolvePromise) => {
			resolveTarget = resolvePromise;
		});
		const insertText = vi.fn();
		const executeJavaScript = vi.fn(() => target);
		const service = new ElectronBrowserService();
		const sessions = (
			service as unknown as {
				sessions: Map<string, unknown>;
			}
		).sessions;
		sessions.set("browser-test", {
			window: {
				isDestroyed: () => false,
				webContents: {
					executeJavaScript,
					insertText,
				},
			},
			partition: {},
			allowedOrigins: new Set<string>(),
			diagnostics: [],
			downloads: [],
			downloadDirectory: "/tmp/browser-test",
		});
		const controller = new AbortController();
		const running = service.handle(
			{
				operation: "act",
				sessionId: "browser-test",
				action: { type: "type", target: "#prompt", text: "do not send" },
			},
			controller.signal,
		);
		const outcome = running.then(
			() => ({ ok: true as const }),
			(error: unknown) => ({ ok: false as const, error }),
		);
		await vi.waitFor(() => expect(executeJavaScript).toHaveBeenCalledOnce());

		controller.abort(new Error("cancelled before typing"));
		resolveTarget({ x: 10, y: 10 });

		await expect(outcome).resolves.toMatchObject({
			ok: false,
			error: expect.objectContaining({ message: "cancelled before typing" }),
		});
		expect(insertText).not.toHaveBeenCalled();
	});

	it("rejects malformed navigation URLs without invoking the window", async () => {
		const loadURL = vi.fn();
		const service = new ElectronBrowserService();
		const sessions = (
			service as unknown as {
				sessions: Map<string, unknown>;
			}
		).sessions;
		sessions.set("browser-test", {
			window: {
				isDestroyed: () => false,
				webContents: { loadURL },
			},
			partition: {},
			allowedOrigins: new Set(["https://example.test"]),
			diagnostics: [],
			downloads: [],
			downloadDirectory: "/tmp/browser-test",
		});

		await expect(
			service.handle(
				{
					operation: "navigate",
					sessionId: "browser-test",
					url: "not a URL",
				},
				new AbortController().signal,
			),
		).rejects.toThrow(
			"Electron browser navigation is outside the origin allowlist.",
		);
		expect(loadURL).not.toHaveBeenCalled();
	});
});

describe("Electron browser snapshot refs", () => {
	it("resolves click targets from snapshot refs through the debugger box model", async () => {
		const executeJavaScript = vi.fn(async () => undefined);
		const sendCommand = vi.fn(async (method: string, params?: object) => {
			if (method === "Accessibility.getFullAXTree") {
				return {
					nodes: [
						{
							nodeId: "1",
							role: { value: "button" },
							name: { value: "Save" },
							backendDOMNodeId: 42,
						},
					],
				};
			}
			if (method === "DOM.scrollIntoViewIfNeeded") return {};
			if (method === "DOM.getBoxModel") {
				expect(params).toMatchObject({ backendNodeId: 42 });
				return { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } };
			}
			if (method === "Input.dispatchMouseEvent") return {};
			throw new Error(`unexpected command ${method}`);
		});
		let attached = false;
		const service = new ElectronBrowserService();
		const sessions = (
			service as unknown as {
				sessions: Map<string, unknown>;
			}
		).sessions;
		sessions.set("browser-test", {
			window: {
				isDestroyed: () => false,
				webContents: {
					getURL: () => "https://example.test/",
					getTitle: () => "Example",
					executeJavaScript,
					debugger: {
						isAttached: () => attached,
						attach: () => {
							attached = true;
						},
						sendCommand,
					},
				},
			},
			partition: {},
			allowedOrigins: new Set<string>(),
			diagnostics: [],
			downloads: [],
			downloadDirectory: "/tmp/browser-test",
		});
		const signal = new AbortController().signal;

		await expect(
			service.handle({ operation: "snapshot", sessionId: "browser-test" }, signal),
		).resolves.toMatchObject({
			url: "https://example.test/",
			title: "Example",
			interactive: [{ ref: "e1", role: "button", name: "Save" }],
			accessibilityTree: {
				nodes: [{ ref: "e1", role: { value: "button" } }],
			},
		});

		await service.handle(
			{
				operation: "act",
				sessionId: "browser-test",
				action: { type: "click", target: "e1" },
			},
			signal,
		);

		expect(sendCommand).toHaveBeenCalledWith("DOM.getBoxModel", {
			backendNodeId: 42,
		});
		expect(sendCommand).toHaveBeenCalledWith(
			"Input.dispatchMouseEvent",
			expect.objectContaining({ type: "mousePressed", x: 20, y: 30 }),
		);
		expect(executeJavaScript).toHaveBeenCalledTimes(1);
		expect(executeJavaScript).toHaveBeenCalledWith(
			expect.stringContaining("requestAnimationFrame"),
			true,
		);
	});

	it("rejects unknown snapshot refs as stale", async () => {
		const executeJavaScript = vi.fn();
		const service = new ElectronBrowserService();
		const sessions = (
			service as unknown as {
				sessions: Map<string, unknown>;
			}
		).sessions;
		sessions.set("browser-test", {
			window: {
				isDestroyed: () => false,
				webContents: {
					executeJavaScript,
					debugger: {
						isAttached: () => false,
						attach: vi.fn(),
						sendCommand: vi.fn(),
					},
				},
			},
			partition: {},
			allowedOrigins: new Set<string>(),
			diagnostics: [],
			downloads: [],
			downloadDirectory: "/tmp/browser-test",
		});

		await expect(
			service.handle(
				{
					operation: "act",
					sessionId: "browser-test",
					action: { type: "click", target: "@e1" },
				},
				new AbortController().signal,
			),
		).rejects.toThrow("Browser target ref is stale. Take a new snapshot.");
		expect(executeJavaScript).not.toHaveBeenCalled();
	});
});
