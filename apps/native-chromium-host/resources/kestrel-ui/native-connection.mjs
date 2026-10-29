// Sent actions fail when their connection closes. They are never replayed.
import { nativeRequestTimeoutMs } from "../../../../packages/shared-types/src/request-timeouts.ts";
export function createNativeConnection({ runtime, emit = () => {}, cryptoApi = crypto, handleBrowserRequest,
	loadConfiguration = async (nonce) => {
		const response = await fetch(runtime.getURL("launch-config.json") + "?challenge=" + nonce, { cache: "no-store", redirect: "error" });
		if (!response.ok) throw new Error("Native launch configuration is unavailable.");
		return response.json();
	},
}) {
	const pending = new Map();
	const browserRequests = new Map();
	let native, retry;
	let ready = false, sequence = 0, delay = 250;
	function arm(id, request, waiting = false) {
		clearTimeout(request.timeout);
		const budget = waiting ? 42_000 : nativeRequestTimeoutMs(request.message.request, "worker");
		request.timeout = setTimeout(() => {
			if (pending.get(id) !== request) return;
			pending.delete(id);
			request.resolve({ ok: false, error: waiting ? "Kestrel's native connection setup timed out." : "Kestrel's native request timed out. Check the task or browser state before retrying." });
		}, Math.max(1, budget - (Date.now() - request.startedAt)));
	}
	function disconnected(connection) {
		if (native !== connection) return;
		native = undefined;
		ready = false;
		for (const request of pending.values()) {
			clearTimeout(request.timeout);
			request.resolve({ ok: false, error: "Kestrel's native connection closed. Check the task or browser state before retrying." });
		}
		pending.clear();
		for (const [id, request] of browserRequests) if (request.connection === connection) {
			browserRequests.delete(id);
			request.controller.abort();
		}
		clearTimeout(retry);
		retry = setTimeout(connect, delay);
		delay = Math.min(delay * 2, 30_000);
	}
	function abort(connection) {
		try { connection.disconnect(); } finally { disconnected(connection); }
	}
	function post(connection, message) {
		try { connection.postMessage(message); } catch { abort(connection); }
	}
	function connect() {
		if (native) return;
		clearTimeout(retry);
		let connection;
		try { connection = runtime.connectNative("com.kestrel.desktop"); }
		catch { retry = setTimeout(connect, delay); delay = Math.min(delay * 2, 30_000); return; }
		native = connection;
		let phase = "challenge";
		connection.onMessage.addListener(async (message) => {
			if (native !== connection) return;
			if (message?.kind === "challenge") {
				if (phase !== "challenge" || typeof message.nonce !== "string" || !/^[a-f0-9]{64}$/.test(message.nonce) || !Number.isSafeInteger(message.browserPid) || message.browserPid <= 0) { abort(connection); return; }
				phase = "authenticating";
				try {
					const configuration = await loadConfiguration(message.nonce);
					if (native !== connection) return;
					if (configuration.version !== 1 || configuration.browserPid !== message.browserPid || typeof configuration.key !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(configuration.key)) throw new Error("Invalid native launch configuration.");
					const bytes = Uint8Array.from(atob(configuration.key), (character) => character.charCodeAt(0));
					if (bytes.length !== 32) throw new Error("Invalid native launch key.");
					let key;
					try { key = await cryptoApi.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); }
					finally { bytes.fill(0); }
					if (native !== connection) return;
					const mac = await cryptoApi.subtle.sign("HMAC", key, new TextEncoder().encode(message.nonce));
					if (native !== connection) return;
					phase = "ready-wait";
					post(connection, { kind: "authenticate", mac: [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("") });
				} catch { if (native === connection) abort(connection); }
			} else if (message?.kind === "ready") {
				if (phase !== "ready-wait") { abort(connection); return; }
				phase = "ready";
				ready = true;
				delay = 250;
				for (const [id, request] of pending) {
					if (native !== connection) break;
					request.sent = connection;
					arm(id, request);
					post(connection, request.message);
				}
			} else if (phase === "ready" && message?.kind === "browser-backend-cancel") {
				const request = browserRequests.get(message.id);
				if (request?.connection === connection) { browserRequests.delete(message.id); request.controller.abort(); }
			} else if (phase === "ready" && message?.kind === "browser-backend-request") {
				if (typeof message.id !== "string" || !message.id || message.id.length > 200 || browserRequests.has(message.id) || browserRequests.size >= 16) { abort(connection); return; }
				const request = { connection, controller: new AbortController() };
				browserRequests.set(message.id, request);
				let response;
				try {
					if (!handleBrowserRequest) throw new Error("Native browser tools are unavailable.");
					response = { ok: true, result: await handleBrowserRequest(message.request, request.controller.signal) };
				} catch (error) { response = { ok: false, error: error instanceof Error ? error.message.slice(0, 500) : "Native browser request failed." }; }
				if (native === connection && browserRequests.get(message.id) === request) {
					browserRequests.delete(message.id);
					post(connection, { kind: "browser-backend-response", id: message.id, ...response });
				}
			} else if (phase === "ready" && message?.kind === "response") {
				const request = pending.get(message.id);
				if (!request || request.sent !== connection) return;
				clearTimeout(request.timeout);
				pending.delete(message.id);
				request.resolve(message.response);
			} else if (phase === "ready" && message?.kind === "event") emit(message.channel, message.event);
		});
		connection.onDisconnect.addListener(() => {
			void runtime.lastError; // Consume Chrome's error without logging payloads.
			disconnected(connection);
		});
	}
	connect();
	return {
		reconnect: connect,
		request(request) {
			if (pending.size >= 64) return Promise.resolve({ ok: false, error: "Kestrel is busy. Retry shortly." });
			return new Promise((resolve) => {
				const id = `native-${++sequence}`;
				const message = { kind: "request", id, request };
				const entry = { message, resolve, startedAt: Date.now(), sent: ready ? native : undefined };
				pending.set(id, entry);
				arm(id, entry, !ready);
				if (ready) post(native, message);
			});
		},
	};
}
