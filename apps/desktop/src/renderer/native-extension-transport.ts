import { createRendererBridge, type RendererTransport, type RendererResponse } from "@kestrel/shared-types";
import { useSyncExternalStore } from "react";

interface ExtensionPort {
	postMessage(message: unknown): void;
	onMessage: { addListener(callback: (message: any) => void): void };
	onDisconnect: { addListener(callback: () => void): void };
}
interface ExtensionRuntime {
	id: string;
	connect(options: { name: string }): ExtensionPort;
}
interface NativeChromeUi {
	runtime?: ExtensionRuntime;
	storage?: {
		session: { get(key: string): Promise<Record<string, unknown>> };
		onChanged: { addListener(callback: (changes: Record<string, { newValue?: unknown }>, area: string) => void): void };
	};
	windows?: { getCurrent(): Promise<{ id?: number }> };
	sidePanel?: {
		open(options: { windowId: number }): Promise<void>;
		close(options: { windowId: number }): Promise<void>;
	};
}

const chromeUi = (globalThis as typeof globalThis & { chrome?: NativeChromeUi }).chrome;
const runtime = chromeUi?.runtime;
export const nativeChromiumSurface = location.protocol === "chrome-extension:" && runtime?.id === location.hostname;
export const nativeChromiumPanel = nativeChromiumSurface && new URLSearchParams(location.search).get("surface") === "panel";
let nativeWindowId: number | undefined;
const openPanelsKey = "kestrel.native.openPanels.v1";
const panelListeners = new Set<() => void>();
let companionOpen = false;
let panelRevision = 0;
let panelWindows: Record<string, unknown> = {};
function updateCompanion() {
	const next = !nativeChromiumPanel && nativeWindowId !== undefined && panelWindows[nativeWindowId] === true;
	if (next === companionOpen) return;
	companionOpen = next;
	for (const listener of panelListeners) listener();
}
if (nativeChromiumSurface) {
	chromeUi?.storage?.onChanged.addListener((changes, area) => {
		if (area !== "session" || !changes[openPanelsKey]) return;
		++panelRevision;
		const value = changes[openPanelsKey]?.newValue;
		panelWindows = value && typeof value === "object" ? value as Record<string, unknown> : {};
		updateCompanion();
	});
	void chromeUi?.windows?.getCurrent().then(async (window) => {
		nativeWindowId = window.id;
		const revision = panelRevision;
		const stored = await chromeUi?.storage?.session.get(openPanelsKey);
		if (revision === panelRevision) {
			const value = stored?.[openPanelsKey];
			panelWindows = value && typeof value === "object" ? value as Record<string, unknown> : {};
		}
		updateCompanion();
	}).catch(() => {});
}
export function useNativeCompanionOpen(): boolean {
	return useSyncExternalStore(
		(listener) => { panelListeners.add(listener); return () => panelListeners.delete(listener); },
		() => companionOpen,
		() => false,
	);
}
export function openNativeAgentPanel(): Promise<void> {
	if (!nativeChromiumSurface || nativeWindowId === undefined || !chromeUi?.sidePanel) return Promise.reject(new Error("Kestrel's agent panel is not available in this window."));
	return chromeUi.sidePanel.open({ windowId: nativeWindowId });
}
export function closeNativeAgentPanel(): Promise<void> {
	if (!nativeChromiumPanel || nativeWindowId === undefined || !chromeUi?.sidePanel) return Promise.reject(new Error("Kestrel's agent panel is not available in this window."));
	return chromeUi.sidePanel.close({ windowId: nativeWindowId });
}

// This module is packaged only in the first-party UI. It never injects a
// transport into user tabs; the worker authenticates its native channel first.
if (nativeChromiumSurface && runtime) {
	document.documentElement.dataset.desktopRuntime = "chromium";
	document.documentElement.dataset.nativeSurface = nativeChromiumPanel ? "panel" : "home";
	const port = runtime.connect({ name: "kestrel-ui" });
	let sequence = 0;
	let closed = false;
	const pending = new Map<number, { resolve: (value: RendererResponse) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
	const listeners = new Map<string, Set<(value: unknown) => void>>();
	port.onMessage.addListener((message) => {
		if (message?.kind === "response" && Number.isSafeInteger(message.id)) {
			const request = pending.get(message.id);
			if (!request) return;
			clearTimeout(request.timeout);
			pending.delete(message.id);
			request.resolve(message.response);
		} else if (message?.kind === "event" && typeof message.channel === "string") {
			for (const listener of listeners.get(message.channel) ?? []) listener(message.event);
		}
	});
	port.onDisconnect.addListener(() => {
		closed = true;
		for (const request of pending.values()) {
			clearTimeout(request.timeout);
			request.reject(new Error("Kestrel's browser connection closed. Reopen this page to reconnect."));
		}
		pending.clear();
	});
	const transport: RendererTransport = {
		request(request) {
			if (request.type === "browser-create-tab" && request.input?.startsWith("https://chromewebstore.google.com")) {
				// Called in the original UI gesture before awaiting any tab work.
				void openNativeAgentPanel().catch(() => {});
			}
			if (closed || pending.size >= 64) return Promise.reject(new Error("Kestrel's browser connection is unavailable."));
			return new Promise((resolve, reject) => {
				const id = ++sequence;
				const timeout = setTimeout(() => { pending.delete(id); reject(new Error("Kestrel's browser request timed out.")); }, 45_000);
				pending.set(id, { resolve, reject, timeout });
				try { port.postMessage({ kind: "request", id, request }); }
				catch (error) { clearTimeout(timeout); pending.delete(id); reject(error); }
			});
		},
		subscribe(channel, listener) {
			const group = listeners.get(channel) ?? new Set();
			listeners.set(channel, group);
			group.add(listener);
			return () => { group.delete(listener); if (!group.size) listeners.delete(channel); };
		},
	};
	Object.defineProperty(window, "kestrel", { value: createRendererBridge(transport), writable: false, configurable: false });
}
