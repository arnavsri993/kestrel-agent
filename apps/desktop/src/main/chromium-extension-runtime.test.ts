import { describe, expect, it, vi } from "vitest";
import { ChromiumExtensionRuntime } from "./chromium-extension-runtime";
import type { ChromiumExtensionHostPort } from "./chromium-extension-host-port";
import type { ExtensionRuntimeExtension } from "./extension-runtime";

describe("ChromiumExtensionRuntime", () => {
	it("caches host load results and scopes adapter operations", async () => {
		const extension: ExtensionRuntimeExtension = {
			id: "d".repeat(32),
			name: "Native fixture",
			version: "1.0.0",
			path: "/verified/extension",
			manifest: { background: { service_worker: "worker.js" } },
		};
		const host: ChromiumExtensionHostPort = {
			loadExtension: vi.fn(async () => ({
				id: extension.id,
				ready: "passed" as const,
				extension,
			})),
			removeExtension: vi.fn(async () => undefined),
			getExtension: vi.fn(async () => extension),
			startServiceWorker: vi.fn(async () => undefined),
		};
		const runtime = new ChromiumExtensionRuntime(host);

		await expect(
			runtime.loadExtension(extension.path, { allowFileAccess: false }),
		).resolves.toEqual({ id: extension.id, ready: "passed" });
		expect(runtime.getExtension(extension.id)).toEqual(extension);
		await runtime.startServiceWorker(extension.id);
		await runtime.removeExtension(extension.id);
		expect(host.startServiceWorker).toHaveBeenCalledWith(extension.id);
		expect(host.removeExtension).toHaveBeenCalledWith(extension.id);
		expect(runtime.getExtension(extension.id)).toBeNull();
	});
});
