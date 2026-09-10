import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import {
	annotateAccessibilityTree,
	redactSensitiveContent,
	type BrowserAction,
	type BrowserSnapshot,
	normalizeBrowserElementRef,
	type ScreenshotFrame,
} from "@kestrel/agent-core";
import {
	type UserBrowserCommand,
	type UserBrowserBookmarkDisplayMode,
	type UserBrowserBookmarkFolder,
	type UserBrowserBookmarkFolderId,
	type UserBrowserBlockedNavigation,
	type UserBrowserDownload,
	type UserBrowserDownloadReputation,
	type UserBrowserEvent,
	type UserBrowserHistoryEntry,
	type UserBrowserPageContext,
	PaymentFormFieldSchema,
	PaymentPromptSchema,
	BrowserDataTransferSchema,
	type PaymentCardEntryId,
	type PaymentCardEntrySummary,
	type PaymentFormField,
	type PaymentPrompt,
	PasswordFormFieldSchema,
	PasswordPromptSchema,
	type PasswordEntryId,
	type PasswordEntrySummary,
	type PasswordFormField,
	type PasswordPrompt,
	UserBrowserPageContextSchema,
	type UserBrowserSettings,
	UserBrowserSettingsSchema,
	type UserBrowserState,
	UserBrowserStateSchema,
	type UserBrowserTab,
	type BrowserTabFolderName,
	type BrowserTabFolderNamingGroup,
	type UserBrowserTabOrganizationApply,
	type UserBrowserTabOrganizationPreview,
	type UserBrowserTabFolder,
	type ChromeWebStoreExtensionInspection,
	type InstalledExtension,
	type FilePreview,
	type SelectedAttachment,
	emptyNewTabGreetingActivity,
	validateBrowserTabFolderName,
} from "@kestrel/shared-types";
import {
	BrowserWindow,
	clipboard,
	dialog,
	session as electronSession,
	systemPreferences,
	Menu,
	nativeImage,
	type LoadURLOptions,
	type PostBody,
	type Rectangle,
	type Session,
	shell,
	type WebContents,
	WebContentsView,
} from "electron";
import decodeIco from "decode-ico";
import sharp from "sharp";
import { z } from "zod";
import {
	dispatchBrowserMouseClick,
	publicInteractiveRefs,
	rememberElementRefs,
	selectBrowserOption,
	targetPointFromBackendNode,
} from "./browser-backend-node-target";
import { BrowserExtensionManager } from "./browser-extension-manager";
import {
	createDefaultBrowserThreatProvider,
	normalizeThreatLookupUrl,
	type BrowserThreatProvider,
	type BrowserThreatVerdict,
	type SuspiciousDownloadAnalyzer,
} from "./browser-threat-provider";
import {
	browserExtensionOperationErrorMessage,
	chromeWebStoreInstallErrorMessage,
} from "../browser-extension-error";
import { ElectronExtensionRuntime } from "./electron-extension-runtime";
import {
	isUserBrowserBackendWireRequest,
	type UserBrowserBackendWireRequest,
} from "./browser-backend-wire";
import {
	BrowserTabStore,
	createEmptyBrowserTab,
	describeBrowserLoadFailure,
	MAX_AX_SNAPSHOT_BYTES,
	MAX_AX_SNAPSHOT_NODES,
	MAX_INTERACTIVE_REFS,
	normalizeBrowserAddress,
	redactUntrustedBrowserText,
	sanitizeBrowserUrl,
	sanitizeUntrustedBrowserValue,
	upsertOriginFavicon,
} from "./browser-tab-store";
import { organizeBrowserTabs } from "./browser-tab-folders";
import { suggestTabDeletions } from "./browser-tab-deletion-suggestions";
import {
	fileAttachment,
	fileStillExists,
	fileTabUrl,
	inspectFilePath,
	previewFile,
} from "./file-tabs";
import {
	isKestrelAppPageUrl,
	parseKestrelAppPage,
} from "../utility/browser-app-pages";
import { isLegacyBrowserDownloadDirectory } from "./user-browser-download-path";
import type { PasswordVault } from "./password-vault";
import { LoginFlowTracker } from "./login-flow-tracker";
import type { SavePaymentCardInput } from "./payment-card-vault";
import type { PaymentCardVault } from "./payment-card-vault";

// Only native WebContentsViews are capped; tab records remain unbounded and
// inactive pages are discarded to keep memory use under control.
const MAX_LIVE_TABS = 8;
const MAX_HISTORY_ENTRIES = 5_000;
const MAX_DOWNLOAD_ENTRIES = 500;
const MAX_BOOKMARKS = 2_000;
const MAX_BOOKMARK_FOLDERS = 100;
const POPUP_GESTURE_WINDOW_MS = 1_500;
const USER_BROWSER_PARTITION = "persist:kestrel-user-browser-v1";
const MAX_TAB_FOLDER_NAMING_TABS = 8;
const CONTEXT_DOWNLOAD_REQUEST_TTL_MS = 30_000;
const DIRECT_DOWNLOAD_DETECTION_WINDOW_MS = 10_000;
const SCREENSHOT_CAPTURE_TIMEOUT_MS = 5_000;
const PAGE_PREVIEW_CAPTURE_TIMEOUT_MS = 750;
const SCREENSHOT_CAPTURE_ATTEMPTS = 3;
const PASSWORD_SUBMISSION_CHANNEL = "kestrel:user-browser-password-submission";
const PASSWORD_COMMAND_CHANNEL = "kestrel:user-browser-credential-command";
const PASSWORD_RESPONSE_CHANNEL = "kestrel:user-browser-credential-response";
const PASSWORD_FORM_CHANGED_CHANNEL = "kestrel:user-browser-password-form-changed";
const PASSWORD_BRIDGE_TIMEOUT_MS = 2_500;
const STRONG_PASSWORD_LENGTH = 20;
const PASSWORD_UPPERCASE = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const PASSWORD_LOWERCASE = "abcdefghijkmnopqrstuvwxyz";
const PASSWORD_DIGITS = "23456789";
const PASSWORD_SYMBOLS = "!@#$%^&*_-+=";
const HEIC_UPLOAD_CHANNEL = "kestrel:user-browser-heic-upload";
const HEIC_UPLOAD_FAILED_CHANNEL = "kestrel:user-browser-heic-upload-failed";
const HEIC_UPLOAD_INPUT_ID_ATTRIBUTE = "data-kestrel-heic-upload-id";
const MAX_HEIC_UPLOAD_FILES = 20;
const MAX_HEIC_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_HEIC_UPLOAD_PIXELS = 75_000_000;
const HEIC_UPLOAD_CONVERSION_TIMEOUT_MS = 30_000;
const HEIC_UPLOAD_TEMPORARY_FILE_TTL_MS = 60 * 60 * 1_000;
const executeFile = promisify(execFileCallback);
const PasswordSubmissionMessageSchema = z.object({
	username: z.string().max(500),
	password: z.string().min(1).max(4_096),
	passwordFieldRect: z
		.object({
			x: z.number().int().min(0).max(20_000),
			y: z.number().int().min(0).max(20_000),
			width: z.number().int().min(0).max(20_000),
			height: z.number().int().min(0).max(20_000),
		})
		.optional(),
});
const PasswordBridgeRequestIdSchema = z
	.string()
	.regex(/^password-request-[a-f0-9-]{36}$/);
const PasswordBridgeResponseSchema = z.object({
	requestId: PasswordBridgeRequestIdSchema,
	ok: z.boolean(),
	filled: z.number().int().min(0).max(32).optional(),
	snapshot: z
		.object({
			fields: z.array(PasswordFormFieldSchema).max(32),
			focusedFieldId: z.string().regex(/^field-[0-9]+$/).optional(),
		})
		.optional(),
});
type PasswordBridgeResponse = z.infer<typeof PasswordBridgeResponseSchema>;
const HeicUploadMessageSchema = z.object({
	inputId: z.string().regex(/^[a-z0-9-]{10,100}$/),
	paths: z
		.array(z.string().min(1).max(16_384))
		.min(1)
		.max(MAX_HEIC_UPLOAD_FILES),
});
const AUTHENTICATION_HOSTS = new Set([
	"accounts.google.com",
	"auth.anthropic.com",
	"accounts.anthropic.com",
	"login.microsoftonline.com",
	"login.live.com",
	"accounts.microsoft.com",
	"appleid.apple.com",
]);
const AUTHENTICATION_PATH_PATTERN =
	/(?:^|\/)(?:auth|authenticate|authentication|authorize|authorization|challenge|consent|log[-_]?in|oauth\d*|sign[-_]?in|sign[-_]?up|signin|signup|sso|verify|verification)(?:\/|$)/i;
const APP_STORE_PROTOCOLS = new Set(["itms-apps:", "macappstore:"]);
const APP_STORE_HOSTS = new Set(["apps.apple.com", "itunes.apple.com"]);
const ALWAYS_ALLOW_PERMISSIONS = new Set([
	"fullscreen",
	"clipboard-sanitized-write",
]);
const ALWAYS_DENY_PERMISSIONS = new Set([
	"usb",
	"hid",
	"serial",
	"fileSystem",
	"windowManagement",
]);
const DOWNLOAD_DRAG_ICON = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
	'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#25282d"/><path d="M32 12v27m0 0L21 28m11 11 11-11M16 51h32" fill="none" stroke="#f0f1f2" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
)}`;

function screenshotCancellationError(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new Error("Screenshot capture was cancelled.");
}

function capturePageWithDeadline(
	webContents: WebContents,
	signal?: AbortSignal,
	timeoutMs = SCREENSHOT_CAPTURE_TIMEOUT_MS,
): ReturnType<WebContents["capturePage"]> {
	if (signal?.aborted)
		return Promise.reject(screenshotCancellationError(signal));
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (operation: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
			operation();
		};
		const abort = () =>
			finish(() => reject(screenshotCancellationError(signal!)));
		const timeout = setTimeout(
			() =>
				finish(() =>
					reject(
						new Error(
							"Visible browser screenshot capture timed out while waiting for Electron.",
						),
					),
				),
			timeoutMs,
		);
		signal?.addEventListener("abort", abort, { once: true });
		void webContents.capturePage().then(
			(image) => finish(() => resolve(image)),
			(cause) => finish(() => reject(cause)),
		);
	});
}

export { isUserBrowserBackendWireRequest };
export type { UserBrowserBackendWireRequest };

export interface UserBrowserServiceOptions {
	window: BrowserWindow;
	allowDevTools?: boolean;
	/** Explicitly enables unpacked and local archive extensions for development only. */
	allowLocalExtensions?: boolean;
	statePath: string;
	downloadDirectory: string;
	legacyDownloadDirectory?: string;
	initialState?: UserBrowserState;
	partitionName?: string;
	now?: () => Date;
	passwordVault?: PasswordVault;
	paymentCardVault?: PaymentCardVault;
	onEvent(event: UserBrowserEvent): void;
	onPasswordPrompt?(prompt: PasswordPrompt | null): void;
	onPaymentPrompt?(prompt: PaymentPrompt | null): void;
	onCommand?(command: UserBrowserCommand): void;
	onLastTabClosed?(): void;
	nameTabFolders?(groups: BrowserTabFolderNamingGroup[]): Promise<BrowserTabFolderName[]>;
	confirmSitePermission?(origin: string, permission: string): Promise<boolean>;
	requestNativeMediaAccess?(mediaType: "camera" | "microphone"): Promise<boolean>;
	/** URL-reputation adapter. Defaults to Google Safe Browsing when configured. */
	threatProvider?: BrowserThreatProvider;
	/** Reserved post-download metadata hook for a future Kestrel AI analyzer. */
	suspiciousDownloadAnalyzer?: SuspiciousDownloadAnalyzer;
	requestPasswordUserPresence?(reason: string): Promise<void>;
}

type BrowserMediaRequestType = "video" | "audio";
type NativeMediaType = "camera" | "microphone";

function isBrowserMediaRequestType(value: unknown): value is BrowserMediaRequestType {
	return value === "video" || value === "audio";
}

function mediaRequestTypes(value: unknown): BrowserMediaRequestType[] {
	if (!Array.isArray(value)) return [];
	return value.filter(isBrowserMediaRequestType);
}

function nativeMediaTypesForRequest(
	mediaTypes: readonly BrowserMediaRequestType[],
): NativeMediaType[] {
	return [
		...(mediaTypes.includes("video") ? (["camera"] as const) : []),
		...(mediaTypes.includes("audio") ? (["microphone"] as const) : []),
	];
}

function mediaPermissionLabel(
	mediaTypes: readonly BrowserMediaRequestType[],
): string {
	const requested = nativeMediaTypesForRequest(mediaTypes);
	if (requested.length === 2) return "camera and microphone";
	if (requested[0]) return requested[0];
	return "camera and microphone";
}

interface ViewRecord {
	view: WebContentsView;
	navigatingTo?: string;
	navigationGeneration: number;
	approvedNavigationUrl?: string;
	pendingDownloadNavigation?: {
		targetUrl: string;
		previousTab: UserBrowserTab;
		requestedAt: number;
		generation: number;
	};
}

/**
 * The only credential-related result that can cross the agent browser wire.
 * It intentionally contains neither a credential identifier nor account or
 * secret material: the main-process vault resolves and fills those locally.
 */
interface AgentCredentialAutofillResult {
	credentialAvailable: boolean;
	autofillResult:
		| "filled"
		| "disabled"
		| "not_active"
		| "not_a_login_form"
		| "selection_required"
		| "unavailable";
	trust: "untrusted_browser";
}

interface PendingContextDownload {
	url: string;
	defaultPath: string;
	title: string;
	requestedAt: number;
}

function liveWebContents(
	value: WebContents | null | undefined,
): WebContents | undefined {
	try {
		return value && typeof value.isDestroyed === "function" && !value.isDestroyed()
			? value
			: undefined;
	} catch {
		return undefined;
	}
}

function zoomPercent(webContents: WebContents, fallbackLevel: number): number {
	let factor = Math.pow(1.2, fallbackLevel);
	try {
		if (typeof webContents.getZoomFactor === "function")
			factor = webContents.getZoomFactor();
	} catch {
		// The level we just applied remains accurate if Electron is closing the view.
	}
	return Math.min(500, Math.max(25, Math.round(factor * 100)));
}

type BrowserNavigationLoadOptions = Pick<
	LoadURLOptions,
	"extraHeaders" | "httpReferrer" | "postData"
>;

const WINDOW_OPEN_POST_CONTENT_TYPES = new Set([
	"application/x-www-form-urlencoded",
	"multipart/form-data",
]);
const WINDOW_OPEN_UTF8_CHARSET = /^charset\s*=\s*(?:utf-8|"utf-8")$/i;

function loadOptionsForWindowOpen(
	postBody: PostBody | null | undefined,
	referrer?: LoadURLOptions["httpReferrer"],
): BrowserNavigationLoadOptions | undefined {
	if (!postBody) return undefined;
	const [rawMediaType = "", ...rawParameters] = postBody.contentType
		.trim()
		.split(";");
	const contentType = rawMediaType.trim().toLowerCase();
	if (!WINDOW_OPEN_POST_CONTENT_TYPES.has(contentType)) return undefined;
	const parameters = rawParameters.map((parameter) => parameter.trim());
	const isFormUrlEncoded =
		contentType === "application/x-www-form-urlencoded";
	const charset = parameters[0];
	if (
		parameters.some((parameter) => !parameter) ||
		(isFormUrlEncoded
			? parameters.length > 1 ||
				(charset !== undefined && !WINDOW_OPEN_UTF8_CHARSET.test(charset))
			: parameters.length > 0)
	)
		return undefined;
	const boundary = postBody.boundary?.trim();
	if (
		contentType === "multipart/form-data" &&
		(!boundary || /[\r\n]/.test(boundary))
	)
		return undefined;
	return {
		postData: postBody.data,
		extraHeaders: `Content-Type: ${contentType}${
			isFormUrlEncoded && charset ? "; charset=UTF-8" : ""
		}${boundary ? `; boundary=${boundary}` : ""}`,
		...(referrer &&
		(typeof referrer === "string" ? referrer : referrer.url)
			? { httpReferrer: referrer }
			: {}),
	};
}

function isHeicUploadPath(value: string): boolean {
	return [".heic", ".heif"].includes(extname(value).toLowerCase());
}

function temporaryJpegFilename(source: string): string {
	const name = basename(source, extname(source))
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^\.+/, "")
		.slice(0, 120);
	return `${name || "image"}.jpeg`;
}

async function convertHeicImageToJpeg(
	source: string,
	destination: string,
): Promise<void> {
	const metadata = await sharp(source, { failOn: "none" })
		.metadata()
		.catch(() => undefined);
	if (
		metadata?.width &&
		metadata.height &&
		metadata.width * metadata.height > MAX_HEIC_UPLOAD_PIXELS
	)
		throw new Error("This HEIC image is too large to convert safely.");
	let sharpError: unknown;
	try {
		await sharp(source, {
			failOn: "none",
			limitInputPixels: MAX_HEIC_UPLOAD_PIXELS,
		})
			.rotate()
			.jpeg({ quality: 92, progressive: true })
			.toFile(destination);
	} catch (cause) {
		sharpError = cause;
		// Sharp's macOS build can inspect HEIC metadata while omitting the HEVC
		// decoder needed for pixels. Let macOS convert locally in that case.
		if (process.platform !== "darwin") throw cause;
		await executeFile(
			"/usr/bin/sips",
			["-s", "format", "jpeg", source, "--out", destination],
			{
				timeout: HEIC_UPLOAD_CONVERSION_TIMEOUT_MS,
				maxBuffer: 64 * 1024,
			},
		);
	}

	const converted = statSync(destination);
	if (
		!converted.isFile() ||
		converted.size === 0 ||
		converted.size > MAX_HEIC_UPLOAD_BYTES
	) {
		throw sharpError instanceof Error
			? sharpError
			: new Error("Kestrel could not create a usable JPEG from this HEIC image.");
	}
}

function safePageUrl(value: string): URL | undefined {
	if (!value || value.length > 8_192) return undefined;
	try {
		const url = new URL(value);
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password
		)
			return undefined;
		return url;
	} catch {
		return undefined;
	}
}

/** Allow only Apple App Store deep links to cross from a page into macOS. */
export function safeAppStoreUrl(value: string): string | undefined {
	if (!value || value.length > 8_192) return undefined;
	try {
		const url = new URL(value);
		if (
			!APP_STORE_PROTOCOLS.has(url.protocol) ||
			!APP_STORE_HOSTS.has(url.hostname.toLowerCase()) ||
			url.port ||
			url.username ||
			url.password
		)
			return undefined;
		return url.toString();
	} catch {
		return undefined;
	}
}

function openAppStoreUrl(value: string): boolean {
	const url = safeAppStoreUrl(value);
	if (!url) return false;
	void Promise.resolve(shell.openExternal(url)).catch(() => undefined);
	return true;
}

function discardPasswordEntry(entry: { password: string }): void {
	entry.password = "";
}

function redactAgentVisibleBrowserText(value: unknown, maximum: number): string {
	return redactUntrustedBrowserText(
		redactSensitiveContent(String(value ?? "")),
		maximum,
	);
}

function downloadMatchesNavigation(
	item: Electron.DownloadItem,
	navigationUrl: string,
): boolean {
	const expected = safePageUrl(navigationUrl)?.toString();
	if (!expected) return false;
	let candidates = [item.getURL()];
	try {
		if (typeof item.getURLChain === "function")
			candidates = candidates.concat(item.getURLChain());
	} catch {
		// Some Electron download implementations do not expose a URL chain.
	}
	return candidates.some(
		(candidate) => safePageUrl(candidate)?.toString() === expected,
	);
}

function reputationUrlsForDownload(item: Electron.DownloadItem): string[] {
	const candidates = [item.getURL()];
	try {
		if (typeof item.getURLChain === "function")
			candidates.push(...item.getURLChain());
	} catch {
		// A partial Electron DownloadItem implementation can still be checked by
		// its final URL. Do not make the download machinery depend on a chain.
	}
	return [
		...new Set(
			candidates.flatMap((candidate) => {
				const url = safePageUrl(candidate)?.toString();
				return url ? [url] : [];
			}),
		),
	];
}

function isAbortedNavigation(cause: unknown): boolean {
	return /ERR_ABORTED/i.test(cause instanceof Error ? cause.message : String(cause));
}

function mayBecomeDirectDownload(cause: unknown): boolean {
	return /ERR_(?:ABORTED|FAILED)\b/i.test(
		cause instanceof Error ? cause.message : String(cause),
	);
}

function safeDownloadFilename(value: string, fallback: string): string {
	const trimmed = value.trim();
	if (!trimmed || trimmed === "." || trimmed === "/") return fallback;
	const cleaned = basename(trimmed)
		.replace(/[^A-Za-z0-9 ._()-]/g, "-")
		.replace(/^\.+/, "")
		.slice(0, 180);
	return cleaned || fallback;
}

function contextResourceFilename(
	url: string,
	suggestedFilename: string,
	fallback: string,
): string {
	const suggested = safeDownloadFilename(suggestedFilename, "");
	if (suggested) return suggested;
	try {
		const pathname = new URL(url).pathname;
		const filename = safeDownloadFilename(
			pathname.split("/").filter(Boolean).at(-1) ?? "",
			"",
		);
		if (filename) return filename;
	} catch {
		// The caller has already validated the URL. Keep a deterministic fallback
		// if a future Electron version supplies an unexpected URL shape here.
	}
	return fallback;
}

/**
 * Authentication pages are stateful even when their tab is not foregrounded.
 * Keep their native views alive so an OAuth opener/popup pair cannot lose its
 * session halfway through a provider redirect.
 */
export function isAuthenticationFlowUrl(value: string): boolean {
	const url = safePageUrl(value);
	if (!url) return false;
	const hostname = url.hostname.toLowerCase();
	return (
		AUTHENTICATION_HOSTS.has(hostname) ||
		/^(?:accounts?|auth|login|oauth\d*|sso)\./i.test(hostname) ||
		AUTHENTICATION_PATH_PATTERN.test(url.pathname)
	);
}

function pageDomain(value: string): string | undefined {
	const url = safePageUrl(value);
	return url?.hostname.toLowerCase().replace(/^www\./, "") || undefined;
}

function hostnameTitle(value: string): string {
	try {
		return new URL(value).hostname.replace(/^www\./, "") || "New Tab";
	} catch {
		return "New Tab";
	}
}

function isFaviconDataUrl(value: string): boolean {
	return value.startsWith("data:image/") && value.length <= 200_000;
}

function resolveFaviconReference(
	pageUrl: string,
	value: string,
): string | undefined {
	if (isFaviconDataUrl(value)) return value;
	const direct = safePageUrl(value);
	if (direct) return direct.toString();
	if (!pageUrl) return undefined;
	try {
		const resolved = new URL(value, pageUrl);
		if (
			!["http:", "https:"].includes(resolved.protocol) ||
			resolved.username ||
			resolved.password
		)
			return undefined;
		return resolved.toString();
	} catch {
		return undefined;
	}
}

function cloneState(state: UserBrowserState): UserBrowserState {
	return UserBrowserStateSchema.parse(structuredClone(state));
}

interface PasswordFormSnapshot {
	fields: PasswordFormField[];
	focusedFieldId?: string;
}

interface PendingPasswordBridgeRequest {
	webContentsId: number;
	expectedOrigin: string;
	resolve(response: PasswordBridgeResponse): void;
	reject(error: Error): void;
	timeout: ReturnType<typeof setTimeout>;
}

function parsePasswordFormSnapshot(raw: unknown): PasswordFormSnapshot {
	if (!raw || typeof raw !== "object") return { fields: [] };
	const candidate = raw as { fields?: unknown; focusedFieldId?: unknown };
	const fields = Array.isArray(candidate.fields)
		? candidate.fields.flatMap((field) => {
			const parsed = PasswordFormFieldSchema.safeParse(field);
			return parsed.success ? [parsed.data] : [];
		})
		: [];
	const focusedFieldId =
		typeof candidate.focusedFieldId === "string" &&
		fields.some((field) => field.id === candidate.focusedFieldId)
			? candidate.focusedFieldId
			: undefined;
	return { fields, ...(focusedFieldId ? { focusedFieldId } : {}) };
}

function isSensitiveAgentFieldName(value: string | undefined): boolean {
	const name = value?.normalize("NFKC").replace(/[._-]+/g, " ").trim();
	return Boolean(
		name === "Sensitive field" ||
			(name &&
				/(?:\b(?:new|current|old|confirm(?:ation)?|repeat)?\s*password\b|\b(?:one\s*time|recovery|verification|security)\s*(?:code|passcode|pin)\b|\botp\b|\b(?:cvv|cvc)\b|\bapi\s*(?:key|token)\b|\baccess\s*token\b|\bprivate\s*key\b)/i.test(
					name,
				)),
	);
}

function randomCharacter(alphabet: string): string {
	if (!alphabet) throw new Error("Password alphabet is unavailable.");
	const limit = 256 - (256 % alphabet.length);
	for (;;) {
		const byte = randomBytes(1)[0]!;
		if (byte < limit) return alphabet[byte % alphabet.length]!;
	}
}

/** Uses cryptographic randomness, avoids ambiguous characters, and guarantees
 * one character from every enabled class before filling the remaining slots. */
export function generateStrongPassword(length = STRONG_PASSWORD_LENGTH): string {
	if (!Number.isInteger(length) || length < 12 || length > 128)
		throw new Error("Generated passwords must be between 12 and 128 characters.");
	const classes = [
		PASSWORD_UPPERCASE,
		PASSWORD_LOWERCASE,
		PASSWORD_DIGITS,
		PASSWORD_SYMBOLS,
	];
	const characters = [
		...classes.map(randomCharacter),
		...Array.from({ length: length - classes.length }, () =>
			randomCharacter(classes.join("")),
		),
	];
	for (let index = characters.length - 1; index > 0; index -= 1) {
		const limit = 256 - (256 % (index + 1));
		let byte = randomBytes(1)[0]!;
		while (byte >= limit) byte = randomBytes(1)[0]!;
		const swap = byte % (index + 1);
		[characters[index], characters[swap]] = [characters[swap]!, characters[index]!];
	}
	return characters.join("");
}

const PAYMENT_FORM_SCAN_SCRIPT = String.raw`(() => {
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 &&
      rect.bottom >= 0 && rect.right >= 0 &&
      rect.top <= innerHeight && rect.left <= innerWidth &&
      style.visibility !== "hidden" && style.display !== "none" &&
      Number(style.opacity) > 0;
  };
  const text = (node) => [
    node.autocomplete,
    node.name,
    node.id,
    node.placeholder,
    node.getAttribute("aria-label"),
    node.labels?.[0]?.innerText,
  ].filter(Boolean).join(" ").toLowerCase();
  const describe = (node) => {
    const type = String(node.type || node.tagName || "").toLowerCase();
    const autocomplete = String(node.autocomplete || "").toLowerCase();
    const hint = text(node);
    let kind = null;
    if (autocomplete === "cc-number" ||
      /(?:cc[-_ ]?number|card[-_ ]?(?:number|no)|cardnumber|pan)/i.test(hint))
      kind = "card-number";
    else if (autocomplete === "cc-exp-month" ||
      /(?:cc[-_ ]?exp|card[-_ ]?(?:exp|expiry|expiration)).*month|month.*(?:exp|expiry|expiration)/i.test(hint))
      kind = "expiration-month";
    else if (autocomplete === "cc-exp-year" ||
      /(?:cc[-_ ]?exp|card[-_ ]?(?:exp|expiry|expiration)).*year|year.*(?:exp|expiry|expiration)/i.test(hint))
      kind = "expiration-year";
    else if (autocomplete === "cc-exp" ||
      /(?:cc[-_ ]?exp|card[-_ ]?(?:exp|expiry|expiration)|expir(?:y|ation))/i.test(hint))
      kind = "expiration";
    else if (autocomplete === "cc-name" ||
      /(?:cardholder|card[-_ ]?name|name[-_ ]?on[-_ ]?card)/i.test(hint))
      kind = "cardholder-name";
    else if (autocomplete === "cc-csc" || autocomplete === "cc-cvv" ||
      /(?:security|verification|cvv|cvc|csc|card[-_ ]?code)/i.test(hint))
      kind = "security-code";
    else if (autocomplete === "postal-code" ||
      /(?:billing[-_ ]?)?(?:postal|post[-_ ]?code|zip)/i.test(hint))
      kind = "postal-code";
    if (!kind) return null;
    const rect = node.getBoundingClientRect();
    const label = String(
      node.labels?.[0]?.innerText || node.getAttribute("aria-label") ||
      node.placeholder || node.name || kind
    ).replace(/\s+/g, " ").trim().slice(0, 500);
    return {
      kind,
      label,
      type: type.slice(0, 100),
      autocomplete: autocomplete.slice(0, 100),
      rect: {
        x: Math.max(0, Math.round(rect.left)),
        y: Math.max(0, Math.round(rect.top)),
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      },
      node,
    };
  };
  const rawFields = Array.from(document.querySelectorAll("input,select,textarea"))
    .filter(visible)
    .map(describe)
    .filter(Boolean)
    .slice(0, 32)
    .map((field, index) => ({ id: "payment-field-" + index, ...field }));
  const numberField = rawFields.find((field) => field.kind === "card-number");
  if (!numberField) return { fields: [] };
  const valueOf = (field) => String(field?.node?.value || "").trim();
  const cardDigits = valueOf(numberField).replace(/\D/g, "");
  const brand = (digits) => {
    if (/^4/.test(digits)) return "Visa";
    if (/^(5[1-5]|2(2[2-9]|[3-6]\d))/.test(digits)) return "Mastercard";
    if (/^3[47]/.test(digits)) return "American Express";
    if (/^(6011|65|64[4-9])/.test(digits)) return "Discover";
    if (/^(35|2131|1800)/.test(digits)) return "JCB";
    if (/^3(?:0[0-5]|[68])/.test(digits)) return "Diners Club";
    return "Card";
  };
  const expirationField = rawFields.find((field) => field.kind === "expiration");
  const monthField = rawFields.find((field) => field.kind === "expiration-month");
  const yearField = rawFields.find((field) => field.kind === "expiration-year");
  const normalizeMonth = (value) => {
    const digits = value.replace(/\D/g, "");
    return digits.length === 1 ? digits.padStart(2, "0") : digits.slice(-2);
  };
  const normalizeYear = (value) => value.replace(/\D/g, "").slice(-2);
  const expirationValue = valueOf(expirationField);
  let month = normalizeMonth(valueOf(monthField));
  let year = normalizeYear(valueOf(yearField));
  if ((!month || !year) && /^\d{4}-\d{2}$/.test(expirationValue)) {
    month ||= expirationValue.slice(5, 7);
    year ||= expirationValue.slice(2, 4);
  }
  if (!month || !year) {
    const combinedDigits = expirationValue.replace(/\D/g, "");
    if (combinedDigits.length === 3) {
      month ||= normalizeMonth(combinedDigits.slice(0, 1));
      year ||= combinedDigits.slice(-2);
    } else if (combinedDigits.length >= 4) {
      month ||= normalizeMonth(combinedDigits.slice(0, 2));
      year ||= combinedDigits.slice(-2);
    }
  }
  const passesLuhn = (digits) => {
    let sum = 0;
    let doubleDigit = false;
    for (let index = digits.length - 1; index >= 0; index -= 1) {
      let digit = Number(digits[index]);
      if (doubleDigit) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      doubleDigit = !doubleDigit;
    }
    return sum % 10 === 0;
  };
  const active = document.activeElement;
  const focusedFieldId = rawFields.find((field) => field.node === active)?.id;
  const candidate = cardDigits.length >= 12 && cardDigits.length <= 19 &&
    passesLuhn(cardDigits) && /^(0[1-9]|1[0-2])$/.test(month) && /^\d{2}$/.test(year) ? {
    brand: brand(cardDigits),
    last4: cardDigits.slice(-4),
    ...(month && /^(0[1-9]|1[0-2])$/.test(month) ? { expirationMonth: month } : {}),
    ...(year && /^\d{2}$/.test(year) ? { expirationYear: year } : {}),
  } : undefined;
  return {
    fields: rawFields.map(({ node, ...field }) => field),
    ...(focusedFieldId ? { focusedFieldId } : {}),
    ...(candidate ? { candidate } : {}),
  };
})()`;

const PAYMENT_FORM_VALUES_SCRIPT = String.raw`(() => {
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 &&
      rect.bottom >= 0 && rect.right >= 0 &&
      rect.top <= innerHeight && rect.left <= innerWidth &&
      style.visibility !== "hidden" && style.display !== "none" &&
      Number(style.opacity) > 0;
  };
  const text = (node) => [
    node.autocomplete, node.name, node.id, node.placeholder,
    node.getAttribute("aria-label"), node.labels?.[0]?.innerText,
  ].filter(Boolean).join(" ").toLowerCase();
  const describe = (node) => {
    const type = String(node.type || node.tagName || "").toLowerCase();
    const autocomplete = String(node.autocomplete || "").toLowerCase();
    const hint = text(node);
    let kind = null;
    if (autocomplete === "cc-number" || /(?:cc[-_ ]?number|card[-_ ]?(?:number|no)|cardnumber|pan)/i.test(hint)) kind = "card-number";
    else if (autocomplete === "cc-exp-month" || /(?:cc[-_ ]?exp|card[-_ ]?(?:exp|expiry|expiration)).*month|month.*(?:exp|expiry|expiration)/i.test(hint)) kind = "expiration-month";
    else if (autocomplete === "cc-exp-year" || /(?:cc[-_ ]?exp|card[-_ ]?(?:exp|expiry|expiration)).*year|year.*(?:exp|expiry|expiration)/i.test(hint)) kind = "expiration-year";
    else if (autocomplete === "cc-exp" || /(?:cc[-_ ]?exp|card[-_ ]?(?:exp|expiry|expiration)|expir(?:y|ation))/i.test(hint)) kind = "expiration";
    else if (autocomplete === "cc-name" || /(?:cardholder|card[-_ ]?name|name[-_ ]?on[-_ ]?card)/i.test(hint)) kind = "cardholder-name";
    else if (autocomplete === "cc-csc" || autocomplete === "cc-cvv" || /(?:security|verification|cvv|cvc|csc|card[-_ ]?code)/i.test(hint)) kind = "security-code";
    else if (autocomplete === "postal-code" || /(?:billing[-_ ]?)?(?:postal|post[-_ ]?code|zip)/i.test(hint)) kind = "postal-code";
    if (!kind) return null;
    const rect = node.getBoundingClientRect();
    const label = String(node.labels?.[0]?.innerText || node.getAttribute("aria-label") || node.placeholder || node.name || kind).replace(/\s+/g, " ").trim().slice(0, 500);
    return { kind, label, type: type.slice(0, 100), autocomplete: autocomplete.slice(0, 100), rect: { x: Math.max(0, Math.round(rect.left)), y: Math.max(0, Math.round(rect.top)), width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)) }, node };
  };
  const fields = Array.from(document.querySelectorAll("input,select,textarea"))
    .filter(visible).map(describe).filter(Boolean).slice(0, 32)
    .map((field, index) => ({ id: "payment-field-" + index, ...field }));
  if (!fields.some((field) => field.kind === "card-number")) return { fields: [] };
  return { fields: fields.map(({ node, ...field }) => ({ ...field, value: field.kind === "security-code" ? "" : String(node.value || "").slice(0, 2_000) })) };
})()`;

interface PaymentFormSnapshot {
	fields: PaymentFormField[];
	focusedFieldId?: string;
	candidate?: PaymentPrompt["candidate"];
}

function parsePaymentFormSnapshot(raw: unknown): PaymentFormSnapshot {
	if (!raw || typeof raw !== "object") return { fields: [] };
	const candidate = raw as {
		fields?: unknown;
		focusedFieldId?: unknown;
		candidate?: unknown;
	};
	const fields = Array.isArray(candidate.fields)
		? candidate.fields.flatMap((field) => {
			const parsed = PaymentFormFieldSchema.safeParse(field);
			return parsed.success ? [parsed.data] : [];
		})
		: [];
	const focusedFieldId =
		typeof candidate.focusedFieldId === "string" &&
		fields.some((field) => field.id === candidate.focusedFieldId)
			? candidate.focusedFieldId
			: undefined;
	const parsedCandidate = PaymentPromptSchema.shape.candidate.safeParse(
		candidate.candidate,
	);
	return {
		fields,
		...(focusedFieldId ? { focusedFieldId } : {}),
		...(parsedCandidate.success && parsedCandidate.data
			? { candidate: parsedCandidate.data }
			: {}),
	};
}

interface PaymentFormValues {
	fields: PaymentFormField[];
	values: Record<string, string>;
}

function parsePaymentFormValues(raw: unknown): PaymentFormValues {
	if (!raw || typeof raw !== "object") return { fields: [], values: {} };
	const candidate = raw as { fields?: unknown };
	const fields: PaymentFormField[] = [];
	const values: Record<string, string> = {};
	if (!Array.isArray(candidate.fields)) return { fields, values };
	for (const field of candidate.fields) {
		if (!field || typeof field !== "object") continue;
		const parsed = PaymentFormFieldSchema.safeParse(field);
		if (!parsed.success) continue;
		fields.push(parsed.data);
		const value = (field as { value?: unknown }).value;
		values[parsed.data.id] = typeof value === "string" ? value : "";
	}
	return { fields, values };
}

function paymentCardInputFromForm(
	snapshot: PaymentFormValues,
): SavePaymentCardInput {
	const valueFor = (kind: PaymentFormField["kind"]): string => {
		const field = snapshot.fields.find((candidate) => candidate.kind === kind);
		return field ? snapshot.values[field.id] ?? "" : "";
	};
	const combinedExpiration = valueFor("expiration");
	const monthValue = valueFor("expiration-month");
	const yearValue = valueFor("expiration-year");
	let expirationMonth = monthValue;
	let expirationYear = yearValue;
	if (!expirationMonth || !expirationYear) {
		if (/^\d{4}-\d{2}$/.test(combinedExpiration)) {
			const [year, month] = combinedExpiration.split("-");
			expirationMonth ||= month ?? "";
			expirationYear ||= year?.slice(-2) ?? "";
		} else {
			const digits = combinedExpiration.replace(/\D/g, "");
			if (digits.length >= 4) {
			expirationMonth ||= digits.slice(0, 2);
			expirationYear ||= digits.slice(-2);
			}
		}
	}
	return {
		cardNumber: valueFor("card-number"),
		expirationMonth,
		expirationYear,
		cardholderName: valueFor("cardholder-name"),
		postalCode: valueFor("postal-code"),
	};
}

function paymentFillScript(
	card: {
		cardNumber: string;
		expirationMonth: string;
		expirationYear: string;
		cardholderName: string;
		postalCode: string;
	},
	fieldIndex?: number,
	expectedOrigin?: string,
): string {
	const cardLiteral = JSON.stringify(card);
	const targetIndex = fieldIndex === undefined ? "undefined" : String(fieldIndex);
	const originLiteral = JSON.stringify(expectedOrigin ?? "");
	return String.raw`(() => {
  if (${originLiteral} && location.origin !== ${originLiteral}) return false;
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0;
  };
  const hint = (node) => [node.autocomplete, node.name, node.id, node.placeholder, node.getAttribute("aria-label"), node.labels?.[0]?.innerText].filter(Boolean).join(" ").toLowerCase();
  const describe = (node) => {
    const autocomplete = String(node.autocomplete || "").toLowerCase();
    const value = hint(node);
    if (autocomplete === "cc-number" || /(?:cc[-_ ]?number|card[-_ ]?(?:number|no)|cardnumber|pan)/i.test(value)) return "card-number";
    if (autocomplete === "cc-exp-month" || /(?:cc[-_ ]?exp|card[-_ ]?(?:exp|expiry|expiration)).*month|month.*(?:exp|expiry|expiration)/i.test(value)) return "expiration-month";
    if (autocomplete === "cc-exp-year" || /(?:cc[-_ ]?exp|card[-_ ]?(?:exp|expiry|expiration)).*year|year.*(?:exp|expiry|expiration)/i.test(value)) return "expiration-year";
    if (autocomplete === "cc-exp" || /(?:cc[-_ ]?exp|card[-_ ]?(?:exp|expiry|expiration)|expir(?:y|ation))/i.test(value)) return "expiration";
    if (autocomplete === "cc-name" || /(?:cardholder|card[-_ ]?name|name[-_ ]?on[-_ ]?card)/i.test(value)) return "cardholder-name";
    if (autocomplete === "cc-csc" || autocomplete === "cc-cvv" || /(?:security|verification|cvv|cvc|csc|card[-_ ]?code)/i.test(value)) return "security-code";
    if (autocomplete === "postal-code" || /(?:billing[-_ ]?)?(?:postal|post[-_ ]?code|zip)/i.test(value)) return "postal-code";
    return null;
  };
  const fields = Array.from(document.querySelectorAll("input,select,textarea")).filter(visible).map((node) => ({ node, kind: describe(node) })).filter((field) => field.kind).slice(0, 32);
  const setValue = (node, value) => {
    const prototype = Object.getPrototypeOf(node);
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(node, value); else node.value = value;
    node.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    node.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  };
  const formattedExpiry = ${cardLiteral}.expirationMonth + "/" + ${cardLiteral}.expirationYear;
  const valueFor = (kind) => {
    if (kind === "card-number") return ${cardLiteral}.cardNumber;
    if (kind === "expiration") return formattedExpiry;
    if (kind === "expiration-month") return ${cardLiteral}.expirationMonth;
    if (kind === "expiration-year") return ${cardLiteral}.expirationYear;
    if (kind === "cardholder-name") return ${cardLiteral}.cardholderName;
    if (kind === "postal-code") return ${cardLiteral}.postalCode;
    return "";
  };
  const index = ${targetIndex};
  if (index !== undefined) {
    const target = fields[index];
    if (!target || target.kind === "security-code") return false;
    setValue(target.node, valueFor(target.kind));
    target.node.focus();
    return true;
  }
  let filled = 0;
  for (const field of fields) {
    if (field.kind === "security-code") continue;
    const value = valueFor(field.kind);
    if (!value) continue;
    setValue(field.node, value);
    filled += 1;
  }
  return filled > 0;
})()`;
}

interface BrowserPartitionParticipant {
	ownsWebContents(webContents: WebContents): boolean;
	isPermissionAllowed(
		origin: string,
		permission: string,
		mediaType?: string,
	): boolean;
	resolvePermissionRequest(
		webContents: WebContents,
		permission: string,
		requestingUrl?: string,
		mediaTypes?: BrowserMediaRequestType[],
		securityOrigin?: string,
	): Promise<boolean>;
	handleWillDownload(
		event: Electron.Event,
		item: Electron.DownloadItem,
		webContents: WebContents,
	): void;
}

/**
 * Electron exposes one permission/download handler per Session. Detached
 * Kestrel windows still use the same browser profile, so route those events to
 * the service that owns the requesting WebContents instead of letting the
 * newest window replace the main window's handlers.
 */
class BrowserPartitionCoordinator {
	private readonly participants = new Set<BrowserPartitionParticipant>();

	constructor(private readonly partition: Session) {
		partition.setPermissionCheckHandler(
			(webContents, permission, requestingOrigin, details) => {
				const participant = this.find(webContents);
				const mediaType =
					permission === "media" &&
					details &&
					"mediaType" in details &&
					typeof details.mediaType === "string"
						? details.mediaType
						: undefined;
				return (
					participant?.isPermissionAllowed(
						requestingOrigin,
						String(permission),
						mediaType,
					) ?? false
				);
			},
		);
		partition.setPermissionRequestHandler(
			(webContents, permission, callback, details) => {
				const participant = this.find(webContents);
				if (!participant) {
					callback(false);
					return;
				}
				void participant
					.resolvePermissionRequest(
						webContents,
						String(permission),
						details?.requestingUrl,
						permission === "media" &&
							details &&
							"mediaTypes" in details
							? mediaRequestTypes(details.mediaTypes)
							: undefined,
						permission === "media" &&
							details &&
							"securityOrigin" in details &&
							typeof details.securityOrigin === "string"
							? details.securityOrigin
							: undefined,
					)
					.then(callback)
					.catch(() => callback(false));
			},
		);
		partition.on("will-download", (event, item, webContents) => {
			const participant = this.find(webContents);
			if (!participant) {
				item.cancel();
				return;
			}
			participant.handleWillDownload(event, item, webContents);
		});
	}

	register(participant: BrowserPartitionParticipant): void {
		this.participants.add(participant);
	}

	unregister(participant: BrowserPartitionParticipant): void {
		this.participants.delete(participant);
	}

	private find(
		webContents: WebContents | null,
	): BrowserPartitionParticipant | undefined {
		if (!webContents) return undefined;
		return [...this.participants].find((participant) =>
			participant.ownsWebContents(webContents),
		);
	}
}

const browserPartitionCoordinators = new WeakMap<
	Session,
	BrowserPartitionCoordinator
>();

function browserPartitionCoordinator(
	partition: Session,
): BrowserPartitionCoordinator {
	let coordinator = browserPartitionCoordinators.get(partition);
	if (!coordinator) {
		coordinator = new BrowserPartitionCoordinator(partition);
		browserPartitionCoordinators.set(partition, coordinator);
	}
	return coordinator;
}

export class UserBrowserService {
	private readonly window: BrowserWindow;
	private readonly store: BrowserTabStore;
	private readonly partition: Session;
	private readonly extensionManager: BrowserExtensionManager;
	private readonly extensionRuntime: ElectronExtensionRuntime;
	private readonly extensionStartup: Promise<void>;
	private readonly views = new Map<string, ViewRecord>();
	private readonly elementRefs = new Map<string, Map<string, number>>();
	private readonly sensitiveElementRefs = new Map<string, Set<string>>();
	private readonly downloadPaths = new Map<string, string>();
	private readonly pendingContextDownloads = new Map<
		number,
		PendingContextDownload[]
	>();
	private readonly activeDownloads = new Map<string, Electron.DownloadItem>();
	private readonly webContentsToTab = new Map<number, string>();
	private readonly confirmSitePermission: NonNullable<
		UserBrowserServiceOptions["confirmSitePermission"]
	>;
	private readonly requestNativeMediaAccess: NonNullable<
		UserBrowserServiceOptions["requestNativeMediaAccess"]
	>;
	private readonly requestPasswordUserPresence: NonNullable<
		UserBrowserServiceOptions["requestPasswordUserPresence"]
	>;
	private readonly now: () => Date;
	private readonly defaultDownloadDirectory: string;
	private readonly legacyDownloadDirectory: string | undefined;
	private downloadDirectory: string;
	private readonly partitionName: string;
	private readonly partitionCoordinator: BrowserPartitionCoordinator;
	private readonly partitionParticipant: BrowserPartitionParticipant;
	private readonly threatProvider: BrowserThreatProvider;
	private readonly suspiciousDownloadAnalyzer: SuspiciousDownloadAnalyzer | undefined;
	private readonly onEvent: UserBrowserServiceOptions["onEvent"];
	private readonly onPasswordPrompt?: UserBrowserServiceOptions["onPasswordPrompt"];
	private readonly passwordVault: PasswordVault | undefined;
	private readonly onPaymentPrompt?: UserBrowserServiceOptions["onPaymentPrompt"];
	private readonly paymentCardVault: PaymentCardVault | undefined;
	private readonly onCommand?: UserBrowserServiceOptions["onCommand"];
	private readonly onLastTabClosed?: UserBrowserServiceOptions["onLastTabClosed"];
	private readonly nameTabFolders?: UserBrowserServiceOptions["nameTabFolders"];
	private readonly recentlyClosedTabs: Array<{ url: string; title: string }> = [];
	private sleepingTabsInterval?: ReturnType<typeof setInterval>;
	private state: UserBrowserState;
	private contentBounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
	private contentVisible = false;
	private contentBoundsSeq = 0;
	private disposed = false;
	private paymentPollInterval: ReturnType<typeof setInterval> | undefined;
	private passwordScanInFlight = false;
	private passwordPromptGeneration = 0;
	private passwordPromptKey = "";
	private passwordPrompt: PasswordPrompt | undefined;
	private readonly pendingPasswordBridgeRequests = new Map<
		string,
		PendingPasswordBridgeRequest
	>();
	private readonly loginFlows = new LoginFlowTracker();
	private passwordSaveCommitTabId: string | undefined;
	private pendingPasswordSave:
		| {
			tabId: string;
			origin: string;
			title: string;
			username: string;
			password: string;
			submittedUrl: string;
			submittedAt: number;
			flowInitiatingOrigin?: string;
			anchor: PasswordPrompt["anchor"];
			confirmedUrl?: string;
			confirmedAt?: number;
		}
		| undefined;
	private readonly passwordPromptSuppressedUntil = new Map<string, number>();
	private readonly passwordAutofilledUntil = new Map<string, number>();
	private paymentScanInFlight = false;
	private paymentPromptKey = "";
	private paymentPrompt: PaymentPrompt | undefined;
	private readonly paymentPromptSuppressedUntil = new Map<string, number>();
	private readonly agentTabPinCounts = new Map<string, number>();
	private readonly closingTabIds = new Set<string>();
	private readonly temporaryHeicUploadDirectories = new Set<string>();
	private tabMutationQueue: Promise<void> = Promise.resolve();
	private readonly allowDevTools: boolean;

	constructor(options: UserBrowserServiceOptions) {
		this.window = options.window;
		this.allowDevTools = options.allowDevTools ?? true;
		this.store = new BrowserTabStore(options.statePath);
		this.state =
			options.initialState && !existsSync(options.statePath)
				? cloneState(options.initialState)
				: this.store.load(options.now);
		this.now = options.now ?? (() => new Date());
		this.defaultDownloadDirectory = options.downloadDirectory;
		this.legacyDownloadDirectory = options.legacyDownloadDirectory;
		const normalizedSettings = this.normalizeDownloadSettings(
			this.state.settings,
		);
		const migratedDownloadDirectory =
			normalizedSettings.downloadDirectory !==
			this.state.settings.downloadDirectory;
		if (migratedDownloadDirectory)
			this.state = { ...this.state, settings: normalizedSettings };
		this.downloadDirectory = this.configuredDownloadDirectory(
			normalizedSettings.downloadDirectory,
		);
		this.onEvent = options.onEvent;
		this.threatProvider =
			options.threatProvider ?? createDefaultBrowserThreatProvider();
		this.suspiciousDownloadAnalyzer = options.suspiciousDownloadAnalyzer;
		this.onPasswordPrompt = options.onPasswordPrompt;
		this.passwordVault = options.passwordVault;
		this.onPaymentPrompt = options.onPaymentPrompt;
		this.paymentCardVault = options.paymentCardVault;
		this.onCommand = options.onCommand;
		this.onLastTabClosed = options.onLastTabClosed;
		this.nameTabFolders = options.nameTabFolders;
		this.confirmSitePermission =
			options.confirmSitePermission ??
			(async (origin, permission) => {
				const response = await dialog.showMessageBox(this.window, {
					type: "question",
					buttons: ["Allow", "Block"],
					defaultId: 1,
					cancelId: 1,
					title: "Site permission",
					message: `${origin} wants to use ${permission}.`,
					detail:
						"Allow only if you trust this site. The choice is remembered for this profile.",
				});
				return response.response === 0;
			});
		this.requestNativeMediaAccess =
			options.requestNativeMediaAccess ??
			(async (mediaType) =>
				process.platform === "darwin"
					? systemPreferences.askForMediaAccess(mediaType)
					: true);
		this.requestPasswordUserPresence =
			options.requestPasswordUserPresence ??
			(async (reason) => {
				if (
					process.platform === "darwin" &&
					typeof systemPreferences.promptTouchID === "function"
				) {
					await systemPreferences.promptTouchID(reason);
					return;
				}
				const response = await dialog.showMessageBox(this.window, {
					type: "question",
					buttons: ["Continue", "Cancel"],
					defaultId: 1,
					cancelId: 1,
					title: "Confirm saved password access",
					message: reason,
					detail: "Confirm local access before Kestrel uses a saved password.",
				});
				if (response.response !== 0)
					throw new Error("Saved password access was cancelled.");
			});
		mkdirSync(this.downloadDirectory, { recursive: true, mode: 0o700 });
		this.extensionManager = new BrowserExtensionManager(dirname(options.statePath), {
			allowLocalExtensions: options.allowLocalExtensions === true,
		});
		this.partitionName = options.partitionName ?? USER_BROWSER_PARTITION;
		if (!/^persist:[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(this.partitionName))
			throw new Error(
				"User browser partitions must be named persistent profiles.",
			);
		this.partition = electronSession.fromPartition(this.partitionName, {
			cache: true,
		});
		this.extensionRuntime = new ElectronExtensionRuntime(this.partition);
		this.applySessionBrowserPreferences();
		this.extensionStartup = this.extensionManager
			.loadAll(this.extensionRuntime)
			.catch((error) => {
				console.warn("[Extension] Failed to restore browser extensions:", error);
			});
		this.startSleepingTabsMonitor();
		if (this.paymentCardVault) {
			this.paymentPollInterval = setInterval(() => {
				void this.refreshPaymentPrompt();
			}, 450);
			this.paymentPollInterval.unref?.();
		}
		this.partitionCoordinator = browserPartitionCoordinator(this.partition);
		this.partitionParticipant = {
			ownsWebContents: (webContents) =>
				this.webContentsToTab.has(webContents.id),
			isPermissionAllowed: (origin, permission, mediaType) =>
				this.isPermissionAllowed(origin, permission, mediaType),
			resolvePermissionRequest: (
				webContents,
				permission,
				requestingUrl,
				mediaTypes,
				securityOrigin,
			) =>
				this.resolvePermissionRequest(
					webContents,
					permission,
					requestingUrl,
					mediaTypes,
					securityOrigin,
				),
			handleWillDownload: (event, item, webContents) =>
				this.handleWillDownload(event, item, webContents),
		};
		this.partitionCoordinator.register(this.partitionParticipant);
		if (migratedDownloadDirectory) this.store.save(this.state);
		void this.backfillOriginFaviconsFromHistory();
		void this.refreshFileStatuses();
	}

	private configuredDownloadDirectory(value: string): string {
		const candidate = value.trim();
		return candidate && isAbsolute(candidate)
			? candidate
			: this.defaultDownloadDirectory;
	}

	private normalizeDownloadSettings(
		settings: UserBrowserSettings,
	): UserBrowserSettings {
		if (
			!this.legacyDownloadDirectory ||
			!isLegacyBrowserDownloadDirectory(
				settings.downloadDirectory,
				this.legacyDownloadDirectory,
			)
		)
			return settings;
		return { ...settings, downloadDirectory: "" };
	}

	private applySessionBrowserPreferences(): void {
		if (typeof this.partition.setSpellCheckerEnabled === "function")
			this.partition.setSpellCheckerEnabled(
				this.state.settings.spellcheckEnabled,
			);
		if (typeof this.partition.setSpellCheckerLanguages === "function")
			this.partition.setSpellCheckerLanguages([
				this.state.settings.spellcheckLanguage,
			]);
	}

	private applyViewBrowserPreferences(webContents: WebContents): void {
		if (typeof webContents.setZoomFactor === "function")
			webContents.setZoomFactor(this.state.settings.defaultZoomPercent / 100);
	}

	private applyBrowserSettings(
		previous: UserBrowserSettings,
		next: UserBrowserSettings,
	): void {
		const normalizedNext = this.normalizeDownloadSettings(next);
		this.state.settings = normalizedNext;
		if (normalizedNext.downloadDirectory !== previous.downloadDirectory) {
			this.downloadDirectory = this.configuredDownloadDirectory(
				normalizedNext.downloadDirectory,
			);
			mkdirSync(this.downloadDirectory, { recursive: true, mode: 0o700 });
		}
		if (
			next.spellcheckEnabled !== previous.spellcheckEnabled ||
			next.spellcheckLanguage !== previous.spellcheckLanguage
		)
			this.applySessionBrowserPreferences();
		if (next.defaultZoomPercent !== previous.defaultZoomPercent) {
			for (const { view } of this.views.values()) {
				const webContents = liveWebContents(view?.webContents);
				if (webContents) this.applyViewBrowserPreferences(webContents);
			}
		}
		if (
			next.minimumFontSize !== previous.minimumFontSize ||
			next.defaultFontFamily !== previous.defaultFontFamily ||
			next.spellcheckEnabled !== previous.spellcheckEnabled
		) {
			// Font and editor preferences are WebContents creation preferences in
			// Electron. Recreate views lazily; the tab URLs and profile data remain.
			for (const tabId of [...this.views.keys()]) this.closeView(tabId);
			this.attachActiveWebView();
		}
	}

	private async refreshFileStatuses(): Promise<void> {
		let changed = false;
		for (const tab of this.state.tabs) {
			if (!tab.file) continue;
			const available = await fileStillExists(tab.file.path);
			const next = available ? "available" : "missing";
			if (tab.file.status !== next) {
				tab.file.status = next;
				changed = true;
			}
		}
		if (changed) this.commit();
	}

	getState(): UserBrowserState {
		return cloneState(this.state);
	}

	/**
	 * Open a bounded, atomically inspected batch of local files. File tabs do
	 * not create WebContentsViews; they remain trusted renderer objects whose
	 * bytes are fetched through the main-process preview boundary.
	 */
	async openFileTabs(
		paths: string[],
		active = true,
	): Promise<{
		browserState: UserBrowserState;
		selectedAttachments: SelectedAttachment[];
	}> {
		this.assertAvailable();
		const uniquePaths = [...new Set(paths)];
		if (uniquePaths.length === 0) throw new Error("Choose at least one file.");
		if (uniquePaths.length > 8)
			throw new Error("Kestrel accepts up to 8 files at a time.");
		const inspected = await Promise.all(uniquePaths.map((path) => inspectFilePath(path)));
		const existing = new Map(
			this.state.tabs.flatMap((tab) =>
				tab.file?.path ? [[tab.file.path, tab] as const] : [],
			),
		);
		const newFiles = inspected.filter((file) => !existing.has(file.path));

		const opened: UserBrowserTab[] = [];
		for (const file of inspected) {
			const alreadyOpen = existing.get(file.path);
			if (alreadyOpen) {
				alreadyOpen.file = file;
				alreadyOpen.title = file.name;
				alreadyOpen.url = fileTabUrl(alreadyOpen.id);
				alreadyOpen.loading = false;
				alreadyOpen.error = undefined;
				opened.push(alreadyOpen);
				continue;
			}
			const timestamp = this.now().toISOString();
			const tab = createEmptyBrowserTab(() => new Date(timestamp));
			tab.title = file.name;
			tab.url = fileTabUrl(tab.id);
			tab.file = file;
			this.state.tabs.push(tab);
			existing.set(file.path, tab);
			opened.push(tab);
		}
		if (active) {
			const target = opened.at(-1);
			if (target) {
				this.state.activeTabId = target.id;
				target.lastActiveAt = this.now().toISOString();
			}
		}
		this.commit();
		await this.syncActiveView();
		return {
			browserState: this.getState(),
			selectedAttachments: inspected.flatMap((file) => {
				const attachment = fileAttachment(file);
				return attachment ? [attachment] : [];
			}),
		};
	}

	async filePreview(tabId: string): Promise<FilePreview> {
		const tab = this.requireTab(tabId);
		if (!tab.file) throw new Error("This tab is not a local file.");
		return previewFile(tab.id, tab.file);
	}

	async openFileDefault(tabId: string): Promise<void> {
		const tab = this.requireTab(tabId);
		if (!tab.file) throw new Error("This tab is not a local file.");
		if (!(await fileStillExists(tab.file.path)))
			throw new Error(`${tab.file.name} is no longer available.`);
		const error = await shell.openPath(tab.file.path);
		if (error) throw new Error(error);
	}

	knownFilePath(path: string): boolean {
		return this.state.tabs.some((tab) => tab.file?.path === path);
	}

	ownsWebContents(webContents: WebContents): boolean {
		return this.webContentsToTab.has(webContents.id);
	}

	async createTab(
		input?: string,
		active = true,
		loadOptions?: BrowserNavigationLoadOptions,
		threatSource: UserBrowserBlockedNavigation["source"] = "navigation",
	): Promise<UserBrowserState> {
		this.assertAvailable();
		const timestamp = this.now().toISOString();
		const tab = createEmptyBrowserTab(() => new Date(timestamp));
		this.state.tabs.push(tab);
		if (active || !this.state.activeTabId) this.state.activeTabId = tab.id;
		this.commit();
		if (input) await this.navigate(tab.id, input, loadOptions, threatSource);
		else await this.syncActiveView();
		return this.getState();
	}

	async selectTab(tabId: string): Promise<UserBrowserState> {
		const tab = this.requireTab(tabId);
		this.clearPasswordPrompt();
		this.clearPaymentPrompt();
		this.state.activeTabId = tabId;
		tab.lastActiveAt = this.now().toISOString();
		this.commit();
		await this.syncActiveView();
		this.discardLeastRecentViews();
		void this.refreshPasswordPrompt(tabId);
		void this.refreshPaymentPrompt(tabId);
		return this.getState();
	}

	async closeTab(tabId: string): Promise<UserBrowserState> {
		// Native page shortcuts can repeat before the first close has finished
		// switching the active WebContentsView. Treat that same in-flight request as
		// already handled instead of queueing a second close for a tab that no longer
		// exists.
		if (this.closingTabIds.has(tabId)) {
			// Wait for the mutation that owns this tab before returning. Returning the
			// current state immediately would let a duplicate IPC response overwrite
			// the renderer with the pre-close tab list.
			await this.tabMutationQueue;
			return this.getState();
		}
		this.closingTabIds.add(tabId);
		try {
			return await this.runExclusiveTabMutation(() => this.closeTabInternal(tabId));
		} finally {
			this.closingTabIds.delete(tabId);
		}
	}

	private async closeTabInternal(
		tabId: string,
		options: { commit?: boolean; sync?: boolean } = {},
	): Promise<UserBrowserState> {
		const shouldCommit = options.commit ?? true;
		const shouldSync = options.sync ?? true;
		if (this.isAgentTabPinned(tabId)) {
			throw new Error(
				"Browser tab is in use by an agent operation and cannot be closed.",
			);
		}
		const tab = this.requireTab(tabId);
		if (tabId === this.state.activeTabId) {
			this.clearPasswordPrompt();
			this.clearPaymentPrompt();
		}
		const url = sanitizeBrowserUrl(tab.url);
		if (url && safePageUrl(url) && !tab.error) {
			this.state.recentlyClosedTabs.unshift({
				url,
				title: redactUntrustedBrowserText(tab.title, 500) || hostnameTitle(url),
				closedAt: this.now().toISOString(),
			});
			this.state.recentlyClosedTabs = this.state.recentlyClosedTabs.slice(0, 32);
		}
		const index = this.state.tabs.findIndex((item) => item.id === tabId);
		this.closeView(tabId);
		this.agentTabPinCounts.delete(tabId);
		this.state.tabs.splice(index, 1);
		if (this.state.tabs.length === 0) {
			this.state.activeTabId = null;
		} else if (this.state.activeTabId === tabId) {
			this.state.activeTabId =
				this.state.tabs[Math.min(index, this.state.tabs.length - 1)]!.id;
		}
		this.pruneEmptyTabFolders();
		if (shouldCommit) this.commit();
		if (this.state.tabs.length === 0) {
			this.onLastTabClosed?.();
			return this.getState();
		}
		if (shouldSync) await this.syncActiveView();
		return this.getState();
	}

	async reopenClosedTab(index = 0): Promise<UserBrowserState> {
		if (
			!Number.isInteger(index) ||
			index < 0 ||
			index >= this.state.recentlyClosedTabs.length
		)
			return this.getState();
		const recent = this.state.recentlyClosedTabs.splice(index, 1)[0];
		if (!recent) return this.getState();
		this.commit();
		return this.createTab(recent.url, true);
	}

	async selectTabByIndex(index: number): Promise<UserBrowserState> {
		const tabs = this.state.tabs;
		if (tabs.length === 0) return this.getState();
		const targetIndex =
			index < 0 ? tabs.length - 1 : Math.min(index, tabs.length - 1);
		const target = tabs[targetIndex];
		if (!target) return this.getState();
		return this.selectTab(target.id);
	}

	zoomIn(tabId?: string): UserBrowserState {
		const targetId = tabId ?? this.state.activeTabId;
		if (!targetId) return this.getState();
		const record = this.views.get(targetId);
		const webContents = liveWebContents(record?.view?.webContents);
		if (webContents) {
			const current =
				typeof webContents.getZoomLevel === "function"
					? webContents.getZoomLevel()
					: 0;
			if (typeof webContents.setZoomLevel === "function") {
				const next = Math.min(current + 0.5, 3.0);
				webContents.setZoomLevel(next);
				this.onEvent({
					type: "zoom",
					zoom: { tabId: targetId, percent: zoomPercent(webContents, next) },
				});
			}
		}
		return this.getState();
	}

	zoomOut(tabId?: string): UserBrowserState {
		const targetId = tabId ?? this.state.activeTabId;
		if (!targetId) return this.getState();
		const record = this.views.get(targetId);
		const webContents = liveWebContents(record?.view?.webContents);
		if (webContents) {
			const current =
				typeof webContents.getZoomLevel === "function"
					? webContents.getZoomLevel()
					: 0;
			if (typeof webContents.setZoomLevel === "function") {
				const next = Math.max(current - 0.5, -3.0);
				webContents.setZoomLevel(next);
				this.onEvent({
					type: "zoom",
					zoom: { tabId: targetId, percent: zoomPercent(webContents, next) },
				});
			}
		}
		return this.getState();
	}

	zoomReset(tabId?: string): UserBrowserState {
		const targetId = tabId ?? this.state.activeTabId;
		if (!targetId) return this.getState();
		const record = this.views.get(targetId);
		const webContents = liveWebContents(record?.view?.webContents);
		if (webContents) {
			if (typeof webContents.setZoomLevel === "function") {
				webContents.setZoomLevel(0);
				this.onEvent({
					type: "zoom",
					zoom: { tabId: targetId, percent: zoomPercent(webContents, 0) },
				});
			}
		}
		return this.getState();
	}

	async navigate(
		tabId: string,
		input: string,
		loadOptions?: BrowserNavigationLoadOptions,
		threatSource: UserBrowserBlockedNavigation["source"] = "navigation",
	): Promise<UserBrowserState> {
		const tab = this.requireTab(tabId);
		const appPage = parseKestrelAppPage(input);
		if (appPage) {
			if (tabId === this.state.activeTabId) {
				this.clearPasswordPrompt();
				this.clearPaymentPrompt();
			}
			this.closeView(tabId);
			delete tab.file;
			tab.error = undefined;
			delete tab.blockedNavigation;
			tab.crashed = false;
			tab.discarded = false;
			tab.loading = false;
			tab.canGoBack = false;
			tab.canGoForward = false;
			tab.url = appPage.url;
			tab.title = appPage.title;
			this.commit();
			await this.syncActiveView();
			return this.getState();
		}
		const normalized = normalizeBrowserAddress(
			input,
			this.state.settings.searchEngine,
			this.state.settings.customSearchUrl,
		);
		if (tabId === this.state.activeTabId) {
			this.clearPasswordPrompt();
			this.clearPaymentPrompt();
		}
		delete tab.file;
		// Keep a healthy WebContentsView alive across normal web navigations so
		// Electron can retain the tab's native back/forward history. App pages,
		// file tabs, discarded views, and crashed renderers still cross an
		// explicit lifecycle boundary and receive a fresh view when needed.
		const record = this.ensureView(tab, false);
		if (!liveWebContents(record?.view?.webContents))
			throw new Error("The browser page is still waking up. Try again.");
		const generation = this.beginNavigationCheck(record);
		await this.checkAndLoadNavigation(
			tab,
			record,
			normalized.url,
			threatSource,
			generation,
			loadOptions,
		);
		this.discardLeastRecentViews();
		return this.getState();
	}

	dismissThreat(tabId: string): UserBrowserState {
		const tab = this.requireTab(tabId);
		if (!tab.blockedNavigation) return this.getState();
		delete tab.blockedNavigation;
		tab.loading = false;
		tab.error = undefined;
		this.commit();
		if (tabId === this.state.activeTabId) void this.syncActiveView();
		return this.getState();
	}

	private beginNavigationCheck(record: ViewRecord): number {
		record.navigationGeneration += 1;
		return record.navigationGeneration;
	}

	private navigationCheckIsCurrent(
		tab: UserBrowserTab,
		record: ViewRecord,
		generation: number,
	): boolean {
		return (
			!this.disposed &&
			this.views.get(tab.id) === record &&
			record.navigationGeneration === generation &&
			this.state.tabs.some((candidate) => candidate.id === tab.id)
		);
	}

	private snapshotTabBeforeNavigation(tab: UserBrowserTab): UserBrowserTab {
		const snapshot = structuredClone(tab);
		delete snapshot.blockedNavigation;
		return snapshot;
	}

	private async reputationForUrl(
		url: string,
		context: "navigation" | "download",
	): Promise<BrowserThreatVerdict | undefined> {
		if (!this.threatProvider.available) return undefined;
		const lookupUrl = normalizeThreatLookupUrl(url);
		if (!lookupUrl)
			return {
				verdict: "unknown",
				provider: this.threatProvider.id,
				reason: "invalid-response",
			};
		try {
			return await this.threatProvider.checkUrl({ url: lookupUrl, context });
		} catch {
			return {
				verdict: "unknown",
				provider: this.threatProvider.id,
				reason: "unavailable",
			};
		}
	}

	private async checkAndLoadNavigation(
		tab: UserBrowserTab,
		record: ViewRecord,
		url: string,
		source: UserBrowserBlockedNavigation["source"],
		generation: number,
		loadOptions?: BrowserNavigationLoadOptions,
	): Promise<void> {
		if (!this.navigationCheckIsCurrent(tab, record, generation)) return;
		delete tab.blockedNavigation;
		tab.error = undefined;
		tab.crashed = false;
		tab.loading = true;
		this.commit();
		if (!this.threatProvider.available) {
			await this.loadApprovedNavigation(
				tab,
				record,
				url,
				generation,
				loadOptions,
			);
			return;
		}
		const verdict = await this.reputationForUrl(url, "navigation");
		if (!this.navigationCheckIsCurrent(tab, record, generation)) return;
		if (verdict?.verdict === "malicious") {
			this.blockNavigation(tab, record, url, source, verdict);
			return;
		}
		await this.loadApprovedNavigation(
			tab,
			record,
			url,
			generation,
			loadOptions,
		);
	}

	private async checkAndRestoreStoredNavigation(
		tab: UserBrowserTab,
		record: ViewRecord,
		url: string,
		generation: number,
	): Promise<void> {
		if (!this.navigationCheckIsCurrent(tab, record, generation)) return;
		if (this.threatProvider.available) {
			const verdict = await this.reputationForUrl(url, "navigation");
			if (!this.navigationCheckIsCurrent(tab, record, generation)) return;
			if (verdict?.verdict === "malicious") {
				this.blockNavigation(tab, record, url, "navigation", verdict);
				return;
			}
		}
		const webContents = liveWebContents(record.view.webContents);
		if (!webContents) return;
		// Restoring a discarded view should preserve the existing tab title,
		// history and loading state. It is not a new user navigation, but it is
		// still reputation-checked when a provider is configured.
		record.approvedNavigationUrl = url;
		try {
			await webContents.loadURL(url);
		} catch {
			// The persisted tab remains usable even when its background restoration
			// cannot complete (for example, while offline). The regular load events
			// retain responsibility for user-visible failures.
		} finally {
			if (record.approvedNavigationUrl === url)
				delete record.approvedNavigationUrl;
		}
	}

	private blockNavigation(
		tab: UserBrowserTab,
		record: ViewRecord,
		url: string,
		source: UserBrowserBlockedNavigation["source"],
		verdict: Extract<BrowserThreatVerdict, { verdict: "malicious" }>,
	): void {
		const threatTypes = verdict.threatTypes.length
			? verdict.threatTypes.slice(0, 5)
			: (["unsafe-site"] as const);
		tab.blockedNavigation = {
			url: sanitizeBrowserUrl(url) || "https://invalid.local/",
			source,
			threatTypes: [...threatTypes],
			provider: verdict.provider.slice(0, 100) || "reputation-provider",
		};
		tab.loading = false;
		tab.error = undefined;
		tab.crashed = false;
		this.elementRefs.delete(tab.id);
		delete record.navigatingTo;
		delete record.approvedNavigationUrl;
		delete record.pendingDownloadNavigation;
		liveWebContents(record.view.webContents)?.stop();
		if (tab.id === this.state.activeTabId) {
			this.clearPasswordPrompt();
			this.clearPaymentPrompt();
		}
		this.commit();
		if (tab.id === this.state.activeTabId) void this.syncActiveView();
	}

	private async loadApprovedNavigation(
		tab: UserBrowserTab,
		record: ViewRecord,
		url: string,
		generation: number,
		loadOptions?: BrowserNavigationLoadOptions,
	): Promise<void> {
		if (!this.navigationCheckIsCurrent(tab, record, generation)) return;
		const webContents = liveWebContents(record.view.webContents);
		if (!webContents) return;
		const priorNavigation = record.pendingDownloadNavigation;
		record.pendingDownloadNavigation = {
			targetUrl: url,
			previousTab:
				priorNavigation?.previousTab ?? this.snapshotTabBeforeNavigation(tab),
			requestedAt: Date.now(),
			generation,
		};
		this.elementRefs.delete(tab.id);
		delete tab.file;
		delete tab.blockedNavigation;
		this.sensitiveElementRefs.delete(tab.id);
		tab.error = undefined;
		tab.crashed = false;
		tab.discarded = false;
		tab.loading = true;
		// The actual WebContents receives the complete URL, but persisted and
		// renderer-visible browser state stays free of credential-like values.
		tab.url = sanitizeBrowserUrl(url);
		tab.title = hostnameTitle(url);
		record.navigatingTo = url;
		this.commit();
		if (tab.id === this.state.activeTabId) this.revealActiveWebContent();
		this.attachActiveWebView();
		// A resolved loadURL does not prove a document committed: Electron may
		// deliver will-download afterward. Only did-navigate clears that snapshot.
		let directDownloadMayArrive = true;
		record.approvedNavigationUrl = url;
		try {
			if (loadOptions) await webContents.loadURL(url, loadOptions);
			else await webContents.loadURL(url);
		} catch (cause) {
			if (!this.navigationCheckIsCurrent(tab, record, generation)) return;
			directDownloadMayArrive = mayBecomeDirectDownload(cause);
			if (isAbortedNavigation(cause)) {
				// Electron can reject loadURL before its will-download event arrives.
				// Keep the short-lived pending snapshot for that event to correlate.
				tab.loading = false;
				tab.error = undefined;
				this.commit();
				return;
			}
			tab.loading = false;
			tab.error = describeBrowserLoadFailure(
				0,
				cause instanceof Error ? cause.message : "",
			);
			this.commit();
		} finally {
			if (record.approvedNavigationUrl === url)
				delete record.approvedNavigationUrl;
			if (
				this.navigationCheckIsCurrent(tab, record, generation) &&
				record.navigatingTo === url
			) {
				delete record.navigatingTo;
				if (!directDownloadMayArrive)
					delete record.pendingDownloadNavigation;
			}
		}
	}

	private interceptPageNavigation(
		tab: UserBrowserTab,
		record: ViewRecord,
		url: string,
		source: Exclude<UserBrowserBlockedNavigation["source"], "popup">,
	): void {
		const normalized = safePageUrl(url)?.toString();
		if (!normalized) return;
		const generation = this.beginNavigationCheck(record);
		void this.checkAndLoadNavigation(tab, record, normalized, source, generation);
	}

	back(tabId: string): UserBrowserState {
		const tab = this.requireTab(tabId);
		if (tab.blockedNavigation) return this.dismissThreat(tabId);
		if (isKestrelAppPageUrl(tab.url)) return this.getState();
		const record = this.requireView(tabId);
		const webContents = liveWebContents(record?.view?.webContents);
		if (webContents?.navigationHistory.canGoBack())
			this.requestHistoryNavigation(tab, record, webContents, -1);
		return this.getState();
	}

	forward(tabId: string): UserBrowserState {
		const tab = this.requireTab(tabId);
		if (isKestrelAppPageUrl(tab.url)) return this.getState();
		const record = this.requireView(tabId);
		const webContents = liveWebContents(record?.view?.webContents);
		if (webContents?.navigationHistory.canGoForward())
			this.requestHistoryNavigation(tab, record, webContents, 1);
		return this.getState();
	}

	private requestHistoryNavigation(
		tab: UserBrowserTab,
		record: ViewRecord,
		webContents: WebContents,
		offset: -1 | 1,
	): void {
		if (!this.threatProvider.available) {
			if (offset < 0) webContents.navigationHistory.goBack();
			else webContents.navigationHistory.goForward();
			return;
		}
		const target = this.historyNavigationTarget(webContents, offset);
		// A configured provider must never be bypassed just because Electron
		// cannot expose the destination history entry on an older runtime.
		if (!target) return;
		const generation = this.beginNavigationCheck(record);
		void this.checkAndRunHistoryNavigation(
			tab,
			record,
			webContents,
			target,
			generation,
			offset,
		).catch(() => undefined);
	}

	private historyNavigationTarget(
		webContents: WebContents,
		offset: -1 | 1,
	): string | undefined {
		const history = webContents.navigationHistory;
		if (
			typeof history.getActiveIndex !== "function" ||
			typeof history.getEntryAtIndex !== "function"
		)
			return undefined;
		try {
			const entry = history.getEntryAtIndex(
				history.getActiveIndex() + offset,
			);
			return safePageUrl(entry?.url ?? "")?.toString();
		} catch {
			return undefined;
		}
	}

	private async checkAndRunHistoryNavigation(
		tab: UserBrowserTab,
		record: ViewRecord,
		webContents: WebContents,
		url: string,
		generation: number,
		offset: -1 | 1,
	): Promise<void> {
		if (!this.navigationCheckIsCurrent(tab, record, generation)) return;
		tab.loading = true;
		tab.error = undefined;
		tab.crashed = false;
		this.commit();
		const verdict = await this.reputationForUrl(url, "navigation");
		if (!this.navigationCheckIsCurrent(tab, record, generation)) return;
		if (verdict?.verdict === "malicious") {
			this.blockNavigation(tab, record, url, "navigation", verdict);
			return;
		}
		if (!liveWebContents(webContents)) return;
		if (offset < 0) webContents.navigationHistory.goBack();
		else webContents.navigationHistory.goForward();
	}

	reload(tabId: string, ignoreCache = false): UserBrowserState {
		const tab = this.requireTab(tabId);
		if (tab.blockedNavigation) {
			void this.navigate(tabId, tab.blockedNavigation.url).catch(() => undefined);
			return this.getState();
		}
		if (!tab.url || isKestrelAppPageUrl(tab.url)) return this.getState();
		this.elementRefs.delete(tabId);
		this.sensitiveElementRefs.delete(tabId);
		tab.error = undefined;
		tab.crashed = false;
		const record = this.ensureView(tab);
		if (tabId === this.state.activeTabId) this.revealActiveWebContent();
		this.attachActiveWebView();
		const webContents = liveWebContents(record?.view?.webContents);
		if (!webContents) return this.getState();
		const normalized = safePageUrl(tab.url)?.toString();
		if (!normalized) return this.getState();
		const generation = this.beginNavigationCheck(record);
		void this.checkAndReloadNavigation(
			tab,
			record,
			normalized,
			generation,
			ignoreCache,
		).catch(() => undefined);
		return this.getState();
	}

	private async checkAndReloadNavigation(
		tab: UserBrowserTab,
		record: ViewRecord,
		url: string,
		generation: number,
		ignoreCache: boolean,
	): Promise<void> {
		if (!this.navigationCheckIsCurrent(tab, record, generation)) return;
		tab.loading = true;
		tab.error = undefined;
		tab.crashed = false;
		this.commit();
		if (!this.threatProvider.available) {
			const webContents = liveWebContents(record.view.webContents);
			if (!webContents) return;
			const loadedUrl = webContents.getURL?.() ?? "";
			if (!loadedUrl) {
				await this.loadApprovedNavigation(tab, record, url, generation);
				return;
			}
			if (
				ignoreCache &&
				typeof webContents.reloadIgnoringCache === "function"
			)
				webContents.reloadIgnoringCache();
			else webContents.reload();
			return;
		}
		const verdict = await this.reputationForUrl(url, "navigation");
		if (!this.navigationCheckIsCurrent(tab, record, generation)) return;
		if (verdict?.verdict === "malicious") {
			this.blockNavigation(tab, record, url, "navigation", verdict);
			return;
		}
		const webContents = liveWebContents(record.view.webContents);
		if (!webContents) return;
		const loadedUrl = webContents.getURL?.() ?? "";
		if (!loadedUrl) {
			await this.loadApprovedNavigation(tab, record, url, generation);
			return;
		}
		if (
			ignoreCache &&
			typeof webContents.reloadIgnoringCache === "function"
		) {
			webContents.reloadIgnoringCache();
		} else {
			webContents.reload();
		}
	}

	stop(tabId: string): UserBrowserState {
		const tab = this.requireTab(tabId);
		if (isKestrelAppPageUrl(tab.url)) return this.getState();
		liveWebContents(this.requireView(tabId)?.view?.webContents)?.stop();
		return this.getState();
	}

	async setContentBounds(
		bounds: Rectangle,
		visible: boolean,
	): Promise<string | undefined> {
		this.assertAvailable();
		const seq = ++this.contentBoundsSeq;
		const pagePreviewPromise =
			!visible && bounds.width >= 160 && bounds.height >= 120
				? this.captureNativePagePreview()
				: undefined;
		if (!visible) {
			// Release native input before waiting for the optional screenshot. A
			// WebContentsView sibling can otherwise swallow renderer pointerup
			// events while capturePage is in flight. The capture was started above
			// while the active view was still attached, so the preview remains valid.
			for (const { view } of this.views.values()) {
				view.setVisible(false);
				if (this.window.contentView.children.includes(view))
					this.window.contentView.removeChildView(view);
			}
		}
		// Renderer menus live in the main window's renderer, while web pages are
		// native WebContentsViews painted above that renderer. Capture the page
		// before returning the preview so opening a menu does not turn the entire
		// page area into an empty canvas.
		const pagePreview = pagePreviewPromise
			? await pagePreviewPromise
			: undefined;
		if (seq !== this.contentBoundsSeq) return undefined;
		const size = this.window.getContentSize();
		const windowWidth = size[0] ?? 0;
		const windowHeight = size[1] ?? 0;
		const x = Math.min(Math.max(0, Math.round(bounds.x)), windowWidth);
		const y = Math.min(Math.max(0, Math.round(bounds.y)), windowHeight);
		const width = Math.min(
			Math.max(0, Math.round(bounds.width)),
			Math.max(0, windowWidth - x),
		);
		const height = Math.min(
			Math.max(0, Math.round(bounds.height)),
			Math.max(0, windowHeight - y),
		);
		this.contentBounds = { x, y, width, height };
		this.contentVisible = visible && width >= 160 && height >= 120;
		await this.syncActiveView();
		if (seq !== this.contentBoundsSeq) await this.syncActiveView();
		return pagePreview;
	}

	private async captureNativePagePreview(): Promise<string | undefined> {
		if (!this.contentVisible) return undefined;
		const tab = this.state.tabs.find(
			(candidate) => candidate.id === this.state.activeTabId,
		);
		if (
			!tab ||
			!tab.url ||
			tab.error ||
			tab.blockedNavigation ||
			tab.file ||
			isKestrelAppPageUrl(tab.url)
		)
			return undefined;
		const record = this.views.get(tab.id);
		const webContents = liveWebContents(record?.view?.webContents);
		if (
			!record ||
			!webContents ||
			!this.window.contentView.children.includes(record.view)
		)
			return undefined;
		try {
			const image = await capturePageWithDeadline(
				webContents,
				undefined,
				PAGE_PREVIEW_CAPTURE_TIMEOUT_MS,
			);
			const { width, height } = image.getSize();
			if (width < 1 || height < 1) return undefined;
			return `data:image/png;base64,${image.toPNG().toString("base64")}`;
		} catch {
			// The native view is still hidden even if Electron cannot provide a
			// frame. The menu remains usable and the renderer falls back to its
			// normal canvas background.
			return undefined;
		}
	}

	updateSettings(settings: UserBrowserSettings): UserBrowserState {
		const previous = this.state.settings;
		this.applyBrowserSettings(previous, { ...settings });
		this.pruneHistory();
		this.commit();
		if (settings.passwordAutofillEnabled === false) this.clearPasswordPrompt();
		else void this.refreshPasswordPrompt();
		if (settings.paymentAutofillEnabled === false) this.clearPaymentPrompt();
		else void this.refreshPaymentPrompt();
		return this.getState();
	}

	resetSettings(): UserBrowserState {
		const previous = this.state.settings;
		const next = UserBrowserSettingsSchema.parse({});
		this.applyBrowserSettings(previous, next);
		this.commit();
		void this.refreshPasswordPrompt();
		void this.refreshPaymentPrompt();
		return this.getState();
	}

	clearHistory(): UserBrowserState {
		this.state.history = [];
		this.state.originFavicons = [];
		this.state.recentlyClosedTabs = [];
		this.state.settings = {
			...this.state.settings,
			newTabGreetingActivity: emptyNewTabGreetingActivity(),
		};
		for (const record of this.views.values())
			liveWebContents(record?.view?.webContents)?.navigationHistory.clear();
		this.commit();
		return this.getState();
	}

	revealDownload(downloadId: string): void {
		const available = this.availableDownload(downloadId);
		if (!available)
			throw new Error("This download is no longer available to reveal.");
		shell.showItemInFolder(available.path);
	}

	async openDownload(downloadId: string): Promise<void> {
		const available = this.availableDownload(downloadId);
		if (!available)
			throw new Error("This download is no longer available to open.");
		const error = await shell.openPath(available.path);
		if (error) throw new Error(error);
	}

	startDownloadDrag(downloadId: string): void {
		this.assertAvailable();
		const available = this.availableDownload(downloadId);
		if (!available || available.download.status !== "completed")
			throw new Error("This download is no longer available to drag.");
		this.window.webContents.startDrag({
			file: available.path,
			icon: nativeImage.createFromDataURL(DOWNLOAD_DRAG_ICON),
		});
	}

	cancelDownload(downloadId: string): UserBrowserState {
		const item = this.activeDownloads.get(downloadId);
		if (!item) throw new Error("This download is not in progress.");
		const record = this.state.downloads.find(
			(download) => download.id === downloadId,
		);
		if (record?.status === "checking" || record?.status === "progressing") {
			record.status = "cancelled";
			record.completedAt = this.now().toISOString();
			record.canReveal = false;
			this.commit();
		}
		item.cancel();
		return this.getState();
	}

	async clearBrowsingData(options: {
		history?: boolean;
		cookies?: boolean;
		cache?: boolean;
	}): Promise<UserBrowserState> {
		this.assertAvailable();
		if (options.history) {
			this.state.history = [];
			this.state.originFavicons = [];
			this.state.recentlyClosedTabs = [];
			this.state.settings = {
				...this.state.settings,
				newTabGreetingActivity: emptyNewTabGreetingActivity(),
			};
		}
		if (options.cache && typeof this.partition.clearCache === "function")
			await this.partition.clearCache();
		if (
			options.cookies &&
			typeof this.partition.clearStorageData === "function"
		) {
			await this.partition.clearStorageData();
			this.state.sitePermissions = [];
		}
		this.commit();
		return this.getState();
	}

	setDownloadDirectory(directory?: string): UserBrowserState {
		this.assertAvailable();
		const normalized = directory?.trim() ?? "";
		if (normalized && !isAbsolute(normalized))
			throw new Error("Download location must be an absolute folder path.");
		if (
			normalized &&
			this.legacyDownloadDirectory &&
			isLegacyBrowserDownloadDirectory(
				normalized,
				this.legacyDownloadDirectory,
			)
		)
			throw new Error(
				"The old Kestrel Downloads folder is no longer used. Choose another folder.",
			);
		this.downloadDirectory = normalized
			? normalized
			: this.defaultDownloadDirectory;
		mkdirSync(this.downloadDirectory, { recursive: true, mode: 0o700 });
		this.state.settings = {
			...this.state.settings,
			downloadDirectory: normalized,
		};
		this.commit();
		return this.getState();
	}

	exportBrowserData() {
		return BrowserDataTransferSchema.parse({
			format: "kestrel-browser-data",
			version: 1,
			exportedAt: this.now().toISOString(),
			bookmarks: this.state.bookmarks,
			bookmarkFolders: this.state.bookmarkFolders,
			history: this.state.history,
			sitePermissions: this.state.sitePermissions,
			// The destination profile owns its filesystem. Never put a local path in
			// a portable export, even when the user chose a custom download folder.
			settings: {
				...this.state.settings,
				downloadDirectory: "",
			},
		});
	}

	importBrowserData(payload: unknown): UserBrowserState {
		this.assertAvailable();
		const imported = BrowserDataTransferSchema.parse(payload);
		const activeTabId =
			this.state.activeTabId ?? this.state.tabs[0]?.id ?? createEmptyBrowserTab(this.now).id;
		const importedFolderIds = new Map<string, UserBrowserBookmarkFolderId>();
		const existingFolderIds = new Set(
			this.state.bookmarkFolders.map((folder) => folder.id),
		);
		for (const folder of imported.bookmarkFolders) {
			if (this.state.bookmarkFolders.length >= MAX_BOOKMARK_FOLDERS) break;
			const name = redactUntrustedBrowserText(folder.name, 80).trim();
			if (!name) continue;
			const nextId = existingFolderIds.has(folder.id)
				? (`bookmark-folder-${randomUUID()}` as UserBrowserBookmarkFolderId)
				: folder.id;
			this.state.bookmarkFolders.push({ ...folder, id: nextId, name });
			existingFolderIds.add(nextId);
			importedFolderIds.set(folder.id, nextId);
		}
		const existingBookmarkUrls = new Set(
			this.state.bookmarks.map((bookmark) => bookmark.url),
		);
		for (const bookmark of imported.bookmarks) {
			const url = sanitizeBrowserUrl(bookmark.url);
			if (!safePageUrl(url) || existingBookmarkUrls.has(url))
				continue;
			const folderId = bookmark.folderId
				? importedFolderIds.get(bookmark.folderId)
				: undefined;
			this.state.bookmarks.push({
				...bookmark,
				url,
				...(folderId ? { folderId } : { folderId: undefined }),
			});
			existingBookmarkUrls.add(url);
		}
		this.state.bookmarks = this.state.bookmarks.slice(-2_000);

		const existingHistory = new Set(
			this.state.history.map((entry) => `${entry.url}\u0000${entry.visitedAt}`),
		);
		for (const entry of imported.history) {
			const url = sanitizeBrowserUrl(entry.url);
			if (!safePageUrl(url)) continue;
			const key = `${url}\u0000${entry.visitedAt}`;
			if (existingHistory.has(key)) continue;
			this.state.history.push({ ...entry, tabId: activeTabId, url });
			existingHistory.add(key);
		}
		this.state.history = this.state.history.slice(-MAX_HISTORY_ENTRIES);

		const permissionKeys = new Set(
			this.state.sitePermissions.map(
				(permission) => `${permission.origin}\u0000${permission.permission}`,
			),
		);
		for (const permission of imported.sitePermissions) {
			const origin = this.permissionOrigin(permission.origin);
			if (!origin) continue;
			const key = `${origin}\u0000${permission.permission}`;
			if (permissionKeys.has(key)) continue;
			this.state.sitePermissions.push({ ...permission, origin });
			permissionKeys.add(key);
		}
		this.state.sitePermissions = this.state.sitePermissions.slice(-500);

		// A transfer never changes the destination's filesystem path. This keeps
		// an imported profile from redirecting downloads to an unreviewed folder.
		const previousSettings = this.state.settings;
		const nextSettings = UserBrowserSettingsSchema.parse({
			...imported.settings,
			downloadDirectory: this.state.settings.downloadDirectory,
		});
		this.applyBrowserSettings(previousSettings, nextSettings);
		this.pruneHistory();
		if (nextSettings.passwordAutofillEnabled === false)
			this.clearPasswordPrompt();
		else void this.refreshPasswordPrompt();
		if (nextSettings.paymentAutofillEnabled === false)
			this.clearPaymentPrompt();
		else void this.refreshPaymentPrompt();
		this.commit();
		return this.getState();
	}

	saveBookmark(input: {
		title: string;
		displayMode: UserBrowserBookmarkDisplayMode;
		folderId?: UserBrowserBookmarkFolderId | null;
	}): UserBrowserState {
		const tab = this.state.tabs.find((item) => item.id === this.state.activeTabId);
		const targetUrl = sanitizeBrowserUrl(tab?.url ?? "");
		if (!safePageUrl(targetUrl))
			throw new Error("Only HTTP and HTTPS pages can be bookmarked.");
		const folderId = this.validBookmarkFolderId(input.folderId);
		const title = this.normalizedBookmarkTitle(
			input.title,
			targetUrl,
			tab?.title,
		);
		const existing = this.state.bookmarks.find((item) => item.url === targetUrl);
		if (existing) {
			existing.title = title;
			existing.displayMode = input.displayMode;
			if (folderId) existing.folderId = folderId;
			else delete existing.folderId;
			if (tab?.faviconDataUrl && isFaviconDataUrl(tab.faviconDataUrl))
				existing.faviconDataUrl = tab.faviconDataUrl;
			this.commit();
			return this.getState();
		}
		if (this.state.bookmarks.length >= MAX_BOOKMARKS)
			throw new Error("Kestrel supports up to 2,000 bookmarks.");
		this.state.bookmarks.unshift({
			id: `bookmark-${randomUUID()}`,
			url: targetUrl,
			title,
			displayMode: input.displayMode,
			...(folderId ? { folderId } : {}),
			...(tab?.faviconDataUrl && isFaviconDataUrl(tab.faviconDataUrl)
				? { faviconDataUrl: tab.faviconDataUrl }
				: {}),
			createdAt: this.now().toISOString(),
		});
		this.commit();
		return this.getState();
	}

	toggleBookmark(url?: string, title?: string): UserBrowserState {
		const activeTab = this.state.tabs.find((item) => item.id === this.state.activeTabId);
		const targetUrl = sanitizeBrowserUrl(url ?? activeTab?.url ?? "");
		if (!safePageUrl(targetUrl))
			throw new Error("Only HTTP and HTTPS pages can be bookmarked.");
		const existing = this.state.bookmarks.find((item) => item.url === targetUrl);
		if (existing) {
			this.state.bookmarks = this.state.bookmarks.filter(
				(item) => item.id !== existing.id,
			);
			this.commit();
			return this.getState();
		}
		if (this.state.bookmarks.length >= MAX_BOOKMARKS)
			throw new Error("Kestrel supports up to 2,000 bookmarks.");
		const sourceTab = this.state.tabs.find(
			(item) => sanitizeBrowserUrl(item.url) === targetUrl,
		);
		this.state.bookmarks.unshift({
			id: `bookmark-${randomUUID()}`,
			url: targetUrl,
			title: this.normalizedBookmarkTitle(
				title,
				targetUrl,
				sourceTab?.title,
			),
			displayMode: "full",
			...(sourceTab?.faviconDataUrl && isFaviconDataUrl(sourceTab.faviconDataUrl)
				? { faviconDataUrl: sourceTab.faviconDataUrl }
				: {}),
			createdAt: this.now().toISOString(),
		});
		this.commit();
		return this.getState();
	}

	updateBookmark(input: {
		bookmarkId: string;
		title: string;
		displayMode: UserBrowserBookmarkDisplayMode;
		folderId?: UserBrowserBookmarkFolderId | null;
	}): UserBrowserState {
		const bookmark = this.state.bookmarks.find(
			(item) => item.id === input.bookmarkId,
		);
		if (!bookmark) throw new Error("This bookmark no longer exists.");
		bookmark.title = this.normalizedBookmarkTitle(input.title, bookmark.url);
		bookmark.displayMode = input.displayMode;
		if (input.folderId !== undefined) {
			const folderId = this.validBookmarkFolderId(input.folderId);
			if (folderId) bookmark.folderId = folderId;
			else delete bookmark.folderId;
		}
		this.commit();
		return this.getState();
	}

	createBookmarkFolder(name: string): {
		state: UserBrowserState;
		folder: UserBrowserBookmarkFolder;
	} {
		if (this.state.bookmarkFolders.length >= MAX_BOOKMARK_FOLDERS)
			throw new Error("Kestrel supports up to 100 bookmark folders.");
		const normalized = redactUntrustedBrowserText(name, 80).trim();
		if (!normalized) throw new Error("Give the bookmark folder a name.");
		const folder: UserBrowserBookmarkFolder = {
			id: `bookmark-folder-${randomUUID()}`,
			name: normalized,
			createdAt: this.now().toISOString(),
		};
		this.state.bookmarkFolders.push(folder);
		this.commit();
		return { state: this.getState(), folder };
	}

	renameBookmarkFolder(folderId: UserBrowserBookmarkFolderId, name: string): UserBrowserState {
		const folder = this.state.bookmarkFolders.find((item) => item.id === folderId);
		if (!folder) throw new Error("This bookmark folder no longer exists.");
		const normalized = redactUntrustedBrowserText(name, 80).trim();
		if (!normalized) throw new Error("Give the bookmark folder a name.");
		folder.name = normalized;
		this.commit();
		return this.getState();
	}

	removeBookmarkFolder(folderId: UserBrowserBookmarkFolderId): UserBrowserState {
		if (!this.state.bookmarkFolders.some((item) => item.id === folderId))
			throw new Error("This bookmark folder no longer exists.");
		this.state.bookmarkFolders = this.state.bookmarkFolders.filter(
			(item) => item.id !== folderId,
		);
		for (const bookmark of this.state.bookmarks)
			if (bookmark.folderId === folderId) delete bookmark.folderId;
		this.commit();
		return this.getState();
	}

	removeBookmark(bookmarkId: string): UserBrowserState {
		this.state.bookmarks = this.state.bookmarks.filter(
			(item) => item.id !== bookmarkId,
		);
		this.commit();
		return this.getState();
	}

	private validBookmarkFolderId(
		folderId: UserBrowserBookmarkFolderId | null | undefined,
	): UserBrowserBookmarkFolderId | undefined {
		if (!folderId) return undefined;
		if (!this.state.bookmarkFolders.some((item) => item.id === folderId))
			throw new Error("This bookmark folder no longer exists.");
		return folderId;
	}

	private normalizedBookmarkTitle(
		title: string | undefined,
		url: string,
		fallbackTitle?: string,
	): string {
		const candidate = redactUntrustedBrowserText(
			title ?? fallbackTitle ?? hostnameTitle(url),
			500,
		)
			.trim()
			.slice(0, 500);
		return candidate || hostnameTitle(url);
	}

	pinTab(tabId: string, pinned: boolean): UserBrowserState {
		const tab = this.requireTab(tabId);
		tab.pinned = pinned;
		if (pinned) tab.tabFolderId = undefined;
		const pinnedTabs = this.state.tabs.filter((item) => item.pinned);
		const rest = this.state.tabs.filter((item) => !item.pinned);
		this.state.tabs = [...pinnedTabs, ...rest];
		this.pruneEmptyTabFolders();
		this.commit();
		return this.getState();
	}

	muteTab(tabId: string, muted: boolean): UserBrowserState {
		const tab = this.requireTab(tabId);
		tab.muted = muted;
		const record = this.views.get(tabId);
		const webContents = liveWebContents(record?.view?.webContents);
		if (
			webContents &&
			typeof webContents.setAudioMuted === "function"
		) {
			webContents.setAudioMuted(muted);
		}
		this.commit();
		return this.getState();
	}

	async duplicateTab(tabId: string): Promise<UserBrowserState> {
		const tab = this.requireTab(tabId);
		if (tab.file) return (await this.openFileTabs([tab.file.path], true)).browserState;
		return this.createTab(tab.url || undefined, true);
	}

	getTabForTransfer(tabId: string): UserBrowserTab {
		if (this.isAgentTabPinned(tabId)) {
			throw new Error(
				"Browser tab is in use by an agent operation and cannot be moved.",
			);
		}
		const tab = this.requireTab(tabId);
		if (tab.file || tab.error) {
			throw new Error("Only browser tabs can move between windows.");
		}
		return structuredClone(tab);
	}

	async importTabForTransfer(tab: UserBrowserTab): Promise<UserBrowserState> {
		return this.runExclusiveTabMutation(async () => {
			this.assertAvailable();
			if (this.state.tabs.some((candidate) => candidate.id === tab.id))
				throw new Error("That browser tab is already open in this window.");
			const previousActiveTabId = this.state.activeTabId;
			const imported: UserBrowserTab = {
				...structuredClone(tab),
				loading: false,
				discarded: false,
				crashed: false,
				error: undefined,
				tabFolderId: undefined,
				lastActiveAt: this.now().toISOString(),
			};
			this.state.tabs.push(imported);
			this.state.activeTabId = imported.id;
			this.commit();
			try {
				if (imported.url) await this.navigate(imported.id, imported.url);
				else await this.syncActiveView();
			} catch (cause) {
				this.closeView(imported.id);
				this.state.tabs = this.state.tabs.filter(
					(candidate) => candidate.id !== imported.id,
				);
				this.state.activeTabId = previousActiveTabId;
				this.commit();
				throw cause;
			}
			return this.getState();
		});
	}

	async removeTabForTransfer(tabId: string): Promise<UserBrowserState> {
		return this.runExclusiveTabMutation(() =>
			this.removeTabForTransferInternal(tabId),
		);
	}

	private async removeTabForTransferInternal(
		tabId: string,
	): Promise<UserBrowserState> {
		if (this.isAgentTabPinned(tabId)) {
			throw new Error(
				"Browser tab is in use by an agent operation and cannot be moved.",
			);
		}
		const index = this.state.tabs.findIndex((tab) => tab.id === tabId);
		if (index < 0) throw new Error("Browser tab is unavailable.");
		if (tabId === this.state.activeTabId) {
			this.clearPasswordPrompt();
			this.clearPaymentPrompt();
		}
		this.closeView(tabId);
		this.state.tabs.splice(index, 1);
		this.agentTabPinCounts.delete(tabId);
		if (this.state.tabs.length === 0) {
			this.state.activeTabId = null;
		} else if (this.state.activeTabId === tabId) {
			this.state.activeTabId =
				this.state.tabs[Math.min(index, this.state.tabs.length - 1)]!.id;
		}
		this.pruneEmptyTabFolders();
		this.commit();
		if (this.state.tabs.length === 0) {
			this.onLastTabClosed?.();
			return this.getState();
		}
		await this.syncActiveView();
		return this.getState();
	}

	async closeOtherTabs(tabId: string): Promise<UserBrowserState> {
		return this.runExclusiveTabMutation(async () => {
			this.requireTab(tabId);
			const closing = this.state.tabs
				.filter((tab) => tab.id !== tabId && !tab.pinned)
				.map((tab) => tab.id);
			if (closing.some((id) => this.isAgentTabPinned(id))) {
				throw new Error(
					"Browser tab is in use by an agent operation and cannot be closed.",
				);
			}
			for (const id of closing) this.closingTabIds.add(id);
			try {
				for (const id of closing)
					await this.closeTabInternal(id, { commit: false, sync: false });
			} finally {
				for (const id of closing) this.closingTabIds.delete(id);
			}
			if (closing.length === 0) return this.getState();
			this.commit();
			await this.syncActiveView();
			return this.getState();
		});
	}

	moveTab(tabId: string, toIndex: number): UserBrowserState {
		const fromIndex = this.state.tabs.findIndex((tab) => tab.id === tabId);
		if (fromIndex < 0) throw new Error("Browser tab is unavailable.");
		const [tab] = this.state.tabs.splice(fromIndex, 1);
		if (!tab) throw new Error("Browser tab is unavailable.");
		const bounded = Math.min(Math.max(0, toIndex), this.state.tabs.length);
		this.state.tabs.splice(bounded, 0, tab);
		this.commit();
		return this.getState();
	}

	async previewOrganizeTabs(): Promise<UserBrowserTabOrganizationPreview> {
		this.assertAvailable();
		const organized = organizeBrowserTabs(this.state.tabs, this.now);
		const suggestedDeletions = suggestTabDeletions(
			this.state.tabs,
			this.state.activeTabId,
			this.now,
		);
		if (!this.nameTabFolders || organized.tabFolders.length === 0) {
			return { ...organized, suggestedDeletions };
		}

		const namingGroups: BrowserTabFolderNamingGroup[] = organized.tabFolders.map(
			(folder) => ({
				id: folder.id,
				fallbackName: folder.name,
				tabs: organized.tabs
					.filter((tab) => tab.tabFolderId === folder.id)
					.slice(0, MAX_TAB_FOLDER_NAMING_TABS)
					.map((tab) => ({
						title:
							tab.title
								.normalize("NFKC")
								.replace(/[\u0000-\u001f\u007f]/gu, " ")
								.replace(/\s+/gu, " ")
								.trim()
								.slice(0, 160) || "Untitled page",
						host: pageDomain(tab.url) ?? "unknown site",
					})),
			}),
		);
		let names: BrowserTabFolderName[] = [];
		try {
			names = await this.nameTabFolders(namingGroups);
		} catch {
			// AI labels are best effort. Keep the deterministic category labels when
			// the configured provider is unavailable or returns an error.
		}
		const folderIds = new Set(organized.tabFolders.map((folder) => folder.id));
		const namesById = new Map<string, string>();
		for (const item of names) {
			const name = validateBrowserTabFolderName(item.name);
			if (folderIds.has(item.id) && name) namesById.set(item.id, name);
		}
		return {
			...organized,
			tabFolders: organized.tabFolders.map((folder) => ({
				...folder,
				name: namesById.get(folder.id) ?? folder.name,
			})),
			suggestedDeletions,
		};
	}

	async applyTabOrganization(
		input: UserBrowserTabOrganizationApply,
	): Promise<UserBrowserState> {
		return this.runExclusiveTabMutation(() =>
			this.applyTabOrganizationInternal(input),
		);
	}

	private async applyTabOrganizationInternal(
		input: UserBrowserTabOrganizationApply,
	): Promise<UserBrowserState> {
		this.assertAvailable();
		if (input.closeTabIds?.length) {
			for (const tabId of [...new Set(input.closeTabIds)]) {
				if (this.state.tabs.some((tab) => tab.id === tabId)) {
					await this.closeTabInternal(tabId);
				}
			}
		}
		const currentTabs = new Map(this.state.tabs.map((tab) => [tab.id, tab]));
		const folderIds = new Set(input.tabFolders.map((folder) => folder.id));
		const assignments = new Map(
			input.assignments.map((assignment) => [
				assignment.tabId,
				assignment.tabFolderId,
			]),
		);
		const orderedIds = [...new Set(input.tabOrder)];
		const orderedTabIds = new Set<string>();
		const orderedTabs = orderedIds.flatMap((tabId) => {
			const tab = currentTabs.get(tabId);
			if (!tab) return [];
			orderedTabIds.add(tabId);
			const tabFolderId = assignments.get(tabId);
			return [
				{
					...tab,
					tabFolderId:
						!tab.pinned && tabFolderId && folderIds.has(tabFolderId)
							? tabFolderId
							: undefined,
				},
			];
		});
		const remainingTabs = this.state.tabs
			.filter((tab) => !orderedTabIds.has(tab.id))
			.map((tab) => ({ ...tab, tabFolderId: undefined }));
		const usedFolderIds = new Set(
			[...orderedTabs, ...remainingTabs].flatMap((tab) =>
				tab.tabFolderId ? [tab.tabFolderId] : [],
			),
		);
		const tabFolders: UserBrowserTabFolder[] = input.tabFolders
			.filter((folder) => usedFolderIds.has(folder.id))
			.map((folder) => ({
				...folder,
				name: folder.name.trim().slice(0, 80) || "Untitled group",
			}));
		this.state.tabs = [...orderedTabs, ...remainingTabs];
		this.state.tabFolders = tabFolders;
		this.commit();
		return this.getState();
	}

	async organizeTabs(): Promise<UserBrowserState> {
		const organized = await this.previewOrganizeTabs();
		return this.applyTabOrganization({
			tabOrder: organized.tabs.map((tab) => tab.id),
			assignments: organized.tabs.map(({ id, tabFolderId }) => ({
				tabId: id,
				...(tabFolderId ? { tabFolderId } : {}),
			})),
			tabFolders: organized.tabFolders,
		});
	}

	async detachTab(tabId: string): Promise<UserBrowserState> {
		return this.runExclusiveTabMutation(() => this.detachTabInternal(tabId));
	}

	private async detachTabInternal(tabId: string): Promise<UserBrowserState> {
		if (this.isAgentTabPinned(tabId)) {
			throw new Error(
				"Browser tab is in use by an agent operation and cannot be detached.",
			);
		}
		const tab = this.requireTab(tabId);
		if (tab.file || tab.error) {
			throw new Error("Only browser tabs can open in a separate window.");
		}
		this.closeView(tabId);
		const index = this.state.tabs.findIndex((item) => item.id === tabId);
		this.state.tabs.splice(index, 1);
		if (this.state.tabs.length === 0) {
			const replacement = createEmptyBrowserTab(this.now);
			this.state.tabs.push(replacement);
			this.state.activeTabId = replacement.id;
		} else if (this.state.activeTabId === tabId) {
			this.state.activeTabId =
				this.state.tabs[Math.min(index, this.state.tabs.length - 1)]!.id;
		}
		this.pruneEmptyTabFolders();
		this.commit();
		await this.syncActiveView();
		return this.getState();
	}

	findInPage(
		tabId: string,
		query: string,
		options: { findNext?: boolean; forward?: boolean } = {},
	): UserBrowserState {
		const record = this.requireView(tabId);
		const text = query.trim();
		if (!text) {
			this.stopFindInPage(tabId);
			return this.getState();
		}
		liveWebContents(record?.view?.webContents)?.findInPage(text, {
			forward: options.forward ?? true,
			findNext: Boolean(options.findNext),
		});
		return this.getState();
	}

	stopFindInPage(tabId: string): UserBrowserState {
		const record = this.views.get(tabId);
		const webContents = liveWebContents(record?.view?.webContents);
		if (webContents) webContents.stopFindInPage("clearSelection");
		return this.getState();
	}

	printTab(tabId: string): UserBrowserState {
		const record = this.requireView(tabId);
		liveWebContents(record?.view?.webContents)?.print({});
		return this.getState();
	}

	openDevTools(tabId: string): UserBrowserState {
		if (!this.allowDevTools) return this.getState();
		const record = this.requireView(tabId);
		liveWebContents(record?.view?.webContents)?.openDevTools({ mode: "detach" });
		return this.getState();
	}

	setSitePermission(
		origin: string,
		permission: string,
		decision: "allow" | "deny",
	): UserBrowserState {
		const normalizedOrigin = this.permissionOrigin(origin);
		if (!normalizedOrigin)
			throw new Error("Site permissions require an HTTP(S) origin.");
		this.rememberSitePermission(normalizedOrigin, permission, decision);
		this.commit();
		return this.getState();
	}

	clearSitePermission(origin: string, permission: string): UserBrowserState {
		const normalizedOrigin = this.permissionOrigin(origin);
		if (!normalizedOrigin)
			throw new Error("Site permissions require an HTTP(S) origin.");
		this.state.sitePermissions = this.state.sitePermissions.filter(
			(item) =>
				!(item.origin === normalizedOrigin && item.permission === permission),
		);
		this.commit();
		return this.getState();
	}

	async pageContext(tabId?: string): Promise<UserBrowserPageContext> {
		return this.runExclusiveTabMutation(() => this.pageContextWhilePinned(tabId));
	}

	private async pageContextWhilePinned(
		tabId?: string,
	): Promise<UserBrowserPageContext> {
		const resolvedTabId = tabId ?? this.requireActiveTab().id;
		return this.withAgentTabPin(resolvedTabId, async () => {
			const tab = this.requireTab(resolvedTabId);
			if (!tab.url || tab.error || isKestrelAppPageUrl(tab.url))
				throw new Error("The selected tab does not have a readable web page.");
		const record = this.ensureView(tab);
		const webContents = liveWebContents(record?.view?.webContents);
		if (!webContents)
			throw new Error("The selected page is still waking up. Try again.");
		const raw = (await webContents.executeJavaScript(`(() => {
      const limit = (value, maximum) => String(value ?? "").replace(/\\s+/g, " ").trim().slice(0, maximum);
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0;
      };
			const sensitiveField = (node) => {
				const hint = [node.type, node.autocomplete, node.name, node.id, node.getAttribute("aria-label"), node.placeholder]
					.filter(Boolean)
					.join(" ")
					.toLowerCase();
				return node instanceof HTMLInputElement && (
					node.type === "password" ||
					/(?:current|new)[-_ ]password|one[-_ ]time[-_ ]code|\\botp\\b|recovery[-_ ]code|verification[-_ ]code|security[-_ ]code|\\b(?:cvv|cvc)\\b|api[-_ ]key|access[-_ ]token|private[-_ ]key/.test(hint)
				);
			};
      const nodes = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,table,article,main")).filter(visible);
      const visibleText = nodes.map((node) => limit(node.innerText || node.textContent, 4000)).filter(Boolean).join("\\n").slice(0, 40000);
      const links = Array.from(document.querySelectorAll("a[href]")).filter(visible).slice(0, 100).map((node) => ({ text: limit(node.innerText || node.textContent, 500), url: node.href }));
			const forms = Array.from(document.querySelectorAll("input,textarea,select,button")).filter(visible).slice(0, 60).map((node) => sensitiveField(node)
				? { label: "Sensitive field", type: "sensitive", name: "" }
				: { label: limit(node.labels?.[0]?.innerText || node.getAttribute("aria-label") || node.placeholder || node.innerText, 500), type: limit(node.type || node.tagName.toLowerCase(), 100), name: limit(node.name || node.id, 500) });
			const active = document.activeElement;
      return {
        description: limit(document.querySelector('meta[name="description"]')?.content, 2000),
				selectedText: active instanceof Element && sensitiveField(active) ? "" : limit(getSelection()?.toString(), 20000),
        visibleText: visibleText || limit(document.body?.innerText, 40000),
        headings: Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).filter(visible).slice(0, 60).map((node) => limit(node.innerText || node.textContent, 500)).filter(Boolean),
        links,
        forms,
        viewport: { width: Math.max(1, Math.round(innerWidth)), height: Math.max(1, Math.round(innerHeight)), scrollX, scrollY }
      };
    })()`)) as Omit<
			UserBrowserPageContext,
			"tabId" | "url" | "title" | "capturedAt" | "trust"
		>;
		const links = Array.isArray(raw.links)
			? raw.links.flatMap((link) => {
					if (!link || typeof link !== "object") return [];
					const candidate = link as { text?: unknown; url?: unknown };
					const url = sanitizeBrowserUrl(String(candidate.url ?? ""));
					return url
						? [
								{
									text: redactAgentVisibleBrowserText(candidate.text, 500),
									url,
								},
							]
						: [];
				})
			: [];
		const forms = Array.isArray(raw.forms)
			? raw.forms.flatMap((form) => {
					if (!form || typeof form !== "object") return [];
					const candidate = form as {
						label?: unknown;
						type?: unknown;
						name?: unknown;
					};
					return [
						{
							label: redactAgentVisibleBrowserText(candidate.label, 500),
							type: redactAgentVisibleBrowserText(candidate.type, 100),
							name: redactAgentVisibleBrowserText(candidate.name, 500),
						},
					];
				})
			: [];
		const url =
			sanitizeBrowserUrl(webContents.getURL()) ||
			sanitizeBrowserUrl(tab.url);
		if (!url)
			throw new Error("The selected tab does not have a safe readable URL.");
		return UserBrowserPageContextSchema.parse({
			tabId: tab.id,
			url,
			title: redactAgentVisibleBrowserText(
				webContents.getTitle() || tab.title,
				500,
			),
			description: redactAgentVisibleBrowserText(raw.description, 2000),
			selectedText: redactAgentVisibleBrowserText(raw.selectedText, 20_000),
			visibleText: redactAgentVisibleBrowserText(raw.visibleText, 40_000),
			headings: Array.isArray(raw.headings)
				? raw.headings
						.map((heading) => redactAgentVisibleBrowserText(heading, 500))
						.filter(Boolean)
				: [],
			links,
			forms,
			viewport: raw.viewport,
			capturedAt: this.now().toISOString(),
			trust: "untrusted_browser",
		});
		});
	}

	async listPasswords(): Promise<PasswordEntrySummary[]> {
		return this.passwordVault?.list() ?? [];
	}

	async savePasswordSuggestion(): Promise<PasswordEntrySummary[]> {
		if (!this.passwordVault)
			throw new Error("The protected password store is unavailable.");
		const pending = this.pendingPasswordSave;
		const prompt = this.passwordPrompt;
		if (!pending || !prompt || prompt.mode !== "save")
			throw new Error("That password suggestion is no longer available.");
		const tab = this.requireActiveTab();
		if (tab.id !== pending.tabId || prompt.tabId !== tab.id)
			throw new Error("The login page changed before the password was saved.");
		if (
			!pending.confirmedAt ||
			!pending.confirmedUrl ||
			this.now().getTime() - pending.confirmedAt > 30_000
		)
			throw new Error("That password suggestion is no longer available.");
		const record = this.requireView(tab.id);
		const webContents = liveWebContents(record?.view?.webContents);
		if (!webContents)
			throw new Error("The login page is still waking up. Try again.");
		const url = safePageUrl(webContents.getURL()) || safePageUrl(tab.url);
		if (!url || url.protocol !== "https:" || url.toString() !== pending.confirmedUrl)
			throw new Error("The login page changed before the password was saved.");
		this.passwordSaveCommitTabId = tab.id;
		try {
			const summaries = await this.passwordVault.save({
				origin: pending.origin,
				title: pending.title,
				username: pending.username,
				password: pending.password,
			});
			// will-navigate/will-redirect are held while the encrypted vault write is
			// in progress. Once it succeeds, discard the submitted secret immediately
			// instead of leaving a stale save prompt alive for a possible second write.
			this.suppressPasswordPrompt(tab.id, pending.origin, 4_000);
			this.clearPasswordPrompt();
			return summaries;
		} finally {
			this.passwordSaveCommitTabId = undefined;
		}
	}

	async updatePasswordUsername(
		id: PasswordEntryId,
		username: string,
	): Promise<PasswordEntrySummary[]> {
		if (!this.passwordVault)
			throw new Error("The protected password store is unavailable.");
		return this.passwordVault.updateUsername(id, username);
	}

	async copyPassword(id: PasswordEntryId): Promise<void> {
		const entry = await this.passwordEntryForSettings(id);
		try {
			await this.requirePasswordUserPresence("Copy saved password");
			const copiedPasswordDigest = createHash("sha256")
				.update(entry.password, "utf8")
				.digest("hex");
			clipboard.writeText(entry.password);
			const clearTimer = setTimeout(() => {
				try {
					const currentClipboardDigest = createHash("sha256")
						.update(clipboard.readText(), "utf8")
						.digest("hex");
					if (currentClipboardDigest === copiedPasswordDigest) clipboard.clear();
				} catch {
					// Clipboard access can be revoked while Kestrel is in the background.
				}
			}, 60_000);
			clearTimer.unref?.();
		} finally {
			discardPasswordEntry(entry);
		}
	}

	async revealPassword(id: PasswordEntryId): Promise<void> {
		const entry = await this.passwordEntryForSettings(id);
		try {
			await this.requirePasswordUserPresence("Reveal saved password");
			await dialog.showMessageBox(this.window, {
				type: "none",
				buttons: ["Done"],
				defaultId: 0,
				title: "Saved password",
				message: entry.password,
				detail:
					"Shown after local device verification. Anyone who can see this window can read it.",
			});
		} finally {
			discardPasswordEntry(entry);
		}
	}

	markNeverSavePasswordForActiveOrigin(): void {
		const tab = this.requireActiveTab();
		const record = this.requireView(tab.id);
		const webContents = liveWebContents(record?.view?.webContents);
		const url = safePageUrl(webContents?.getURL() || tab.url);
		if (!url || url.protocol !== "https:")
			throw new Error("Password exceptions can only be saved for HTTPS websites.");
		const origin =
			this.passwordPrompt?.mode === "save"
				? this.passwordPrompt.origin
				: url.origin;
		if (!this.state.settings.neverSavePasswordOrigins.includes(origin)) {
			this.state.settings = {
				...this.state.settings,
				neverSavePasswordOrigins: [
					...this.state.settings.neverSavePasswordOrigins,
					origin,
				].slice(-500),
			};
			this.commit();
		}
		this.clearPasswordPrompt();
	}

	async generatePasswordForActiveForm(): Promise<void> {
		if (!this.state.settings.offerStrongPasswords)
			throw new Error("Strong password suggestions are turned off in Password settings.");
		const tab = this.requireActiveTab();
		const record = this.requireView(tab.id);
		const webContents = liveWebContents(record?.view?.webContents);
		if (!webContents)
			throw new Error("The sign-up page is still waking up. Try again.");
		const url = safePageUrl(webContents.getURL()) || safePageUrl(tab.url);
		if (!url || url.protocol !== "https:")
			throw new Error("Strong passwords can only be generated on HTTPS websites.");
		const snapshot = await this.readPasswordFormSnapshot(webContents, url.origin);
		const newPasswordFields = snapshot.fields.filter(
			(field) => field.kind === "new-password",
		);
		if (!newPasswordFields.length)
			throw new Error("Kestrel could not find a new-password field on this page.");
		let generatedPassword = generateStrongPassword();
		try {
			for (const field of newPasswordFields) {
				const filled = await this.fillPasswordFields(webContents, url.origin, {
					username: "",
					password: generatedPassword,
					fieldId: field.id,
					includeUsername: false,
					includePassword: true,
				});
				if (filled < 1)
					throw new Error("Kestrel could not fill the new-password field.");
			}
		} finally {
			// Do not promote generated values into service state; each bridge request
			// has settled before this local reference is released.
			generatedPassword = "";
		}
		// Keep the existing prompt stable so its renderer can acknowledge the
		// completed action. Re-emitting a new generate prompt here would reset the
		// UI and make a second, accidental generation look like the first one.
	}

	async removePassword(id: PasswordEntryId): Promise<PasswordEntrySummary[]> {
		if (!this.passwordVault)
			throw new Error("The protected password store is unavailable.");
		return this.passwordVault.remove(id);
	}

	async listPaymentCards(): Promise<PaymentCardEntrySummary[]> {
		return this.paymentCardVault?.list() ?? [];
	}

	async savePaymentCardFromActiveTab(
		expectedOrigin?: string,
	): Promise<PaymentCardEntrySummary[]> {
		if (!this.paymentCardVault)
			throw new Error("The protected payment card store is unavailable.");
		const tab = this.requireActiveTab();
		const record = this.requireView(tab.id);
		const webContents = liveWebContents(record?.view?.webContents);
		if (!webContents)
			throw new Error("The payment page is still waking up. Try again.");
		const url = safePageUrl(webContents.getURL()) || safePageUrl(tab.url);
		if (!url || url.protocol !== "https:")
			throw new Error("Payment cards can only be saved on HTTPS websites.");
		if (expectedOrigin && expectedOrigin !== url.origin)
			throw new Error("The payment page changed before the card was saved.");
		const snapshot = parsePaymentFormValues(
			await webContents.executeJavaScript(PAYMENT_FORM_VALUES_SCRIPT),
		);
		const card = paymentCardInputFromForm(snapshot);
		const summaries = await this.paymentCardVault.save(card);
		this.suppressPaymentPrompt(tab.id, url.origin, 4_000);
		this.clearPaymentPrompt();
		return summaries;
	}

	async removePaymentCard(
		id: PaymentCardEntryId,
	): Promise<PaymentCardEntrySummary[]> {
		if (!this.paymentCardVault)
			throw new Error("The protected payment card store is unavailable.");
		const entries = await this.paymentCardVault.remove(id);
		void this.refreshPaymentPrompt();
		return entries;
	}

	async fillPaymentCardPage(id: PaymentCardEntryId): Promise<void> {
		const { tab, webContents, entry, origin } =
			await this.paymentCardForActiveTab(id);
		const filled = await webContents.executeJavaScript(
			paymentFillScript(entry, undefined, origin),
		);
		if (filled !== true)
			throw new Error("Kestrel could not find a payment field on this page.");
		this.suppressPaymentPrompt(tab.id, origin, 4_000);
		this.clearPaymentPrompt();
	}

	async fillPaymentCardField(
		id: PaymentCardEntryId,
		fieldId: string,
	): Promise<void> {
		const { tab, webContents, entry, origin } =
			await this.paymentCardForActiveTab(id);
		const snapshot = await this.readPaymentFormSnapshot(webContents);
		const field = snapshot.fields.find((candidate) => candidate.id === fieldId);
		if (!field || field.kind === "security-code")
			throw new Error("That payment field is no longer available.");
		const fieldIndex = Number(field.id.slice("payment-field-".length));
		const filled = await webContents.executeJavaScript(
			paymentFillScript(entry, fieldIndex, origin),
		);
		if (filled !== true)
			throw new Error("Kestrel could not fill that payment field.");
		this.suppressPaymentPrompt(tab.id, origin, 4_000);
		this.clearPaymentPrompt();
	}

	dismissPaymentPrompt(): void {
		const tab = this.state.tabs.find(
			(candidate) => candidate.id === this.state.activeTabId,
		);
		const url = tab?.url ? safePageUrl(tab.url) : undefined;
		if (tab && url?.protocol === "https:")
			this.suppressPaymentPrompt(tab.id, url.origin, 30_000);
		this.clearPaymentPrompt();
	}

	async fillPasswordPage(id: PasswordEntryId): Promise<void> {
		const { tab, webContents, entry, origin } =
			await this.passwordEntryForActiveTab(id);
		try {
			const filled = await this.fillPasswordFields(webContents, origin, {
				username: entry.username,
				password: entry.password,
				includeUsername: this.state.settings.autofillUsernames,
				includePassword: this.state.settings.autofillPasswords,
			});
			if (filled < 1)
				throw new Error("Kestrel could not find a login field on this page.");
			this.loginFlows.selectCredential(tab.id, id, entry.username);
			this.loginFlows.markAutofill(tab.id);
			void this.markPasswordUsed(id, origin);
			this.suppressPasswordPrompt(tab.id, origin, 4_000);
			this.clearPasswordPrompt();
		} finally {
			discardPasswordEntry(entry);
		}
	}

	async fillPasswordField(
		id: PasswordEntryId,
		fieldId: string,
	): Promise<void> {
		const { tab, webContents, entry, origin } =
			await this.passwordEntryForActiveTab(id);
		try {
			const snapshot = await this.readPasswordFormSnapshot(webContents, origin);
			const field = snapshot.fields.find((candidate) => candidate.id === fieldId);
			if (!field || (field.kind !== "username" && field.kind !== "password"))
				throw new Error("That form field is no longer available.");
			const filled = await this.fillPasswordFields(webContents, origin, {
				username: entry.username,
				password: entry.password,
				fieldId,
				includeUsername: field.kind === "username",
				includePassword: field.kind === "password",
			});
			if (filled < 1)
				throw new Error("Kestrel could not fill that form field.");
			this.loginFlows.selectCredential(tab.id, id, entry.username);
			this.loginFlows.markAutofill(tab.id);
			void this.markPasswordUsed(id, origin);
			this.suppressPasswordPrompt(tab.id, origin, 4_000);
			this.clearPasswordPrompt();
		} finally {
			discardPasswordEntry(entry);
		}
	}

	private async autofillCredentialForAgent(
		tabId: string,
		signal: AbortSignal,
	): Promise<AgentCredentialAutofillResult> {
		const unavailable = (
			autofillResult: AgentCredentialAutofillResult["autofillResult"],
			credentialAvailable = false,
		): AgentCredentialAutofillResult => ({
			credentialAvailable,
			autofillResult,
			trust: "untrusted_browser",
		});
		if (signal.aborted) throw signal.reason;
		if (tabId !== this.state.activeTabId) return unavailable("not_active");
		if (
			this.state.settings.passwordAutofillEnabled === false ||
			(this.state.settings.autofillPasswords === false &&
				this.state.settings.autofillUsernames === false)
		)
			return unavailable("disabled");
		if (!this.passwordVault) return unavailable("unavailable");

		const tab = this.requireTab(tabId);
		const record = this.requireView(tab.id);
		const webContents = liveWebContents(record.view.webContents);
		const url = safePageUrl(webContents?.getURL() || tab.url);
		if (!webContents || !url || url.protocol !== "https:")
			return unavailable("not_a_login_form");
		const snapshot = await this.readPasswordFormSnapshot(webContents, url.origin);
		if (signal.aborted) throw signal.reason;
		if (
			!snapshot.fields.some(
				(field) => field.kind === "username" || field.kind === "password",
			)
		)
			return unavailable("not_a_login_form");

		const entries = await this.passwordVault.listForOrigin(url.origin);
		if (signal.aborted) throw signal.reason;
		if (!entries.length) return unavailable("unavailable");
		const flow = this.loginFlows.readContext(tab.id);
		const selected =
			flow?.authOrigin === url.origin && flow.selectedCredentialId
				? entries.find((entry) => entry.id === flow.selectedCredentialId)
				: undefined;
		const entrySummary = selected ?? (entries.length === 1 ? entries[0] : undefined);
		if (!entrySummary) return unavailable("selection_required", true);

		const entry = await this.passwordVault.getForOrigin(entrySummary.id, url.origin);
		if (!entry) return unavailable("unavailable", true);
		try {
			if (signal.aborted) throw signal.reason;
			const filled = await this.fillPasswordFields(webContents, url.origin, {
				username: entry.username,
				password: entry.password,
				includeUsername: this.state.settings.autofillUsernames,
				includePassword: this.state.settings.autofillPasswords,
			});
			if (signal.aborted) throw signal.reason;
			if (filled < 1) return unavailable("unavailable", true);

			this.loginFlows.selectCredential(tab.id, entry.id, entry.username);
			this.loginFlows.markAutofill(tab.id);
			void this.markPasswordUsed(entry.id, url.origin);
			this.suppressPasswordPrompt(tab.id, url.origin, 4_000);
			this.clearPasswordPrompt({
				preservePending: this.pendingPasswordSave?.tabId === tab.id,
			});
			return unavailable("filled", true);
		} finally {
			discardPasswordEntry(entry);
		}
	}

	dismissPasswordPrompt(): void {
		const tab = this.state.tabs.find(
			(candidate) => candidate.id === this.state.activeTabId,
		);
		const url = tab?.url ? safePageUrl(tab.url) : undefined;
		if (tab && url?.protocol === "https:")
			this.suppressPasswordPrompt(tab.id, url.origin, 30_000);
		this.clearPasswordPrompt();
	}

	private async passwordEntryForActiveTab(id: PasswordEntryId): Promise<{
		tab: UserBrowserTab;
		webContents: WebContents;
		entry: NonNullable<Awaited<ReturnType<PasswordVault["getForOrigin"]>>>;
		origin: string;
	}> {
		if (!this.passwordVault)
			throw new Error("The protected password store is unavailable.");
		const tab = this.requireActiveTab();
		const record = this.requireView(tab.id);
		const webContents = liveWebContents(record?.view?.webContents);
		if (!webContents)
			throw new Error("The login page is still waking up. Try again.");
		const url = safePageUrl(webContents.getURL()) || safePageUrl(tab.url);
		if (!url || url.protocol !== "https:")
			throw new Error("Passwords can only be filled on HTTPS websites.");
		if (
			!this.passwordPrompt ||
			this.passwordPrompt.tabId !== tab.id ||
			this.passwordPrompt.origin !== url.origin ||
			!this.passwordPrompt.entries.some((entry) => entry.id === id)
		)
			throw new Error("That saved login suggestion is no longer available.");
		const entry = await this.passwordVault.getForOrigin(id, url.origin);
		if (!entry)
			throw new Error("That saved login is not available for this website.");
		return { tab, webContents, entry, origin: url.origin };
	}

	private async passwordEntryForSettings(id: PasswordEntryId): Promise<
		NonNullable<Awaited<ReturnType<PasswordVault["get"]>>>
	> {
		if (!this.passwordVault)
			throw new Error("The protected password store is unavailable.");
		const entry = await this.passwordVault.get(id);
		if (!entry) throw new Error("That saved login no longer exists.");
		return entry;
	}

	private async requirePasswordUserPresence(reason: string): Promise<void> {
		await this.requestPasswordUserPresence(reason);
	}

	private async markPasswordUsed(id: PasswordEntryId, origin: string): Promise<void> {
		if (!this.passwordVault) return;
		const markUsed = (this.passwordVault as PasswordVault & {
			markUsed?: (passwordId: PasswordEntryId, passwordOrigin: string) => Promise<void>;
		}).markUsed;
		if (typeof markUsed !== "function") return;
		await Promise.resolve(markUsed.call(this.passwordVault, id, origin)).catch(
			() => undefined,
		);
	}

	private async readPasswordFormSnapshot(
		webContents: WebContents,
		origin: string,
	): Promise<PasswordFormSnapshot> {
		const response = await this.requestPasswordBridge(webContents, origin, {
			type: "scan",
		});
		if (!response.ok || !response.snapshot)
			throw new Error("Kestrel could not inspect this login form.");
		return parsePasswordFormSnapshot(response.snapshot);
	}

	private async fillPasswordFields(
		webContents: WebContents,
		origin: string,
		input: {
			username: string;
			password: string;
			fieldId?: string;
			includeUsername?: boolean;
			includePassword?: boolean;
		},
	): Promise<number> {
		const response = await this.requestPasswordBridge(webContents, origin, {
			type: "fill",
			...input,
		});
		return response.ok ? response.filled ?? 0 : 0;
	}

	private requestPasswordBridge(
		webContents: WebContents,
		expectedOrigin: string,
		command:
			| { type: "scan" }
			| {
					type: "fill";
					username: string;
					password: string;
					fieldId?: string;
					includeUsername?: boolean;
					includePassword?: boolean;
				},
	): Promise<PasswordBridgeResponse> {
		if (!liveWebContents(webContents))
			return Promise.reject(new Error("The login page is still waking up. Try again."));
		const requestId = `password-request-${randomUUID()}`;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingPasswordBridgeRequests.delete(requestId);
				reject(new Error("Kestrel could not reach this login form. Try again."));
			}, PASSWORD_BRIDGE_TIMEOUT_MS);
			this.pendingPasswordBridgeRequests.set(requestId, {
				webContentsId: webContents.id,
				expectedOrigin,
				resolve,
				reject,
				timeout,
			});
			try {
				webContents.send(PASSWORD_COMMAND_CHANNEL, {
					requestId,
					expectedOrigin,
					...command,
				});
			} catch (error) {
				clearTimeout(timeout);
				this.pendingPasswordBridgeRequests.delete(requestId);
				reject(
					error instanceof Error
						? error
						: new Error("Kestrel could not reach this login form."),
				);
			}
		});
	}

	private handlePasswordBridgeResponse(
		webContents: WebContents,
		event: Electron.IpcMainEvent,
		raw: unknown,
	): void {
		const response = PasswordBridgeResponseSchema.safeParse(raw);
		if (!response.success) return;
		const pending = this.pendingPasswordBridgeRequests.get(response.data.requestId);
		if (!pending || pending.webContentsId !== webContents.id) return;
		// A preload can load in child frames. Only the current top-level document
		// is allowed to settle a main-process credential command.
		if (event.senderFrame !== webContents.mainFrame) return;
		const frameUrl = safePageUrl(event.senderFrame.url);
		if (!frameUrl || frameUrl.protocol !== "https:" || frameUrl.origin !== pending.expectedOrigin) {
			this.settlePasswordBridgeRequest(
				response.data.requestId,
				new Error("The login page changed before Kestrel could fill it."),
			);
			return;
		}
		this.settlePasswordBridgeRequest(response.data.requestId, response.data);
	}

	private settlePasswordBridgeRequest(
		requestId: string,
		result: PasswordBridgeResponse | Error,
	): void {
		const pending = this.pendingPasswordBridgeRequests.get(requestId);
		if (!pending) return;
		this.pendingPasswordBridgeRequests.delete(requestId);
		clearTimeout(pending.timeout);
		if (result instanceof Error) pending.reject(result);
		else pending.resolve(result);
	}

	private rejectPasswordBridgeRequests(
		message: string,
		webContentsId?: number,
	): void {
		for (const [requestId, pending] of this.pendingPasswordBridgeRequests) {
			if (webContentsId !== undefined && pending.webContentsId !== webContentsId) continue;
			this.settlePasswordBridgeRequest(requestId, new Error(message));
		}
	}

	private async paymentCardForActiveTab(id: PaymentCardEntryId): Promise<{
		tab: UserBrowserTab;
		webContents: WebContents;
		entry: NonNullable<Awaited<ReturnType<PaymentCardVault["get"]>>>;
		origin: string;
	}> {
		if (!this.paymentCardVault)
			throw new Error("The protected payment card store is unavailable.");
		const tab = this.requireActiveTab();
		const record = this.requireView(tab.id);
		const webContents = liveWebContents(record?.view?.webContents);
		if (!webContents)
			throw new Error("The payment page is still waking up. Try again.");
		const url = safePageUrl(webContents.getURL()) || safePageUrl(tab.url);
		if (!url || url.protocol !== "https:")
			throw new Error("Payment cards can only be filled on HTTPS websites.");
		if (
			!this.paymentPrompt ||
			this.paymentPrompt.tabId !== tab.id ||
			this.paymentPrompt.origin !== url.origin ||
			!this.paymentPrompt.entries.some((entry) => entry.id === id)
		)
			throw new Error("That payment suggestion is no longer available.");
		const entry = await this.paymentCardVault.get(id);
		if (!entry) throw new Error("That saved payment card is not available.");
		return { tab, webContents, entry, origin: url.origin };
	}

	private async readPaymentFormSnapshot(
		webContents: WebContents,
	): Promise<PaymentFormSnapshot> {
		return parsePaymentFormSnapshot(
			await webContents.executeJavaScript(PAYMENT_FORM_SCAN_SCRIPT),
		);
	}

	private async handleHeicUpload(
		tab: UserBrowserTab,
		webContents: WebContents,
		event: Electron.IpcMainEvent,
		raw: unknown,
	): Promise<void> {
		const parsed = HeicUploadMessageSchema.safeParse(raw);
		if (!parsed.success || this.disposed || isKestrelAppPageUrl(tab.url)) return;
		const pageUrl = safePageUrl(webContents.getURL()) || safePageUrl(tab.url);
		const frameUrl = safePageUrl(
			event.senderFrame?.url || webContents.getURL(),
		);
		if (!pageUrl || !frameUrl || pageUrl.origin !== frameUrl.origin) return;

		let originalPaths: string[];
		try {
			originalPaths = this.validatedHeicUploadPaths(parsed.data.paths);
		} catch {
			this.notifyHeicUploadFailure(webContents, parsed.data.inputId);
			return;
		}

		const temporaryDirectory = mkdtempSync(
			join(tmpdir(), "kestrel-heic-upload-"),
		);
		this.temporaryHeicUploadDirectories.add(temporaryDirectory);
		try {
			const convertedPaths: string[] = [];
			const usedFilenames = new Set<string>();
			for (const [index, source] of originalPaths.entries()) {
				if (!isHeicUploadPath(parsed.data.paths[index]!)) {
					convertedPaths.push(source);
					continue;
				}
				const filename = temporaryJpegFilename(source);
				const stem = basename(filename, extname(filename));
				let uniqueFilename = filename;
				let duplicate = 2;
				while (usedFilenames.has(uniqueFilename)) {
					uniqueFilename = `${stem}-${duplicate}.jpeg`;
					duplicate += 1;
				}
				usedFilenames.add(uniqueFilename);
				const destination = join(temporaryDirectory, uniqueFilename);
				await convertHeicImageToJpeg(source, destination);
				convertedPaths.push(destination);
			}
			if (
				this.disposed ||
				!liveWebContents(webContents) ||
				safePageUrl(webContents.getURL())?.origin !== pageUrl.origin
			)
				throw new Error("The page changed before the HEIC image was converted.");
			await this.replaceHeicUploadInputFiles(
				webContents,
				parsed.data.inputId,
				convertedPaths,
			);
			this.retainTemporaryHeicUploadDirectory(temporaryDirectory);
		} catch {
			this.releaseTemporaryHeicUploadDirectory(temporaryDirectory);
			this.notifyHeicUploadFailure(webContents, parsed.data.inputId);
		}
	}

	private validatedHeicUploadPaths(paths: readonly string[]): string[] {
		if (!paths.some(isHeicUploadPath))
			throw new Error("No HEIC image was selected.");
		return paths.map((path) => {
			if (!isAbsolute(path)) throw new Error("The selected image path is invalid.");
			const source = realpathSync(path);
			const metadata = statSync(source);
			if (
				!metadata.isFile() ||
				metadata.size === 0 ||
				metadata.size > MAX_HEIC_UPLOAD_BYTES
			)
				throw new Error("The selected image cannot be converted safely.");
			return source;
		});
	}

	private async replaceHeicUploadInputFiles(
		webContents: WebContents,
		inputId: string,
		paths: string[],
	): Promise<void> {
		const attachedHere = !webContents.debugger.isAttached();
		if (attachedHere) webContents.debugger.attach("1.3");
		try {
			const document = (await webContents.debugger.sendCommand(
				"DOM.getDocument",
				{ depth: 0 },
			)) as { root: { nodeId: number } };
			const selected = (await webContents.debugger.sendCommand(
				"DOM.querySelector",
				{
					nodeId: document.root.nodeId,
					selector: `input[${HEIC_UPLOAD_INPUT_ID_ATTRIBUTE}="${inputId}"]`,
				},
			)) as { nodeId: number };
			if (!selected.nodeId)
				throw new Error("The image upload field is no longer available.");
			await webContents.debugger.sendCommand("DOM.setFileInputFiles", {
				nodeId: selected.nodeId,
				files: paths,
			});
		} finally {
			if (attachedHere && liveWebContents(webContents)) {
				try {
					if (webContents.debugger.isAttached()) webContents.debugger.detach();
				} catch {
					// The page can close while its temporary upload is being installed.
				}
			}
		}
	}

	private notifyHeicUploadFailure(webContents: WebContents, inputId: string): void {
		if (!liveWebContents(webContents)) return;
		try {
			webContents.send(HEIC_UPLOAD_FAILED_CHANNEL, { inputId });
		} catch {
			// Falling back to the original file is best effort after page teardown.
		}
	}

	private retainTemporaryHeicUploadDirectory(directory: string): void {
		const cleanup = setTimeout(
			() => this.releaseTemporaryHeicUploadDirectory(directory),
			HEIC_UPLOAD_TEMPORARY_FILE_TTL_MS,
		);
		cleanup.unref?.();
	}

	private releaseTemporaryHeicUploadDirectory(directory: string): void {
		if (!this.temporaryHeicUploadDirectories.delete(directory)) return;
		try {
			rmSync(directory, { recursive: true, force: true, maxRetries: 2 });
		} catch {
			// Temporary conversion artifacts are never user-owned files.
		}
	}

	private async handlePasswordSubmission(
		tab: UserBrowserTab,
		webContents: WebContents,
		event: Electron.IpcMainEvent,
		raw: unknown,
	): Promise<void> {
		if (
			this.disposed ||
			!this.passwordVault ||
			this.state.settings.passwordAutofillEnabled === false ||
			this.state.settings.offerToSavePasswords === false ||
			tab.id !== this.state.activeTabId ||
			isKestrelAppPageUrl(tab.url)
		)
			return;
		const parsed = PasswordSubmissionMessageSchema.safeParse(raw);
		if (!parsed.success || parsed.data.password.includes("\0")) return;
		const pageUrl =
			safePageUrl(webContents.getURL()) || safePageUrl(tab.url);
		if (event.senderFrame !== webContents.mainFrame) return;
		const frameUrl = safePageUrl(event.senderFrame.url);
		if (
			!pageUrl ||
			pageUrl.protocol !== "https:" ||
			!frameUrl ||
			frameUrl.origin !== pageUrl.origin
		)
			return;
		if (this.state.settings.neverSavePasswordOrigins.includes(pageUrl.origin)) return;
		const suppressionKey = `${tab.id}:${pageUrl.origin}`;
		if (
			(this.passwordPromptSuppressedUntil.get(suppressionKey) ?? 0) >
			this.now().getTime()
		)
			return;
		// Keep only the most recent submission for this tab while the login page
		// remains unconfirmed. This matters when a person corrects a failed
		// password attempt: a later successful navigation must never save the
		// earlier, mistyped secret. Once a save prompt has been confirmed, it is
		// immutable until the person accepts, dismisses, or navigates away.
		if (
			this.pendingPasswordSave?.tabId === tab.id &&
			this.pendingPasswordSave.confirmedAt
		)
			return;
		const pageWidth =
			this.contentBounds.width || this.window.getContentSize()[0] || 800;
		const pageHeight =
			this.contentBounds.height || this.window.getContentSize()[1] || 600;
		const field = parsed.data.passwordFieldRect;
		const anchor = field
			? {
				x: Math.max(0, this.contentBounds.x + field.x),
				y: Math.max(0, this.contentBounds.y + field.y),
				width: field.width,
				height: field.height,
			}
			: {
				x: Math.max(0, this.contentBounds.x + pageWidth - 368),
				y: Math.max(0, this.contentBounds.y + 16),
					width: 348,
					height: Math.min(96, Math.max(1, pageHeight - 32)),
				};
		const loginFlow = this.loginFlows.readContext(tab.id);
		const flowMatchesOrigin = loginFlow?.authOrigin === pageUrl.origin;
		const flowUsername = flowMatchesOrigin
			? loginFlow.username?.slice(0, 500)
			: undefined;
		const flowInitiatingOrigin = flowMatchesOrigin
			? loginFlow.initiatingOrigin
			: undefined;
		this.discardPendingPasswordSave();
		this.pendingPasswordSave = {
			tabId: tab.id,
			origin: pageUrl.origin,
			title: hostnameTitle(pageUrl.toString()),
			username:
				parsed.data.username.trim().slice(0, 500) ||
					flowUsername ||
					"",
			password: parsed.data.password,
			submittedUrl: pageUrl.toString(),
			submittedAt: this.now().getTime(),
			...(flowInitiatingOrigin ? { flowInitiatingOrigin } : {}),
			anchor,
		};
	}

	private async maybeOfferPasswordSaveAfterNavigation(
		tab: UserBrowserTab,
		webContents: WebContents,
		navigationUrl: string,
	): Promise<void> {
		const pending = this.pendingPasswordSave;
		const url = safePageUrl(navigationUrl);
		if (
			!pending ||
			this.disposed ||
			tab.id !== this.state.activeTabId ||
			pending.tabId !== tab.id ||
			!url ||
			url.protocol !== "https:" ||
			url.toString() === pending.submittedUrl ||
			this.now().getTime() - pending.submittedAt > 30_000
		) {
			if (pending && this.now().getTime() - pending.submittedAt > 30_000)
				this.discardPendingPasswordSave();
			return;
		}
		if (this.state.settings.neverSavePasswordOrigins.includes(pending.origin)) {
			this.discardPendingPasswordSave();
			return;
		}
		const expectedLoginDestination =
			url.origin === pending.origin ||
			(pending.flowInitiatingOrigin !== undefined &&
				url.origin === pending.flowInitiatingOrigin);
		if (!expectedLoginDestination) {
			// A submitted secret must not remain eligible while a tab is taken to an
			// unrelated HTTPS page. Exact same-origin or a tracked return to the
			// initiating site is the only cross-origin success relationship we trust.
			this.discardPendingPasswordSave();
			return;
		}
		try {
			const snapshot = await this.readPasswordFormSnapshot(webContents, url.origin);
			// A destination that still contains a current-password field usually
			// signals an unsuccessful login. Do not offer to save in that case.
			if (snapshot.fields.some((field) => field.kind === "password")) return;
			if (
				this.pendingPasswordSave !== pending ||
				safePageUrl(webContents.getURL())?.toString() !== url.toString()
			)
				return;
			const entries = (await this.passwordVault?.listForOrigin(pending.origin) ?? []).slice(0, 24);
			pending.confirmedUrl = url.toString();
			pending.confirmedAt = this.now().getTime();
			this.setPasswordPrompt(
				PasswordPromptSchema.parse({
					tabId: tab.id,
					origin: pending.origin,
					title: pending.title,
					mode: "save",
					fields: [],
					entries,
					candidate: { username: pending.username },
					anchor: pending.anchor,
				}),
			);
		} catch {
			// The destination may still be constructing its preload document. Its
			// did-stop-loading event will make one more bounded attempt.
		}
	}

	private async refreshPasswordPrompt(tabId?: string): Promise<void> {
		if (
			this.disposed ||
			!this.passwordVault ||
			this.passwordScanInFlight ||
			this.state.settings.passwordAutofillEnabled === false
		)
			return;
		if (tabId && tabId !== this.state.activeTabId) return;
		const tab = this.state.tabs.find(
			(candidate) => candidate.id === (tabId ?? this.state.activeTabId),
		);
		const record = tab ? this.views.get(tab.id) : undefined;
		const webContents = liveWebContents(record?.view?.webContents);
		const url = tab?.url
			? safePageUrl(webContents?.getURL() || tab.url)
			: undefined;
		if (
			!tab ||
			!webContents ||
			!url ||
			url.protocol !== "https:" ||
			isKestrelAppPageUrl(tab.url)
		) {
			this.clearPasswordPrompt();
			return;
		}
		if (
			this.pendingPasswordSave?.tabId === tab.id &&
			!this.pendingPasswordSave.confirmedAt
		)
			return;
		const suppressionKey = `${tab.id}:${url.origin}`;
		if (
			(this.passwordPromptSuppressedUntil.get(suppressionKey) ?? 0) >
			this.now().getTime()
		) {
			this.clearPasswordPrompt();
			return;
		}
		const automaticFillKey = `${tab.id}:${url.toString()}`;
		if (
			(this.passwordAutofilledUntil.get(automaticFillKey) ?? 0) >
			this.now().getTime()
		) {
			this.clearPasswordPrompt();
			return;
		}
		// A submitted credential is held only in the main process until the user
		// explicitly confirms the save. Do not let the regular fill scan replace
		// that confirmation while the page is still settling.
		if (this.passwordPrompt?.mode === "save") {
			if (
				this.passwordPrompt.tabId === tab.id &&
				this.passwordPrompt.origin === url.origin
			)
				return;
			this.clearPasswordPrompt();
		}

		this.passwordScanInFlight = true;
		const scanGeneration = this.passwordPromptGeneration;
		try {
			const snapshot = await this.readPasswordFormSnapshot(webContents, url.origin);
			if (
				scanGeneration !== this.passwordPromptGeneration ||
				this.passwordPrompt?.mode === "save"
			)
				return;
			if (!snapshot.fields.length) {
				this.clearPasswordPrompt({
					preservePending: this.pendingPasswordSave?.tabId === tab.id,
				});
				return;
			}
			const credentialFields = snapshot.fields.filter(
				(field) =>
					field.kind === "username" ||
					field.kind === "password" ||
					field.kind === "new-password",
			);
			if (!credentialFields.length) {
				this.clearPasswordPrompt({
					preservePending: this.pendingPasswordSave?.tabId === tab.id,
				});
				return;
			}
			const focused = snapshot.focusedFieldId
				? snapshot.fields.find((field) => field.id === snapshot.focusedFieldId)
				: undefined;
			const newPasswordField = snapshot.fields.find(
				(field) => field.kind === "new-password",
			);
			if (newPasswordField && this.state.settings.offerStrongPasswords) {
				this.setPasswordPrompt(
					PasswordPromptSchema.parse({
						tabId: tab.id,
						origin: url.origin,
						title: redactUntrustedBrowserText(
							webContents.getTitle() || hostnameTitle(url.toString()),
							500,
						),
						mode: "generate",
						fields: snapshot.fields,
						...(focused ? { focusedFieldId: focused.id } : {}),
						entries: [],
						anchor: this.passwordPromptAnchor(snapshot, focused),
					}),
				);
				return;
			}
			const entries = (await this.passwordVault.listForOrigin(url.origin)).slice(
				0,
				24,
			);
			if (scanGeneration !== this.passwordPromptGeneration)
				return;
			if (!entries.length) {
				this.clearPasswordPrompt({
					preservePending: this.pendingPasswordSave?.tabId === tab.id,
				});
				return;
			}
			if (
				this.state.settings.autofillPasswords === false &&
				this.state.settings.autofillUsernames === false
			) {
				this.clearPasswordPrompt({
					preservePending: this.pendingPasswordSave?.tabId === tab.id,
				});
				return;
			}
			const flow = this.loginFlows.readContext(tab.id);
			const selectedFlowEntry =
				flow?.authOrigin === url.origin && flow.selectedCredentialId
					? entries.find((entry) => entry.id === flow.selectedCredentialId)
					: undefined;
			const automaticEntry = selectedFlowEntry ?? (entries.length === 1 ? entries[0] : undefined);
			if (automaticEntry) {
				const candidate = await this.passwordVault.getForOrigin(automaticEntry.id, url.origin);
				if (candidate) {
					try {
						if (scanGeneration !== this.passwordPromptGeneration) return;
						const filled = await this.fillPasswordFields(webContents, url.origin, {
							username: candidate.username,
							password: candidate.password,
							includeUsername: this.state.settings.autofillUsernames,
							includePassword: this.state.settings.autofillPasswords,
						});
						if (filled > 0) {
							this.loginFlows.selectCredential(tab.id, candidate.id, candidate.username);
							this.loginFlows.markAutofill(tab.id);
							void this.markPasswordUsed(candidate.id, url.origin);
							this.passwordAutofilledUntil.set(
								automaticFillKey,
								this.now().getTime() + 5_000,
							);
							this.clearPasswordPrompt({
								preservePending: this.pendingPasswordSave?.tabId === tab.id,
							});
							return;
						}
					} finally {
						discardPasswordEntry(candidate);
					}
				}
			}
			const prompt = PasswordPromptSchema.parse({
				tabId: tab.id,
				origin: url.origin,
				title: redactUntrustedBrowserText(
					webContents.getTitle() || hostnameTitle(url.toString()),
					500,
				),
				mode: focused ? "field" : "page",
				fields: snapshot.fields,
				...(focused ? { focusedFieldId: focused.id } : {}),
				entries,
				anchor: this.passwordPromptAnchor(snapshot, focused),
			});
			this.setPasswordPrompt(prompt);
		} catch {
			// A navigation or renderer restart can invalidate a scan. The next
			// interval will retry without surfacing a page-owned error to the user.
			this.clearPasswordPrompt({
				preservePending: this.pendingPasswordSave?.tabId === tab.id,
			});
		} finally {
			this.passwordScanInFlight = false;
		}
	}

	private setPasswordPrompt(prompt: PasswordPrompt): void {
		const key = JSON.stringify({
			tabId: prompt.tabId,
			origin: prompt.origin,
			mode: prompt.mode,
			candidate: prompt.candidate,
			focusedFieldId: prompt.focusedFieldId,
			entries: prompt.entries.map((entry) => entry.id),
			fields: prompt.fields.map((field) => [field.id, field.rect]),
		});
		if (key === this.passwordPromptKey) return;
		this.passwordPromptKey = key;
		this.passwordPrompt = prompt;
		this.onPasswordPrompt?.(prompt);
	}

	private passwordPromptAnchor(
		snapshot: PasswordFormSnapshot,
		focused?: PasswordFormField,
	): PasswordPrompt["anchor"] {
		const target = focused ?? snapshot.fields.find((field) => field.kind !== "new-password");
		if (target) {
			return {
				x: Math.max(0, this.contentBounds.x + target.rect.x),
				y: Math.max(0, this.contentBounds.y + target.rect.y),
				width: target.rect.width,
				height: target.rect.height,
			};
		}
		const pageWidth = this.contentBounds.width || this.window.getContentSize()[0] || 800;
		const pageHeight = this.contentBounds.height || this.window.getContentSize()[1] || 600;
		return {
			x: Math.max(0, this.contentBounds.x + pageWidth - 368),
			y: Math.max(0, this.contentBounds.y + 16),
			width: 348,
			height: Math.min(96, Math.max(1, pageHeight - 32)),
		};
	}

	private clearPasswordPrompt(options: { preservePending?: boolean } = {}): void {
		this.passwordPromptGeneration += 1;
		// Never keep a submitted password alive after the associated prompt or page
		// is gone. The secret is intentionally not part of any renderer contract.
		if (!options.preservePending) this.discardPendingPasswordSave();
		if (!this.passwordPrompt && !this.passwordPromptKey) return;
		this.passwordPrompt = undefined;
		this.passwordPromptKey = "";
		this.onPasswordPrompt?.(null);
	}

	private discardPendingPasswordSave(): void {
		if (this.pendingPasswordSave) this.pendingPasswordSave.password = "";
		this.pendingPasswordSave = undefined;
	}

	private suppressPasswordPrompt(
		tabId: string,
		origin: string,
		durationMs: number,
	): void {
		this.passwordPromptSuppressedUntil.set(
			`${tabId}:${origin}`,
			this.now().getTime() + durationMs,
		);
	}

	private async refreshPaymentPrompt(tabId?: string): Promise<void> {
		if (
			this.disposed ||
			!this.paymentCardVault ||
			this.paymentScanInFlight ||
			this.state.settings.paymentAutofillEnabled === false
		)
			return;
		if (tabId && tabId !== this.state.activeTabId) return;
		const tab = this.state.tabs.find(
			(candidate) => candidate.id === (tabId ?? this.state.activeTabId),
		);
		const record = tab ? this.views.get(tab.id) : undefined;
		const webContents = liveWebContents(record?.view?.webContents);
		const url = tab?.url
			? safePageUrl(webContents?.getURL() || tab.url)
			: undefined;
		if (
			!tab ||
			!webContents ||
			!url ||
			url.protocol !== "https:" ||
			isKestrelAppPageUrl(tab.url)
		) {
			this.clearPaymentPrompt();
			return;
		}
		const suppressionKey = `${tab.id}:${url.origin}`;
		if (
			(this.paymentPromptSuppressedUntil.get(suppressionKey) ?? 0) >
			this.now().getTime()
		) {
			this.clearPaymentPrompt();
			return;
		}

		this.paymentScanInFlight = true;
		try {
			const snapshot = await this.readPaymentFormSnapshot(webContents);
			const numberField = snapshot.fields.find(
				(field) => field.kind === "card-number",
			);
			if (!numberField) {
				this.clearPaymentPrompt();
				return;
			}
			const entries = (await this.paymentCardVault.list()).slice(0, 24);
			const candidate = snapshot.candidate;
			const savedCandidate = candidate
				? entries.find(
						(entry) =>
							entry.last4 === candidate.last4 &&
							entry.brand === candidate.brand &&
							(!candidate.expirationMonth ||
								entry.expirationMonth === candidate.expirationMonth) &&
							(!candidate.expirationYear ||
								entry.expirationYear === candidate.expirationYear),
					)
				: undefined;
			if (!candidate && !entries.length) {
				this.clearPaymentPrompt();
				return;
			}
			const focused = snapshot.focusedFieldId
				? snapshot.fields.find((field) => field.id === snapshot.focusedFieldId)
				: undefined;
			const pageWidth =
				this.contentBounds.width || this.window.getContentSize()[0] || 800;
			const pageHeight =
				this.contentBounds.height || this.window.getContentSize()[1] || 600;
			const anchorField = focused ?? numberField;
			const anchor = anchorField
				? {
					x: Math.max(0, this.contentBounds.x + anchorField.rect.x),
					y: Math.max(0, this.contentBounds.y + anchorField.rect.y),
					width: anchorField.rect.width,
					height: anchorField.rect.height,
				}
				: {
					x: Math.max(0, this.contentBounds.x + pageWidth - 430),
					y: Math.max(0, this.contentBounds.y + 16),
					width: 410,
					height: Math.min(96, Math.max(1, pageHeight - 32)),
				};
			const prompt = PaymentPromptSchema.parse({
				tabId: tab.id,
				origin: url.origin,
				title: redactUntrustedBrowserText(
					webContents.getTitle() || hostnameTitle(url.toString()),
					500,
				),
				mode: candidate && !savedCandidate ? "save" : "fill",
				fields: snapshot.fields,
				...(focused ? { focusedFieldId: focused.id } : {}),
				entries,
				...(candidate && !savedCandidate ? { candidate } : {}),
				anchor,
			});
			this.setPaymentPrompt(prompt);
		} catch {
			// Navigation and renderer restarts can invalidate a scan. Retry on the
			// next interval without surfacing a page-owned error.
			this.clearPaymentPrompt();
		} finally {
			this.paymentScanInFlight = false;
		}
	}

	private setPaymentPrompt(prompt: PaymentPrompt): void {
		const key = JSON.stringify({
			tabId: prompt.tabId,
			origin: prompt.origin,
			mode: prompt.mode,
			candidate: prompt.candidate,
			focusedFieldId: prompt.focusedFieldId,
			entries: prompt.entries.map((entry) => entry.id),
			fields: prompt.fields.map((field) => [field.id, field.rect]),
		});
		if (key === this.paymentPromptKey) return;
		this.paymentPromptKey = key;
		this.paymentPrompt = prompt;
		this.onPaymentPrompt?.(prompt);
	}

	private clearPaymentPrompt(): void {
		if (!this.paymentPrompt && !this.paymentPromptKey) return;
		this.paymentPrompt = undefined;
		this.paymentPromptKey = "";
		this.onPaymentPrompt?.(null);
	}

	private suppressPaymentPrompt(
		tabId: string,
		origin: string,
		durationMs: number,
	): void {
		this.paymentPromptSuppressedUntil.set(
			`${tabId}:${origin}`,
			this.now().getTime() + durationMs,
		);
	}

	isActiveTab(tabId: string): boolean {
		return this.state.activeTabId === tabId;
	}

	async insertLoginCode(
		tabId: string,
		code: string,
		expectedDomain: string,
		expectedOrigin: string,
	): Promise<void> {
		if (!/^[A-Z0-9][A-Z0-9-]{3,15}$/.test(code))
			throw new Error("The login code is invalid.");
		if (!this.isActiveTab(tabId))
			throw new Error("The verification page is no longer active.");
		const domain = pageDomain(`https://${expectedDomain}`);
		const originUrl = safePageUrl(expectedOrigin);
		if (!domain || !originUrl || originUrl.origin !== expectedOrigin)
			throw new Error("The verification page domain is invalid.");
		const tab = this.requireTab(tabId);
		const record = this.requireView(tab.id);
		const webContents = liveWebContents(record?.view?.webContents);
		if (!webContents)
			throw new Error("The verification page is still waking up. Try again.");
		if (
			pageDomain(webContents.getURL()) !== domain ||
			safePageUrl(webContents.getURL())?.origin !== expectedOrigin
		)
			throw new Error("The page changed before the code was used.");
		const focusedCodeField = await webContents.executeJavaScript(`(() => {
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0;
      };
      const explicitSelector = [
        'input[autocomplete="one-time-code"]',
        'input[name*="code" i]',
        'input[id*="code" i]',
        'input[placeholder*="code" i]',
        'input[name*="otp" i]',
        'input[id*="otp" i]',
      ].join(",");
      const explicitTarget = Array.from(document.querySelectorAll(explicitSelector)).find(visible);
      const target = explicitTarget ?? Array.from(document.querySelectorAll('input[type="tel"]')).find(visible);
      if (!target) return false;
      target.focus();
      if (typeof target.select === "function") target.select();
      return true;
    })()`);
		if (!focusedCodeField)
			throw new Error("The page changed; Kestrel could not find its code field.");
		if (
			pageDomain(webContents.getURL()) !== domain ||
			safePageUrl(webContents.getURL())?.origin !== expectedOrigin
		)
			throw new Error("The page changed before the code was used.");
		webContents.focus();
		webContents.insertText(code);
	}

	async snapshot(
		tabId?: string,
		signal?: AbortSignal,
	): Promise<BrowserSnapshot> {
		return this.runExclusiveTabMutation(
			() => this.snapshotWhilePinned(tabId, signal),
			signal,
		);
	}

	private async snapshotWhilePinned(
		tabId?: string,
		signal?: AbortSignal,
	): Promise<BrowserSnapshot> {
		const resolvedTabId = tabId ?? this.requireActiveTab().id;
		return this.withAgentTabPin(resolvedTabId, async () => {
			const tab = this.requireTab(resolvedTabId);
			const record = this.ensureView(tab);
			const webContents = liveWebContents(record?.view?.webContents);
			if (!webContents)
				throw new Error("The selected page is still waking up. Try again.");
		if (signal?.aborted) throw signal.reason;
		const url =
			sanitizeBrowserUrl(webContents.getURL()) ||
			sanitizeBrowserUrl(tab.url);
		if (!url) {
			this.elementRefs.set(tab.id, new Map());
			this.sensitiveElementRefs.delete(tab.id);
			return {
				url: "about:blank",
				title: (webContents.getTitle() || tab.title || "New Tab").slice(
					0,
					500,
				),
				accessibilityTree: { nodes: [] },
				interactive: [],
			};
		}
		if (!webContents.debugger.isAttached()) webContents.debugger.attach("1.3");
		const result = (await webContents.debugger.sendCommand(
			"Accessibility.getFullAXTree",
		)) as { nodes?: unknown[] };
		const nodes = result.nodes ?? [];
		const annotated = annotateAccessibilityTree({
			nodes: nodes.slice(0, MAX_AX_SNAPSHOT_NODES),
		});
		const interactive = annotated.interactive.slice(0, MAX_INTERACTIVE_REFS);
		const accessibilityTree = sanitizeUntrustedBrowserValue(
			annotated.accessibilityTree,
		);
		if (
			Buffer.byteLength(JSON.stringify(accessibilityTree), "utf8") >
			MAX_AX_SNAPSHOT_BYTES
		) {
			this.elementRefs.set(tab.id, new Map());
			this.sensitiveElementRefs.delete(tab.id);
			throw new Error("Visible browser accessibility snapshot exceeds 1.5 MB.");
		}
		this.elementRefs.set(tab.id, rememberElementRefs(interactive));
		this.sensitiveElementRefs.set(
			tab.id,
			new Set(
				interactive
					.filter((item) => isSensitiveAgentFieldName(item.name))
					.map((item) => item.ref),
			),
		);
		return {
			url,
			title: redactUntrustedBrowserText(webContents.getTitle(), 500),
			accessibilityTree,
			interactive: publicInteractiveRefs(interactive).map((item) => ({
				ref: item.ref,
				role: item.role,
				...(item.name
					? { name: redactUntrustedBrowserText(item.name, 500) }
					: {}),
			})),
			truncated:
				nodes.length > MAX_AX_SNAPSHOT_NODES ||
				annotated.interactive.length > MAX_INTERACTIVE_REFS,
		};
		});
	}

	searchHistory(
		query = "",
		limit = 30,
	): {
		entries: UserBrowserHistoryEntry[];
		trust: "untrusted_browser";
	} {
		const needle = query.trim().toLocaleLowerCase();
		const entries = [...this.state.history]
			.reverse()
			.flatMap((entry) => {
				const url = sanitizeBrowserUrl(entry.url);
				if (!url) return [];
				const sanitized = {
					...entry,
					url,
					title: redactUntrustedBrowserText(entry.title, 500),
				};
				if (
					needle &&
					!`${sanitized.title}\n${sanitized.url}`
						.toLocaleLowerCase()
						.includes(needle)
				)
					return [];
				return [sanitized];
			})
			.slice(0, Math.min(100, Math.max(1, Math.trunc(limit))));
		return { entries: structuredClone(entries), trust: "untrusted_browser" };
	}

	visibleDownloads(): {
		downloads: UserBrowserDownload[];
		trust: "untrusted_browser";
	} {
		return {
			downloads: structuredClone([...this.state.downloads].reverse()),
			trust: "untrusted_browser",
		};
	}

	async screenshot(
		tabId?: string,
		signal?: AbortSignal,
	): Promise<ScreenshotFrame> {
		return this.runExclusiveTabMutation(
			() => this.screenshotWhilePinned(tabId, signal),
			signal,
		);
	}

	private async screenshotWhilePinned(
		tabId?: string,
		signal?: AbortSignal,
	): Promise<ScreenshotFrame> {
		const resolvedTabId = tabId ?? this.requireActiveTab().id;
		return this.withAgentTabPin(resolvedTabId, async () => {
			const tab = this.requireTab(resolvedTabId);
			let lastError: Error | undefined;
			for (
				let attempt = 0;
				attempt < SCREENSHOT_CAPTURE_ATTEMPTS;
				attempt++
			) {
				if (signal?.aborted) throw screenshotCancellationError(signal);
				await this.syncActiveView();
				const record = this.ensureView(tab);
				const view = record.view;
				const webContents = liveWebContents(view?.webContents);
					if (
						!webContents ||
					!this.contentVisible ||
					!this.window.contentView.children.includes(view)
				) {
					lastError = new Error(
						"Active browser view is not attached for screenshot.",
					);
					await new Promise<void>((resolve) => setTimeout(resolve, 50));
						continue;
					}
					await this.assertScreenshotHasNoSensitiveForm(tab, webContents);
					try {
					const image = await capturePageWithDeadline(webContents, signal);
					const { width, height } = image.getSize();
					if (width < 1 || height < 1) {
						throw new Error("Screenshot capture returned an empty frame.");
					}
					const bgra = image.toBitmap();
					const rgba = new Uint8Array(bgra.byteLength);
					for (let offset = 0; offset < bgra.length; offset += 4) {
						rgba[offset] = bgra[offset + 2]!;
						rgba[offset + 1] = bgra[offset + 1]!;
						rgba[offset + 2] = bgra[offset]!;
						rgba[offset + 3] = bgra[offset + 3]!;
					}
					return { width, height, rgba, png: image.toPNG() };
				} catch (cause) {
					if (signal?.aborted)
						throw screenshotCancellationError(signal);
					lastError =
						cause instanceof Error
							? cause
							: new Error("Visible browser screenshot capture failed.");
					if (liveWebContents(webContents)) webContents.invalidate();
					await new Promise<void>((resolve) => setTimeout(resolve, 50));
				}
			}
			throw (
				lastError ?? new Error("Visible browser screenshot capture failed.")
			);
			});
	}

	private async assertScreenshotHasNoSensitiveForm(
		tab: UserBrowserTab,
		webContents: WebContents,
	): Promise<void> {
		if (isKestrelAppPageUrl(tab.url)) return;
		const url = safePageUrl(webContents.getURL()) || safePageUrl(tab.url);
		if (!url || url.protocol !== "https:") return;
		const snapshot = await this.readPasswordFormSnapshot(webContents, url.origin);
		if (
			snapshot.fields.some(
				(field) =>
					field.kind === "password" ||
					field.kind === "new-password" ||
					field.kind === "secret",
			)
		)
			throw new Error(
				"Kestrel does not share browser screenshots from pages with sensitive input fields.",
			);
	}

	async act(
		tabId: string,
		action: BrowserAction,
		signal: AbortSignal,
	): Promise<void> {
		return this.runExclusiveTabMutation(
			() => this.actWhilePinned(tabId, action, signal),
			signal,
		);
	}

	private async actWhilePinned(
		tabId: string,
		action: BrowserAction,
		signal: AbortSignal,
	): Promise<void> {
		return this.withAgentTabPin(tabId, async () => {
			const record = this.ensureView(this.requireTab(tabId));
			const webContents = liveWebContents(record?.view?.webContents);
			if (!webContents)
				throw new Error("The selected page is still waking up. Try again.");
		if (signal.aborted) throw signal.reason;
		if (action.type === "click") {
			const point = await this.targetPoint(
				webContents,
				action.target,
				false,
				tabId,
				signal,
			);
			if (signal.aborted) throw signal.reason;
			await dispatchBrowserMouseClick(webContents, point, signal);
			await new Promise<void>((resolveSettle) => setImmediate(resolveSettle));
		} else if (action.type === "type") {
			const ref = normalizeBrowserElementRef(action.target);
			if (!ref)
				throw new Error(
					"Kestrel agents must use a current accessibility ref before typing into a browser field.",
				);
			if (this.sensitiveElementRefs.get(tabId)?.has(ref))
				throw new Error(
					"Kestrel agents cannot type into a sensitive browser field. Ask the user to enter that value directly.",
				);
			await this.targetPoint(
				webContents,
				action.target,
				true,
				tabId,
				signal,
				true,
			);
			if (signal.aborted) throw signal.reason;
			webContents.insertText(action.text);
		} else if (action.type === "select") {
			await selectBrowserOption(
				webContents,
				action.target,
				action.value,
				this.elementRefs.get(tabId),
				signal,
			);
		} else if (action.type === "key") {
			if (
				!/^[A-Za-z0-9]{1,20}$/.test(action.key) &&
				![
					"Enter",
					"Escape",
					"Tab",
					"Backspace",
					"ArrowUp",
					"ArrowDown",
					"ArrowLeft",
					"ArrowRight",
				].includes(action.key)
			)
				throw new Error("Browser key is not allowed.");
			webContents.sendInputEvent({ type: "keyDown", keyCode: action.key });
			webContents.sendInputEvent({ type: "keyUp", keyCode: action.key });
		} else {
			webContents.sendInputEvent({
				type: "mouseWheel",
				x: 0,
				y: 0,
				deltaX: Math.trunc(action.x),
				deltaY: Math.trunc(action.y),
				canScroll: true,
			});
		}
		await this.syncActiveView();
		});
	}

	async handleAgentRequest(
		request: UserBrowserBackendWireRequest,
		signal: AbortSignal,
	): Promise<unknown> {
		return this.runExclusiveTabMutation(async () => {
			if (signal.aborted) throw signal.reason;
			const tabId = "tabId" in request ? request.tabId : undefined;
			if (
				tabId &&
				(request.operation === "visible-navigate" ||
					request.operation === "visible-select" ||
					request.operation === "visible-autofill")
			) {
				return this.withAgentTabPin(tabId, () =>
					this.dispatchAgentRequest(request, signal),
				);
			}
			return this.dispatchAgentRequest(request, signal);
		}, signal);
	}

	private async dispatchAgentRequest(
		request: UserBrowserBackendWireRequest,
		signal: AbortSignal,
	): Promise<unknown> {
		switch (request.operation) {
			case "visible-tabs":
				return this.getState().tabs.map((tab) => ({
					id: tab.id,
					title: tab.title,
					url: sanitizeBrowserUrl(tab.url),
					active: tab.id === this.state.activeTabId,
					loading: tab.loading,
					discarded: tab.discarded,
					trust: "untrusted_browser" as const,
				}));
			case "visible-context":
				return this.pageContextWhilePinned(request.tabId);
			case "visible-snapshot":
				return {
					...(await this.snapshotWhilePinned(request.tabId, signal)),
					trust: "untrusted_browser",
				};
			case "visible-screenshot":
				return {
					...(await this.screenshotWhilePinned(request.tabId, signal)),
					trust: "untrusted_browser",
				};
			case "visible-history":
				return this.searchHistory(request.query, request.limit);
			case "visible-downloads":
				return this.visibleDownloads();
			case "visible-autofill":
				return this.autofillCredentialForAgent(request.tabId, signal);
			case "visible-act":
				await this.actWhilePinned(request.tabId, request.action, signal);
				return { performed: true };
			case "visible-navigate":
				await this.navigate(request.tabId, request.input);
				return { navigated: true };
			case "visible-create": {
				const state = await this.createTab(request.input, true);
				return { tabId: state.activeTabId };
			}
			case "visible-close":
				await this.closeTabInternal(request.tabId);
				return { closed: true };
			case "visible-select":
				await this.selectTab(request.tabId);
				return { selected: true };
			default: {
				const unsupported: never = request;
				throw new Error(
					`Unsupported visible-browser operation: ${String(unsupported)}`,
				);
			}
		}
	}

	sleepTab(tabId: string): UserBrowserState {
		if (tabId === this.state.activeTabId || this.isAgentTabPinned(tabId))
			return this.getState();
		const tab = this.requireTab(tabId);
		if (
			!tab.url ||
			isKestrelAppPageUrl(tab.url) ||
			isAuthenticationFlowUrl(tab.url)
		)
			return this.getState();
		this.closeView(tabId);
		tab.discarded = true;
		this.commit();
		return this.getState();
	}

	sleepInactiveTabs(): UserBrowserState {
		for (const tab of this.state.tabs) {
			if (
				tab.id === this.state.activeTabId ||
				this.isAgentTabPinned(tab.id) ||
				!tab.url ||
				tab.discarded ||
				isKestrelAppPageUrl(tab.url) ||
				isAuthenticationFlowUrl(tab.url)
			)
				continue;
			const record = this.views.get(tab.id);
			const webContents = liveWebContents(record?.view?.webContents);
			if (
				webContents &&
				webContents.isCurrentlyAudible()
			) {
				continue;
			}
			this.closeView(tab.id);
			tab.discarded = true;
		}
		this.commit();
		return this.getState();
	}

	private startSleepingTabsMonitor(): void {
		if (this.sleepingTabsInterval) clearInterval(this.sleepingTabsInterval);
		this.sleepingTabsInterval = setInterval(() => {
			this.checkSleepingTabs();
		}, 30_000);
	}

	private checkSleepingTabs(): void {
		if (
			this.disposed ||
			!this.state.settings.sleepingTabsEnabled ||
			!this.state.settings.memorySaverMode
		)
			return;
		const timeoutMinutes = this.state.settings.sleepingTabTimeoutMinutes || 30;
		const timeoutMs = timeoutMinutes * 60 * 1000;
		const nowTime = this.now().getTime();
		let changed = false;

		for (const tab of this.state.tabs) {
			if (
				tab.id === this.state.activeTabId ||
				this.isAgentTabPinned(tab.id) ||
				!tab.url ||
				tab.discarded ||
				isKestrelAppPageUrl(tab.url) ||
				isAuthenticationFlowUrl(tab.url)
			)
				continue;
			const lastActive = Date.parse(tab.lastActiveAt);
			if (isNaN(lastActive) || nowTime - lastActive < timeoutMs) continue;

			// Do not sleep tabs that are playing audio
			const record = this.views.get(tab.id);
			const webContents = liveWebContents(record?.view?.webContents);
			if (
				webContents &&
				webContents.isCurrentlyAudible()
			) {
				continue;
			}

			// Do not sleep tabs matching excluded domains
			try {
				const hostname = new URL(tab.url).hostname.toLowerCase();
				if (
					this.state.settings.sleepingTabExcludedDomains?.some((domain) =>
						hostname.includes(domain.toLowerCase().trim()),
					)
				) {
					continue;
				}
			} catch {
				// Ignore parse error
			}

			this.closeView(tab.id);
			tab.discarded = true;
			changed = true;
		}

		if (changed) {
			this.commit();
		}
	}

	listExtensions(): InstalledExtension[] {
		return this.extensionManager.list();
	}

	private extensionOperationError(
		cause: unknown,
		operation: "install" | "manage",
	): Error {
		// Keep the actionable native cause in the desktop log, but never send a
		// filesystem path or Electron implementation detail to the renderer.
		console.warn(`[Extension] ${operation} operation failed:`, cause);
		return new Error(
			operation === "install"
				? chromeWebStoreInstallErrorMessage(cause)
				: browserExtensionOperationErrorMessage(cause),
		);
	}

	async inspectExtensionUrl(
		urlOrId: string,
	): Promise<ChromeWebStoreExtensionInspection> {
		try {
			await this.extensionStartup;
			return await this.extensionManager.inspectChromeWebStore(urlOrId);
		} catch (cause) {
			throw this.extensionOperationError(cause, "install");
		}
	}

	async installReviewedExtension(inspectionId: string): Promise<InstalledExtension> {
		try {
			await this.extensionStartup;
			return await this.extensionManager.installInspectedChromeWebStore(
				inspectionId,
				this.extensionRuntime,
			);
		} catch (cause) {
			throw this.extensionOperationError(cause, "install");
		}
	}

	async installExtensionFile(filePath: string): Promise<InstalledExtension> {
		try {
			await this.extensionStartup;
			return await this.extensionManager.installFromCrxOrZipFile(
				filePath,
				this.extensionRuntime,
			);
		} catch (cause) {
			throw this.extensionOperationError(cause, "manage");
		}
	}

	async installExtensionFolder(
		folderPath: string,
	): Promise<InstalledExtension> {
		try {
			await this.extensionStartup;
			return await this.extensionManager.installFromUnpacked(
				folderPath,
				this.extensionRuntime,
			);
		} catch (cause) {
			throw this.extensionOperationError(cause, "manage");
		}
	}

	async toggleExtension(
		id: string,
		enabled: boolean,
	): Promise<InstalledExtension> {
		try {
			await this.extensionStartup;
			return await this.extensionManager.toggle(id, enabled, this.extensionRuntime);
		} catch (cause) {
			throw this.extensionOperationError(cause, "manage");
		}
	}

	async reloadExtension(id: string): Promise<InstalledExtension> {
		try {
			await this.extensionStartup;
			return await this.extensionManager.reload(id, this.extensionRuntime);
		} catch (cause) {
			throw this.extensionOperationError(cause, "manage");
		}
	}

	async uninstallExtension(id: string): Promise<void> {
		try {
			await this.extensionStartup;
			return await this.extensionManager.uninstall(id, this.extensionRuntime);
		} catch (cause) {
			throw this.extensionOperationError(cause, "manage");
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.sleepingTabsInterval) clearInterval(this.sleepingTabsInterval);
		if (this.paymentPollInterval) clearInterval(this.paymentPollInterval);
		this.paymentPollInterval = undefined;
		this.rejectPasswordBridgeRequests("The browser tab is no longer available.");
		this.loginFlows.clearAll();
		this.clearPasswordPrompt();
		this.clearPaymentPrompt();
		this.partitionCoordinator.unregister(this.partitionParticipant);
		for (const tabId of [...this.views.keys()]) this.closeView(tabId);
		this.elementRefs.clear();
		this.sensitiveElementRefs.clear();
		this.pendingContextDownloads.clear();
		for (const directory of [...this.temporaryHeicUploadDirectories])
			this.releaseTemporaryHeicUploadDirectory(directory);
	}

	private handleWillDownload(
		_event: Electron.Event,
		item: Electron.DownloadItem,
		webContents: WebContents,
	): void {
		const tabId = this.webContentsToTab.get(webContents.id);
		if (!tabId) {
			item.cancel();
			return;
		}
		const pendingContextDownload = this.takePendingContextDownload(
			webContents.id,
			item.getURL(),
		);
		const id = `download-${randomUUID()}`;
		const filename = pendingContextDownload
			? safeDownloadFilename(
					basename(pendingContextDownload.defaultPath),
					`${id}.download`,
				)
			: this.availableDownloadName(item.getFilename(), id);
		let path =
			pendingContextDownload?.defaultPath ??
			join(this.downloadDirectory, filename);
		const startedAt = this.now().toISOString();
		const askForLocation =
			Boolean(pendingContextDownload) ||
			this.state.settings.downloadBehavior === "ask";
		const requiresReputationCheck = this.threatProvider.available;
		// Pause before allocating a destination or displaying the save panel. A
		// provider can then block a bad download without a partial file being
		// written to disk. Electron keeps the normal download implementation and
		// its macOS quarantine behavior; Kestrel never edits xattrs or launch policy.
		if (requiresReputationCheck && typeof item.pause === "function") item.pause();
		this.downloadPaths.set(id, path);
		this.activeDownloads.set(id, item);
		this.state.downloads.push({
			id,
			tabId,
			filename,
			sourceUrl: sanitizeBrowserUrl(item.getURL()) || "https://invalid.local/",
			receivedBytes: 0,
			totalBytes: Math.max(0, item.getTotalBytes()),
			status: requiresReputationCheck ? "checking" : "progressing",
			startedAt,
			canReveal: false,
		});
		this.state.downloads.splice(
			0,
			Math.max(0, this.state.downloads.length - MAX_DOWNLOAD_ENTRIES),
		);
		this.commit();
		item.on("updated", () => {
			const record = this.state.downloads.find(
				(download) => download.id === id,
			);
			if (!record || record.status !== "progressing") return;
			record.receivedBytes = Math.max(0, item.getReceivedBytes());
			record.totalBytes = Math.max(0, item.getTotalBytes());
			this.emit();
		});
		item.once("done", (_doneEvent, status) => {
			this.activeDownloads.delete(id);
			const record = this.state.downloads.find(
				(download) => download.id === id,
			);
			if (!record) return;
			record.receivedBytes = Math.max(0, item.getReceivedBytes());
			record.totalBytes = Math.max(0, item.getTotalBytes());
				if (record.status === "blocked" || record.status === "cancelled") {
					record.canReveal = false;
					record.completedAt ??= this.now().toISOString();
				this.commit();
				return;
			}
			record.status =
				status === "completed"
					? "completed"
					: status === "cancelled"
						? "cancelled"
						: "failed";
			record.completedAt = this.now().toISOString();
			record.canReveal = status === "completed" && existsSync(path);
			this.commit();
			if (
				status === "completed" &&
				record.canReveal &&
				record.reputation?.verdict === "unknown" &&
				this.suspiciousDownloadAnalyzer
			) {
				void this.suspiciousDownloadAnalyzer
					.analyze({
						downloadId: id,
						filePath: path,
						filename,
						sourceUrl: record.sourceUrl,
						reputation: {
							verdict: "unknown",
							provider: record.reputation.provider,
							reason: "unavailable",
						},
					})
					.catch(() => undefined);
			}
		});
		if (!pendingContextDownload)
			this.restoreDirectDownloadNavigation(tabId, item);
		const record = () =>
			this.state.downloads.find((download) => download.id === id);
		const permitDownload = (resume: boolean): void => {
			const current = record();
			if (
				this.activeDownloads.get(id) !== item ||
				!current ||
				(current.status !== "checking" && current.status !== "progressing")
			)
				return;
			current.status = "progressing";
			this.commit();
				const setDestinationAndResume = (destination: string): void => {
					if (
						this.activeDownloads.get(id) !== item ||
						record()?.status !== "progressing"
					)
						return;
				path = destination;
				this.downloadPaths.set(id, path);
				item.setSavePath(path);
				if (resume && typeof item.resume === "function") item.resume();
			};
			if (!askForLocation) {
				setDestinationAndResume(path);
				return;
			}
			void dialog
				.showSaveDialog(this.window, {
					title: pendingContextDownload?.title ?? "Save download",
					defaultPath: path,
				})
				.then((result) => {
					if (result.canceled || !result.filePath) {
						item.cancel();
						return;
					}
					setDestinationAndResume(result.filePath);
				})
				.catch(() => item.cancel());
		};
		if (!requiresReputationCheck) {
			if (askForLocation && typeof item.pause === "function") item.pause();
			permitDownload(askForLocation);
			return;
		}
		if (typeof item.pause !== "function") {
			const current = record();
			if (current) {
				current.status = "failed";
				current.completedAt = this.now().toISOString();
				current.reputation = this.downloadReputation({
					verdict: "unknown",
					provider: this.threatProvider.id,
					reason: "unavailable",
				});
				this.commit();
			}
			item.cancel();
			return;
		}
		void this.checkAndStartDownload(item, id, permitDownload);
	}

	private downloadReputation(
		verdict: BrowserThreatVerdict,
	): UserBrowserDownloadReputation {
		return {
			verdict: verdict.verdict,
			provider: verdict.provider.slice(0, 100) || "reputation-provider",
			threatTypes:
				verdict.verdict === "malicious"
					? verdict.threatTypes.slice(0, 5)
					: [],
			checkedAt: this.now().toISOString(),
		};
	}

	private async downloadUrlReputation(
		item: Electron.DownloadItem,
	): Promise<BrowserThreatVerdict> {
		const urls = reputationUrlsForDownload(item);
		if (!urls.length) {
			return {
				verdict: "unknown",
				provider: this.threatProvider.id,
				reason: "invalid-response",
			};
		}
		let unknown: Extract<BrowserThreatVerdict, { verdict: "unknown" }> | undefined;
		for (const url of urls) {
			const verdict = await this.reputationForUrl(url, "download");
			if (!verdict) {
				unknown ??= {
					verdict: "unknown",
					provider: this.threatProvider.id,
					reason: "unavailable",
				};
				continue;
			}
			if (verdict.verdict === "malicious") return verdict;
			if (verdict.verdict === "unknown") unknown ??= verdict;
		}
		return (
			unknown ?? {
				verdict: "safe",
				provider: this.threatProvider.id,
			}
		);
	}

	private async checkAndStartDownload(
		item: Electron.DownloadItem,
		downloadId: string,
		permitDownload: (resume: boolean) => void,
	): Promise<void> {
		const verdict = await this.downloadUrlReputation(item);
		const record = this.state.downloads.find(
			(download) => download.id === downloadId,
		);
			if (
				!record ||
				this.activeDownloads.get(downloadId) !== item ||
				record.status !== "checking"
			)
				return;
		record.reputation = this.downloadReputation(verdict);
		if (verdict.verdict === "malicious") {
			record.status = "blocked";
			record.completedAt = this.now().toISOString();
			record.canReveal = false;
			this.commit();
			item.cancel();
			return;
		}
		permitDownload(true);
	}

	private restoreDirectDownloadNavigation(
		tabId: string,
		item: Electron.DownloadItem,
	): boolean {
		const record = this.views.get(tabId);
		const pending = record?.pendingDownloadNavigation;
		const tab = this.state.tabs.find((candidate) => candidate.id === tabId);
		if (
			!record ||
			!pending ||
			!tab ||
			pending.generation !== record.navigationGeneration ||
			!downloadMatchesNavigation(item, pending.targetUrl)
		)
			return false;
		if (Date.now() - pending.requestedAt > DIRECT_DOWNLOAD_DETECTION_WINDOW_MS) {
			delete record.pendingDownloadNavigation;
			return false;
		}

		Object.assign(tab, pending.previousTab);
		delete record.navigatingTo;
		delete record.pendingDownloadNavigation;
		this.closeView(tabId);
		tab.discarded = Boolean(tab.url);
		this.commit();
		if (tabId === this.state.activeTabId) void this.syncActiveView();
		this.onCommand?.("open-downloads");
		return true;
	}

	private async saveContextResource(
		tabId: string,
		resourceUrl: string,
		suggestedFilename: string,
		resourceLabel: "image" | "audio" | "video" | "link",
	): Promise<void> {
		const url = safePageUrl(resourceUrl)?.toString();
		if (!url) return;
		const record = this.requireView(tabId);
		const webContents = liveWebContents(record?.view?.webContents);
		if (!webContents) return;
		const fallback = `${resourceLabel}.download`;
		const defaultPath = join(
			this.downloadDirectory,
			contextResourceFilename(url, suggestedFilename, fallback),
		);
		const pending = {
			url,
			defaultPath,
			title: `Save ${resourceLabel[0]!.toUpperCase()}${resourceLabel.slice(1)} As…`,
			requestedAt: Date.now(),
		};
		const queue = this.pendingContextDownloads.get(webContents.id) ?? [];
		queue.push(pending);
		this.pendingContextDownloads.set(webContents.id, queue);
		try {
			webContents.downloadURL(url);
		} catch (cause) {
			this.removePendingContextDownload(webContents.id, pending);
			throw cause;
		}
	}

	private takePendingContextDownload(
		webContentsId: number,
		resourceUrl: string,
	): PendingContextDownload | undefined {
		const queue = this.pendingContextDownloads.get(webContentsId);
		if (!queue) return undefined;
		const now = Date.now();
		const fresh = queue.filter(
			(item) => now - item.requestedAt <= CONTEXT_DOWNLOAD_REQUEST_TTL_MS,
		);
		const normalizedUrl = safePageUrl(resourceUrl)?.toString();
		const index = normalizedUrl
			? fresh.findIndex((item) => item.url === normalizedUrl)
			: -1;
		if (index < 0) {
			if (fresh.length) this.pendingContextDownloads.set(webContentsId, fresh);
			else this.pendingContextDownloads.delete(webContentsId);
			return undefined;
		}
		const [pending] = fresh.splice(index, 1);
		if (fresh.length) this.pendingContextDownloads.set(webContentsId, fresh);
		else this.pendingContextDownloads.delete(webContentsId);
		return pending;
	}

	private removePendingContextDownload(
		webContentsId: number,
		pending: PendingContextDownload,
	): void {
		const queue = this.pendingContextDownloads.get(webContentsId);
		if (!queue) return;
		const next = queue.filter((item) => item !== pending);
		if (next.length) this.pendingContextDownloads.set(webContentsId, next);
		else this.pendingContextDownloads.delete(webContentsId);
	}

	private ensureView(
		tab: UserBrowserTab,
		loadStoredUrl = true,
	): ViewRecord {
		if (tab.file || isKestrelAppPageUrl(tab.url))
			throw new Error("App pages do not use a web view.");
		const existing = this.views.get(tab.id);
		if (existing && liveWebContents(existing?.view?.webContents)) return existing;
		if (existing) this.closeView(tab.id, false);
		const view = new WebContentsView({
			webPreferences: {
				preload: join(__dirname, "../preload/userBrowser.cjs"),
				partition: this.partitionName,
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				webSecurity: true,
				javascript: true,
				devTools: false,
					backgroundThrottling: true,
					spellcheck: this.state.settings.spellcheckEnabled,
					defaultFontFamily: {
						standard: this.state.settings.defaultFontFamily,
						serif: this.state.settings.defaultFontFamily,
						sansSerif: this.state.settings.defaultFontFamily,
						monospace: "SFMono-Regular",
					},
					minimumFontSize: this.state.settings.minimumFontSize,
				},
			});
		const webContents = liveWebContents(view?.webContents);
		if (!webContents)
			throw new Error("Kestrel could not create a browser page. Try again.");
		view.setBackgroundColor("#ffffff");
		this.applyViewBrowserPreferences(webContents);
		const record: ViewRecord = { view, navigationGeneration: 0 };
		this.views.set(tab.id, record);
		this.webContentsToTab.set(webContents.id, tab.id);
		this.configureView(tab, record);
		if (
			tab.muted &&
			typeof webContents.setAudioMuted === "function"
		) {
			webContents.setAudioMuted(true);
		}
		if (loadStoredUrl && tab.url && !tab.blockedNavigation) {
			const restoredUrl = safePageUrl(tab.url)?.toString();
			if (restoredUrl) {
				const generation = this.beginNavigationCheck(record);
				void this.checkAndRestoreStoredNavigation(
					tab,
					record,
					restoredUrl,
					generation,
				).catch(() => undefined);
			}
		}
		return record;
	}

	private configureView(tab: UserBrowserTab, record: ViewRecord): void {
		const webContents = liveWebContents(record?.view?.webContents);
		if (!webContents) return;
		webContents.setWindowOpenHandler(({ url, disposition, postBody, referrer }) => {
			if (openAppStoreUrl(url)) return { action: "deny" };
			if (safePageUrl(url)) {
				const loadOptions = loadOptionsForWindowOpen(postBody, referrer);
				void this.createTab(
					url,
					disposition !== "background-tab",
					loadOptions,
					"popup",
				).catch(() => undefined);
			}
			return { action: "deny" };
		});
		webContents.on("ipc-message", (event, channel, ...args) => {
			if (channel === PASSWORD_SUBMISSION_CHANNEL) {
				void this.handlePasswordSubmission(tab, webContents, event, args[0]).catch(
					() => undefined,
				);
				return;
			}
			if (channel === PASSWORD_RESPONSE_CHANNEL) {
				this.handlePasswordBridgeResponse(webContents, event, args[0]);
				return;
			}
			if (
				channel === PASSWORD_FORM_CHANGED_CHANNEL &&
				event.senderFrame === webContents.mainFrame
			) {
				void this.refreshPasswordPrompt(tab.id);
			}
			if (channel === HEIC_UPLOAD_CHANNEL)
				void this.handleHeicUpload(tab, webContents, event, args[0]).catch(
					() => undefined,
				);
		});
		webContents.on("will-navigate", (event, url) => {
			if (this.passwordSaveCommitTabId === tab.id) {
				event.preventDefault();
				return;
			}
			if (openAppStoreUrl(url)) {
				event.preventDefault();
				return;
			}
			const normalized = safePageUrl(url)?.toString();
			if (!normalized) {
				event.preventDefault();
				return;
			}
			if (record.approvedNavigationUrl === normalized) {
				delete record.approvedNavigationUrl;
				return;
			}
			event.preventDefault();
			this.interceptPageNavigation(tab, record, normalized, "navigation");
		});
		webContents.on("will-redirect", (event, url) => {
			if (this.passwordSaveCommitTabId === tab.id) {
				event.preventDefault();
				return;
			}
			if (openAppStoreUrl(url)) {
				event.preventDefault();
				return;
			}
			const normalized = safePageUrl(url)?.toString();
			event.preventDefault();
			if (!normalized) return;
			this.interceptPageNavigation(tab, record, normalized, "redirect");
		});
		webContents.on("did-start-loading", () => {
			tab.loading = true;
			tab.error = undefined;
			this.updateNavigationState(tab, webContents);
		});
		webContents.on("did-stop-loading", () => {
			tab.loading = false;
			if (tab.blockedNavigation) {
				this.commit();
				return;
			}
			this.updateNavigationState(tab, webContents);
			if (!tab.faviconDataUrl && tab.url) {
				const origin = safePageUrl(tab.url)?.origin;
				if (origin) void this.loadFavicon(tab, `${origin}/favicon.ico`);
			}
			void this.refreshPasswordPrompt(tab.id);
			void this.maybeOfferPasswordSaveAfterNavigation(
				tab,
				webContents,
				webContents.getURL(),
			);
			void this.refreshPaymentPrompt(tab.id);
		});
		webContents.on("page-title-updated", (_event, title) => {
			tab.title = title.trim().slice(0, 500) || hostnameTitle(tab.url);
			const recent = [...this.state.history]
				.reverse()
				.find((entry) => entry.tabId === tab.id && entry.url === tab.url);
			if (recent) recent.title = tab.title;
			this.commit();
		});
		webContents.on("page-favicon-updated", (_event, favicons) => {
			const favicon = favicons.find(
				(value) => isFaviconDataUrl(value) || safePageUrl(value),
			);
			if (favicon) void this.loadFavicon(tab, favicon);
		});
		webContents.on(
			"did-navigate",
			(_event, url, _httpResponseCode, _httpStatusText) => {
				if (tab.blockedNavigation) return;
				if (tab.id === this.state.activeTabId) {
					this.clearPasswordPrompt({
						preservePending: this.pendingPasswordSave?.tabId === tab.id,
					});
					this.clearPaymentPrompt();
				}
				this.didNavigate(tab, webContents, url);
				this.loginFlows.recordNavigation(tab.id, url);
				void this.maybeOfferPasswordSaveAfterNavigation(tab, webContents, url);
				void this.refreshPasswordPrompt(tab.id);
				void this.refreshPaymentPrompt(tab.id);
			},
		);
		webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
			if (isMainFrame) {
				if (tab.blockedNavigation) return;
				if (tab.id === this.state.activeTabId) {
					this.clearPasswordPrompt({
						preservePending: this.pendingPasswordSave?.tabId === tab.id,
					});
					this.clearPaymentPrompt();
				}
				this.didNavigate(tab, webContents, url);
				this.loginFlows.recordNavigation(tab.id, url);
				void this.maybeOfferPasswordSaveAfterNavigation(tab, webContents, url);
				void this.refreshPasswordPrompt(tab.id);
				void this.refreshPaymentPrompt(tab.id);
			}
		});
		webContents.on(
			"did-fail-load",
			(_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
				if (!isMainFrame || errorCode === -3) return;
				if (tab.blockedNavigation) return;
				if (
					record.navigatingTo &&
					safePageUrl(validatedUrl)?.toString() !==
						safePageUrl(record.navigatingTo)?.toString()
				)
					return;
				tab.loading = false;
				tab.error = describeBrowserLoadFailure(errorCode, errorDescription);
				this.updateNavigationState(tab, webContents);
			},
		);
		webContents.on("render-process-gone", () => {
			if (tab.blockedNavigation) return;
			if (tab.id === this.state.activeTabId) {
				this.clearPasswordPrompt();
				this.clearPaymentPrompt();
			}
			tab.loading = false;
			tab.crashed = true;
			tab.error = "This tab stopped responding. Reload it to continue.";
			this.closeView(tab.id);
			tab.discarded = Boolean(tab.url);
			this.commit();
		});
		webContents.on("found-in-page", (_event, result) => {
			this.onEvent({
				type: "find-in-page",
				match: {
					tabId: tab.id,
					activeMatchOrdinal: result.activeMatchOrdinal,
					matches: result.matches,
					finalUpdate: result.finalUpdate,
				},
			});
		});
		webContents.on("context-menu", (_event, params) => {
			const template: Electron.MenuItemConstructorOptions[] = [];
			const imageURL = params.hasImageContents
				? safePageUrl(params.srcURL)?.toString()
				: undefined;
			const linkURL = safePageUrl(params.linkURL)?.toString();
			const addSeparator = () => {
				if (template.length && template.at(-1)?.type !== "separator")
					template.push({ type: "separator" });
			};

			if (params.hasImageContents) {
				if (imageURL) {
					template.push(
						{
							label: "Open Image in New Tab",
							click: () => void this.createTab(imageURL, true),
						},
						{
							label: "Save Image As…",
							click: () =>
								void this.saveContextResource(
									tab.id,
									imageURL,
									params.suggestedFilename,
									"image",
								).catch(() => undefined),
						},
					);
				}
				template.push({
					label: "Copy Image",
					click: () => {
						const current = liveWebContents(webContents);
						if (current) current.copyImageAt(params.x, params.y);
					},
				});
				if (imageURL) {
					template.push({
						label: "Copy Image Address",
						click: () => clipboard.writeText(imageURL),
					});
				}
				addSeparator();
			}

			if (linkURL && linkURL !== imageURL) {
				template.push(
					{
						label: "Open Link in New Tab",
						click: () => void this.createTab(linkURL, true),
					},
					{
						label: "Save Link As…",
						click: () =>
							void this.saveContextResource(
								tab.id,
								linkURL,
								params.suggestedFilename,
								"link",
							).catch(() => undefined),
					},
					{
						label: "Copy Link",
						click: () => clipboard.writeText(linkURL),
					},
				);
				addSeparator();
			}

			const mediaURL = safePageUrl(params.srcURL)?.toString();
			if (
				mediaURL &&
				!params.hasImageContents &&
				(params.mediaType === "audio" || params.mediaType === "video")
			) {
				const mediaType = params.mediaType === "audio" ? "audio" : "video";
				template.push({
					label: `Save ${mediaType === "audio" ? "Audio" : "Video"} As…`,
					click: () =>
						void this.saveContextResource(
							tab.id,
							mediaURL,
							params.suggestedFilename,
							mediaType,
						).catch(() => undefined),
				});
				if (mediaType === "video") {
					template.push({
						label: "Copy Video Frame",
						click: () => {
							const current = liveWebContents(webContents);
							if (current) current.copyVideoFrameAt(params.x, params.y);
						},
					});
				}
				addSeparator();
			}

			if (params.isEditable) {
				template.push(
					{ role: "cut" },
					{ role: "copy" },
					{ role: "paste" },
					{ role: "selectAll" },
				);
				addSeparator();
			} else if (params.selectionText) {
				template.push({ role: "copy" });
				const query = params.selectionText.trim().slice(0, 200);
				if (query) {
					template.push({
						label: `Search for “${query.slice(0, 40)}”`,
						click: () => void this.createTab(query, true),
					});
				}
				addSeparator();
			}

			template.push(
				{
					label: "Back",
					enabled: tab.canGoBack,
					click: () => this.back(tab.id),
				},
				{
					label: "Forward",
					enabled: tab.canGoForward,
					click: () => this.forward(tab.id),
				},
				{ role: "reload" },
				{ type: "separator" },
				{
					label: this.state.bookmarks.some((item) => item.url === tab.url)
						? "Remove Bookmark"
						: "Bookmark This Page",
					enabled: Boolean(safePageUrl(tab.url)),
					click: () => {
						const existing = this.state.bookmarks.find(
							(item) => item.url === tab.url,
						);
						if (existing) this.removeBookmark(existing.id);
						else this.onCommand?.("bookmark-page");
					},
				},
				{
					label: "Print…",
					click: () => this.printTab(tab.id),
				},
				{
					label: "Screenshot",
					click: () => this.onCommand?.("save-screenshot"),
				},
				{
					label: "More tools",
					submenu: [
						{
							label: "Find in page",
							accelerator: "CommandOrControl+F",
							click: () => this.onCommand?.("find-in-page"),
						},
						{ type: "separator" },
						{
							label: "Downloads",
							accelerator: "CommandOrControl+J",
							click: () => this.onCommand?.("open-downloads"),
						},
						{
							label: "Bookmarks",
							accelerator: "CommandOrControl+Shift+D",
							click: () => this.onCommand?.("open-bookmarks"),
						},
						{
							label: "Settings",
							accelerator: "CommandOrControl+,",
							click: () => this.onCommand?.("open-settings"),
						},
						{
							label: "Command Center",
							accelerator: "CommandOrControl+K",
							click: () => this.onCommand?.("open-commands"),
						},
						{
							label: "Keyboard shortcuts",
							accelerator: "CommandOrControl+/",
							click: () => this.onCommand?.("show-shortcuts"),
						},
					],
				},
				...(this.allowDevTools
					? [
							{ type: "separator" } as const,
							{
								label: "Inspect",
								click: () => this.openDevTools(tab.id),
							},
						]
					: []),
			);
			Menu.buildFromTemplate(template).popup({ window: this.window });
		});
		webContents.on("before-input-event", (event, input) => {
			if (input.type !== "keyDown") return;

			// Escape: Stop loading if currently loading
			if (input.key === "Escape") {
				if (tab.loading) {
					event.preventDefault();
					this.stop(tab.id);
				}
				return;
			}

			// F5 / Shift+F5: Reload / Hard reload
			if (input.key === "F5") {
				event.preventDefault();
				this.reload(tab.id, input.shift);
				return;
			}

			// F1: Show shortcuts
			if (input.key === "F1") {
				event.preventDefault();
				this.onCommand?.("show-shortcuts");
				return;
			}

			// Alt + Left / Alt + Right / Alt + D (Standard navigation)
			if (input.alt && !input.meta && !input.control) {
				if (input.key === "ArrowLeft") {
					event.preventDefault();
					this.back(tab.id);
					return;
				}
				if (input.key === "ArrowRight") {
					event.preventDefault();
					this.forward(tab.id);
					return;
				}
				if (input.key.toLowerCase() === "d") {
					event.preventDefault();
					this.onCommand?.("focus-address");
					return;
				}
			}

			const command = input.meta || input.control;
			if (!command) return;
			const key = input.key.toLowerCase();
			const code = input.code?.toLowerCase() ?? "";

			// Tab switching: Cmd/Ctrl + 1..8, Cmd/Ctrl + 9
			if (/^[1-8]$/.test(input.key)) {
				event.preventDefault();
				const index = parseInt(input.key, 10) - 1;
				void this.selectTabByIndex(index);
				return;
			}
			if (input.key === "9") {
				event.preventDefault();
				void this.selectTabByIndex(-1);
				return;
			}

			// Tab cycle: Ctrl+Tab, Ctrl+Shift+Tab, Cmd+Alt+Left/Right, Cmd+Shift+[/]
			if (
				(key === "tab" && (input.control || input.meta) && input.shift) ||
				(key === "pageup" && (input.control || input.meta)) ||
				(key === "[" && input.shift) ||
				(input.alt && input.key === "ArrowLeft")
			) {
				event.preventDefault();
				void this.cycleTab(-1);
				return;
			}
			if (
				(key === "tab" && (input.control || input.meta)) ||
				(key === "pagedown" && (input.control || input.meta)) ||
				(key === "]" && input.shift) ||
				(input.alt && input.key === "ArrowRight")
			) {
				event.preventDefault();
				void this.cycleTab(1);
				return;
			}

			// Zoom controls: Cmd/Ctrl + (+, =, -, _, 0)
			if (
				["=", "+", "add", "numpadadd"].includes(key) ||
				["equal", "numpadadd"].includes(code)
			) {
				event.preventDefault();
				this.zoomIn(tab.id);
				return;
			}
			if (
				["-", "_", "subtract", "numpadsubtract"].includes(key) ||
				["minus", "numpadsubtract"].includes(code)
			) {
				event.preventDefault();
				this.zoomOut(tab.id);
				return;
			}
			if (
				["0", "numpad0"].includes(key) ||
				["digit0", "numpad0"].includes(code)
			) {
				event.preventDefault();
				this.zoomReset(tab.id);
				return;
			}

			// Primary browser & application shortcuts
			if (key === "t") {
				event.preventDefault();
				if (input.shift) {
					void this.reopenClosedTab();
				} else {
					void this.createTab(undefined, true);
				}
			} else if (key === "w" || (input.control && input.key === "F4")) {
				event.preventDefault();
				void this.closeTab(tab.id).catch(() => undefined);
			} else if (key === "r") {
				event.preventDefault();
				this.reload(tab.id, input.shift);
			} else if (key === "l" || (input.control && key === "e")) {
				event.preventDefault();
				this.onCommand?.("focus-address");
			} else if (key === "n" && !input.shift) {
				event.preventDefault();
				this.onCommand?.("new-agent");
			} else if (key === "k" || (key === "p" && input.shift)) {
				event.preventDefault();
				this.onCommand?.("open-commands");
			} else if (key === "p") {
				event.preventDefault();
				this.printTab(tab.id);
			} else if (key === "f") {
				event.preventDefault();
				this.onCommand?.("find-in-page");
			} else if (key === "d") {
				event.preventDefault();
				if (input.shift) this.onCommand?.("open-bookmarks");
				else {
					const existing = this.state.bookmarks.find(
						(item) => item.url === tab.url,
					);
					if (existing) this.removeBookmark(existing.id);
					else this.onCommand?.("bookmark-page");
				}
			} else if (key === "i" && input.shift && this.allowDevTools) {
				event.preventDefault();
				this.openDevTools(tab.id);
			} else if (key === "h" || key === "y") {
				event.preventDefault();
				this.onCommand?.("open-history");
			} else if (key === "j") {
				event.preventDefault();
				this.onCommand?.("open-downloads");
			} else if (key === ",") {
				event.preventDefault();
				this.onCommand?.("open-settings");
			} else if (key === "/" || key === "?") {
				event.preventDefault();
				this.onCommand?.("show-shortcuts");
			} else if (key === "b") {
				event.preventDefault();
				if (input.shift) {
					this.updateSettings({
						...this.state.settings,
						showBookmarksBar: !this.state.settings.showBookmarksBar,
					});
				} else {
					this.onCommand?.("toggle-sidebar");
				}
			} else if (key === "s" && input.shift) {
				event.preventDefault();
				this.onCommand?.("toggle-sidebar");
			} else if (input.key === "[" || (input.meta && input.key === "ArrowLeft")) {
				event.preventDefault();
				this.back(tab.id);
			} else if (input.key === "]" || (input.meta && input.key === "ArrowRight")) {
				event.preventDefault();
				this.forward(tab.id);
			}
		});
	}

	private didNavigate(
		tab: UserBrowserTab,
		webContents: WebContents,
		value: string,
	): void {
		const url = safePageUrl(value);
		if (!url || !liveWebContents(webContents)) return;
		const record = this.views.get(tab.id);
		if (record?.view.webContents !== webContents) return;
		delete record.pendingDownloadNavigation;
		// Snapshot element refs are tied to a specific DOM generation. Any main-frame
		// navigation, including SPA route changes, must invalidate them before reuse.
		this.elementRefs.delete(tab.id);
		this.sensitiveElementRefs.delete(tab.id);
		tab.url = sanitizeBrowserUrl(url.toString());
		tab.title =
			webContents.getTitle().trim().slice(0, 500) || hostnameTitle(tab.url);
		tab.crashed = false;
		tab.error = undefined;
		tab.discarded = false;
		this.updateNavigationState(tab, webContents, false);
		if (this.state.settings.historyRetentionDays !== 0) {
			const last = this.state.history.at(-1);
			if (
				last &&
				last.tabId === tab.id &&
				last.url === tab.url &&
				Date.parse(this.now().toISOString()) - Date.parse(last.visitedAt) <
					2_000
			) {
				last.title = tab.title;
			} else {
				this.state.history.push({
					id: `visit-${randomUUID()}`,
					tabId: tab.id,
					url: sanitizeBrowserUrl(tab.url),
					title: tab.title,
					visitedAt: this.now().toISOString(),
				});
			}
		}
		this.pruneHistory();
		this.commit();
	}

	private async cycleTab(direction: -1 | 1): Promise<void> {
		const tabs = this.state.tabs;
		if (tabs.length < 2) return;
		const current = tabs.findIndex((tab) => tab.id === this.state.activeTabId);
		const next =
			tabs[(Math.max(0, current) + direction + tabs.length) % tabs.length];
		if (next) await this.selectTab(next.id);
	}

	private updateNavigationState(
		tab: UserBrowserTab,
		webContents: WebContents,
		commit = true,
	): void {
		if (!liveWebContents(webContents)) return;
		tab.canGoBack = webContents.navigationHistory.canGoBack();
		tab.canGoForward = webContents.navigationHistory.canGoForward();
		if (commit) this.commit();
	}

	private async syncActiveView(): Promise<void> {
		this.attachActiveWebView();
	}

	private revealActiveWebContent(): void {
		if (this.contentBounds.width >= 160 && this.contentBounds.height >= 120) {
			this.contentVisible = true;
			return;
		}
		const size = this.window.getContentSize();
		const width = Math.max(0, size[0] ?? 0);
		const height = Math.max(0, size[1] ?? 0);
		if (width < 160 || height < 120) return;
		this.contentBounds = { x: 0, y: 0, width, height };
		this.contentVisible = true;
	}

	private attachActiveWebView(): void {
		if (this.disposed || this.window.isDestroyed()) return;
		for (const { view } of this.views.values()) {
			if (this.window.contentView.children.includes(view))
				this.window.contentView.removeChildView(view);
			view.setVisible(false);
		}
		const tab = this.state.tabs.find(
			(candidate) => candidate.id === this.state.activeTabId,
		);
		if (
			!this.contentVisible ||
			!tab ||
			!tab.url ||
			tab.error ||
			tab.blockedNavigation
		)
			return;
		if (isKestrelAppPageUrl(tab.url)) return;
		const { view } = this.ensureView(tab);
		const webContents = liveWebContents(view?.webContents);
		if (!webContents) return;
		this.window.contentView.addChildView(view);
		view.setBounds(this.contentBounds);
		view.setVisible(true);
		webContents.focus();
	}

	private discardLeastRecentViews(): void {
		if (this.views.size <= MAX_LIVE_TABS) return;
		const candidates = this.state.tabs
			.filter(
				(tab) =>
					tab.id !== this.state.activeTabId &&
					!this.isAgentTabPinned(tab.id) &&
					!isAuthenticationFlowUrl(tab.url) &&
					this.views.has(tab.id),
			)
			.sort((left, right) =>
				left.lastActiveAt.localeCompare(right.lastActiveAt),
			);
		while (this.views.size > MAX_LIVE_TABS && candidates.length) {
			const tab = candidates.shift()!;
			this.closeView(tab.id);
			tab.discarded = Boolean(tab.url);
		}
		this.commit();
	}

	private closeView(tabId: string, closeWebContents = true): void {
		if (tabId === this.state.activeTabId) this.clearPasswordPrompt();
		this.loginFlows.clearTab(tabId);
		const record = this.views.get(tabId);
		if (!record) return;
		this.views.delete(tabId);
		this.elementRefs.delete(tabId);
		this.sensitiveElementRefs.delete(tabId);
		const webContents = record?.view?.webContents;
		if (webContents && typeof webContents.id === "number")
			this.rejectPasswordBridgeRequests("The browser tab is no longer available.", webContents.id);
		if (webContents && typeof webContents.id === "number")
			this.webContentsToTab.delete(webContents.id);
		if (
			!this.window.isDestroyed() &&
			this.window.contentView.children.includes(record.view)
		)
			this.window.contentView.removeChildView(record.view);
		if (closeWebContents && liveWebContents(webContents)) {
			if (webContents.debugger.isAttached()) webContents.debugger.detach();
			webContents.close({ waitForBeforeUnload: false });
		}
	}


	private async runExclusiveTabMutation<T>(
		operation: () => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		if (signal?.aborted) throw signal.reason;
		let release!: () => void;
		let acquired = false;
		const previous = this.tabMutationQueue;
		this.tabMutationQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			await this.waitForTabMutationTurn(previous, signal);
			acquired = true;
			if (signal?.aborted) throw signal.reason;
			return await operation();
		} finally {
			if (acquired) release();
			else void previous.then(release, release);
		}
	}

	private waitForTabMutationTurn(
		previous: Promise<void>,
		signal?: AbortSignal,
	): Promise<void> {
		if (!signal) return previous;
		if (signal.aborted) {
			return Promise.reject(signal.reason);
		}
		return new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				signal.removeEventListener("abort", onAbort);
				reject(signal.reason);
			};
			signal.addEventListener("abort", onAbort);
			void previous.then(
				() => {
					signal.removeEventListener("abort", onAbort);
					resolve();
				},
				() => {
					signal.removeEventListener("abort", onAbort);
					resolve();
				},
			);
		});
	}

	private isAgentTabPinned(tabId: string): boolean {
		return (this.agentTabPinCounts.get(tabId) ?? 0) > 0;
	}

	private pinAgentTab(tabId: string): void {
		this.agentTabPinCounts.set(
			tabId,
			(this.agentTabPinCounts.get(tabId) ?? 0) + 1,
		);
	}

	private unpinAgentTab(tabId: string): void {
		const next = (this.agentTabPinCounts.get(tabId) ?? 0) - 1;
		if (next <= 0) this.agentTabPinCounts.delete(tabId);
		else this.agentTabPinCounts.set(tabId, next);
	}

	private async withAgentTabPin<T>(
		tabId: string,
		fn: () => Promise<T>,
	): Promise<T> {
		this.pinAgentTab(tabId);
		try {
			return await fn();
		} finally {
			this.unpinAgentTab(tabId);
		}
	}

	private requireTab(tabId: string): UserBrowserTab {
		this.assertAvailable();
		const tab = this.state.tabs.find((candidate) => candidate.id === tabId);
		if (!tab) throw new Error("Browser tab is unavailable.");
		return tab;
	}

	private requireActiveTab(): UserBrowserTab {
		if (!this.state.activeTabId) throw new Error("No browser tab is active.");
		return this.requireTab(this.state.activeTabId);
	}

	private availableDownload(
		downloadId: string,
	): { download: UserBrowserDownload; path: string } | undefined {
		const download = this.state.downloads.find(
			(item) => item.id === downloadId,
		);
		if (!download || !download.canReveal) return undefined;
		const storedPath = this.downloadPaths.get(downloadId);
		const filename = basename(download.filename);
		const path =
			storedPath ??
			(filename === download.filename
				? join(this.downloadDirectory, filename)
				: undefined);
		if (!path || !existsSync(path)) return undefined;
		return { download, path };
	}

	private requireView(tabId: string): ViewRecord {
		const tab = this.requireTab(tabId);
		if (!tab.url || isKestrelAppPageUrl(tab.url))
			throw new Error("This tab has not navigated yet.");
		return this.ensureView(tab);
	}

	private storedSitePermission(
		origin: string,
		permission: string,
	): boolean | undefined {
		const stored = this.state.sitePermissions.find(
			(item) => item.origin === origin && item.permission === permission,
		);
		return stored ? stored.decision === "allow" : undefined;
	}

	private isPermissionAllowed(
		originValue: string,
		permission: string,
		mediaType?: string,
	): boolean {
		if (ALWAYS_ALLOW_PERMISSIONS.has(permission)) return true;
		if (ALWAYS_DENY_PERMISSIONS.has(permission)) return false;
		const origin = this.permissionOrigin(originValue);
		if (!origin) return false;
		if (permission === "media" && mediaType === "video")
			return (
				this.storedSitePermission(origin, "camera") ??
				this.storedSitePermission(origin, "media") ??
				false
			);
		if (permission === "media" && mediaType === "audio")
			return (
				this.storedSitePermission(origin, "microphone") ??
				this.storedSitePermission(origin, "media") ??
				false
			);
		return this.storedSitePermission(origin, permission) ?? false;
	}

	private async resolvePermissionRequest(
		webContents: WebContents,
		permission: string,
		requestingUrl?: string,
		mediaTypes: BrowserMediaRequestType[] = [],
		securityOrigin?: string,
	): Promise<boolean> {
		if (ALWAYS_ALLOW_PERMISSIONS.has(permission)) return true;
		if (ALWAYS_DENY_PERMISSIONS.has(permission)) return false;
		const currentWebContents = liveWebContents(webContents);
		const origin = this.permissionOrigin(
			securityOrigin ||
			requestingUrl ||
				currentWebContents?.getURL() ||
				"",
		);
		if (!origin) return false;
		if (permission === "media") {
			const requestedMediaTypes = mediaTypes.length
				? mediaTypes
				: (["video", "audio"] as BrowserMediaRequestType[]);
			const nativeTypes = nativeMediaTypesForRequest(requestedMediaTypes);
			const storedDecisions = nativeTypes.map((mediaType) =>
				this.storedSitePermission(origin, mediaType) ??
				this.storedSitePermission(origin, "media"),
			);
			if (storedDecisions.some((decision) => decision === false)) return false;
			let allowed = storedDecisions.every((decision) => decision === true);
			if (!allowed) {
				allowed = await this.confirmSitePermission(
					origin,
					mediaPermissionLabel(requestedMediaTypes),
				);
				for (const mediaType of nativeTypes)
					this.rememberSitePermission(origin, mediaType, allowed ? "allow" : "deny");
				this.commit();
			}
			if (!allowed) return false;
			for (const mediaType of nativeTypes) {
				if (!(await this.requestNativeMediaAccess(mediaType))) return false;
			}
			return true;
		}
		const stored = this.state.sitePermissions.find(
			(item) => item.origin === origin && item.permission === permission,
		);
		if (stored) return stored.decision === "allow";
		const allowed = await this.confirmSitePermission(origin, permission);
		this.setSitePermission(origin, permission, allowed ? "allow" : "deny");
		return allowed;
	}

	private rememberSitePermission(
		origin: string,
		permission: string,
		decision: "allow" | "deny",
	): void {
		const next = this.state.sitePermissions.filter(
			(item) => !(item.origin === origin && item.permission === permission),
		);
		next.push({
			origin,
			permission,
			decision,
			updatedAt: this.now().toISOString(),
		});
		this.state.sitePermissions = next.slice(-500);
	}

	private permissionOrigin(value: string): string | undefined {
		try {
			const url = new URL(value);
			if (
				!["http:", "https:"].includes(url.protocol) ||
				url.username ||
				url.password
			)
				return undefined;
			return url.origin;
		} catch {
			return undefined;
		}
	}

	private assertAvailable(): void {
		if (this.disposed || this.window.isDestroyed())
			throw new Error("The user browser is unavailable.");
	}

	private commit(): void {
		this.store.save(this.state);
		this.emit();
	}

	private pruneEmptyTabFolders(): void {
		const usedFolderIds = new Set(
			this.state.tabs.flatMap((tab) =>
				tab.tabFolderId ? [tab.tabFolderId] : [],
			),
		);
		this.state.tabFolders = this.state.tabFolders.filter((folder) =>
			usedFolderIds.has(folder.id),
		);
	}

	private emit(): void {
		if (!this.disposed) this.onEvent({ type: "state", state: this.getState() });
	}

	private pruneHistory(): void {
		const days = this.state.settings.historyRetentionDays;
		if (days === 0) {
			this.state.history = [];
			this.state.originFavicons = [];
			return;
		}
		const cutoff = this.now().getTime() - days * 24 * 60 * 60 * 1_000;
		this.state.history = this.state.history
			.filter((entry) => Date.parse(entry.visitedAt) >= cutoff)
			.slice(-MAX_HISTORY_ENTRIES);
	}

	private availableDownloadName(original: string, id: string): string {
		const cleaned = safeDownloadFilename(original, `${id}.download`);
		const extension = extname(cleaned);
		const stem = cleaned.slice(0, cleaned.length - extension.length);
		let candidate = cleaned;
		let index = 2;
		while (existsSync(join(this.downloadDirectory, candidate))) {
			candidate = `${stem} ${index}${extension}`;
			index += 1;
		}
		return candidate;
	}

	private rememberOriginFavicon(
		origin: string,
		faviconDataUrl: string,
	): boolean {
		const existing = this.state.originFavicons.find(
			(item) => item.origin === origin,
		);
		if (existing?.faviconDataUrl === faviconDataUrl) return false;
		this.state.originFavicons = upsertOriginFavicon(
			this.state.originFavicons,
			origin,
			faviconDataUrl,
			this.now().toISOString(),
		);
		return true;
	}

	private backfillOriginFaviconsFromHistory(limit = 7): void {
		const known = new Set(
			this.state.originFavicons.map((item) => item.origin),
		);
		const grouped = new Map<
			string,
			{ visits: number; lastVisitedAt: string }
		>();
		for (const entry of this.state.history) {
			const parsed = safePageUrl(entry.url);
			if (!parsed || known.has(parsed.origin)) continue;
			const current = grouped.get(parsed.origin);
			if (!current) {
				grouped.set(parsed.origin, {
					visits: 1,
					lastVisitedAt: entry.visitedAt,
				});
				continue;
			}
			current.visits += 1;
			if (entry.visitedAt > current.lastVisitedAt) {
				current.lastVisitedAt = entry.visitedAt;
			}
		}
		const origins = [...grouped.entries()]
			.sort(
				(left, right) =>
					right[1].visits - left[1].visits ||
					right[1].lastVisitedAt.localeCompare(left[1].lastVisitedAt),
			)
			.slice(0, Math.max(0, limit))
			.map(([origin]) => origin);
		for (const origin of origins) {
			void this.loadOriginFavicon(origin);
		}
	}

	private loadOriginFavicon(origin: string): void {
		const candidates = [
			`${origin}/favicon.ico`,
			`${origin}/favicon.png`,
			`${origin}/apple-touch-icon.png`,
		];
		void this.loadFirstOriginFavicon(origin, candidates);
	}

	private async loadFirstOriginFavicon(
		origin: string,
		candidates: string[],
	): Promise<void> {
		for (const candidate of candidates) {
			const faviconDataUrl = await this.resolveFaviconDataUrl(
				`${origin}/`,
				candidate,
			);
			if (!faviconDataUrl) continue;
			if (this.rememberOriginFavicon(origin, faviconDataUrl)) this.commit();
			else this.emit();
			return;
		}
	}

	private async loadFavicon(
		target: Pick<UserBrowserTab, "url" | "faviconDataUrl">,
		value: string,
	): Promise<void> {
		try {
			const faviconDataUrl = await this.resolveFaviconDataUrl(
				target.url,
				value,
			);
			if (!faviconDataUrl) return;
			target.faviconDataUrl = faviconDataUrl;
			const origin =
				safePageUrl(target.url)?.origin ??
				safePageUrl(resolveFaviconReference(target.url, value) ?? "")?.origin;
			if (origin && this.rememberOriginFavicon(origin, faviconDataUrl))
				this.commit();
			else this.emit();
		} catch {
			// Favicons are optional and must never affect navigation.
		}
	}

	private async resolveFaviconDataUrl(
		pageUrl: string,
		value: string,
	): Promise<string | undefined> {
		if (isFaviconDataUrl(value)) return this.normalizeInlineFavicon(value);
		const resolved = resolveFaviconReference(pageUrl, value);
		if (!resolved) return undefined;
		return this.fetchFaviconDataUrl(resolved);
	}

	private normalizeInlineFavicon(value: string): string | undefined {
		if (!isFaviconDataUrl(value)) return undefined;
		const image = nativeImage.createFromDataURL(value);
		if (image.isEmpty()) return undefined;
		return image.resize({ width: 32, height: 32 }).toDataURL();
	}

	private async encodeFaviconBytes(bytes: Buffer): Promise<string | undefined> {
		try {
			const png = await sharp(bytes, { failOn: "none" })
				.resize(32, 32, {
					fit: "contain",
					background: { r: 0, g: 0, b: 0, alpha: 0 },
				})
				.png()
				.toBuffer();
			if (png.byteLength === 0 || png.byteLength > 200_000) return undefined;
			const image = nativeImage.createFromBuffer(png);
			if (!image.isEmpty()) return image.toDataURL();
		} catch {
			// Fall back to ICO decoding and Electron's native decoder.
		}
		try {
			const icons = decodeIco(bytes);
			const largest = [...icons].sort((left, right) => right.width - left.width)[0];
			if (largest) {
				const png = await sharp(largest.data, {
					raw: {
						width: largest.width,
						height: largest.height,
						channels: 4,
					},
				})
					.resize(32, 32, {
						fit: "contain",
						background: { r: 0, g: 0, b: 0, alpha: 0 },
					})
					.png()
					.toBuffer();
				if (png.byteLength > 0 && png.byteLength <= 200_000) {
					const image = nativeImage.createFromBuffer(png);
					if (!image.isEmpty()) return image.toDataURL();
				}
			}
		} catch {
			// Optional favicon formats must never affect navigation.
		}
		const image = nativeImage.createFromBuffer(bytes);
		if (image.isEmpty()) return undefined;
		return image.resize({ width: 32, height: 32 }).toDataURL();
	}

	private async fetchFaviconDataUrl(value: string): Promise<string | undefined> {
		const response = await this.partition.fetch(value, {
			signal: AbortSignal.timeout(5_000),
		});
		const length = Number(response.headers.get("content-length") ?? 0);
		if (!response.ok || length > 512_000) return undefined;
		const bytes = Buffer.from(await response.arrayBuffer());
		if (bytes.byteLength > 512_000) return undefined;
		return this.encodeFaviconBytes(bytes);
	}

	private async targetPoint(
		webContents: WebContents,
		selector: string,
		focus: boolean,
		tabId: string,
		signal: AbortSignal,
		rejectSensitive = false,
	): Promise<{ x: number; y: number }> {
		if (!selector || selector.length > 2_000)
			throw new Error("Browser selector is invalid.");
		const ref = normalizeBrowserElementRef(selector);
		if (ref) {
			const backendNodeId = this.elementRefs.get(tabId)?.get(ref);
			if (backendNodeId === undefined)
				throw new Error("Browser target ref is stale. Take a new snapshot.");
			return targetPointFromBackendNode(
				webContents,
				backendNodeId,
				focus,
				signal,
				rejectSensitive,
			);
		}
		return webContents.executeJavaScript(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!(node instanceof Element)) throw new Error("Browser target was not found.");
      node.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      if (box.width <= 0 || box.height <= 0 || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) <= 0) throw new Error("Browser target is not visible.");
      if (node.matches(":disabled") || node.getAttribute("aria-disabled") === "true") throw new Error("Browser target is disabled.");
      const secretHint = [
        node.tagName,
        node.getAttribute("type"),
        node.getAttribute("autocomplete"),
        node.getAttribute("name"),
        node.id,
        node.getAttribute("aria-label"),
        node.getAttribute("placeholder"),
        node.labels?.[0]?.innerText,
      ].filter(Boolean).join(" ").toLowerCase();
      const isSensitive =
        (node instanceof HTMLInputElement && node.type === "password") ||
        /(?:\\b(?:new|current|old|confirm(?:ation)?|repeat)?\\s*password\\b|\\bone[-_\\s]*time[-_\\s]*(?:code|passcode|token)\\b|\\botp\\b|\\b(?:recovery|verification|security)\\s*(?:code|passcode|pin)\\b|\\b(?:cvv|cvc|cc[-_\\s]*csc)\\b|\\bapi[-_\\s]*(?:key|token)\\b|\\baccess[-_\\s]*token\\b|\\bprivate[-_\\s]*key\\b)/i.test(secretHint);
      if (${rejectSensitive} && isSensitive) {
        throw new Error("Kestrel agents cannot type into a sensitive browser field. Ask the user to enter that value directly.");
      }
      const x = Math.round(Math.max(0, Math.min(innerWidth - 1, box.left + box.width / 2)));
      const y = Math.round(Math.max(0, Math.min(innerHeight - 1, box.top + box.height / 2)));
      const hit = document.elementFromPoint(x, y);
      if (!(hit instanceof Element) || (hit !== node && !node.contains(hit))) {
        throw new Error("Browser target is obscured or cannot receive pointer input.");
      }
      ${focus ? "if (node instanceof HTMLElement) node.focus();" : ""}
      return { x, y };
    })()`);
	}
}
