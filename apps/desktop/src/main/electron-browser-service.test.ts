import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const nativeMocks = vi.hoisted(() => ({
	getSources: vi.fn(),
	execFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFile: nativeMocks.execFile }));

vi.mock("electron", () => ({
	app: {},
	BrowserWindow: class {},
	desktopCapturer: { getSources: nativeMocks.getSources },
	session: {},
	systemPreferences: {
		getMediaAccessStatus: () => "granted",
		isTrustedAccessibilityClient: () => true,
	},
	screen: {
		getPrimaryDisplay: () => ({
			id: 1,
			bounds: { x: 0, y: 0, width: 1280, height: 800 },
		}),
	},
}));

import {
	ElectronBrowserService,
	buildDesktopKeyScript,
	isDesktopCaptureFresh,
	isolatedBrowserShouldCancelRequest,
	mapDesktopScreenshotPoint,
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

describe("desktop capture coordinate and key helpers", () => {
	const bounds = { x: -1440, y: 40, width: 2560, height: 1400 };

	it("maps screenshot-local coordinates into global display coordinates", () => {
		expect(mapDesktopScreenshotPoint(0, 0, bounds)).toEqual({ x: -1440, y: 40 });
		expect(mapDesktopScreenshotPoint(2559, 1399, bounds)).toEqual({ x: 1119, y: 1439 });
		expect(() => mapDesktopScreenshotPoint(2560, 0, bounds)).toThrow(
			"outside the captured display",
		);
	});

	it("builds bounded native modifier chords", () => {
		expect(buildDesktopKeyScript(36, ["Command", "Shift"])).toBe(
			'tell application "System Events" to key code 36 using {command down, shift down}',
		);
		expect(() => buildDesktopKeyScript(36, ["Meta"])).toThrow(
			"modifiers are invalid",
		);
		expect(buildDesktopKeyScript("a", ["Control"])).toBe(
			'tell application "System Events" to keystroke "a" using {control down}',
		);
	});

	it("expires captures at two minutes and rejects malformed timestamps", () => {
		const now = Date.parse("2026-10-13T12:00:30.000Z");
		expect(isDesktopCaptureFresh("2026-10-13T12:00:00.000Z", now)).toBe(true);
		expect(isDesktopCaptureFresh("2026-10-13T11:58:29.999Z", now)).toBe(false);
		expect(isDesktopCaptureFresh("invalid", now)).toBe(false);
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
					action: { type: "click", x: 10, y: 20, captureId: "disabled-test" },
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

	it("requires a matching fresh capture and consumes it before input", async () => {
		nativeMocks.execFile.mockImplementation((_path, _args, _options, callback) => {
			const child = new EventEmitter();
			setTimeout(
				() => callback(null, JSON.stringify({ pid: 42, bundleId: "com.example.Target" })),
				0,
			);
			return child;
		});
		const service = new ElectronBrowserService();
		service.setComputerUseEnabled(true);
		const internal = service as unknown as {
			lastDesktopCapture: { metadata: {
				captureId: string;
				displayId: string;
				bounds: { x: number; y: number; width: number; height: number };
				capturedAt: string;
			}; foreground: { pid: number; bundleId: string } } | undefined;
		};
		internal.lastDesktopCapture = {
			metadata: {
				captureId: "capture-1",
				displayId: "1",
				bounds: { x: 0, y: 0, width: 1280, height: 800 },
				capturedAt: new Date().toISOString(),
			},
			foreground: { pid: 42, bundleId: "com.example.Target" },
		};
		await expect(
			service.handle(
				{ operation: "desktop-act", action: { type: "click", x: 1280, y: 0, captureId: "wrong" } },
				new AbortController().signal,
			),
		).rejects.toThrow("does not match");
		await expect(
			service.handle(
				{ operation: "desktop-act", action: { type: "click", x: 1280, y: 1, captureId: "capture-1" } },
				new AbortController().signal,
			),
		).rejects.toThrow("outside the captured display");
		await expect(
			service.handle(
				{ operation: "desktop-act", action: { type: "click", x: 1, y: 1, captureId: "capture-1" } },
				new AbortController().signal,
			),
		).rejects.toThrow("fresh desktop screenshot");
	});

	it("captures the normalized primary display and cancels native input", async () => {
		const image = {
			getSize: vi.fn()
				.mockReturnValueOnce({ width: 8, height: 8 })
				.mockReturnValue({ width: 4, height: 4 }),
			resize: vi.fn(() => image),
			toBitmap: vi.fn(() => new Uint8Array(4 * 4 * 4)),
			toPNG: vi.fn(() => new Uint8Array([1])),
		};
		nativeMocks.getSources.mockResolvedValueOnce([
			{ display_id: "1", thumbnail: image },
		]);
		nativeMocks.execFile.mockImplementation((_path, _args, _options, callback) => {
			const child = new EventEmitter();
			setTimeout(
				() => callback(null, JSON.stringify({ pid: 42, bundleId: "com.example.Target" })),
				0,
			);
			return child;
		});
		const service = new ElectronBrowserService();
		service.setComputerUseEnabled(true);
		const frame = (await service.handle(
			{ operation: "desktop-screenshot" },
			new AbortController().signal,
		)) as { width: number; height: number; desktop: { captureId: string } };
		expect(frame.width).toBe(4);
		expect(frame.height).toBe(4);
		expect(frame.desktop.captureId).toEqual(expect.any(String));
		for (const [, args] of nativeMocks.execFile.mock.calls) {
			if (args.includes("JavaScript")) expect(() => new Function(args.at(-1))).not.toThrow();
		}

		const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
		child.kill = vi.fn();
		nativeMocks.execFile.mockImplementationOnce((_path, _args, _options, callback) => {
			setTimeout(() => callback(new Error("terminated")), 0);
			return child;
		});
		const controller = new AbortController();
		const running = service.handle(
			{
				operation: "desktop-act",
				action: { type: "click", x: 1, y: 1, captureId: frame.desktop.captureId },
			},
			controller.signal,
		);
		controller.abort();
		await expect(running).rejects.toThrow("aborted");
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
	});

	it("fails closed when the frontmost app changes during capture", async () => {
		const image = {
			getSize: () => ({ width: 4, height: 4 }),
			toBitmap: () => new Uint8Array(4 * 4 * 4),
			toPNG: () => new Uint8Array([1]),
		};
		nativeMocks.getSources.mockResolvedValueOnce([
			{ display_id: "1", thumbnail: image },
		]);
		let query = 0;
		nativeMocks.execFile.mockImplementation((_path, _args, _options, callback) => {
			const child = new EventEmitter();
			query += 1;
			const pid = query === 1 ? 42 : 43;
			setTimeout(() => callback(null, JSON.stringify({ pid, bundleId: "com.example.Target" })), 0);
			return child;
		});
		const service = new ElectronBrowserService();
		service.setComputerUseEnabled(true);
		await expect(
			service.handle({ operation: "desktop-screenshot" }, new AbortController().signal),
		).rejects.toThrow("changed during capture");
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
