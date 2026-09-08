/**
 * The extension package and compatibility system deliberately depend on this
 * small Kestrel-owned boundary instead of Electron's Session API.  That keeps
 * package verification, persistence, and compatibility evidence portable to a
 * future browser runtime.
 */
export type ExtensionRuntimeExtension = {
	id: string;
	name: string;
	version: string;
	path: string;
	manifest: unknown;
};

export type ExtensionRuntimeLoadResult = {
	id: string;
	/**
	 * Runtime lifecycle evidence. `not_checked` means the adapter could not
	 * observe readiness, not that the extension is ready.
	 */
	ready: "passed" | "not_checked" | "not_applicable";
};

export interface ExtensionRuntime {
	loadExtension(
		path: string,
		options: { allowFileAccess: boolean },
	): Promise<ExtensionRuntimeLoadResult>;
	removeExtension(id: string): void | Promise<void>;
	getExtension(id: string): ExtensionRuntimeExtension | null;
	startServiceWorker(extensionId: string): Promise<void>;
}
