import type { Extension, Session } from "electron";
import type {
	ExtensionRuntime,
	ExtensionRuntimeExtension,
	ExtensionRuntimeLoadResult,
} from "./extension-runtime";

function runtimeExtension(extension: Extension): ExtensionRuntimeExtension {
	return {
		id: extension.id,
		name: extension.name,
		version: extension.version,
		path: extension.path,
		manifest: extension.manifest,
	};
}

/** The only adapter that knows Electron's extension and service-worker APIs. */
export class ElectronExtensionRuntime implements ExtensionRuntime {
	constructor(private readonly session: Session) {}

	async loadExtension(
		path: string,
		options: { allowFileAccess: boolean },
	): Promise<ExtensionRuntimeLoadResult> {
		let loadedId: string | undefined;
		const readyBeforeLoad = new Set<string>();
		let resolveReady: (() => void) | undefined;
		const readyAfterLoad = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});
		const onReady = (_event: Electron.Event, extension: Extension) => {
			if (extension.id === loadedId) resolveReady?.();
			else readyBeforeLoad.add(extension.id);
		};
		this.session.extensions.on("extension-ready", onReady);
		try {
			const extension = await this.session.extensions.loadExtension(path, options);
			loadedId = extension.id;
			const background =
				extension.manifest && typeof extension.manifest === "object"
					? (extension.manifest as Record<string, unknown>).background
					: undefined;
			if (!background || typeof background !== "object")
				return { id: extension.id, ready: "not_applicable" };
			if (readyBeforeLoad.has(extension.id))
				return { id: extension.id, ready: "passed" };
			const observed = await new Promise<boolean>((resolve) => {
				const timeout = setTimeout(() => resolve(false), 1_000);
				void readyAfterLoad.then(() => {
					clearTimeout(timeout);
					resolve(true);
				});
			});
			return {
				id: extension.id,
				ready: observed ? "passed" : "not_checked",
			};
		} finally {
			this.session.extensions.off("extension-ready", onReady);
		}
	}

	removeExtension(id: string): void {
		this.session.extensions.removeExtension(id);
	}

	getExtension(id: string): ExtensionRuntimeExtension | null {
		const extension = this.session.extensions.getExtension(id);
		return extension ? runtimeExtension(extension) : null;
	}

	async startServiceWorker(extensionId: string): Promise<void> {
		await this.session.serviceWorkers.startWorkerForScope(
			`chrome-extension://${extensionId}/`,
		);
	}
}
