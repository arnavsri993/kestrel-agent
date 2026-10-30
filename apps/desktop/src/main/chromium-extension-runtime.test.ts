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

	it.each([true, false])("uninstalls explicitly when supported (%s), preserving the cache after failure", async (explicit) => {
		const extension: ExtensionRuntimeExtension = {
			id: "d".repeat(32), name: "Native fixture", version: "1.0.0",
			path: "/verified/extension", manifest: {},
		};
		const remove = vi.fn(async () => undefined);
		const host: ChromiumExtensionHostPort = {
			loadExtension: vi.fn(async () => ({ id: extension.id, ready: "passed" as const, extension })),
			removeExtension: vi.fn(async () => undefined),
			getExtension: vi.fn(async () => extension),
			startServiceWorker: vi.fn(async () => undefined),
		};
		if (explicit) host.uninstallExtension = remove;
		else host.removeExtension = remove;
		const runtime = new ChromiumExtensionRuntime(host);
		await runtime.loadExtension(extension.path, { allowFileAccess: false });
		remove.mockRejectedValueOnce(new Error("native removal failed"));
		await expect(runtime.uninstallExtension(extension.id)).rejects.toThrow("native removal failed");
		expect(runtime.getExtension(extension.id)).toEqual(extension);
		await runtime.uninstallExtension(extension.id);
		expect(runtime.getExtension(extension.id)).toBeNull();
		if (explicit) expect(host.removeExtension).not.toHaveBeenCalled();
		expect(remove).toHaveBeenCalledTimes(2);
	});
});
