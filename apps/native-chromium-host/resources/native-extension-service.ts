import {
	RendererRequestSchema,
	type InstalledExtension,
} from "../../../packages/shared-types/src/index";
import {
	browserExtensionOperationErrorMessage,
	chromeWebStoreInstallErrorMessage,
} from "../../desktop/src/browser-extension-error";
import { BrowserExtensionManager } from "../../desktop/src/main/browser-extension-manager";
import type { ChromiumExtensionHostPort } from "../../desktop/src/main/chromium-extension-host-port";
import { ChromiumExtensionRuntime } from "../../desktop/src/main/chromium-extension-runtime";

export { createNativeExtensionHostPort } from "./native-extension-host-port";
export type { NativeExtensionRequest } from "./native-extension-host-port";

const REQUEST_FIELDS = {
	"browser-list-extensions": ["type"],
	"browser-inspect-extension-url": ["type", "urlOrId"],
	"browser-install-extension-url": ["type", "inspectionId"],
	"browser-toggle-extension": ["type", "extensionId", "enabled"],
	"browser-reload-extension": ["type", "extensionId"],
	"browser-uninstall-extension": ["type", "extensionId"],
} as const;

const INITIALIZATION_ERROR =
	"Kestrel could not restore its browser extensions. Review the extensions list and try enabling the affected extension again.";
const INVALID_REQUEST = "This browser extension request is not supported.";
// The shared mapping deliberately permits a few contextual main-process
// messages. The native transport accepts only these fixed public strings, so
// a host error cannot smuggle its filesystem path through a permitted prefix.
const PUBLIC_ERRORS = new Set([
	"Open a Chrome Web Store extension listing and try again.",
	"The download timed out. Check your connection and try again.",
	"That extension review expired. Review the package again before installing it.",
	"The Chrome Web Store could not provide this extension right now. Try again later.",
	"This extension needs Chrome features that Kestrel does not support yet.",
	"Kestrel rejected the package because its Chrome Web Store signature could not be verified.",
	"Kestrel rejected the package because it did not pass extension safety checks.",
	"Kestrel could not install this extension. It may rely on Chrome features that are unavailable here.",
	"This extension is no longer installed. Refresh the extensions list and try again.",
	"Enable this extension before reloading it.",
	"Kestrel could not update this extension. Try again, or remove and review it again from the Chrome Web Store.",
]);

export type NativeExtensionInitialization =
	| { ok: true; extensions: InstalledExtension[] }
	| { ok: false; error: string; extensions?: InstalledExtension[] };

/**
 * Node-only package/review boundary for the native browser's existing profile.
 * Only the trusted relay supplies profileRoot and the live host port. Renderer
 * callers can approve a manager-owned review UUID, never an unpacked path.
 */
export function createNativeExtensionService({
	profileRoot,
	host,
	chromiumVersion,
}: {
	profileRoot: string;
	host: ChromiumExtensionHostPort;
	chromiumVersion?: string | undefined;
}) {
	const runtime = new ChromiumExtensionRuntime(host);
	let manager: BrowserExtensionManager | undefined;
	let initialization: Promise<NativeExtensionInitialization> | undefined;

	function initialize(): Promise<NativeExtensionInitialization> {
		initialization ??= (async () => {
			try {
				manager = new BrowserExtensionManager(profileRoot, {
					allowLocalExtensions: false,
					runtimeBackend: "chromium",
					...(chromiumVersion ? { chromiumVersion } : {}),
				});
				let enabledIds = new Set<string>();
				try {
					enabledIds = new Set(manager.list().filter((extension) => extension.enabled).map((extension) => extension.id));
				} catch {
					// A durable interrupted-update journal blocks listing until
					// loadAll has reconciled it against the actual native runtime.
				}
				await manager.loadAll(runtime);
				const extensions = manager.list();
				// loadAll records individual failures instead of throwing. A restored
				// registry or startup switch alone is not live readiness evidence.
				const restoreFailed = extensions.some(
					(extension) =>
						enabledIds.has(extension.id) &&
						(!extension.enabled ||
							extension.compatibility?.runtime.registered !== "passed" ||
							extension.compatibility?.runtime.ready !== "passed" ||
							extension.compatibility?.runtime.remainedLoaded !== "passed"),
				);
				return restoreFailed
					? { ok: false, error: INITIALIZATION_ERROR, extensions }
					: { ok: true, extensions };
			} catch {
				return { ok: false, error: INITIALIZATION_ERROR };
			}
		})();
		return initialization;
	}

	async function handle(input: unknown) {
		// RendererRequestSchema strips unknown keys. Reject them first so a
		// renderer path/local-install field can never silently become authority.
		if (!input || typeof input !== "object" || Array.isArray(input))
			return { ok: false, error: INVALID_REQUEST };
		const type = (input as { type?: unknown }).type;
		if (typeof type !== "string" || !Object.hasOwn(REQUEST_FIELDS, type))
			return { ok: false, error: INVALID_REQUEST };
		const fields = REQUEST_FIELDS[
			type as keyof typeof REQUEST_FIELDS
		] as readonly string[];
		if (Object.keys(input).some((key) => !fields.includes(key)))
			return { ok: false, error: INVALID_REQUEST };
		const parsed = RendererRequestSchema.safeParse(input);
		if (!parsed.success) return { ok: false, error: INVALID_REQUEST };
		const request = parsed.data;
		if ("extensionId" in request && !/^[a-p]{32}$/.test(request.extensionId))
			return { ok: false, error: INVALID_REQUEST };
		const initialized = await initialize();
		// A failed restore still allows listing, disabling, removing, and retrying
		// an extension. A failed constructor has no usable package manager.
		if (!manager) return initialized;
		try {
			switch (request.type) {
				case "browser-list-extensions":
					return { ok: true, extensions: manager.list() };
				case "browser-inspect-extension-url":
					return {
						ok: true,
						extensionInspection: await manager.inspectChromeWebStore(request.urlOrId),
					};
				case "browser-install-extension-url":
					return {
						ok: true,
						extension: await manager.installInspectedChromeWebStore(request.inspectionId, runtime),
					};
				case "browser-toggle-extension":
					return {
						ok: true,
						extension: await manager.toggle(request.extensionId, request.enabled, runtime),
					};
				case "browser-reload-extension":
					return { ok: true, extension: await manager.reload(request.extensionId, runtime) };
				case "browser-uninstall-extension":
					await manager.uninstall(request.extensionId, runtime);
					return { ok: true };
				default:
					return { ok: false, error: INVALID_REQUEST };
			}
		} catch (cause) {
			const storeOperation =
				request.type === "browser-inspect-extension-url" ||
				request.type === "browser-install-extension-url";
			const mapper = storeOperation
				? chromeWebStoreInstallErrorMessage
				: browserExtensionOperationErrorMessage;
			const mapped = mapper(cause);
			return { ok: false, error: PUBLIC_ERRORS.has(mapped) ? mapped : mapper(undefined) };
		}
	}

	return { initialize, handle };
}
