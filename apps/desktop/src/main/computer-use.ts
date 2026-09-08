import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { platform as hostPlatform } from "node:os";
import { systemPreferences } from "electron";
import {
	ComputerUsePermissionStateSchema,
	ComputerUseSettingsSchema,
	ComputerUseStatusSchema,
	type ComputerUsePermissionState,
	type ComputerUseSettings,
	type ComputerUseStatus,
} from "@kestrel/shared-types";

export type ComputerUseSurface = "screen-recording" | "accessibility";

export const COMPUTER_USE_SETTINGS_FILE = "computer-use.json";

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

export interface ComputerUseManagerOptions {
	platform?: NodeJS.Platform;
	now?: () => string;
	permissionProbe?: ComputerUsePermissionProbe;
}

const DEFAULT_SETTINGS: ComputerUseSettings = {
	version: 1,
	enabled: false,
};

function permissionState(value: unknown): ComputerUsePermissionState {
	const parsed = ComputerUsePermissionStateSchema.safeParse(value);
	return parsed.success ? parsed.data : "unknown";
}

function nativePermissionProbe(
	platformName: NodeJS.Platform,
): ComputerUsePermissionProbe {
	if (platformName !== "darwin") {
		return {
			screenRecording: () => "unavailable",
			accessibility: () => false,
		};
	}
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
				// The status surface must never prompt for a native permission. The
				// actual capability checks use this same non-prompting probe.
				return systemPreferences.isTrustedAccessibilityClient(false);
			} catch {
				return false;
			}
		},
	};
}

async function persistAtomically(path: string, settings: ComputerUseSettings): Promise<void> {
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

export class ComputerUseManager {
	private settings: ComputerUseSettings = { ...DEFAULT_SETTINGS };
	private loaded = false;
	private writeChain: Promise<void> = Promise.resolve();
	private readonly platformName: NodeJS.Platform;
	private readonly now: () => string;
	private readonly permissionProbe: ComputerUsePermissionProbe;

	constructor(
		private readonly settingsPath: string,
		options: ComputerUseManagerOptions = {},
	) {
		this.platformName = options.platform ?? hostPlatform();
		this.now = options.now ?? (() => new Date().toISOString());
		this.permissionProbe =
			options.permissionProbe ?? nativePermissionProbe(this.platformName);
	}

	async load(): Promise<ComputerUseSettings> {
		if (this.loaded) return { ...this.settings };
		this.loaded = true;
		try {
			const raw = JSON.parse(await readFile(this.settingsPath, "utf8")) as unknown;
			const parsed = ComputerUseSettingsSchema.safeParse(raw);
			if (parsed.success) this.settings = parsed.data;
		} catch {
			// A first-run profile, missing file, or malformed preference is safely
			// disabled. Do not overwrite user data just to repair a read failure.
		}
		return { ...this.settings };
	}

	async setEnabled(enabled: boolean): Promise<ComputerUseSettings> {
		await this.load();
		const operation = this.writeChain.then(async () => {
			const next = ComputerUseSettingsSchema.parse({
				...this.settings,
				enabled,
			});
			await persistAtomically(this.settingsPath, next);
			// Keep the in-memory enforcement state unchanged if persistence fails.
			// The setting must not report enabled while the native backend still has
			// the previous value or while a restart would safely default it off.
			this.settings = next;
		});
		this.writeChain = operation.catch(() => undefined);
		await operation;
		return { ...this.settings };
	}

	async status(): Promise<ComputerUseStatus> {
		await this.load();
		const screenRecording =
			this.platformName === "darwin"
				? permissionState(this.permissionProbe.screenRecording())
				: "unavailable";
		const accessibility =
			this.platformName === "darwin"
				? this.permissionProbe.accessibility()
					? ("granted" as const)
					: ("not-granted" as const)
				: "unavailable";
		return ComputerUseStatusSchema.parse({
			enabled: this.settings.enabled,
			platform: this.platformName,
			screenRecording,
			accessibility,
			captureReady: this.settings.enabled && screenRecording === "granted",
			controlReady: this.settings.enabled && accessibility === "granted",
			checkedAt: this.now(),
		});
	}

	static settingsUrl(surface: ComputerUseSurface): string | undefined {
		return MACOS_COMPUTER_USE_SETTINGS_URLS[surface];
	}
}
