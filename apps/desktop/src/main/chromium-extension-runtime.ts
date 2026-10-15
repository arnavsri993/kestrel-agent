import type { ChromiumExtensionHostPort } from "./chromium-extension-host-port";
import type {
	ExtensionRuntime,
	ExtensionRuntimeExtension,
	ExtensionRuntimeLoadResult,
} from "./extension-runtime";

/**
 * Chromium/CEF adapter for BrowserExtensionManager. Package verification and
 * compatibility evidence stay in the manager; this class only talks to the
 * native host port that owns the user-browser profile.
 */
export class ChromiumExtensionRuntime implements ExtensionRuntime {
	private readonly cache = new Map<string, ExtensionRuntimeExtension>();

	constructor(private readonly host: ChromiumExtensionHostPort) {}

	async loadExtension(
		path: string,
		options: { allowFileAccess: boolean },
	): Promise<ExtensionRuntimeLoadResult> {
		const loaded = await this.host.loadExtension(path, options);
		this.cache.set(loaded.extension.id, loaded.extension);
		return { id: loaded.id, ready: loaded.ready };
	}

	async removeExtension(id: string): Promise<void> {
		await this.host.removeExtension(id);
		this.cache.delete(id);
	}

	getExtension(id: string): ExtensionRuntimeExtension | null {
		return this.cache.get(id) ?? null;
	}

	async startServiceWorker(extensionId: string): Promise<void> {
		await this.host.startServiceWorker(extensionId);
	}
}
