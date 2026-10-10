import { describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => {
	const makeWindow = () => ({
		isDestroyed: () => false,
		loadURL: vi.fn<() => Promise<void>>(),
		webContents: {
			id: 42,
			listeners: new Map<string, (...args: unknown[]) => void>(),
			on: vi.fn(),
			setWindowOpenHandler: vi.fn(),
			stop: vi.fn(),
		},
	});
	const makePartition = () => ({
		setPermissionRequestHandler: vi.fn(),
		setPermissionCheckHandler: vi.fn(),
		on: vi.fn(),
		webRequest: { onBeforeRequest: vi.fn(), onErrorOccurred: vi.fn() },
	});
	return {
		makeWindow,
		makePartition,
		windows: [] as ReturnType<typeof makeWindow>[],
		partitions: [] as ReturnType<typeof makePartition>[],
	};
});

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs")>()),
	mkdirSync: vi.fn(),
}));

vi.mock("electron", () => ({
	app: { getPath: () => "/tmp/kestrel-electron-browser-test" },
	BrowserWindow: class {
		constructor() {
			const window = electronMocks.makeWindow();
			window.webContents.on.mockImplementation((name, listener) => {
				window.webContents.listeners.set(name, listener);
			});
			electronMocks.windows.push(window);
			return window;
		}
	},
	desktopCapturer: {},
	session: {
		fromPartition: () => {
			const partition = electronMocks.makePartition();
			electronMocks.partitions.push(partition);
			return partition;
		},
	},
	systemPreferences: {},
}));

import {
	ElectronBrowserService,
	isolatedBrowserShouldCancelRequest,
	MAX_BROWSER_DOWNLOAD_RECORDS,
	retainRecentBrowserDownloads,
	uniqueIsolatedDownloadFilename,
	waitForBrowserPostClickFrame,
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

describe("Electron browser navigation scope errors", () => {
	const initialUrl = "https://example.test/start";
	const deniedUrl = "https://user:password@outside.test/private?token=secret#private";
	const cancelled = () => Object.assign(new Error("ERR_FAILED (-2) loading URL"), {
		code: "ERR_FAILED",
		errno: -2,
	});

	async function browser() {
		const service = new ElectronBrowserService();
		const sessionId = (await service.handle(
			{ operation: "create", allowedOrigins: ["https://example.test"] },
			new AbortController().signal,
		)) as string;
		const window = electronMocks.windows.at(-1)!;
		const partition = electronMocks.partitions.at(-1)!;
		const emit = (name: string, url: string, isMainFrame = true) => {
			const event = { url, isMainFrame, isSameDocument: false, preventDefault: vi.fn() };
			window.webContents.listeners.get(name)!(event, url);
			return event;
		};
		const request = (url: string, id = 1, resourceType = "mainFrame", webContentsId = 42) => {
			const callback = vi.fn();
			partition.webRequest.onBeforeRequest.mock.calls[0]![0](
				{ url, id, resourceType, webContentsId },
				callback,
			);
			return callback;
		};
		const navigate = (signal = new AbortController().signal) => service.handle(
			{ operation: "navigate", sessionId, url: initialUrl },
			signal,
		);
		return { window, partition, emit, request, navigate };
	}

	it("reports only the denied origin for a main-frame redirect and preserves its cancellation", async () => {
		const fixture = await browser();
		fixture.window.loadURL.mockImplementation(async () => {
			fixture.emit("did-start-navigation", initialUrl);
			expect(fixture.request(initialUrl)).toHaveBeenCalledWith({ cancel: false });
			expect(fixture.emit("will-redirect", deniedUrl).preventDefault).toHaveBeenCalledOnce();
			throw cancelled();
		});
		await expect(fixture.navigate()).rejects.toMatchObject({
			message: "Electron browser navigation was blocked because origin https://outside.test is outside this session's origin allowlist.",
		});
		expect(fixture.partition.setPermissionCheckHandler.mock.calls[0]![0]()).toBe(false);
		const permission = vi.fn();
		fixture.partition.setPermissionRequestHandler.mock.calls[0]![0](undefined, "camera", permission);
		expect(permission).toHaveBeenCalledWith(false);
	});

	it("reports bound main-frame request denials without exposing URL credentials or tokens", async () => {
		const fixture = await browser();
		fixture.window.loadURL.mockImplementation(async () => {
			fixture.emit("did-start-navigation", initialUrl);
			fixture.request(initialUrl, 7);
			expect(fixture.request(deniedUrl, 7)).toHaveBeenCalledWith({ cancel: true });
			throw Object.assign(new Error("request cancelled"), { code: "ERR_BLOCKED_BY_CLIENT" });
		});
		await expect(fixture.navigate()).rejects.toMatchObject({
			message: "Electron browser navigation was blocked because origin https://outside.test is outside this session's origin allowlist.",
		});
	});

	it("uses generic scope wording for denied opaque destinations", async () => {
		const fixture = await browser();
		fixture.window.loadURL.mockImplementation(async () => {
			fixture.emit("did-start-navigation", initialUrl);
			fixture.emit("will-redirect", "data:text/html,secret");
			throw cancelled();
		});
		await expect(fixture.navigate()).rejects.toMatchObject({
			message: "Electron browser navigation was blocked outside this session's origin allowlist.",
		});
	});

	it.each(["subFrame", "script", "image", "xhr"])("does not attribute blocked %s requests to navigation", async (resourceType) => {
		const fixture = await browser();
		const failure = cancelled();
		fixture.window.loadURL.mockImplementation(async () => {
			fixture.emit("did-start-navigation", initialUrl);
			fixture.request(initialUrl);
			expect(fixture.request(deniedUrl, 1, resourceType)).toHaveBeenCalledWith({ cancel: true });
			expect(fixture.emit("will-redirect", deniedUrl, false).preventDefault).toHaveBeenCalledOnce();
			throw failure;
		});
		await expect(fixture.navigate()).rejects.toBe(failure);
	});

	it("does not attribute stale request IDs or requests from another WebContents", async () => {
		const fixture = await browser();
		const failure = cancelled();
		fixture.window.loadURL.mockImplementation(async () => {
			fixture.emit("did-start-navigation", initialUrl);
			fixture.request(initialUrl, 2);
			fixture.request(deniedUrl, 1);
			fixture.request(deniedUrl, 2, "mainFrame", 99);
			throw failure;
		});
		await expect(fixture.navigate()).rejects.toBe(failure);
	});

	it("clears a denial before retrying and ignores denial events outside an attempt", async () => {
		const fixture = await browser();
		fixture.window.loadURL.mockImplementationOnce(async () => {
			fixture.emit("did-start-navigation", initialUrl);
			fixture.emit("will-redirect", deniedUrl);
			throw cancelled();
		});
		await expect(fixture.navigate()).rejects.toThrow("origin allowlist");
		fixture.emit("will-redirect", deniedUrl);
		const failure = cancelled();
		fixture.window.loadURL.mockImplementationOnce(async () => {
			fixture.emit("did-start-navigation", initialUrl);
			throw failure;
		});
		await expect(fixture.navigate()).rejects.toBe(failure);
	});

	it("preserves unrelated network errors even after an observed scope denial", async () => {
		const fixture = await browser();
		const failure = Object.assign(new Error("DNS lookup failed"), { code: "ERR_NAME_NOT_RESOLVED" });
		fixture.window.loadURL.mockImplementation(async () => {
			fixture.emit("did-start-navigation", initialUrl);
			fixture.emit("will-redirect", deniedUrl);
			throw failure;
		});
		await expect(fixture.navigate()).rejects.toBe(failure);
	});

	it("preserves abort reasons after an observed denial and stops the browser", async () => {
		const fixture = await browser();
		const controller = new AbortController();
		const reason = new Error("cancelled by caller");
		fixture.window.loadURL.mockImplementation(async () => {
			fixture.emit("did-start-navigation", initialUrl);
			fixture.emit("will-redirect", deniedUrl);
			controller.abort(reason);
			throw cancelled();
		});
		await expect(fixture.navigate(controller.signal)).rejects.toBe(reason);
		expect(fixture.window.webContents.stop).toHaveBeenCalledOnce();
	});

	it("does not start a navigation for an already aborted signal", async () => {
		const fixture = await browser();
		const controller = new AbortController();
		const reason = new Error("already cancelled");
		controller.abort(reason);
		await expect(fixture.navigate(controller.signal)).rejects.toBe(reason);
		expect(fixture.window.loadURL).not.toHaveBeenCalled();
	});

	it("disables attribution when page navigation interrupts a loadURL attempt", async () => {
		const fixture = await browser();
		const failure = cancelled();
		fixture.window.loadURL.mockImplementation(async () => {
			fixture.emit("did-start-navigation", initialUrl);
			expect(fixture.emit("will-navigate", deniedUrl).preventDefault).toHaveBeenCalledOnce();
			fixture.emit("will-redirect", deniedUrl);
			throw failure;
		});
		await expect(fixture.navigate()).rejects.toBe(failure);
	});

	it("does not attribute redirects before the matching main-frame navigation starts", async () => {
		const fixture = await browser();
		const failure = cancelled();
		fixture.window.loadURL.mockImplementation(async () => {
			fixture.emit("will-redirect", deniedUrl);
			fixture.emit("did-start-navigation", "https://example.test/other");
			fixture.emit("will-redirect", deniedUrl);
			throw failure;
		});
		await expect(fixture.navigate()).rejects.toBe(failure);
	});

	it("does not attribute overlapping loadURL attempts, including after one settles", async () => {
		const fixture = await browser();
		const firstFailure = cancelled();
		const secondFailure = cancelled();
		let rejectFirst!: (error: unknown) => void;
		let rejectSecond!: (error: unknown) => void;
		fixture.window.loadURL.mockImplementationOnce(() => {
			fixture.emit("did-start-navigation", initialUrl);
			return new Promise((_resolve, reject) => { rejectFirst = reject; });
		});
		fixture.window.loadURL.mockImplementationOnce(() => {
			fixture.emit("did-start-navigation", initialUrl);
			return new Promise((_resolve, reject) => { rejectSecond = reject; });
		});
		const first = fixture.navigate();
		const second = fixture.navigate();
		fixture.emit("will-redirect", deniedUrl);
		rejectFirst(firstFailure);
		await expect(first).rejects.toBe(firstFailure);
		fixture.emit("will-redirect", deniedUrl);
		rejectSecond(secondFailure);
		await expect(second).rejects.toBe(secondFailure);
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

	it("assigns unique filenames when a download name is already occupied", () => {
		expect(
			uniqueIsolatedDownloadFilename(
				"report.pdf",
				["report.pdf"],
				"download-1",
			),
		).toBe("report-2.pdf");
		expect(
			uniqueIsolatedDownloadFilename(
				"report.pdf",
				["report.pdf", "report-2.pdf"],
				"download-1",
			),
		).toBe("report-3.pdf");
	});
});

describe("Electron browser action cancellation", () => {
	it("fails closed for whole-desktop capture and input until explicitly enabled", async () => {
		const service = new ElectronBrowserService();
		const signal = new AbortController().signal;

		await expect(
			service.handle({ operation: "desktop-screenshot" }, signal),
		).rejects.toThrow("Whole-desktop computer use is disabled");
		await expect(
			service.handle(
				{
					operation: "desktop-act",
					action: { type: "click", x: 10, y: 20 },
				},
				signal,
			),
		).rejects.toThrow("Whole-desktop computer use is disabled");
		expect(service.isComputerUseEnabled()).toBe(false);

		service.setComputerUseEnabled(true);
		expect(service.isComputerUseEnabled()).toBe(true);
	});

	it("bounds the post-click frame wait when navigation strands the old context", async () => {
		await expect(
			waitForBrowserPostClickFrame(
				() => new Promise(() => undefined),
				new AbortController().signal,
				5,
			),
		).resolves.toBe("bounded_wait");
	});

	it("stops a post-click frame wait when the browser action is cancelled", async () => {
		const controller = new AbortController();
		const waiting = waitForBrowserPostClickFrame(
			() => new Promise(() => undefined),
			controller.signal,
			1_000,
		);
		controller.abort(new Error("cancelled post-click wait"));

		await expect(waiting).rejects.toThrow("cancelled post-click wait");
	});

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

	it("dispatches key actions through CDP for hidden browser sessions", async () => {
		let attached = false;
		const sendCommand = vi.fn(async () => ({}));
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

		await service.handle(
			{
				operation: "act",
				sessionId: "browser-test",
				action: { type: "key", key: "ArrowDown" },
			},
			new AbortController().signal,
		);

		expect(sendCommand).toHaveBeenNthCalledWith(1, "Input.dispatchKeyEvent", {
			type: "keyDown",
			key: "ArrowDown",
		});
		expect(sendCommand).toHaveBeenNthCalledWith(2, "Input.dispatchKeyEvent", {
			type: "keyUp",
			key: "ArrowDown",
		});
	});

	it("selects a native option through a bounded semantic CDP action", async () => {
		let attached = false;
		const sendCommand = vi.fn(async (method: string, params?: object) => {
			if (method === "DOM.scrollIntoViewIfNeeded") return {};
			if (method === "DOM.resolveNode")
				return { object: { objectId: "select-object" } };
			if (method === "Runtime.callFunctionOn") {
				if (
					(params as { functionDeclaration?: string }).functionDeclaration?.includes(
						"shouldFocus",
					)
				)
					return { result: { value: { ok: true, x: 20, y: 30 } } };
				expect(params).toMatchObject({
					objectId: "select-object",
					arguments: [{ value: "us" }],
					returnByValue: true,
					userGesture: true,
				});
				expect((params as { functionDeclaration?: string }).functionDeclaration).toContain(
					"HTMLSelectElement",
				);
				return { result: { value: { ok: true } } };
			}
			if (method === "Runtime.releaseObject") return {};
			throw new Error(`unexpected command ${method}`);
		});
		const service = new ElectronBrowserService();
		const sessions = (
			service as unknown as {
				sessions: Map<string, unknown>;
			}
		).sessions;
		const elementRefs = (
			service as unknown as {
				elementRefs: Map<string, Map<string, number>>;
			}
		).elementRefs;
		sessions.set("browser-test", {
			window: {
				isDestroyed: () => false,
				webContents: {
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
		elementRefs.set("browser-test", new Map([["e1", 42]]));

		await service.handle(
			{
				operation: "act",
				sessionId: "browser-test",
				action: { type: "select", target: "e1", value: "us" },
			},
			new AbortController().signal,
		);

		expect(sendCommand).toHaveBeenCalledWith("DOM.scrollIntoViewIfNeeded", {
			backendNodeId: 42,
		});
		await vi.waitFor(() =>
			expect(sendCommand).toHaveBeenCalledWith("Runtime.releaseObject", {
				objectId: "select-object",
			}),
		);
	});
});

describe("Electron browser snapshot refs", () => {
	it("resolves and preflights click targets from snapshot refs", async () => {
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
			if (method === "DOM.resolveNode") {
				expect(params).toMatchObject({ backendNodeId: 42 });
				return { object: { objectId: "button-object" } };
			}
			if (method === "Runtime.callFunctionOn") {
				expect(params).toMatchObject({
					objectId: "button-object",
				arguments: [{ value: false }, { value: false }],
					awaitPromise: true,
					returnByValue: true,
				});
				return { result: { value: { ok: true, x: 20, y: 30 } } };
			}
			if (method === "Runtime.releaseObject") return {};
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

		expect(sendCommand).toHaveBeenCalledWith("DOM.resolveNode", {
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

	it("rejects an obscured snapshot ref before dispatching pointer input", async () => {
		const sendCommand = vi.fn(async (method: string) => {
			if (method === "DOM.scrollIntoViewIfNeeded") return {};
			if (method === "DOM.resolveNode")
				return { object: { objectId: "obscured-button" } };
			if (method === "Runtime.callFunctionOn")
				return { result: { value: { ok: false, code: "obscured" } } };
			if (method === "Runtime.releaseObject") return {};
			throw new Error(`unexpected command ${method}`);
		});
		const service = new ElectronBrowserService();
		const sessions = (
			service as unknown as { sessions: Map<string, unknown> }
		).sessions;
		const elementRefs = (
			service as unknown as {
				elementRefs: Map<string, Map<string, number>>;
			}
		).elementRefs;
		sessions.set("browser-test", {
			window: {
				isDestroyed: () => false,
				webContents: {
					debugger: {
						isAttached: () => true,
						attach: vi.fn(),
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
		elementRefs.set("browser-test", new Map([["e1", 42]]));

		await expect(
			service.handle(
				{
					operation: "act",
					sessionId: "browser-test",
					action: { type: "click", target: "e1" },
				},
				new AbortController().signal,
			),
		).rejects.toThrow("obscured");
		expect(sendCommand).not.toHaveBeenCalledWith(
			"Input.dispatchMouseEvent",
			expect.anything(),
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
