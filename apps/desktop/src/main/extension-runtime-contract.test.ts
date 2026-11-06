import { describe, expect, it, vi } from "vitest";
import type {
	ExtensionRuntime,
	ExtensionRuntimeExtension,
	ExtensionRuntimeLoadResult,
} from "./extension-runtime";

/**
 * Shared ExtensionRuntime contract scenarios. Any adapter (Electron today,
 * Chromium/CEF later) must satisfy these readiness and scoping semantics.
 */
function createContractRuntime(options: {
	extension: ExtensionRuntimeExtension;
	readyTiming: "before" | "after" | "never" | "not_applicable";
}): {
	runtime: ExtensionRuntime;
	startServiceWorker: ReturnType<typeof vi.fn>;
	removeExtension: ReturnType<typeof vi.fn>;
} {
	const startServiceWorker = vi.fn(async () => undefined);
	const removeExtension = vi.fn(async () => undefined);
	const loaded = new Map<string, ExtensionRuntimeExtension>();
	const runtime: ExtensionRuntime = {
		async loadExtension(path, _options): Promise<ExtensionRuntimeLoadResult> {
			loaded.set(options.extension.id, { ...options.extension, path });
			if (options.readyTiming === "not_applicable")
				return { id: options.extension.id, ready: "not_applicable" };
			if (options.readyTiming === "before" || options.readyTiming === "after")
				return { id: options.extension.id, ready: "passed" };
			return { id: options.extension.id, ready: "not_checked" };
		},
		removeExtension,
		getExtension(id) {
			return loaded.get(id) ?? null;
		},
		startServiceWorker,
	};
	return { runtime, startServiceWorker, removeExtension };
}

describe("ExtensionRuntime contract", () => {
	it("treats observed readiness as passed for service-worker packages", async () => {
		const extension: ExtensionRuntimeExtension = {
			id: "a".repeat(32),
			name: "Worker extension",
			version: "1.0.0",
			path: "/verified/extension",
			manifest: { background: { service_worker: "worker.js" } },
		};
		const { runtime } = createContractRuntime({
			extension,
			readyTiming: "before",
		});

		await expect(
			runtime.loadExtension(extension.path, { allowFileAccess: false }),
		).resolves.toEqual({ id: extension.id, ready: "passed" });
	});

	it("uses not_checked when the adapter cannot observe readiness", async () => {
		const extension: ExtensionRuntimeExtension = {
			id: "b".repeat(32),
			name: "Unobserved extension",
			version: "1.0.0",
			path: "/verified/extension",
			manifest: { background: { page: "background.html" } },
		};
		const { runtime } = createContractRuntime({
			extension,
			readyTiming: "never",
		});

		await expect(
			runtime.loadExtension(extension.path, { allowFileAccess: false }),
		).resolves.toEqual({ id: extension.id, ready: "not_checked" });
	});

	it("uses not_applicable without a background runtime and keeps operations scoped", async () => {
		const extension: ExtensionRuntimeExtension = {
			id: "c".repeat(32),
			name: "Content extension",
			version: "1.0.0",
			path: "/verified/extension",
			manifest: {},
		};
		const { runtime, startServiceWorker, removeExtension } = createContractRuntime({
			extension,
			readyTiming: "not_applicable",
		});

		await expect(
			runtime.loadExtension(extension.path, { allowFileAccess: false }),
		).resolves.toEqual({ id: extension.id, ready: "not_applicable" });
		expect(runtime.getExtension(extension.id)).toMatchObject({
			id: extension.id,
			path: extension.path,
		});
		await runtime.startServiceWorker(extension.id);
		await runtime.removeExtension(extension.id);
		expect(startServiceWorker).toHaveBeenCalledWith(extension.id);
		expect(removeExtension).toHaveBeenCalledWith(extension.id);
	});
});
