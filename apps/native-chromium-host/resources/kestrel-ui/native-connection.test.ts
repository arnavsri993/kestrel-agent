import { createHmac, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNativeConnection } from "./native-connection.mjs";

const nonce = "a".repeat(64);
const secret = Buffer.alloc(32, 7);
const configuration = { version: 1, browserPid: 77, key: secret.toString("base64") };
const challenge = { kind: "challenge", nonce, browserPid: 77 };
function event() {
	const listeners: ((message?: any) => any)[] = [];
	return { addListener: (listener: (message?: any) => any) => listeners.push(listener),
		emit: async (message?: any) => { for (const listener of listeners) await listener(message); } };
}
function harness(options: Record<string, any> = {}) {
	const ports: any[] = [];
	const runtime = { connectNative: vi.fn(() => {
		const port = { onMessage: event(), onDisconnect: event(), postMessage: vi.fn(), disconnect: vi.fn() };
		port.disconnect.mockImplementation(() => { void port.onDisconnect.emit(); });
		ports.push(port);
		return port;
	}) };
	const emit = vi.fn();
	const connection = createNativeConnection({ runtime, emit, cryptoApi: webcrypto,
		loadConfiguration: async () => configuration, ...options });
	async function authenticate(port = ports.at(-1)) {
		await port.onMessage.emit(challenge);
		expect(port.postMessage).toHaveBeenCalledWith({ kind: "authenticate", mac: createHmac("sha256", secret).update(nonce).digest("hex") });
		await port.onMessage.emit({ kind: "ready" });
	}
	return { connection, ports, authenticate, emit };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
describe("native worker connection", () => {
	it("holds requests until authentication and accepts only current responses", async () => {
		const { connection, ports, authenticate, emit } = harness();
		const response = connection.request({ type: "snapshot" });
		expect(ports[0].postMessage).not.toHaveBeenCalled();
		await ports[0].onMessage.emit({ kind: "event", channel: "core-event", event: "untrusted" });
		expect(emit).not.toHaveBeenCalled();
		await authenticate();
		const sent = ports[0].postMessage.mock.calls.at(-1)[0];
		expect(sent.request).toEqual({ type: "snapshot" });
		await ports[0].onMessage.emit({ kind: "response", id: sent.id, response: { ok: true } });
		expect(await response).toEqual({ ok: true });
	});

	it.each(["configuration", "signature"])("ignores an old delayed %s after reconnecting", async (stage) => {
		let release!: (value: any) => void;
		const held = new Promise((resolve) => { release = resolve; });
		let calls = 0;
		const options = stage === "configuration"
			? { loadConfiguration: () => ++calls === 1 ? held : Promise.resolve(configuration) }
			: { cryptoApi: { subtle: {
				importKey: (...args: any[]) => (webcrypto.subtle.importKey as any)(...args),
				sign: (...args: any[]) => ++calls === 1 ? held : (webcrypto.subtle.sign as any)(...args),
			} } };
		const { connection, ports, authenticate } = harness(options);
		const oldChallenge = ports[0].onMessage.emit(challenge);
		// Let actual WebCrypto reach the held sign operation when testing it.
		if (stage === "signature") await vi.waitFor(() => expect(calls).toBe(1));
		ports[0].disconnect();
		await vi.advanceTimersByTimeAsync(250);
		await authenticate(ports[1]);
		const result = connection.request({ type: "runtime-cancel-session", sessionId: "session-canary" });
		release(stage === "configuration" ? configuration : new Uint8Array(32).buffer);
		await oldChallenge;
		await ports[0].onMessage.emit({ kind: "ready" });
		await ports[0].onDisconnect.emit();
		expect(ports[0].postMessage).not.toHaveBeenCalled();
		expect(ports[1].disconnect).not.toHaveBeenCalled();
		const sent = ports[1].postMessage.mock.calls.at(-1)[0];
		await ports[1].onMessage.emit({ kind: "response", id: sent.id, response: { ok: true } });
		expect(await result).toEqual({ ok: true });
	});

	it("fails sent actions without replay when the native host disconnects", async () => {
		const { connection, ports, authenticate } = harness();
		await authenticate();
		const result = connection.request({ type: "runtime-cancel-session", sessionId: "session-canary" });
		ports[0].disconnect();
		expect((await result).ok).toBe(false);
		await vi.advanceTimersByTimeAsync(250);
		await authenticate(ports[1]);
		expect(ports[1].postMessage.mock.calls.map(([message]: any[]) => message.kind)).toEqual(["authenticate"]);
	});

	it("keeps a dispatched agent request alive beyond the old 42-second transport deadline", async () => {
		const { connection, ports, authenticate } = harness();
		await authenticate();
		const settled = vi.fn();
		const response = connection.request({ type: "runtime-run-agent", sessionId: "session-long", streamId: "stream-long" }).then((result: unknown) => { settled(result); return result; });
		const sent = ports[0].postMessage.mock.calls.at(-1)[0];
		await vi.advanceTimersByTimeAsync(90_000);
		expect(settled).not.toHaveBeenCalled();
		await ports[0].onMessage.emit({ kind: "response", id: sent.id, response: { ok: true } });
		expect(await response).toEqual({ ok: true });
		expect(ports[0].postMessage.mock.calls.filter(([message]: any[]) => message.kind === "request")).toHaveLength(1);
	});

	it("bounds connection setup separately and allows a queued agent request to finish after authentication", async () => {
		const { connection, ports, authenticate } = harness();
		const settled = vi.fn();
		const response = connection.request({ type: "runtime-call-tool", sessionId: "session-long", toolName: "browser.tabs", input: {} }).then((result: unknown) => { settled(result); return result; });
		await vi.advanceTimersByTimeAsync(40_000);
		await authenticate();
		const sent = ports[0].postMessage.mock.calls.at(-1)[0];
		await vi.advanceTimersByTimeAsync(60_000);
		expect(settled).not.toHaveBeenCalled();
		await ports[0].onMessage.emit({ kind: "response", id: sent.id, response: { ok: true } });
		expect(await response).toEqual({ ok: true });
	});

	it("fails a synchronous send error and rejects ready before authentication", async () => {
		const { connection, ports, authenticate } = harness();
		await authenticate();
		ports[0].postMessage.mockImplementation(() => { throw new Error("Port closed"); });
		expect((await connection.request({ type: "snapshot" })).ok).toBe(false);
		await vi.advanceTimersByTimeAsync(250);
		const waiting = connection.request({ type: "snapshot" });
		await ports[1].onMessage.emit({ kind: "ready" });
		expect((await waiting).ok).toBe(false);
		expect(ports[1].postMessage).not.toHaveBeenCalled();
	});

	it("bounds pending requests and frees timed out slots", async () => {
		const { connection } = harness();
		const requests = Array.from({ length: 64 }, () => connection.request({ type: "snapshot" }));
		expect((await connection.request({ type: "snapshot" })).error).toMatch(/busy/);
		await vi.advanceTimersByTimeAsync(42_000);
		expect((await Promise.all(requests)).every((result) => !result.ok && /timed out/.test(result.error))).toBe(true);
	});

	it("accepts Core browser requests only after native authentication", async () => {
		const handleBrowserRequest = vi.fn(async () => ({ tabId: "canary" }));
		const { ports, authenticate } = harness({ handleBrowserRequest });
		const request = { kind: "browser-backend-request", id: "core-1", request: { operation: "visible-create" } };
		await ports[0].onMessage.emit(request);
		expect(handleBrowserRequest).not.toHaveBeenCalled();
		await authenticate();
		await ports[0].onMessage.emit(request);
		expect(ports[0].postMessage).toHaveBeenLastCalledWith({ kind: "browser-backend-response", id: "core-1", ok: true, result: { tabId: "canary" } });
	});

	it.each(["cancel", "disconnect"])("aborts Core work on %s without replay or a stale response", async (reason) => {
		let finish!: (value: any) => void;
		let signal!: AbortSignal;
		const handleBrowserRequest = vi.fn((_request: unknown, inputSignal: AbortSignal) => {
			signal = inputSignal;
			return new Promise((resolve) => { finish = resolve; });
		});
		const { ports, authenticate } = harness({ handleBrowserRequest });
		await authenticate();
		const work = ports[0].onMessage.emit({ kind: "browser-backend-request", id: "core-1", request: { operation: "visible-create" } });
		if (reason === "cancel") await ports[0].onMessage.emit({ kind: "browser-backend-cancel", id: "core-1" });
		else { ports[0].disconnect(); await vi.advanceTimersByTimeAsync(250); await authenticate(ports[1]); }
		expect(signal.aborted).toBe(true);
		finish({ tabId: "late" });
		await work;
		expect(handleBrowserRequest).toHaveBeenCalledTimes(1);
		for (const port of ports) expect(port.postMessage.mock.calls.map(([message]: any[]) => message.kind)).toEqual(["authenticate"]);
	});
});
