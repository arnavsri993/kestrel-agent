import type {
	ExtensionRuntimeExtension,
	ExtensionRuntimeLoadResult,
} from "./extension-runtime";

/**
 * Narrow host-side control surface for Chromium/CEF extension loading.
 * CEF 152 no longer exposes CefRequestContext::LoadExtension, so the native
 * host persists verified unpack paths and applies them through Chromium's
 * startup `--load-extension` switch on the user-browser profile.
 */
export type ChromiumExtensionHostPort = {
	loadExtension(
		path: string,
		options: { allowFileAccess: boolean },
	): Promise<ExtensionRuntimeLoadResult & { extension: ExtensionRuntimeExtension }>;
	removeExtension(id: string): Promise<void>;
	getExtension(id: string): Promise<ExtensionRuntimeExtension | null>;
	startServiceWorker(extensionId: string): Promise<void>;
};
