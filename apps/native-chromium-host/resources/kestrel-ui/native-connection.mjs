// Sent actions fail when their connection closes. They are never replayed.
export function createNativeConnection({ runtime, emit = () => {}, cryptoApi = crypto,
	loadConfiguration = async (nonce) => {
		const response = await fetch(runtime.getURL("launch-config.json") + "?challenge=" + nonce, { cache: "no-store", redirect: "error" });
		if (!response.ok) throw new Error("Native launch configuration is unavailable.");
		return response.json();
	},
}) {
	const pending = new Map();
	let native, retry;
	let ready = false, sequence = 0, delay = 250;
	function disconnected(connection) {
		if (native !== connection) return;
		native = undefined;
		ready = false;
		for (const request of pending.values()) {
			clearTimeout(request.timeout);
			request.resolve({ ok: false, error: "Kestrel's native connection closed. Retry the request." });
		}
		pending.clear();
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
				for (const request of pending.values()) {
					if (native !== connection) break;
					request.sent = connection;
					post(connection, request.message);
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
				const timeout = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: "Kestrel's native request timed out." }); }, 42_000);
				pending.set(id, { message, resolve, timeout, sent: ready ? native : undefined });
				if (ready) post(native, message);
			});
		},
	};
}
