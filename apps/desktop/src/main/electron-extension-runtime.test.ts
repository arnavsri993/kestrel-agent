import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ElectronExtensionRuntime } from "./electron-extension-runtime";

type FakeExtension = {
	id: string;
	name: string;
	version: string;
	path: string;
	manifest: Record<string, unknown>;
};

function fakeSession(extension: FakeExtension, options?: { ready?: "before" | "after" | "never" }) {
	const extensions = new EventEmitter() as EventEmitter & {
		loadExtension: ReturnType<typeof vi.fn>;
		removeExtension: ReturnType<typeof vi.fn>;
		getExtension: ReturnType<typeof vi.fn>;
	};
	let loaded = false;
	extensions.loadExtension = vi.fn(async () => {
		if (options?.ready === "before") extensions.emit("extension-ready", {}, extension);
		loaded = true;
		if (options?.ready === "after")
			queueMicrotask(() => extensions.emit("extension-ready", {}, extension));
		return extension;
	});
	extensions.removeExtension = vi.fn(() => {
		loaded = false;
	});
	extensions.getExtension = vi.fn((id: string) =>
		loaded && id === extension.id ? extension : undefined,
	);
	const startWorkerForScope = vi.fn(async () => undefined);
	return {
		extensions,
		serviceWorkers: { startWorkerForScope },
	};
}

afterEach(() => vi.useRealTimers());

describe("ElectronExtensionRuntime", () => {
	it("records an extension-ready event that arrives while Electron resolves loadExtension", async () => {
		const extension: FakeExtension = {
			id: "a".repeat(32),
			name: "Worker extension",
			version: "1.0.0",
			path: "/verified/extension",
			manifest: { background: { service_worker: "worker.js" } },
		};
		const session = fakeSession(extension, { ready: "before" });
		const runtime = new ElectronExtensionRuntime(session as never);

		await expect(
			runtime.loadExtension(extension.path, { allowFileAccess: false }),
		).resolves.toEqual({ id: extension.id, ready: "passed" });
	});

	it("does not claim readiness if Electron emits no lifecycle evidence", async () => {
		vi.useFakeTimers();
		const extension: FakeExtension = {
			id: "b".repeat(32),
			name: "Unobserved extension",
			version: "1.0.0",
			path: "/verified/extension",
			manifest: { background: { page: "background.html" } },
		};
		const session = fakeSession(extension, { ready: "never" });
		const runtime = new ElectronExtensionRuntime(session as never);
		const loading = runtime.loadExtension(extension.path, { allowFileAccess: false });

		await vi.advanceTimersByTimeAsync(1_000);
		await expect(loading).resolves.toEqual({ id: extension.id, ready: "not_checked" });
	});

	it("uses not_applicable for packages without a background runtime and keeps adapter operations scoped", async () => {
		const extension: FakeExtension = {
			id: "c".repeat(32),
			name: "Content extension",
			version: "1.0.0",
			path: "/verified/extension",
			manifest: {},
		};
		const session = fakeSession(extension);
		const runtime = new ElectronExtensionRuntime(session as never);

		await expect(
			runtime.loadExtension(extension.path, { allowFileAccess: false }),
		).resolves.toEqual({ id: extension.id, ready: "not_applicable" });
		expect(runtime.getExtension(extension.id)).toMatchObject({
			id: extension.id,
			path: extension.path,
		});
		await runtime.startServiceWorker(extension.id);
		runtime.removeExtension(extension.id);
		expect(session.serviceWorkers.startWorkerForScope).toHaveBeenCalledWith(
			`chrome-extension://${extension.id}/`,
		);
		expect(session.extensions.removeExtension).toHaveBeenCalledWith(extension.id);
	});
});
