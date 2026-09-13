export const USER_BROWSER_ACTIVITY_CHANNEL = "kestrel:user-browser-activity";
export const USER_BROWSER_ACTIVITY_EVENT = "kestrel:user-browser-activity";

export interface UserBrowserActivity {
	playing: boolean;
	microphone: boolean;
	camera: boolean;
	screen: boolean;
	location: boolean;
	busy: boolean;
	dirty: boolean;
}

// This function is serialized by Electron and runs in the page's main world.
// Keep it self-contained: it receives no Node or Kestrel capabilities, and it
// only dispatches a fixed boolean snapshot back to the isolated preload.
export function installUserBrowserActivityInstrumentation(eventName: string): void {
	if (window.top !== window || typeof eventName !== "string") return;

	const dispatch = window.dispatchEvent.bind(window);
	const ActivityEvent = window.CustomEvent;
	const queryMedia = Document.prototype.querySelectorAll;
	const scheduleMicrotask = typeof queueMicrotask === "function"
		? queueMicrotask.bind(globalThis)
		: (callback: () => void) => Promise.resolve().then(callback);
	const scheduleTask = window.setTimeout.bind(window);
	const activity = {
		playing: false,
		microphone: false,
		camera: false,
		screen: false,
		location: false,
		busy: false,
		dirty: false,
	};
	let lastSerialized = "";
	let reportScheduled = false;
	let pendingBusy = 0;
	let pendingLocation = 0;
	const microphoneTracks = new Set<MediaStreamTrack>();
	const cameraTracks = new Set<MediaStreamTrack>();
	const screenTracks = new Set<MediaStreamTrack>();
	const locationWatches = new Set<number>();
	const activeXhrs = new Set<XMLHttpRequest>();
	const webSockets = new Set<WebSocket>();
	const peerConnections = new Set<RTCPeerConnection>();
	const wakeLocks = new Set<WakeLockSentinel>();
	const dirtyForms = new Set<Element>();
	let documentDirty = false;

	function liveTrack(set: Set<MediaStreamTrack>): boolean {
		for (const track of set) {
			if (track.readyState === "live") return true;
			set.delete(track);
		}
		return false;
	}

	function mediaIsPlaying(): boolean {
		for (const media of queryMedia.call(document, "audio,video")) {
			const element = media as HTMLMediaElement;
			// Do not use volume or muted here: a muted video can still be an active
			// presentation and must keep its tab awake.
			if (!element.paused && !element.ended) return true;
		}
		return false;
	}

	function openWebSocket(): boolean {
		for (const socket of webSockets) {
			if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) return true;
			webSockets.delete(socket);
		}
		return false;
	}

	function livePeerConnection(): boolean {
		for (const peer of peerConnections) {
			const state = peer.connectionState;
			if (state === "new" || state === "connecting" || state === "connected" || state === "disconnected") return true;
			peerConnections.delete(peer);
		}
		return false;
	}

	function liveWakeLock(): boolean {
		for (const lock of wakeLocks) {
			if (!lock.released) return true;
			wakeLocks.delete(lock);
		}
		return false;
	}

	function report(): void {
		reportScheduled = false;
		activity.playing = mediaIsPlaying();
		activity.microphone = liveTrack(microphoneTracks);
		activity.camera = liveTrack(cameraTracks);
		activity.screen = liveTrack(screenTracks);
		activity.location = pendingLocation > 0 || locationWatches.size > 0;
		activity.busy = pendingBusy > 0 || activeXhrs.size > 0 || openWebSocket() || livePeerConnection() || liveWakeLock();
		activity.dirty = documentDirty || dirtyForms.size > 0;
		const serialized = JSON.stringify(activity);
		if (serialized === lastSerialized) return;
		lastSerialized = serialized;
		try {
			dispatch(new ActivityEvent(eventName, { detail: { ...activity } }));
		} catch {
			// Instrumentation must never affect a site's page lifecycle.
		}
	}

	function requestReport(): void {
		if (reportScheduled) return;
		reportScheduled = true;
		scheduleMicrotask(report);
	}

	function observePromise<T>(result: T, fulfilled?: (value: Awaited<T>) => void): void {
		if (!result || typeof (result as { then?: unknown }).then !== "function") return;
		pendingBusy++;
		requestReport();
		Promise.resolve(result).then(
			(value) => {
				try { fulfilled?.(value as Awaited<T>); } finally { pendingBusy--; requestReport(); }
			},
			() => { pendingBusy--; requestReport(); },
		);
	}

	function observeStream(stream: MediaStream, kind: "user" | "display"): void {
		for (const track of stream.getTracks()) {
			const destination = kind === "display"
				? (track.kind === "video" ? screenTracks : undefined)
				: (track.kind === "audio" ? microphoneTracks : cameraTracks);
			if (!destination) continue;
			destination.add(track);
			track.addEventListener("ended", requestReport, { once: true });
			// MediaStreamTrack.stop() changes readyState without dispatching `ended`.
			// Observe it without changing the method's receiver, arguments, return, or
			// thrown errors so stopped capture clears immediately.
			const stop = track.stop;
			try {
				track.stop = function (...args: Parameters<MediaStreamTrack["stop"]>) {
					try { return stop.apply(this, args); } finally { requestReport(); }
				};
			} catch {}
		}
		requestReport();
	}

	function wrapMediaRequest(method: "getUserMedia" | "getDisplayMedia", kind: "user" | "display"): void {
		const mediaDevices = navigator.mediaDevices;
		const original = mediaDevices?.[method];
		if (typeof original !== "function") return;
		try {
			mediaDevices[method] = function (...args: unknown[]) {
				const result = original.apply(this, args as never);
				observePromise(result, (stream) => observeStream(stream as MediaStream, kind));
				return result;
			};
		} catch {
			// Some browsers expose an immutable implementation. Missing this advisory
			// signal is safer than changing page-visible API behavior.
		}
	}

	function installLocationInstrumentation(): void {
		const geolocation = navigator.geolocation;
		if (!geolocation) return;
		const getCurrentPosition = geolocation.getCurrentPosition;
		const watchPosition = geolocation.watchPosition;
		const clearWatch = geolocation.clearWatch;
		if (typeof getCurrentPosition === "function") {
			try {
				geolocation.getCurrentPosition = function (success, failure, options) {
					let settled = false;
					const settle = () => {
						if (settled) return;
						settled = true;
						pendingLocation--;
						requestReport();
					};
					pendingLocation++;
					requestReport();
					return getCurrentPosition.call(
						this,
						(...args) => { settle(); return success?.(...args); },
						(...args) => { settle(); return failure?.(...args); },
						options,
					);
				};
			} catch {}
		}
		if (typeof watchPosition === "function" && typeof clearWatch === "function") {
			try {
				geolocation.watchPosition = function (success, failure, options) {
					const id = watchPosition.call(this, success, failure, options);
					locationWatches.add(id);
					requestReport();
					return id;
				};
				geolocation.clearWatch = function (id) {
					locationWatches.delete(id);
					requestReport();
					return clearWatch.call(this, id);
				};
			} catch {}
		}
	}

	function installFetchInstrumentation(): void {
		const originalFetch = window.fetch;
		if (typeof originalFetch !== "function") return;
		try {
			window.fetch = function (...args: Parameters<typeof fetch>) {
				const result = originalFetch.apply(this, args);
				observePromise(result);
				return result;
			};
		} catch {}
	}

	function installXhrInstrumentation(): void {
		const prototype = window.XMLHttpRequest?.prototype;
		const send = prototype?.send;
		if (typeof send !== "function") return;
		try {
			prototype.send = function (...args: Parameters<XMLHttpRequest["send"]>) {
				const xhr = this as XMLHttpRequest;
				let finished = false;
				const finish = () => {
					if (finished) return;
					finished = true;
					activeXhrs.delete(xhr);
					xhr.removeEventListener("loadend", finish);
					requestReport();
				};
				activeXhrs.add(xhr);
				xhr.addEventListener("loadend", finish, { once: true });
				requestReport();
				try {
					return send.apply(xhr, args);
				} catch (error) {
					finish();
					throw error;
				} finally {
					if (xhr.readyState === XMLHttpRequest.DONE) finish();
				}
			};
		} catch {}
	}

	function installSocketInstrumentation(): void {
		const NativeWebSocket = window.WebSocket;
		if (typeof NativeWebSocket === "function" && typeof Proxy === "function") {
			try {
				window.WebSocket = new Proxy(NativeWebSocket, {
					construct(target, args) {
						const socket = Reflect.construct(target, args) as WebSocket;
						webSockets.add(socket);
						socket.addEventListener("close", () => { webSockets.delete(socket); requestReport(); }, { once: true });
						requestReport();
						return socket;
					},
				});
			} catch {}
		}
		const NativePeerConnection = window.RTCPeerConnection;
		if (typeof NativePeerConnection !== "function" || typeof Proxy !== "function") return;
		try {
			window.RTCPeerConnection = new Proxy(NativePeerConnection, {
				construct(target, args) {
					const peer = Reflect.construct(target, args) as RTCPeerConnection;
					peerConnections.add(peer);
					peer.addEventListener("connectionstatechange", requestReport);
					requestReport();
					return peer;
				},
			});
		} catch {}
	}

	function installWakeLockInstrumentation(): void {
		const wakeLock = navigator.wakeLock;
		const request = wakeLock?.request;
		if (typeof request !== "function") return;
		try {
			wakeLock.request = function (...args: Parameters<WakeLock["request"]>) {
				const result = request.apply(this, args);
				observePromise(result, (lock) => {
					const sentinel = lock as WakeLockSentinel;
					wakeLocks.add(sentinel);
					sentinel.addEventListener("release", () => { wakeLocks.delete(sentinel); requestReport(); }, { once: true });
					requestReport();
				});
				return result;
			};
		} catch {}
	}

	function editableTarget(event: Event): Element | undefined {
		const target = event.composedPath()[0];
		if (!(target instanceof Element)) return;
		if (target instanceof HTMLInputElement) {
			if (["button", "hidden", "image", "reset", "submit"].includes(target.type)) return;
			return target;
		}
		if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target instanceof HTMLElement && target.isContentEditable) return target;
	}

	function installDirtyFormInstrumentation(): void {
		document.addEventListener("input", (event) => {
			if (!event.isTrusted) return;
			const target = editableTarget(event);
			if (!target) return;
			const form = target.closest("form");
			if (form) dirtyForms.add(form);
			else documentDirty = true;
			requestReport();
		}, true);
		document.addEventListener("change", (event) => {
			if (!event.isTrusted) return;
			const target = editableTarget(event);
			if (!target) return;
			const form = target.closest("form");
			if (form) dirtyForms.add(form);
			else documentDirty = true;
			requestReport();
		}, true);
		document.addEventListener("reset", (event) => {
			const form = event.target;
			if (form instanceof HTMLFormElement) dirtyForms.delete(form);
			requestReport();
		}, true);
		document.addEventListener("submit", (event) => {
			const form = event.target;
			if (!(form instanceof HTMLFormElement)) return;
			// A capture listener runs before page submit handlers. Defer until the
			// next task so a site's preventDefault decision is final before a draft
			// is cleared.
			scheduleTask(() => {
				if (!event.defaultPrevented) dirtyForms.delete(form);
				requestReport();
			}, 0);
		}, true);
	}

	function clearForPageExit(): void {
		microphoneTracks.clear();
		cameraTracks.clear();
		screenTracks.clear();
		locationWatches.clear();
		activeXhrs.clear();
		webSockets.clear();
		peerConnections.clear();
		wakeLocks.clear();
		dirtyForms.clear();
		documentDirty = false;
		pendingBusy = 0;
		pendingLocation = 0;
		report();
	}

	document.addEventListener("play", requestReport, true);
	document.addEventListener("playing", requestReport, true);
	document.addEventListener("pause", requestReport, true);
	document.addEventListener("ended", requestReport, true);
	document.addEventListener("emptied", requestReport, true);
	document.addEventListener("abort", requestReport, true);
	window.addEventListener("pagehide", clearForPageExit, { once: true });
	new MutationObserver(requestReport).observe(document, { childList: true, subtree: true });
	wrapMediaRequest("getUserMedia", "user");
	wrapMediaRequest("getDisplayMedia", "display");
	installLocationInstrumentation();
	installFetchInstrumentation();
	installXhrInstrumentation();
	installSocketInstrumentation();
	installWakeLockInstrumentation();
	installDirtyFormInstrumentation();
	report();
}
