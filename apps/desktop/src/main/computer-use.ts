import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { arch as hostArch, platform as hostPlatform } from "node:os";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { systemPreferences } from "electron";
import {
	ComputerUseAXNodeSchema,
	ComputerUseAXTreeSchema,
	ComputerUseActionReceiptSchema,
	ComputerUseApplicationSchema,
	ComputerUseCapabilitiesSchema,
	ComputerUseErrorCodeSchema,
	ComputerUseInvariantSampleSchema,
	ComputerUsePermissionStateSchema,
	ComputerUseRequestSchema,
	ComputerUseResponseSchema,
	ComputerUseSettingsSchema,
	ComputerUseStatusSchema,
	ComputerUseWindowSchema,
	type ComputerUseActionReceipt,
	type ComputerUseErrorCode,
	type ComputerUseElementSelector,
	type ComputerUseInvariantResult,
	type ComputerUsePermissionState,
	type ComputerUseRequest,
	type ComputerUseResponse,
	type ComputerUseSettings,
	type ComputerUseStatus,
} from "@kestrel/shared-types";

export type ComputerUseSurface = "screen-recording" | "accessibility";

export const COMPUTER_USE_SETTINGS_FILE = "computer-use.json";

/** Stable name for the no-global-input boundary and its static audit. */
export const BACKGROUND_COMPUTER_USE_MUST_NOT_CAPTURE_USER_INPUT =
	"BACKGROUND_COMPUTER_USE_MUST_NOT_CAPTURE_USER_INPUT" as const;

export const MACOS_COMPUTER_USE_SETTINGS_URLS: Record<
	ComputerUseSurface,
	string
> = {
	"screen-recording":
		"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
	accessibility:
		"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
};

export interface ComputerUsePermissionProbe {
	screenRecording(): unknown;
	accessibility(): boolean;
}

/** The deliberately small API exported by the bundled Objective-C++ addon. */
export interface NativeComputerUseBackend {
	health(): unknown;
	capabilities(): unknown;
	listApplications(): unknown;
	listWindows(): unknown;
	describeWindow(windowId: number): unknown;
	captureWindow(
		windowId: number,
		options: { maxWidth: number; maxHeight: number },
	): unknown;
	inspectAccessibilityTree(input: {
		pid: number;
		windowId?: number;
		maxNodes: number;
		maxDepth: number;
	}): unknown;
	resolveElement(input: {
		pid: number;
		windowId?: number;
		selector: Record<string, unknown>;
	}): unknown;
	performAccessibilityAction(input: {
		pid: number;
		windowId?: number;
		selector: Record<string, unknown>;
		action: Record<string, unknown>;
	}): unknown;
	setAccessibilityValue(input: {
		pid: number;
		windowId?: number;
		selector: Record<string, unknown>;
		value: string;
		secret?: boolean;
	}): unknown;
	readAccessibilityValue(input: {
		pid: number;
		windowId?: number;
		selector: Record<string, unknown>;
	}): unknown;
	getInvariantState(input: { targetPid?: number }): unknown;
	probeTargetedEventSupport(input: {
		pid: number;
		bundleId?: string;
		eventClass: "mouse" | "keyboard" | "scroll";
	}): unknown;
	shutdown(): unknown;
}

export interface NativeForegroundInputBackend {
	preflightEventAccess(): boolean;
	performForegroundInput(input: {
		operationId: string;
		target: Extract<ComputerUseRequest, { operation: "performForegroundInput" }>["target"];
		action: Extract<ComputerUseRequest, { operation: "performForegroundInput" }>["action"];
	}): Promise<unknown>;
	cancelForegroundInput(operationId: string): boolean;
}

export interface ComputerUseManagerOptions {
	platform?: NodeJS.Platform;
	architecture?: string;
	osVersion?: string;
	now?: () => string;
	permissionProbe?: ComputerUsePermissionProbe;
	nativeBackend?: NativeComputerUseBackend;
	nativeBackendLoader?: () => NativeComputerUseBackend | undefined;
	foregroundInputBackend?: NativeForegroundInputBackend;
	foregroundInputBackendLoader?: () => NativeForegroundInputBackend | undefined;
	kestrelPid?: number;
}

const DEFAULT_SETTINGS: ComputerUseSettings = { version: 1, enabled: false, foregroundEnabled: false };

function permissionState(value: unknown): ComputerUsePermissionState {
	const parsed = ComputerUsePermissionStateSchema.safeParse(value);
	return parsed.success ? parsed.data : "unknown";
}

function nativePermissionProbe(
	platformName: NodeJS.Platform,
): ComputerUsePermissionProbe {
	if (platformName !== "darwin")
		return { screenRecording: () => "unavailable", accessibility: () => false };
	return {
		screenRecording: () => {
			try {
				return permissionState(systemPreferences.getMediaAccessStatus("screen"));
			} catch {
				return "unknown";
			}
		},
		accessibility: () => {
			try {
				// Status checks are always non-prompting. The user explicitly opens
				// Privacy & Security from Settings when permission is needed.
				return systemPreferences.isTrustedAccessibilityClient(false);
			} catch {
				return false;
			}
		},
	};
}

async function persistAtomically(
	path: string,
	settings: ComputerUseSettings,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, `${JSON.stringify(settings)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await chmod(temporaryPath, 0o600);
		await rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

function nativeErrorCode(value: unknown): ComputerUseErrorCode | undefined {
	const code =
		value && typeof value === "object"
			? (value as { code?: unknown }).code
			: undefined;
	const parsed = ComputerUseErrorCodeSchema.safeParse(code);
	return parsed.success ? parsed.data : undefined;
}

function errorMessage(value: unknown, fallback: string): string {
	return value instanceof Error && value.message ? value.message : fallback;
}

class ComputerUseOperationError extends Error {
	readonly code: ComputerUseErrorCode;
	readonly retryable: boolean;
	before?: ReturnType<typeof ComputerUseInvariantSampleSchema.parse> | undefined;
	after?: ReturnType<typeof ComputerUseInvariantSampleSchema.parse> | undefined;

	constructor(code: ComputerUseErrorCode, message: string, retryable = false) {
		super(message);
		this.name = "ComputerUseOperationError";
		this.code = code;
		this.retryable = retryable;
	}
}

function operationError(
	value: unknown,
	fallbackCode: ComputerUseErrorCode = "nativeBridgeUnavailable",
	fallbackMessage = "The background computer-use backend is unavailable.",
): ComputerUseOperationError {
	if (value instanceof ComputerUseOperationError) return value;
	return new ComputerUseOperationError(
		nativeErrorCode(value) ?? fallbackCode,
		errorMessage(value, fallbackMessage),
	);
}

function safeRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function assertRecord(value: unknown, message: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new ComputerUseOperationError("nativeBridgeUnavailable", message);
	return value as Record<string, unknown>;
}

function isBinary(value: unknown): value is Uint8Array {
	return value instanceof Uint8Array || Buffer.isBuffer(value);
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: undefined;
}

function invariantResult(
	before: ReturnType<typeof ComputerUseInvariantSampleSchema.parse>,
	after: ReturnType<typeof ComputerUseInvariantSampleSchema.parse>,
): { cursor: ComputerUseInvariantResult; foreground: ComputerUseInvariantResult } {
	const cursorChanged =
		before.cursorX !== after.cursorX || before.cursorY !== after.cursorY;
	const userMoved =
		cursorChanged &&
		(before.userActivity === "active" || after.userActivity === "active");
	return {
		cursor: cursorChanged ? (userMoved ? "user_moved" : "violated") : "held",
		foreground:
			before.frontmostPid === after.frontmostPid &&
			before.frontmostBundleId === after.frontmostBundleId &&
			after.frontmostPid !== after.targetPid
				? "held"
				: "violated",
	};
}

type AccessibilityRefreshState = { retried: boolean };

function refreshedAccessibilitySelector(
	selector: ComputerUseElementSelector,
): ComputerUseElementSelector | undefined {
	const refreshed: Record<string, unknown> = { ...selector };
	delete refreshed.elementId;
	delete refreshed.fingerprint;
	if (Array.isArray(refreshed.ancestry) && refreshed.ancestry.length === 0)
		delete refreshed.ancestry;
	return Object.keys(refreshed).length > 0
		? (refreshed as ComputerUseElementSelector)
		: undefined;
}

function nativeModuleCandidates(moduleName = "background-computer-use.node"): string[] {
	const direct = [
		join(__dirname, "../native", moduleName),
		join(process.cwd(), "apps/desktop/native", moduleName),
	];
	return [
		...direct,
		...direct.map((candidate) =>
			candidate.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`),
		),
	];
}

export function loadNativeForegroundInputBackend(): NativeForegroundInputBackend | undefined {
	if (hostPlatform() !== "darwin") return undefined;
	const requireNative = createRequire(import.meta.url);
	for (const candidate of nativeModuleCandidates("foreground-computer-input.node")) {
		try {
			const loaded = requireNative(candidate) as Partial<NativeForegroundInputBackend>;
			if (typeof loaded?.performForegroundInput === "function" &&
				typeof loaded.preflightEventAccess === "function" &&
				typeof loaded.cancelForegroundInput === "function")
				return loaded as NativeForegroundInputBackend;
		} catch {
			// A missing native asset is reflected in status and never bypassed.
		}
	}
	return undefined;
}

export function loadNativeComputerUseBackend(): NativeComputerUseBackend | undefined {
	if (hostPlatform() !== "darwin") return undefined;
	const requireNative = createRequire(import.meta.url);
	for (const candidate of nativeModuleCandidates()) {
		try {
			const loaded = requireNative(candidate) as Partial<NativeComputerUseBackend>;
			if (
				typeof loaded?.health === "function" &&
				typeof loaded.capabilities === "function" &&
				typeof loaded.listApplications === "function" &&
				typeof loaded.listWindows === "function" &&
				typeof loaded.describeWindow === "function" &&
				typeof loaded.captureWindow === "function" &&
				typeof loaded.inspectAccessibilityTree === "function" &&
				typeof loaded.resolveElement === "function" &&
				typeof loaded.performAccessibilityAction === "function" &&
				typeof loaded.setAccessibilityValue === "function" &&
				typeof loaded.readAccessibilityValue === "function" &&
				typeof loaded.getInvariantState === "function" &&
				typeof loaded.probeTargetedEventSupport === "function" &&
				typeof loaded.shutdown === "function"
			)
				return loaded as NativeComputerUseBackend;
		} catch {
			// Optional native assets must degrade to an honest unavailable state.
		}
	}
	return undefined;
}

export class ComputerUseManager {
	private settings: ComputerUseSettings = { ...DEFAULT_SETTINGS };
	private loaded = false;
	private writeChain: Promise<void> = Promise.resolve();
	private readonly platformName: NodeJS.Platform;
	private readonly architecture: string;
	private readonly osVersion: string | undefined;
	private readonly now: () => string;
	private readonly permissionProbe: ComputerUsePermissionProbe;
	private readonly kestrelPid: number;
	private readonly nativeBackendLoader: () => NativeComputerUseBackend | undefined;
	private nativeBackend: NativeComputerUseBackend | undefined;
	private nativeLoadAttempted = false;
	private nativeFailure: string | undefined;
	private readonly foregroundInputBackendLoader: () => NativeForegroundInputBackend | undefined;
	private foregroundInputBackend: NativeForegroundInputBackend | undefined;
	private foregroundInputLoadAttempted = false;
	private readonly active = new Map<string, AbortController>();
	private readonly foregroundActivationRequests = new Set<string>();
	private readonly mutationTails = new Map<string, Promise<void>>();
	private readonly unsafeTargets = new Set<string>();
	private latestFailure:
		| { code: string; message: string; at: string }
		| undefined;

	constructor(
		private readonly settingsPath: string,
		options: ComputerUseManagerOptions = {},
	) {
		this.platformName = options.platform ?? hostPlatform();
		this.architecture = options.architecture ?? hostArch();
		this.osVersion =
			options.osVersion ??
			(process.platform === "darwin"
				? (
					process as typeof process & { getSystemVersion?: () => string }
				  ).getSystemVersion?.()
				: undefined);
		this.now = options.now ?? (() => new Date().toISOString());
		this.permissionProbe =
			options.permissionProbe ?? nativePermissionProbe(this.platformName);
		this.kestrelPid = options.kestrelPid ?? process.pid;
		this.nativeBackend = options.nativeBackend;
		this.nativeBackendLoader =
			options.nativeBackendLoader ?? loadNativeComputerUseBackend;
		this.nativeLoadAttempted = Boolean(options.nativeBackend);
		this.foregroundInputBackend = options.foregroundInputBackend;
		this.foregroundInputBackendLoader = options.foregroundInputBackendLoader ?? loadNativeForegroundInputBackend;
		this.foregroundInputLoadAttempted = Boolean(options.foregroundInputBackend);
	}

	async load(): Promise<ComputerUseSettings> {
		if (this.loaded) return { ...this.settings };
		this.loaded = true;
		try {
			const raw = JSON.parse(await readFile(this.settingsPath, "utf8")) as unknown;
			const parsed = ComputerUseSettingsSchema.safeParse(raw);
			if (parsed.success) this.settings = parsed.data;
		} catch {
			// Missing or malformed preference safely remains disabled.
		}
		return { ...this.settings };
	}

	async setEnabled(enabled: boolean, foregroundEnabled?: boolean): Promise<ComputerUseSettings> {
		await this.load();
		const operation = this.writeChain.then(async () => {
			const foregroundWasEnabled = this.settings.foregroundEnabled;
			const next = ComputerUseSettingsSchema.parse({
				...this.settings,
				enabled,
				foregroundEnabled: enabled && (foregroundEnabled ?? this.settings.foregroundEnabled),
			});
			await persistAtomically(this.settingsPath, next);
			this.settings = next;
			if (!enabled || (foregroundWasEnabled && !next.foregroundEnabled)) this.stopAll();
		});
		this.writeChain = operation.catch(() => undefined);
		await operation;
		return { ...this.settings };
	}

	async status(): Promise<ComputerUseStatus> {
		await this.load();
		const screenRecording =
			this.platformName === "darwin"
				? this.safeScreenRecordingProbe()
				: "unavailable";
		const accessibility =
			this.platformName === "darwin"
				? this.safeAccessibilityProbe()
					? ("granted" as const)
					: ("not-granted" as const)
				: "unavailable";
		const nativeBackend = this.nativeBackendStatus();
		const nativeReady = nativeBackend === "healthy";
		const foregroundInputBackend = this.platformName !== "darwin" || this.architecture !== "arm64"
			? "unsupported" as const
			: this.getForegroundInputBackend() ? "healthy" as const : "unavailable" as const;
		let postEventAccess = false;
		try { postEventAccess = this.foregroundInputBackend?.preflightEventAccess() === true; } catch { /* fail closed */ }
		return ComputerUseStatusSchema.parse({
			enabled: this.settings.enabled,
			foregroundEnabled: this.settings.foregroundEnabled,
			foregroundReady: this.settings.enabled && this.settings.foregroundEnabled &&
				accessibility === "granted" && postEventAccess && foregroundInputBackend === "healthy",
			postEventAccess,
			foregroundInputBackend,
			platform: this.platformName,
			screenRecording,
			accessibility,
			captureReady:
				this.settings.enabled && nativeReady && screenRecording === "granted",
			controlReady:
				this.settings.enabled && nativeReady && accessibility === "granted",
			checkedAt: this.now(),
			nativeBackend,
			architecture: this.architecture,
			...(this.osVersion ? { osVersion: this.osVersion } : {}),
			backgroundSafeOnly: !this.settings.enabled || !this.settings.foregroundEnabled,
			activeOperations: this.active.size,
			...(this.latestFailure ? { latestFailure: this.latestFailure } : {}),
		});
	}

	stopAll(): number {
		const count = this.active.size;
		for (const [requestId, controller] of this.active) {
			controller.abort(new Error("Background computer use was stopped."));
			this.foregroundInputBackend?.cancelForegroundInput(requestId);
		}
		return count;
	}

	async shutdown(): Promise<void> {
		this.stopAll();
		const backend = this.nativeBackend;
		this.nativeBackend = undefined;
		if (backend) {
			try {
				backend.shutdown();
			} catch {
				// Native shutdown is best effort during app teardown.
			}
		}
	}

	async handle(
		raw: unknown,
		signal: AbortSignal = new AbortController().signal,
	): Promise<ComputerUseResponse> {
		const parsed = ComputerUseRequestSchema.safeParse(raw);
		if (!parsed.success) {
			const requestId =
				raw && typeof raw === "object" &&
				typeof (raw as { requestId?: unknown }).requestId === "string"
					? String((raw as { requestId: string }).requestId).slice(0, 200)
					: `invalid-${randomUUID()}`;
				return this.failure(
					requestId,
					"invalidRequest",
					"The computer-use request failed strict protocol validation.",
					false,
					"none",
					"not_checked",
					0,
				);
			}
		const request = parsed.data;
		if (this.active.has(request.requestId))
			return this.failure(
				request.requestId,
				"invalidRequest",
				"A computer-use request with this ID is already running.",
				false,
				"none",
				"not_checked",
				0,
				undefined,
				undefined,
				request.operation,
			);
		if (request.operation === "shutdown") {
			await this.shutdown();
			return this.success(request.requestId, {}, "none", "not_checked", request.operation);
		}
		if (request.operation === "cancel") {
			if (request.cancelRequestId === "*") {
				const stoppedOperations = this.stopAll();
				return this.success(
					request.requestId,
					{ cancelled: stoppedOperations > 0, stoppedOperations },
					"none",
					"not_checked",
					request.operation,
				);
			}
			const controller = this.active.get(request.cancelRequestId);
			controller?.abort(new Error("Background computer-use request cancelled."));
			return this.success(
				request.requestId,
				{ cancelled: Boolean(controller) },
				"none",
				"not_checked",
				request.operation,
			);
		}
		const controller = new AbortController();
		const onAbort = () =>
			controller.abort(
				signal.reason ?? new Error("Computer-use request cancelled."),
			);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
		const timeout = setTimeout(
			() =>
				controller.abort(
					new ComputerUseOperationError(
						"timeout",
						"The background computer-use request exceeded its deadline.",
						true,
					),
				),
			request.deadlineMs,
		);
		timeout.unref?.();
		this.active.set(request.requestId, controller);
		const startedAt = Date.now();
		try {
			if (controller.signal.aborted)
				throw operationError(
					controller.signal.reason,
					"cancelled",
					"The background computer-use request was cancelled.",
				);
			const dispatch = await this.dispatch(request, controller.signal);
			const durationMs = Date.now() - startedAt;
			if (durationMs > request.deadlineMs)
				throw new ComputerUseOperationError(
					"timeout",
					"The background computer-use request exceeded its deadline.",
					true,
				);
			return ComputerUseResponseSchema.parse({
				protocolVersion: 1,
				requestId: request.requestId,
				ok: true,
				result: dispatch.result,
				evidence: this.evidence(
					request,
					durationMs,
					dispatch.backend,
					dispatch.postcondition,
					dispatch.before,
					dispatch.after,
				),
			});
		} catch (cause) {
			const failure = operationError(
				cause,
				controller.signal.aborted ? "cancelled" : "nativeBridgeUnavailable",
				controller.signal.aborted
					? "The background computer-use request was cancelled."
					: "The background computer-use request failed.",
			);
			this.latestFailure = {
				code: failure.code,
				message: failure.message.slice(0, 500),
				at: this.now(),
			};
			const backend =
				request.operation === "captureWindow"
					? "screencapturekit"
					: request.operation === "performForegroundInput"
						? "macos-foreground-input"
					: request.operation === "health" || request.operation === "capabilities"
						? "none"
						: "macos-accessibility";
				return this.failure(
					request.requestId,
					failure.code,
					failure.message,
					failure.retryable,
					backend,
					failure.code === "invariantViolation" ? "failed" : "not_checked",
					Date.now() - startedAt,
					failure.before,
					failure.after,
					request.operation,
				);
		} finally {
			clearTimeout(timeout);
			signal.removeEventListener("abort", onAbort);
			this.foregroundActivationRequests.delete(request.requestId);
			if (this.active.get(request.requestId) === controller)
				this.active.delete(request.requestId);
		}
	}

	static settingsUrl(surface: ComputerUseSurface): string | undefined {
		return MACOS_COMPUTER_USE_SETTINGS_URLS[surface];
	}

	private nativeBackendStatus(): "healthy" | "degraded" | "unavailable" | "unsupported" {
		if (this.platformName !== "darwin" || this.architecture !== "arm64")
			return "unsupported";
		const backend = this.getNativeBackend();
		if (!backend) return "unavailable";
		try {
			return safeRecord(backend.health()).status === "healthy"
				? "healthy"
				: "degraded";
		} catch {
			return "degraded";
		}
	}

	private getNativeBackend(): NativeComputerUseBackend | undefined {
		if (this.nativeLoadAttempted) return this.nativeBackend;
		this.nativeLoadAttempted = true;
		try {
			this.nativeBackend = this.nativeBackendLoader();
			if (!this.nativeBackend)
				this.nativeFailure = "Native bridge asset was not found.";
		} catch (cause) {
			this.nativeFailure = errorMessage(cause, "Native bridge could not be loaded.");
		}
		return this.nativeBackend;
	}

	private getForegroundInputBackend(): NativeForegroundInputBackend | undefined {
		if (this.foregroundInputLoadAttempted) return this.foregroundInputBackend;
		this.foregroundInputLoadAttempted = true;
		try {
			this.foregroundInputBackend = this.foregroundInputBackendLoader();
		} catch {
			// A failed load is reported as unavailable, without falling back to global scripts.
		}
		return this.foregroundInputBackend;
	}

	private requireNative(): NativeComputerUseBackend {
		const backend = this.getNativeBackend();
		if (!backend)
			throw new ComputerUseOperationError(
				"nativeBridgeUnavailable",
				this.nativeFailure ?? "The bundled macOS native bridge is unavailable.",
				true,
			);
		return backend;
	}

	private requireEnabled(): void {
		if (!this.settings.enabled)
			throw new ComputerUseOperationError(
				"disabled",
				"Background Computer Use is disabled. Enable it in Settings → Agent → Permissions & sandbox.",
			);
		if (this.platformName !== "darwin" || this.architecture !== "arm64")
			throw new ComputerUseOperationError(
				"unsupportedPlatform",
				"Background Computer Use is available only on Apple Silicon macOS.",
			);
	}

	private requireAccessibility(): void {
		if (!this.safeAccessibilityProbe())
			throw new ComputerUseOperationError(
				"permissionDenied",
				"macOS Accessibility permission is required for semantic background control.",
				true,
			);
	}

	private requireScreenRecording(): void {
		if (this.safeScreenRecordingProbe() !== "granted")
			throw new ComputerUseOperationError(
				"permissionDenied",
				"macOS Screen Recording permission is required to capture a background window.",
				true,
			);
	}

	private safeAccessibilityProbe(): boolean {
		try {
			return this.permissionProbe.accessibility();
		} catch {
			return false;
		}
	}

	private safeScreenRecordingProbe(): ComputerUsePermissionState {
		try {
			return permissionState(this.permissionProbe.screenRecording());
		} catch {
			return "unknown";
		}
	}

	/**
	 * Native calls are currently synchronous Node-API calls, so their own
	 * native bounds remain the last line of defense against AX/ScreenCaptureKit
	 * hangs.  Racing the call with the request signal still makes the service
	 * promptly cancellable for test doubles and any future async bridge method,
	 * and prevents a late result from being treated as a successful action.
	 */
	private async callNative<T>(
		signal: AbortSignal,
		call: () => T | PromiseLike<T>,
	): Promise<T> {
		if (signal.aborted)
			throw operationError(
				signal.reason,
				"cancelled",
				"The background computer-use request was cancelled.",
			);
		let abort: (() => void) | undefined;
		try {
			const result = call();
			if (signal.aborted)
				throw operationError(
					signal.reason,
					"cancelled",
					"The background computer-use request was cancelled.",
				);
			return await Promise.race([
				Promise.resolve(result),
				new Promise<T>((_resolve, reject) => {
					abort = () =>
						reject(
							operationError(
								signal.reason,
								"cancelled",
								"The background computer-use request was cancelled.",
							),
						);
					signal.addEventListener("abort", abort, { once: true });
				}),
			]);
		} finally {
			if (abort) signal.removeEventListener("abort", abort);
		}
	}

	private async callAccessibilityWithRefresh<T>(
		signal: AbortSignal,
		selector: ComputerUseElementSelector,
		refreshState: AccessibilityRefreshState,
		call: (selector: ComputerUseElementSelector) => T | PromiseLike<T>,
	): Promise<T> {
		try {
			return await this.callNative(signal, () => call(selector));
		} catch (cause) {
			if (nativeErrorCode(cause) !== "staleElement" || refreshState.retried)
				throw cause;
			const refreshed = refreshedAccessibilitySelector(selector);
			if (!refreshed) throw cause;
			refreshState.retried = true;
			return this.callNative(signal, () => call(refreshed));
		}
	}

	private async waitForMutationSlot(
		previous: Promise<void>,
		signal: AbortSignal,
	): Promise<void> {
		if (signal.aborted)
			throw operationError(
				signal.reason,
				"cancelled",
				"The background computer-use request was cancelled.",
			);
		let abort: (() => void) | undefined;
		try {
			await Promise.race([
				previous,
				new Promise<void>((_resolve, reject) => {
					abort = () =>
						reject(
							operationError(
								signal.reason,
								"cancelled",
								"The background computer-use request was cancelled.",
							),
						);
					signal.addEventListener("abort", abort, { once: true });
				}),
			]);
		} finally {
			if (abort) signal.removeEventListener("abort", abort);
		}
	}

	private async serializeMutation<T>(
		pid: number,
		signal: AbortSignal,
		operation: () => Promise<T>,
	): Promise<T> {
		// Serialize all mutations for one process, including requests that omit a
		// window ID. A process-wide key is conservative because multiple windows
		// can share Accessibility state and a wildcard request must conflict with
		// every window owned by that process.
		const key = `${pid}:*`;
		const previous = this.mutationTails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.then(
			() => current,
			() => current,
		);
		this.mutationTails.set(key, tail);
		try {
			await this.waitForMutationSlot(previous, signal);
			if (signal.aborted)
				throw operationError(
					signal.reason,
					"cancelled",
					"The background computer-use request was cancelled.",
				);
			return await operation();
		} finally {
			release();
			if (this.mutationTails.get(key) === tail) this.mutationTails.delete(key);
		}
	}

	private assertTarget(pid: number, windowId?: number): void {
		if (pid === this.kestrelPid)
			throw new ComputerUseOperationError(
				"backgroundUnsafe",
				"Kestrel BrowserWindow and WebContents use the browser backend, never host-level computer use.",
			);
		if (this.isUnsafeTarget(pid, windowId))
			throw new ComputerUseOperationError(
				"backgroundUnsafe",
				"This application or window was marked background-unsafe for the current session.",
			);
	}

	private isUnsafeTarget(pid: number, windowId?: number): boolean {
		const key = `${pid}:${windowId ?? "*"}`;
		return this.unsafeTargets.has(key) || this.unsafeTargets.has(`${pid}:*`);
	}

	private async dispatch(
		request: ComputerUseRequest,
		signal: AbortSignal,
	): Promise<{
		result: Record<string, unknown>;
		backend: "macos-accessibility" | "macos-foreground-input" | "screencapturekit" | "none";
		postcondition: "verified" | "not_checked" | "failed";
		before?: ReturnType<typeof ComputerUseInvariantSampleSchema.parse>;
		after?: ReturnType<typeof ComputerUseInvariantSampleSchema.parse>;
	}> {
		if (request.operation === "status")
			return { result: { status: await this.status() }, backend: "none", postcondition: "not_checked" };
		if (request.operation === "performForegroundInput") {
			this.requireEnabled();
			if (!this.settings.foregroundEnabled)
				throw new ComputerUseOperationError("disabled", "Foreground Mac control is off. Enable it separately in Settings → Agent → Permissions & sandbox.");
			this.requireAccessibility();
			this.assertTarget(request.target.pid, request.target.windowId);
			const native = this.getForegroundInputBackend();
			if (!native)
				throw new ComputerUseOperationError("nativeBridgeUnavailable", "The bundled foreground input bridge is unavailable.");
			return this.serializeMutation(request.target.pid, signal, async () => {
				if (signal.aborted) throw operationError(signal.reason, "cancelled", "The foreground input action was cancelled.");
				const cancel = () => { native.cancelForegroundInput(request.requestId); };
				signal.addEventListener("abort", cancel, { once: true });
				try {
					if (request.action.type === "activate")
						this.foregroundActivationRequests.add(request.requestId);
					const result = assertRecord(await native.performForegroundInput({
						operationId: request.requestId,
						target: request.target,
						action: request.action,
					}), "The foreground bridge returned an invalid result.");
					if (!["sent", "cancelled", "interrupted"].includes(String(result.outcome)) ||
						!["unverified", "not-sent", "partial"].includes(String(result.delivery)) ||
						!["retained", "changed"].includes(String(result.targetState)) ||
						typeof result.eventsPosted !== "number" || !Number.isInteger(result.eventsPosted) ||
						result.eventsPosted < 0 || result.eventsPosted > 10_000)
						throw new ComputerUseOperationError("nativeBridgeUnavailable", "The foreground bridge returned an invalid result.");
					const receipt = ComputerUseActionReceiptSchema.parse({
						actionId: `computer-action-${randomUUID()}`,
						requestId: request.requestId,
						targetBundleId: request.target.bundleId,
						targetPid: request.target.pid,
						targetWindowId: request.target.windowId,
						requestedAction: request.action.type,
						backend: "macos-foreground-input",
						policyDecision: "allowed",
						startedAt: this.now(),
						completedAt: this.now(),
						postcondition: request.action.type === "activate"
							? "The requested app and window became foreground."
							: "Input was posted; the receiving application has not been verified.",
						cursorInvariant: "not_applicable",
						foregroundInvariant: "not_applicable",
						outcome: result.outcome === "sent"
							? request.action.type === "activate" ? "verified" : "dispatched"
							: result.outcome === "cancelled" ? "cancelled" : "failed",
					});
					return {
						result: { outcome: result.outcome, delivery: result.delivery, targetState: result.targetState,
							eventsPosted: result.eventsPosted, ...(typeof result.reason === "string" ? { reason: result.reason.slice(0, 500) } : {}), receipt },
						backend: "macos-foreground-input" as const,
						postcondition: request.action.type === "activate" && result.outcome === "sent"
							? "verified" as const : "not_checked" as const,
					};
				} finally {
					signal.removeEventListener("abort", cancel);
				}
			});
		}
		if (request.operation === "health") {
			const backend = this.getNativeBackend();
			return {
				result: backend
					? safeRecord(backend.health())
					: {
							status: this.platformName === "darwin" ? "unavailable" : "unsupported",
							protocolVersion: 1,
							architecture: this.architecture,
						},
				backend: "none",
				postcondition: "not_checked",
			};
		}
		if (request.operation === "capabilities") {
			const backend = this.getNativeBackend();
			const result = backend
				? safeRecord(backend.capabilities())
				: {
						protocolVersion: 1,
						platform: this.platformName,
						architecture: this.architecture,
						bridge: "unavailable",
					accessibility: false,
					screenCaptureKit: false,
					screenRecordingPermission: false,
					targetedEvents: false,
						backgroundSafeOnly: true,
						maxTreeNodes: 800,
						maxCaptureWidth: 3_840,
						maxCaptureHeight: 2_160,
					};
			return {
				result: ComputerUseCapabilitiesSchema.parse(result),
				backend: "none",
				postcondition: "not_checked",
			};
		}
		if (request.operation === "listApplications") {
			this.requireEnabled();
			const native = this.requireNative();
			const applications = assertRecordArray(
				await this.callNative(signal, () => native.listApplications()),
				ComputerUseApplicationSchema,
				"Native application listing was invalid.",
			);
			return {
				result: {
					applications: applications.map((application) =>
						this.isUnsafeTarget(application.pid)
							? { ...application, capability: "unsafeForSession" as const }
							: application,
					),
				},
				backend: "none",
				postcondition: "not_checked",
			};
		}
		if (request.operation === "listWindows") {
			this.requireEnabled();
			const native = this.requireNative();
			const windows = assertRecordArray(
				await this.callNative(signal, () => native.listWindows()),
				ComputerUseWindowSchema,
				"Native window listing was invalid.",
			);
			return {
				result: {
					windows: windows.map((window) =>
						this.isUnsafeTarget(window.pid, window.windowId)
							? { ...window, capability: "unsafeForSession" as const }
							: window,
					),
				},
				backend: "none",
				postcondition: "not_checked",
			};
		}
		if (request.operation === "describeWindow") {
			this.requireEnabled();
			const native = this.requireNative();
			return {
				result: {
					window: ComputerUseWindowSchema.parse(
						await this.callNative(signal, () => native.describeWindow(request.windowId)),
					),
				},
				backend: "none",
				postcondition: "not_checked",
			};
		}
		if (request.operation === "captureWindow") {
			this.requireEnabled();
			this.requireScreenRecording();
			const native = this.requireNative();
			const capture = assertRecord(
				await this.callNative(signal, () =>
					native.captureWindow(request.windowId, {
						maxWidth: request.maxWidth,
						maxHeight: request.maxHeight,
					}),
				),
				"Native window capture returned no frame.",
			);
			const width = positiveInteger(capture.width);
			const height = positiveInteger(capture.height);
			if (!width || !height || !isBinary(capture.png) || capture.png.byteLength > 20_000_000)
				throw new ComputerUseOperationError(
					"captureUnavailable",
					"The selected background window could not be captured safely.",
					true,
				);
			return {
				result: {
					windowId: request.windowId,
					width,
					height,
					pngBase64: Buffer.from(capture.png).toString("base64"),
					trust: "untrusted_background_window",
				},
				backend: "screencapturekit",
				postcondition: "verified",
			};
		}
		if (request.operation === "inspectAccessibilityTree") {
			this.requireEnabled();
			this.requireAccessibility();
			this.assertTarget(request.pid, request.windowId);
			const native = this.requireNative();
			const tree = ComputerUseAXTreeSchema.parse(
				await this.callNative(signal, () =>
					native.inspectAccessibilityTree({
						pid: request.pid,
						...(request.windowId ? { windowId: request.windowId } : {}),
						maxNodes: request.maxNodes,
						maxDepth: request.maxDepth,
					}),
				),
			);
			return {
				result: { tree },
				backend: "macos-accessibility",
				postcondition: "not_checked",
			};
		}
		if (request.operation === "resolveElement") {
			this.requireEnabled();
			this.requireAccessibility();
			this.assertTarget(request.pid, request.windowId);
			const native = this.requireNative();
			const refreshState: AccessibilityRefreshState = { retried: false };
			const node = ComputerUseAXNodeSchema.parse(
				await this.callAccessibilityWithRefresh(
					signal,
					request.selector,
					refreshState,
					(selector) =>
						native.resolveElement({
							pid: request.pid,
							...(request.windowId ? { windowId: request.windowId } : {}),
							selector,
						}),
				),
			);
			return {
				result: { node },
				backend: "macos-accessibility",
				postcondition: "not_checked",
			};
		}
		if (request.operation === "readAccessibilityValue") {
			this.requireEnabled();
			this.requireAccessibility();
			this.assertTarget(request.pid, request.windowId);
			const native = this.requireNative();
			const refreshState: AccessibilityRefreshState = { retried: false };
			const value = assertRecord(
				await this.callAccessibilityWithRefresh(
					signal,
					request.selector,
					refreshState,
					(selector) =>
						native.readAccessibilityValue({
							pid: request.pid,
							...(request.windowId ? { windowId: request.windowId } : {}),
							selector,
						}),
				),
				"The Accessibility value response was invalid.",
			);
			return {
				result: { value: value.value, redacted: Boolean(value.redacted) },
				backend: "macos-accessibility",
				postcondition: "verified",
			};
		}
		if (request.operation === "probeTargetedEventSupport") {
			this.requireEnabled();
			this.assertTarget(request.pid, request.windowId);
			return {
				result: {
					state: "unverified",
					eventClass: request.eventClass,
					backgroundSafe: false,
					reason: "Process-targeted events are disabled until an application-specific live proof exists.",
				},
				backend: "none",
				postcondition: "not_checked",
			};
		}
		if (request.operation === "getInvariantState") {
			this.requireEnabled();
			const native = this.requireNative();
			const sample = ComputerUseInvariantSampleSchema.parse(
				await this.callNative(signal, () => native.getInvariantState({
					...(request.targetPid !== undefined
						? { targetPid: request.targetPid }
						: {}),
				})),
			);
			return {
				result: { sample },
				backend: "none",
				postcondition: "not_checked",
			};
		}

		if (
			request.operation !== "performAccessibilityAction" &&
			request.operation !== "setAccessibilityValue"
		)
			throw new ComputerUseOperationError(
				"invalidRequest",
				"Unsupported computer-use operation.",
			);
		this.requireEnabled();
		this.requireAccessibility();
		this.assertTarget(request.pid, request.windowId);
		const native = this.requireNative();
		return this.serializeMutation(request.pid, signal, () =>
			this.dispatchMutation(request, signal, native),
		);
	}

	private async dispatchMutation(
		request: Extract<
			ComputerUseRequest,
			{ operation: "performAccessibilityAction" | "setAccessibilityValue" }
		>,
		signal: AbortSignal,
		native: NativeComputerUseBackend,
	): Promise<{
		result: Record<string, unknown>;
		backend: "macos-accessibility";
		postcondition: "verified" | "not_checked" | "failed";
		before?: ReturnType<typeof ComputerUseInvariantSampleSchema.parse>;
		after?: ReturnType<typeof ComputerUseInvariantSampleSchema.parse>;
	}> {
		let before: ReturnType<typeof ComputerUseInvariantSampleSchema.parse> | undefined;
		let after: ReturnType<typeof ComputerUseInvariantSampleSchema.parse> | undefined;
		let postcondition: "verified" | "not_checked" | "failed" = "not_checked";
		let result: Record<string, unknown> = {};
		let mutationAttempted = false;
		const refreshState: AccessibilityRefreshState = { retried: false };
		try {
			if (signal.aborted)
				throw operationError(
					signal.reason,
					"cancelled",
					"The background computer-use action was cancelled.",
				);
			before = ComputerUseInvariantSampleSchema.parse(
				await this.callNative(signal, () =>
					native.getInvariantState({ targetPid: request.pid }),
				),
			);
			if (before.frontmostPid === request.pid)
				throw new ComputerUseOperationError(
					"backgroundUnsafe",
					"The target application is foreground; Kestrel will not activate or take focus from it.",
				);
			if (request.operation === "performAccessibilityAction") {
				mutationAttempted = true;
				result = safeRecord(
					await this.callAccessibilityWithRefresh(
						signal,
						request.selector,
						refreshState,
						(selector) =>
							native.performAccessibilityAction({
								pid: request.pid,
								...(request.windowId
									? { windowId: request.windowId }
									: {}),
								selector,
								action: request.action,
							}),
					),
				);
				const expectedValue =
					request.postcondition?.expectedValue ?? request.expectedValue;
				if (expectedValue !== undefined) {
					const postconditionSelector =
						request.postcondition?.selector ?? request.selector;
					const read = assertRecord(
						await this.callAccessibilityWithRefresh(
							signal,
							postconditionSelector,
							refreshState,
							(selector) =>
								native.readAccessibilityValue({
									pid: request.pid,
									...(request.windowId
										? { windowId: request.windowId }
										: {}),
									selector,
								}),
						),
						"The Accessibility postcondition could not be read.",
					);
					postcondition =
						!read.redacted && Object.is(read.value, expectedValue)
							? "verified"
							: "failed";
				}
			} else {
				mutationAttempted = true;
				result = safeRecord(
					await this.callAccessibilityWithRefresh(
						signal,
						request.selector,
						refreshState,
						(selector) =>
							native.setAccessibilityValue({
								pid: request.pid,
								...(request.windowId
									? { windowId: request.windowId }
									: {}),
								selector,
								value: request.value,
								secret: request.secret,
							}),
					),
				);
				const read = assertRecord(
					await this.callAccessibilityWithRefresh(
						signal,
						request.selector,
						refreshState,
						(selector) =>
							native.readAccessibilityValue({
								pid: request.pid,
								...(request.windowId
									? { windowId: request.windowId }
									: {}),
								selector,
							}),
					),
					"The Accessibility value postcondition could not be read.",
				);
				if (!request.secret && !read.redacted) {
					const expectedValue = request.expectedValue ?? request.value;
					postcondition = Object.is(read.value, expectedValue)
						? "verified"
						: "failed";
				}
			}
			if (signal.aborted) {
				const cancelled = operationError(
					signal.reason,
					"cancelled",
					"The background computer-use action was cancelled.",
				);
				cancelled.before = before;
				cancelled.after = after;
				throw cancelled;
			}
			after = ComputerUseInvariantSampleSchema.parse(
				await this.callNative(signal, () =>
					native.getInvariantState({ targetPid: request.pid }),
				),
			);
			const invariants = invariantResult(before, after);
			if (invariants.cursor === "violated" || invariants.foreground === "violated") {
				this.unsafeTargets.add(`${request.pid}:*`);
				this.unsafeTargets.add(`${request.pid}:${request.windowId ?? "*"}`);
				const violation = new ComputerUseOperationError(
					"invariantViolation",
					`${BACKGROUND_COMPUTER_USE_MUST_NOT_CAPTURE_USER_INPUT} was not held; Kestrel stopped and disabled this target for the session.`,
				);
				violation.before = before;
				violation.after = after;
				throw violation;
			}
			if (postcondition === "failed") {
				const postconditionFailure = new ComputerUseOperationError(
					request.operation === "setAccessibilityValue"
						? "unsupportedAttribute"
						: "unsupportedAction",
					request.operation === "setAccessibilityValue"
						? "The Accessibility value did not remain set."
						: "The requested Accessibility action did not reach its expected postcondition.",
				);
				postconditionFailure.before = before;
				postconditionFailure.after = after;
				throw postconditionFailure;
			}
			const receipt: ComputerUseActionReceipt = ComputerUseActionReceiptSchema.parse({
				actionId: `computer-action-${randomUUID()}`,
				requestId: request.requestId,
				targetBundleId:
					typeof result.targetBundleId === "string"
						? result.targetBundleId
						: undefined,
				targetPid: request.pid,
				...(request.windowId ? { targetWindowId: request.windowId } : {}),
				...(request.selector.fingerprint
					? { elementFingerprint: request.selector.fingerprint }
					: {}),
				requestedAction:
					request.operation === "setAccessibilityValue"
						? "setValue"
						: request.action.type,
				backend: "macos-accessibility",
				policyDecision: "allowed",
				startedAt: before.sampledAt,
				completedAt: after.sampledAt,
				postcondition,
				cursorInvariant: invariants.cursor,
				foregroundInvariant: invariants.foreground,
				outcome: postcondition === "verified" ? "verified" : "dispatched",
			});
			return {
				result: { ...result, receipt, postcondition },
				backend: "macos-accessibility",
				postcondition,
				before,
				after,
			};
		} catch (cause) {
			const failure = operationError(
				cause,
				signal.aborted ? "cancelled" : "nativeBridgeUnavailable",
				signal.aborted
					? "The background computer-use action was cancelled."
					: "The background computer-use action failed.",
			);
			if (before && !failure.before) failure.before = before;
			if (!after && !signal.aborted) {
				try {
					after = ComputerUseInvariantSampleSchema.parse(
						await this.callNative(signal, () =>
							native.getInvariantState({ targetPid: request.pid }),
						),
					);
				} catch {
					// Preserve the pre-sample when the target is gone or the bridge stopped.
				}
			}
			if (after && !failure.after) failure.after = after;
			if (mutationAttempted && before && after) {
				const invariants = invariantResult(before, after);
				if (
					invariants.cursor === "violated" ||
					invariants.foreground === "violated"
				) {
					this.unsafeTargets.add(`${request.pid}:*`);
					this.unsafeTargets.add(`${request.pid}:${request.windowId ?? "*"}`);
					const violation = new ComputerUseOperationError(
						"invariantViolation",
						`${BACKGROUND_COMPUTER_USE_MUST_NOT_CAPTURE_USER_INPUT} was not held; Kestrel stopped and disabled this target for the session.`,
					);
					violation.before = before;
					violation.after = after;
					throw violation;
				}
			}
			throw failure;
		}
	}

	private evidence(
		request: ComputerUseRequest,
		durationMs: number,
		backend: "macos-accessibility" | "macos-foreground-input" | "screencapturekit" | "none",
		postcondition: "verified" | "not_checked" | "failed",
		before?: ReturnType<typeof ComputerUseInvariantSampleSchema.parse>,
		after?: ReturnType<typeof ComputerUseInvariantSampleSchema.parse>,
	) {
		const invariants =
			before && after
				? invariantResult(before, after)
				: {
						cursor: "not_applicable" as const,
						foreground: "not_applicable" as const,
					};
		return {
			operation: request.operation,
			durationMs: Math.min(120_000, Math.max(0, Math.trunc(durationMs))),
			backend,
			cursorInvariant: invariants.cursor,
			foregroundInvariant: invariants.foreground,
			postcondition,
			activationAttempted: this.foregroundActivationRequests.has(request.requestId),
			...(before && after ? { invariantReceipt: { before, after } } : {}),
		};
	}

	private success(
		requestId: string,
		result: Record<string, unknown>,
		backend: "macos-accessibility" | "macos-foreground-input" | "screencapturekit" | "none",
		postcondition: "verified" | "not_checked" | "failed",
		operation = "control",
	): ComputerUseResponse {
		return ComputerUseResponseSchema.parse({
			protocolVersion: 1,
			requestId,
			ok: true,
			result,
			evidence: {
				operation,
				durationMs: 0,
				backend,
				cursorInvariant: "not_applicable",
				foregroundInvariant: "not_applicable",
				postcondition,
				activationAttempted: this.foregroundActivationRequests.has(requestId),
			},
		});
	}

	private failure(
		requestId: string,
		code: ComputerUseErrorCode,
		message: string,
		retryable: boolean,
		backend: "macos-accessibility" | "macos-foreground-input" | "screencapturekit" | "none",
		postcondition: "verified" | "not_checked" | "failed",
		durationMs = 0,
		before?: ReturnType<typeof ComputerUseInvariantSampleSchema.parse>,
		after?: ReturnType<typeof ComputerUseInvariantSampleSchema.parse>,
		operation = "failed",
	): ComputerUseResponse {
		const invariants =
			before && after
				? invariantResult(before, after)
				: {
						cursor: "unknown" as const,
						foreground: "unknown" as const,
				};
		return ComputerUseResponseSchema.parse({
			protocolVersion: 1,
			requestId,
			ok: false,
			error: { code, message: message.slice(0, 2_000), retryable },
				evidence: {
				operation,
				durationMs: Math.min(120_000, Math.max(0, Math.trunc(durationMs))),
				backend,
				cursorInvariant: invariants.cursor,
				foregroundInvariant: invariants.foreground,
				postcondition,
				activationAttempted: this.foregroundActivationRequests.has(requestId),
				...(before && after ? { invariantReceipt: { before, after } } : {}),
			},
		});
	}
}

function assertRecordArray<T>(
	value: unknown,
	schema: { parse(input: unknown): T },
	message: string,
): T[] {
	if (!Array.isArray(value) || value.length > 800)
		throw new ComputerUseOperationError("nativeBridgeUnavailable", message);
	try {
		return value.map((entry) => schema.parse(entry));
	} catch {
		throw new ComputerUseOperationError("nativeBridgeUnavailable", message);
	}
}
