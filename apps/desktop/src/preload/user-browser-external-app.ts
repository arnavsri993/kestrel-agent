export const EXTERNAL_APP_CHANNEL = "kestrel:user-browser-external-app";
export const EXTERNAL_APP_READY_CHANNEL = "kestrel:user-browser-external-app-ready";
export const EXTERNAL_APP_EVENT = "kestrel:user-browser-external-app-request";

// Serialized by contextBridge.executeInMainWorld; keep this function closed
// over only its argument and browser globals. It never exposes Electron APIs.
export function installExternalAppWindowOpen(eventName: string): void {
	if (window !== window.top || location.protocol !== "https:") return;
	const nativeOpen = window.open;
	const post = window.postMessage.bind(window);
	const origin = location.origin;
	window.open = function (...args: Parameters<Window["open"]>) {
		const value = args[0];
		// Classification only; the main process performs all URL validation.
		if (typeof value === "string" && value.length <= 16_384 &&
			/^(?:zoommtg|zoomus|msteams|cursor|macappstore|itms-apps|itms-appss):/i.test(value)) {
			post({ type: eventName, url: value }, origin);
			return null;
		}
		return Reflect.apply(nativeOpen, window, args);
	};
}

interface ExternalAppBridgeRuntime {
	isMainFrame: boolean;
	send: (channel: string, value: unknown) => void;
	onReady: (listener: (value: unknown) => void) => void;
	execute: (func: typeof installExternalAppWindowOpen, args: string[]) => void;
}

export function installExternalAppBridge(runtime: ExternalAppBridgeRuntime): void {
	const page = new URL(location.href);
	if (!runtime.isMainFrame || page.protocol !== "https:" || page.username || page.password) return;
	let documentId = crypto.randomUUID();
	const documentUrl = location.href;
	const origin = location.origin;
	let generation: number | undefined;
	let capturedAt: number | undefined;
	let readyPending = true;
	runtime.onReady((raw) => {
		if (!raw || typeof raw !== "object") return;
		const value = raw as { documentId?: unknown; generation?: unknown };
		if (readyPending && location.href === documentUrl && value.documentId === documentId &&
			Number.isSafeInteger(value.generation) && Number(value.generation) >= 0) {
			generation = Number(value.generation);
			readyPending = false;
		}
	});
	runtime.send(EXTERNAL_APP_CHANNEL, { type: "ready", documentId, documentUrl });
	const capture = (event: MouseEvent | KeyboardEvent) => {
		if (!event.isTrusted || generation === undefined || location.href !== documentUrl || !document.hasFocus()) return;
		const kind = event.type === "mousedown" ? "mouse" : (event as KeyboardEvent).key;
		if (kind === "mouse" ? (event as MouseEvent).button !== 0 :
			!["Enter", " "].includes(kind) || (event as KeyboardEvent).repeat ||
			(event as KeyboardEvent).isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
		capturedAt = Date.now();
		runtime.send(EXTERNAL_APP_CHANNEL, { type: "capture", documentId, documentUrl, generation, kind });
	};
	window.addEventListener("mousedown", capture, true);
	window.addEventListener("keydown", capture, true);
	window.addEventListener("pagehide", () => {
		capturedAt = undefined;
		generation = undefined;
		readyPending = false;
	}, true);
	window.addEventListener("pageshow", (event: PageTransitionEvent) => {
		if (!event.isTrusted || !event.persisted || location.href !== documentUrl) return;
		// BFCache restores this isolated preload instead of running it again. A
		// new private nonce keeps any delayed acknowledgement from the old visit
		// from restoring its generation, and no input survives the restore.
		capturedAt = undefined;
		generation = undefined;
		documentId = crypto.randomUUID();
		readyPending = true;
		runtime.send(EXTERNAL_APP_CHANNEL, { type: "ready", documentId, documentUrl });
	}, true);
	window.addEventListener("message", (event: MessageEvent) => {
		if (event.source !== window || event.origin !== origin || location.href !== documentUrl ||
			generation === undefined || capturedAt === undefined) return;
		const value = event.data as { type?: unknown; url?: unknown } | null;
		if (!value || value.type !== EXTERNAL_APP_EVENT || typeof value.url !== "string" || value.url.length > 16_384 ||
			!/^(?:zoommtg|zoomus|msteams|cursor|macappstore|itms-apps|itms-appss):/i.test(value.url)) return;
		const at = capturedAt;
		capturedAt = undefined;
		if (Date.now() < at || Date.now() - at > 5_000) return;
		runtime.send(EXTERNAL_APP_CHANNEL, { type: "request", documentId, documentUrl, generation, url: value.url });
	});
	try { runtime.execute(installExternalAppWindowOpen, [EXTERNAL_APP_EVENT]); }
	catch { /* Native unknown-referrer launches remain denied if installation fails. */ }
}
