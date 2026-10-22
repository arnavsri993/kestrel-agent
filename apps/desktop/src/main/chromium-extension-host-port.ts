import type {
	ExtensionRuntimeExtension,
	ExtensionRuntimeLoadResult,
} from "./extension-runtime";

/**
 * Narrow host-side control surface for Chromium/CEF extension loading.
 * CEF 152 no longer exposes CefRequestContext::LoadExtension. The live native
 * host controls reviewed packages through its private browser pipe; the legacy
 * file port records startup registrations and reports readiness as unchecked.
 */
export type ChromiumExtensionHostPort = {
	loadExtension(
		path: string,
		options: { allowFileAccess: boolean },
	): Promise<ExtensionRuntimeLoadResult & { extension: ExtensionRuntimeExtension }>;
	removeExtension(id: string): Promise<void>;
	/** Permanent uninstall; removeExtension only disables an installation. */
	uninstallExtension?(id: string): Promise<void>;
	getExtension(id: string): Promise<ExtensionRuntimeExtension | null>;
	startServiceWorker(extensionId: string): Promise<void>;
};
