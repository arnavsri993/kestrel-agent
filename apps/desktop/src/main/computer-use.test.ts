import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	systemPreferences: {},
}));

import {
	ComputerUseManager,
	type NativeComputerUseBackend,
	type NativeForegroundInputBackend,
} from "./computer-use";

const TARGET_PID = 4242;
const KESTREL_PID = 1;
const FRONTMOST_PID = 9001;

function invariant(overrides: Record<string, unknown> = {}) {
	return {
		cursorX: 100,
		cursorY: 200,
		frontmostPid: FRONTMOST_PID,
		frontmostBundleId: "com.example.foreground",
		targetPid: TARGET_PID,
		kestrelPid: KESTREL_PID,
		userActivity: "idle",
		sampledAt: "2026-09-02T12:00:00.000Z",
		backend: "none",
		activationAttempted: false,
		...overrides,
	};
}

function nativeFixture(
	overrides: Partial<Record<keyof NativeComputerUseBackend, unknown>> = {},
) {
	let value: unknown = "idle";
	return {
		health: () => ({
			status: "healthy",
			protocolVersion: 1,
			platform: "darwin",
			architecture: "arm64",
			bridge: "in-process-node-api",
			publicAPIs: true,
		}),
		capabilities: () => ({
			protocolVersion: 1,
			platform: "darwin",
			architecture: "arm64",
			bridge: "in-process-node-api",
			accessibility: true,
			screenCaptureKit: true,
			screenRecordingPermission: true,
			targetedEvents: false,
			backgroundSafeOnly: true,
			maxTreeNodes: 800,
			maxCaptureWidth: 3840,
			maxCaptureHeight: 2160,
		}),
		listApplications: () => [],
		listWindows: () => [],
		describeWindow: () => ({
			pid: TARGET_PID,
			bundleId: "com.example.target",
			applicationName: "Target",
			windowId: 7,
			bounds: { x: 0, y: 0, width: 100, height: 100 },
			layer: 0,
			visible: true,
			captureState: "available",
			accessibilityAvailable: true,
			isFrontmostApplication: false,
			capability: "unverified",
			supportedBackends: ["macos-accessibility", "screencapturekit"],
		}),
		captureWindow: () => ({
			width: 1,
			height: 1,
			png: Uint8Array.from([137, 80, 78, 71]),
		}),
		inspectAccessibilityTree: () => ({
			protocolVersion: 1,
			generation: "g-1",
			pid: TARGET_PID,
			windowId: 7,
			nodes: [
				{
					elementId: "e-button",
					fingerprint: "ax1-button",
					identifier: "button",
					value: value,
					valueRedacted: false,
					supportedActions: ["AXPress"],
					settableAttributes: [],
					children: [],
					ancestry: [],
				},
			],
			truncated: false,
		}),
		resolveElement: () => ({
			elementId: "e-button",
			fingerprint: "ax1-button",
			identifier: "button",
			value,
			valueRedacted: false,
			supportedActions: ["AXPress"],
			settableAttributes: [],
			children: [],
			ancestry: [],
		}),
		performAccessibilityAction: () => {
			value = "complete";
			return {
				performed: true,
				targetBundleId: "com.example.target",
			};
		},
		setAccessibilityValue: (_input: unknown) => {
			value = "set";
			return {
				set: true,
				targetBundleId: "com.example.target",
			};
		},
		readAccessibilityValue: () => ({ value, redacted: false }),
		getInvariantState: () => invariant(),
		probeTargetedEventSupport: () => ({
			state: "unverified",
			eventClass: "mouse",
			backgroundSafe: false,
			reason: "disabled",
		}),
		shutdown: () => ({ shutdown: true }),
		...overrides,
	} as unknown as NativeComputerUseBackend;
}

function request(
	operation: Record<string, unknown>,
	requestId = `request-${Math.random()}`,
) {
	return {
		protocolVersion: 1,
		requestId,
		deadlineMs: 1_000,
		...operation,
	};
}

function managerWithNative(
	settingsPath: string,
	nativeBackend: NativeComputerUseBackend,
) {
	return new ComputerUseManager(settingsPath, {
		platform: "darwin",
		architecture: "arm64",
		permissionProbe: {
			screenRecording: () => "granted",
			accessibility: () => true,
		},
		nativeBackend,
		kestrelPid: KESTREL_PID,
	});
}

describe("computer-use preference and native permission status", () => {
	it("keeps foreground input off separately and dispatches only after both switches are on", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-foreground-input-"));
		const performForegroundInput = vi.fn(async () => ({
			operationId: "foreground-action",
			outcome: "sent", delivery: "unverified", targetState: "retained", eventsPosted: 2,
		}));
		const foregroundInputBackend: NativeForegroundInputBackend = {
			preflightEventAccess: () => true,
			performForegroundInput,
			cancelForegroundInput: vi.fn(() => true),
		};
		try {
			const manager = new ComputerUseManager(join(root, "settings.json"), {
				platform: "darwin", architecture: "arm64", kestrelPid: KESTREL_PID,
				permissionProbe: { screenRecording: () => "granted", accessibility: () => true },
				nativeBackend: nativeFixture(), foregroundInputBackend,
			});
			const input = request({ operation: "performForegroundInput",
				target: { pid: TARGET_PID, windowId: 7, bundleId: "com.example.target",
					bounds: { x: 0, y: 0, width: 100, height: 100 } },
				action: { type: "click", point: { x: 50, y: 50 } },
			}, "foreground-action");
			await manager.setEnabled(true);
			expect((await manager.status()).foregroundReady).toBe(false);
			expect(await manager.handle(input)).toMatchObject({ ok: false, error: { code: "disabled" } });
			expect(performForegroundInput).not.toHaveBeenCalled();
			await manager.setEnabled(true, true);
			expect(await manager.status()).toMatchObject({ foregroundReady: true, backgroundSafeOnly: false });
			expect(await manager.handle(input)).toMatchObject({
				ok: true,
				result: { outcome: "sent", delivery: "unverified", receipt: { backend: "macos-foreground-input", outcome: "dispatched" } },
				evidence: { backend: "macos-foreground-input", postcondition: "not_checked", activationAttempted: false },
			});
			expect(performForegroundInput).toHaveBeenCalledTimes(1);
			expect(await manager.handle({ ...input, requestId: "foreground-activate",
				action: { type: "activate" } })).toMatchObject({
				ok: true,
				evidence: { activationAttempted: true, postcondition: "verified" },
				result: { receipt: { requestedAction: "activate", outcome: "verified" } },
			});
			await manager.setEnabled(false);
			expect((await manager.status()).foregroundEnabled).toBe(false);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
	it("defaults off, persists atomically, and reports non-prompting permission state", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-computer-use-"));
		const settingsPath = join(root, "nested", "computer-use.json");
		let screenRecording: unknown = "not-determined";
		let accessibility = false;
		const probe = {
			screenRecording: () => screenRecording,
			accessibility: () => accessibility,
		};

		try {
			const manager = new ComputerUseManager(settingsPath, {
				platform: "darwin",
				nativeBackend: nativeFixture(),
				now: () => "2026-09-02T12:00:00.000Z",
				permissionProbe: probe,
			});

			expect(await manager.load()).toEqual({ version: 1, enabled: false, foregroundEnabled: false });
			expect(await manager.status()).toMatchObject({
				enabled: false,
				screenRecording: "not-determined",
				accessibility: "not-granted",
				captureReady: false,
				controlReady: false,
			});

			await manager.setEnabled(true);
			expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
				version: 1,
				enabled: true,
				foregroundEnabled: false,
			});

			screenRecording = "granted";
			accessibility = true;
			expect(await manager.status()).toMatchObject({
				enabled: true,
				screenRecording: "granted",
				accessibility: "granted",
				captureReady: true,
				controlReady: true,
				checkedAt: "2026-09-02T12:00:00.000Z",
			});

			const restarted = new ComputerUseManager(settingsPath, {
				platform: "darwin",
				permissionProbe: probe,
			});
			expect((await restarted.load()).enabled).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not report readiness when the native bridge is unavailable", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-computer-use-"));
		try {
			const manager = new ComputerUseManager(join(root, "settings.json"), {
				platform: "darwin",
				architecture: "arm64",
				permissionProbe: {
					screenRecording: () => "granted",
					accessibility: () => true,
				},
				nativeBackendLoader: () => undefined,
			});
			await manager.setEnabled(true);

			expect(await manager.status()).toMatchObject({
				enabled: true,
				nativeBackend: "unavailable",
				captureReady: false,
				controlReady: false,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports native permission surfaces as unavailable off macOS", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-computer-use-"));
		try {
			const manager = new ComputerUseManager(join(root, "settings.json"), {
				platform: "linux",
			});
			expect(await manager.status()).toMatchObject({
				platform: "linux",
				screenRecording: "unavailable",
				accessibility: "unavailable",
				captureReady: false,
				controlReady: false,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not leave the in-memory preference enabled when persistence fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-computer-use-"));
		const blocker = join(root, "not-a-directory");
		writeFileSync(blocker, "block");
		try {
			const manager = new ComputerUseManager(join(blocker, "settings.json"), {
				platform: "darwin",
				permissionProbe: {
					screenRecording: () => "granted",
					accessibility: () => true,
				},
			});

			await expect(manager.setEnabled(true)).rejects.toThrow();
			expect((await manager.status()).enabled).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed while disabled and validates native health and capabilities", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-computer-use-"));
		const native = nativeFixture();
		try {
			const manager = managerWithNative(join(root, "settings.json"), native);
			const response = await manager.handle(
				request({ operation: "listWindows" }, "disabled-list"),
			);
			expect(response.ok).toBe(false);
			if (!response.ok) expect(response.error.code).toBe("disabled");
			expect(await manager.handle(request({ operation: "health" }, "health"))).toMatchObject({
			ok: true,
			result: { status: "healthy" },
		});
			expect(await manager.handle(request({ operation: "capabilities" }, "caps"))).toMatchObject({
			ok: true,
			result: { targetedEvents: false, backgroundSafeOnly: true },
		});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("verifies semantic actions without changing cursor or foreground and returns a redacted receipt", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-computer-use-"));
		try {
			const manager = managerWithNative(
				join(root, "settings.json"),
				nativeFixture(),
			);
			await manager.setEnabled(true);
			const response = await manager.handle(
				request(
					{
						operation: "performAccessibilityAction",
						pid: TARGET_PID,
						windowId: 7,
						selector: { identifier: "button" },
						action: { type: "press" },
						expectedValue: "complete",
					},
					"semantic-action",
				),
			);
			expect(response.ok).toBe(true);
			if (response.ok) {
				expect(response.evidence).toMatchObject({
					backend: "macos-accessibility",
					cursorInvariant: "held",
					foregroundInvariant: "held",
					postcondition: "verified",
				});
				expect(response.result.receipt).toMatchObject({
					requestedAction: "press",
					backend: "macos-accessibility",
					outcome: "verified",
					cursorInvariant: "held",
					foregroundInvariant: "held",
				});
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("never returns secure values in action results or receipts", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-computer-use-"));
		const secret = "fixture-secret-that-must-not-escape";
		const native = nativeFixture({
			setAccessibilityValue: () => ({
				set: true,
				redacted: true,
				targetBundleId: "com.example.target",
			}),
			readAccessibilityValue: () => ({
				value: { redacted: true, reason: "secure-field" },
				redacted: true,
			}),
		});
		try {
			const manager = managerWithNative(join(root, "settings.json"), native);
			await manager.setEnabled(true);
			const response = await manager.handle(
				request(
					{
						operation: "setAccessibilityValue",
						pid: TARGET_PID,
						selector: { identifier: "secure-text" },
						value: secret,
						secret: true,
					},
					"secure-action",
				),
			);
			expect(JSON.stringify(response)).not.toContain(secret);
			expect(response.ok).toBe(true);
		if (response.ok) {
			expect(
				(response.result as { receipt: { outcome: string } }).receipt.outcome,
			).toBe("dispatched");
		}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns typed validation, stale, ambiguous, and unsupported failures", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-computer-use-"));
		try {
			const native = nativeFixture({
				resolveElement: () => {
					const error = new Error("stale") as Error & { code: string };
					error.code = "staleElement";
					throw error;
				},
			});
			const manager = managerWithNative(join(root, "settings.json"), native);
			await manager.setEnabled(true);
			const invalid = await manager.handle({ operation: "listWindows" });
			expect(invalid.ok).toBe(false);
		if (!invalid.ok) expect(invalid.error.code).toBe("invalidRequest");
		const stale = await manager.handle(
			request(
				{
					operation: "resolveElement",
					pid: TARGET_PID,
					selector: { elementId: "old" },
				},
				"stale",
			),
		);
		if (!stale.ok) expect(stale.error.code).toBe("staleElement");

		const ambiguousManager = managerWithNative(
			join(root, "ambiguous.json"),
			nativeFixture({
				resolveElement: () => {
					const error = new Error("ambiguous") as Error & { code: string };
					error.code = "ambiguousSelector";
					throw error;
				},
			}),
		);
		await ambiguousManager.setEnabled(true);
		const ambiguous = await ambiguousManager.handle(
			request(
				{
					operation: "resolveElement",
					pid: TARGET_PID,
					selector: { title: "Repeated" },
				},
				"ambiguous",
			),
		);
		if (!ambiguous.ok) expect(ambiguous.error.code).toBe("ambiguousSelector");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refreshes a stale semantic selector once before resolving it", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-computer-use-"));
		let attempts = 0;
		const selectors: Record<string, unknown>[] = [];
		try {
			const native = nativeFixture({
				resolveElement: (input: { selector: Record<string, unknown> }) => {
					attempts += 1;
					selectors.push(input.selector);
					if (attempts === 1) {
						const error = new Error("stale") as Error & { code: string };
						error.code = "staleElement";
						throw error;
					}
					return nativeFixture().resolveElement({
						pid: TARGET_PID,
						selector: { identifier: "button" },
					});
				},
			});
			const manager = managerWithNative(join(root, "settings.json"), native);
			await manager.setEnabled(true);
			const response = await manager.handle(
				request(
					{
						operation: "resolveElement",
						pid: TARGET_PID,
						selector: {
							elementId: "old",
							fingerprint: "old-fingerprint",
							identifier: "button",
						},
					},
					"refresh-selector",
				),
			);
			expect(response.ok).toBe(true);
			expect(attempts).toBe(2);
			expect(selectors[1]).toEqual({ identifier: "button" });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("serializes mutations per target and cancels while waiting for the slot", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-computer-use-"));
		let calls = 0;
		let resolveFirst: () => void = () => undefined;
		let firstStarted: () => void = () => undefined;
		const started = new Promise<void>((resolve) => {
			firstStarted = resolve;
		});
		const firstGate = new Promise<void>((resolve) => {
			resolveFirst = resolve;
		});
		try {
			const native = nativeFixture({
				performAccessibilityAction: async () => {
					calls += 1;
					if (calls === 1) {
						firstStarted();
						await firstGate;
					}
					return { performed: true, targetBundleId: "com.example.target" };
				},
			});
			const manager = managerWithNative(join(root, "settings.json"), native);
			await manager.setEnabled(true);
			const action = {
				operation: "performAccessibilityAction" as const,
				pid: TARGET_PID,
				windowId: 7,
				selector: { identifier: "button" },
				action: { type: "press" as const },
			};
			const firstPromise = manager.handle(request(action, "serialized-first"));
			await started;
			const cancellation = new AbortController();
			const secondPromise = manager.handle(
				request(action, "serialized-second"),
				cancellation.signal,
			);
			await Promise.resolve();
			expect(calls).toBe(1);
			cancellation.abort(new Error("cancelled while queued"));
			const second = await secondPromise;
			expect(second.ok).toBe(false);
			if (!second.ok) expect(second.error.code).toBe("cancelled");
			resolveFirst();
			const first = await firstPromise;
			expect(first.ok).toBe(true);
			expect(calls).toBe(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("honors cancellation and deadlines for bounded backend calls", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-computer-use-"));
		try {
			const pending = new Promise<unknown>(() => undefined);
			const native = nativeFixture({ listWindows: () => pending });
			const manager = managerWithNative(join(root, "settings.json"), native);
			await manager.setEnabled(true);
			const cancellation = new AbortController();
			const cancelledPromise = manager.handle(
				request({ operation: "listWindows" }, "cancelled"),
				cancellation.signal,
			);
			await Promise.resolve();
			cancellation.abort(new Error("cancelled by test"));
			const cancelled = await cancelledPromise;
			expect(cancelled.ok).toBe(false);
			if (!cancelled.ok) expect(cancelled.error.code).toBe("cancelled");

			const deadline = await manager.handle({
				...request({ operation: "listWindows" }, "deadline"),
				deadlineMs: 10,
			});
			expect(deadline.ok).toBe(false);
			if (!deadline.ok) expect(deadline.error.code).toBe("timeout");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("caches an invariant violation as unsafe for the rest of the session", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-computer-use-"));
		let samples = 0;
		let resolves = 0;
		try {
			const native = nativeFixture({
				getInvariantState: () => {
					samples += 1;
					return samples === 1
						? invariant()
						: invariant({ frontmostPid: TARGET_PID, frontmostBundleId: "com.example.target" });
				},
				resolveElement: () => {
					resolves += 1;
					return {
						elementId: "e-button",
						fingerprint: "ax1-button",
						identifier: "button",
						value: "idle",
						valueRedacted: false,
						supportedActions: ["AXPress"],
						settableAttributes: [],
						children: [],
						ancestry: [],
					};
				},
			});
			const manager = managerWithNative(join(root, "settings.json"), native);
			await manager.setEnabled(true);
			const violation = await manager.handle(
				request(
					{
						operation: "performAccessibilityAction",
						pid: TARGET_PID,
						selector: { identifier: "button" },
						action: { type: "press" },
					},
					"violation",
				),
			);
			expect(violation.ok).toBe(false);
			if (!violation.ok) expect(violation.error.code).toBe("invariantViolation");
			const blocked = await manager.handle(
				request(
					{
						operation: "resolveElement",
						pid: TARGET_PID,
						selector: { identifier: "button" },
					},
					"blocked",
				),
			);
			expect(blocked.ok).toBe(false);
			if (!blocked.ok) expect(blocked.error.code).toBe("backgroundUnsafe");
			expect(resolves).toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
