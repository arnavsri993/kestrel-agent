import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import {
	ComputerUsePermissionStateSchema,
	ComputerUseSettingsSchema,
	ComputerUseStatusSchema,
	type ComputerUsePermissionState,
	type ComputerUseSettings,
	type ComputerUseStatus,
} from "@kestrel/shared-types";
import type { DesktopAction } from "@kestrel/agent-core";

const MAX_CAPTURE_AGE_MS = 30_000;
const MAX_DESKTOP_PNG_BYTES = 700_000;
const SETTINGS_VERSION = 1;
const DISABLE_PERSISTENCE_ERROR = "Whole-desktop computer use is disabled for this run, but the preference could not be saved. Kestrel may restore the previously saved setting after restart.";

export type NativeDesktopBounds = { x: number; y: number; width: number; height: number };
export type NativeDesktopIdentity = {
	displayId: number;
	logicalBounds: NativeDesktopBounds;
	foregroundProcessId: number;
	frontmostWindowId: number;
	frontmostWindowBounds: NativeDesktopBounds;
};
export type NativeDesktopCapture = NativeDesktopIdentity & {
	width: number;
	height: number;
	pngBase64: string;
	capturedAt: string;
	enablementGeneration?: number;
};

export interface NativeComputerUsePlatform {
	permissions(): Promise<{ screenRecording: unknown; accessibility: unknown }>;
	capture(signal: AbortSignal): Promise<NativeDesktopCapture>;
	currentIdentity(signal: AbortSignal): Promise<NativeDesktopIdentity>;
	act(action: DesktopAction, capture: NativeDesktopCapture & { captureId: string }, signal: AbortSignal): Promise<void>;
	openSettings(surface: "screen-recording" | "accessibility"): Promise<void>;
}

function permission(value: unknown): ComputerUsePermissionState {
	const parsed = ComputerUsePermissionStateSchema.safeParse(value);
	return parsed.success ? parsed.data : "unknown";
}

function sameBounds(left: NativeDesktopBounds, right: NativeDesktopBounds): boolean {
	return ["x", "y", "width", "height"].every((key) =>
		Math.abs(left[key as keyof NativeDesktopBounds] - right[key as keyof NativeDesktopBounds]) <= 0.5,
	);
}

function sameIdentity(left: NativeDesktopIdentity, right: NativeDesktopIdentity): boolean {
	return left.displayId === right.displayId &&
		left.foregroundProcessId === right.foregroundProcessId &&
		left.frontmostWindowId === right.frontmostWindowId &&
		sameBounds(left.logicalBounds, right.logicalBounds) &&
		sameBounds(left.frontmostWindowBounds, right.frontmostWindowBounds);
}

export class NativeComputerUseManager {
	private settings: ComputerUseSettings = { version: SETTINGS_VERSION, enabled: false };
	private loaded = false;
	private disableRequested = false;
	private loadPromise: Promise<void> | undefined;
	private generation = 0;
	private captureSequence = 0;
	private readonly activeOperations = new Set<AbortController>();
	private writeChain: Promise<void> = Promise.resolve();
	private latestCapture: (NativeDesktopCapture & { captureId: string }) | undefined;

	constructor(
		private readonly settingsPath: string,
		private readonly platform: NativeComputerUsePlatform,
		private readonly now: () => number = Date.now,
	) {}

	async load(): Promise<ComputerUseSettings> {
		if (!this.loaded) {
			this.loadPromise ??= (async () => {
				let handle: Awaited<ReturnType<typeof open>> | undefined;
				try {
					handle = await open(this.settingsPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
					const info = await handle.stat();
					if (!info.isFile() || info.nlink !== 1 || info.size > 4096 || (typeof process.getuid === "function" && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) return;
					const bytes = Buffer.alloc(4097); let total = 0;
					while (total < bytes.length) {
						const read = await handle.read(bytes, total, bytes.length - total, total);
						if (!read.bytesRead) break;
						total += read.bytesRead;
					}
					if (total > 4096) return;
					const parsed = ComputerUseSettingsSchema.safeParse(JSON.parse(bytes.subarray(0, total).toString("utf8")));
					if (parsed.success && !this.disableRequested) this.settings = parsed.data;
				} catch { /* First run or an unsafe preference stays disabled. */ }
				finally { await handle?.close().catch(() => undefined); this.loaded = true; }
			})().finally(() => { this.loadPromise = undefined; });
			await this.loadPromise;
		}
		return { ...this.settings };
	}

	async status(): Promise<ComputerUseStatus> {
		await this.load();
		const permissions = await this.platform.permissions();
		const screenRecording = permission(permissions.screenRecording);
		const accessibility = permission(permissions.accessibility);
		const captureReady = this.settings.enabled && screenRecording === "granted";
		return ComputerUseStatusSchema.parse({
			enabled: this.settings.enabled,
			platform: "darwin",
			screenRecording,
			accessibility,
			captureReady,
			controlReady: captureReady && accessibility === "granted",
			checkedAt: new Date(this.now()).toISOString(),
		});
	}

	async setEnabled(enabled: boolean): Promise<ComputerUseStatus> {
		if (!enabled) {
			// Opt-out takes effect synchronously, even if preference persistence fails.
			this.disableRequested = true;
			this.settings = { version: SETTINGS_VERSION, enabled: false };
			this.generation++;
			this.latestCapture = undefined;
			for (const controller of this.activeOperations) controller.abort(new Error("Whole-desktop computer use was disabled."));
			const next = ComputerUseSettingsSchema.parse({ version: SETTINGS_VERSION, enabled: false });
			const generation = this.generation;
			const write = this.writeChain.then(() => this.persist(next));
			this.writeChain = write.catch(() => undefined);
			try { await write; }
			catch { throw new Error(DISABLE_PERSISTENCE_ERROR); }
			if (generation === this.generation) this.settings = next;
			return this.status();
		}
		await this.load();
		this.disableRequested = false;
		this.generation++;
		this.latestCapture = undefined;
		for (const controller of this.activeOperations) controller.abort(new Error("Whole-desktop computer use was disabled or changed."));
		const next = ComputerUseSettingsSchema.parse({ version: SETTINGS_VERSION, enabled });
		const generation = this.generation;
		const write = this.writeChain.then(() => this.persist(next));
		this.writeChain = write.catch(() => undefined);
		await write;
		if (generation === this.generation) this.settings = next;
		return this.status();
	}

	private async persist(next: ComputerUseSettings): Promise<void> {
		await mkdir(dirname(this.settingsPath), { recursive: true, mode: 0o700 });
		const temporaryPath = `${this.settingsPath}.${randomUUID()}.tmp`;
		try {
			const handle = await open(temporaryPath, "wx", 0o600);
			try { await handle.writeFile(`${JSON.stringify(next)}\n`, "utf8"); await handle.sync(); }
			finally { await handle.close(); }
			await chmod(temporaryPath, 0o600);
			await rename(temporaryPath, this.settingsPath);
		} finally {
			await rm(temporaryPath, { force: true }).catch(() => undefined);
		}
	}

	async openSettings(surface: "screen-recording" | "accessibility"): Promise<void> {
		if (surface !== "screen-recording" && surface !== "accessibility")
			throw new Error("The requested macOS permission surface is unavailable.");
		await this.platform.openSettings(surface);
	}

	invalidate(): void {
		this.generation++;
		this.captureSequence++;
		this.latestCapture = undefined;
		for (const controller of this.activeOperations) controller.abort(new Error("The native desktop owner was interrupted. Check any submitted action before retrying."));
	}

	async handleBackendRequest(
		request: { operation: string; action?: DesktopAction },
		signal: AbortSignal,
	): Promise<unknown> {
		if (request.operation === "desktop-screenshot") return this.capture(signal);
		if (request.operation === "desktop-act") return this.act(request.action, signal);
		throw new Error("Unsupported native computer-use operation.");
	}

	async handleHostRequest(request: { type: string; enabled?: boolean | undefined; surface?: "screen-recording" | "accessibility" | undefined }): Promise<unknown> {
		if (request.type === "computer-use-status") return { ok: true, computerUseStatus: await this.status() };
		if (request.type === "computer-use-update") {
			if (typeof request.enabled !== "boolean") throw new Error("The native computer-use preference was invalid.");
			try { return { ok: true, computerUseStatus: await this.setEnabled(request.enabled) }; }
			catch (error) {
				if (!request.enabled && error instanceof Error && error.message === DISABLE_PERSISTENCE_ERROR)
					return { ok: false, error: DISABLE_PERSISTENCE_ERROR };
				throw error;
			}
		}
		if (request.type === "computer-use-open-settings") {
			if (request.surface !== "screen-recording" && request.surface !== "accessibility") throw new Error("The requested macOS permission surface is unavailable.");
			await this.openSettings(request.surface);
			return { ok: true };
		}
		throw new Error("Unsupported native computer-use host request.");
	}

	private async requireEnabled(capture = false, control = false): Promise<void> {
		const status = await this.status();
		if (!status.enabled)
			throw new Error("Whole-desktop computer use is disabled. Enable it in Settings → Agent → Permissions & sandbox.");
		if (capture && status.screenRecording === "unavailable")
			throw new Error("Whole-desktop capture requires macOS 14 or newer.");
		if (capture && !status.captureReady)
			throw new Error(`macOS Screen Recording permission is ${status.screenRecording}; allow it in Privacy & Security to capture the desktop.`);
		if (control && !status.controlReady)
			throw new Error(`macOS Accessibility permission is ${status.accessibility}; allow it in Privacy & Security to control the desktop.`);
	}

	private async capture(signal: AbortSignal) {
		const generation = this.generation;
		const sequence = ++this.captureSequence;
		const operation = new AbortController();
		this.activeOperations.add(operation);
		const abortFromCaller = () => operation.abort(signal.reason);
		signal.addEventListener("abort", abortFromCaller, { once: true });
		try {
		this.latestCapture = undefined;
		operation.signal.throwIfAborted();
		await this.requireEnabled(true, false);
		operation.signal.throwIfAborted();
		if (generation !== this.generation) throw new Error("The native desktop capture was superseded or disabled.");
		const captured = await this.platform.capture(operation.signal);
		operation.signal.throwIfAborted();
		if (generation !== this.generation || sequence !== this.captureSequence) throw new Error("The native desktop capture was superseded or disabled.");
		if (!Number.isInteger(captured.width) || !Number.isInteger(captured.height) ||
			captured.width < 1 || captured.height < 1 || captured.width * captured.height > 8_000_000 ||
			typeof captured.pngBase64 !== "string" || captured.pngBase64.length < 44 ||
			captured.pngBase64.length > MAX_DESKTOP_PNG_BYTES ||
			!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(captured.pngBase64) ||
			!Number.isInteger(captured.displayId) || captured.displayId <= 0 ||
			!Number.isInteger(captured.foregroundProcessId) || captured.foregroundProcessId <= 0 ||
			!Number.isInteger(captured.frontmostWindowId) || captured.frontmostWindowId <= 0)
			throw new Error("The native desktop capture was invalid or exceeded the transport limit.");
		const capturedAt = new Date(captured.capturedAt);
		if (!Number.isFinite(capturedAt.getTime()) || Math.abs(capturedAt.getTime() - this.now()) > 5_000)
			throw new Error("The native desktop capture timestamp is invalid or stale.");
		const captureId = randomUUID();
		if (generation !== this.generation || sequence !== this.captureSequence) throw new Error("The native desktop capture was superseded or disabled.");
		this.latestCapture = { ...captured, captureId, enablementGeneration: generation };
		return {
			version: 1,
			encoding: "png",
			width: captured.width,
			height: captured.height,
			pngBase64: captured.pngBase64,
			trust: "untrusted_desktop",
			captureId,
			displayId: captured.displayId,
			capturedAt: captured.capturedAt,
			logicalBounds: captured.logicalBounds,
			foregroundProcessId: captured.foregroundProcessId,
			frontmostWindowId: captured.frontmostWindowId,
			frontmostWindowBounds: captured.frontmostWindowBounds,
		};
		} finally { signal.removeEventListener("abort", abortFromCaller); this.activeOperations.delete(operation); }
	}

	private async act(action: DesktopAction | undefined, signal: AbortSignal): Promise<{ performed: true }> {
		const generation = this.generation;
		const operation = new AbortController();
		this.activeOperations.add(operation);
		const abortFromCaller = () => operation.abort(signal.reason);
		signal.addEventListener("abort", abortFromCaller, { once: true });
		try {
		const captured = this.latestCapture;
		this.latestCapture = undefined;
		operation.signal.throwIfAborted();
		await this.requireEnabled(true, true);
		operation.signal.throwIfAborted();
		if (!captured || !action?.captureId || action.captureId !== captured.captureId)
			throw new Error("Native desktop actions require the matching fresh computer.screenshot captureId.");
		if (this.now() - new Date(captured.capturedAt).getTime() > MAX_CAPTURE_AGE_MS)
			throw new Error("The desktop capture expired. Take a fresh screenshot before acting.");
		if (action.type === "click" && (action.x >= captured.width || action.y >= captured.height))
			throw new Error("Desktop click coordinates must be inside the captured display image.");
		const current = await this.platform.currentIdentity(operation.signal);
		if (generation !== this.generation || !sameIdentity(captured, current))
			throw new Error("The frontmost app, window, or display changed since the screenshot. Take a fresh screenshot before acting.");
		signal.throwIfAborted();
		await this.requireEnabled(true, true);
		operation.signal.throwIfAborted();
		const finalIdentity = await this.platform.currentIdentity(operation.signal);
		if (generation !== this.generation || !sameIdentity(captured, finalIdentity)) throw new Error("The frontmost app, window, or display changed before desktop action submission.");
		operation.signal.throwIfAborted();
		try { await this.platform.act(action, captured, operation.signal); }
		catch (error) {
			if (operation.signal.aborted || generation !== this.generation || (error instanceof Error && error.message.startsWith("UNCERTAIN:")))
				throw Object.assign(new Error(error instanceof Error && error.message.startsWith("UNCERTAIN:") ? error.message.slice("UNCERTAIN:".length) : "Desktop action outcome is uncertain because interruption occurred during submission."), { outcomeUncertain: true });
			throw error;
		}
		if (operation.signal.aborted || generation !== this.generation) throw Object.assign(new Error("Desktop action outcome is uncertain because interruption occurred during submission."), { outcomeUncertain: true });
		return { performed: true };
		} finally { signal.removeEventListener("abort", abortFromCaller); this.activeOperations.delete(operation); }
	}
}
