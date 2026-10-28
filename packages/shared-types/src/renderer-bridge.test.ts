import { describe, expect, it, vi } from "vitest";
import {
	createRendererBridge,
	type RendererEventChannel,
	type RendererTransport,
} from "./renderer-bridge";

function fixture() {
	const listeners = new Map<RendererEventChannel, (value: unknown) => void>();
	const cleanup = vi.fn();
	const transport: RendererTransport = {
		request: vi.fn(async () => ({ ok: true as const })),
		subscribe: vi.fn((channel, callback) => {
			listeners.set(channel, callback);
			return cleanup;
		}),
		notify: vi.fn(),
	};
	return { transport, listeners, cleanup, bridge: createRendererBridge(transport) };
}

describe("portable renderer bridge", () => {
	it("rejects unsupported requests before they cross the host transport", async () => {
		const { bridge, transport } = fixture();
		expect(() => bridge.request({ type: "arbitrary-host-command" } as never)).toThrow();
		expect(transport.request).not.toHaveBeenCalled();
		await expect(bridge.request({ type: "snapshot" })).resolves.toEqual({ ok: true });
		expect(transport.request).toHaveBeenCalledWith({ type: "snapshot" });
	});

	it("drops malformed events and prevents queued callbacks after disposal", () => {
		const { bridge, listeners, cleanup } = fixture();
		const callback = vi.fn();
		const dispose = bridge.onAgentStream(callback);
		const emit = listeners.get("agent-stream")!;
		emit({ streamId: "stream", delta: 1 });
		expect(callback).not.toHaveBeenCalled();
		const event = { streamId: "stream", sessionId: "session", delta: "hello" };
		emit(event);
		expect(callback).toHaveBeenCalledExactlyOnceWith(event);
		dispose();
		dispose();
		emit(event);
		expect(cleanup).toHaveBeenCalledOnce();
		expect(callback).toHaveBeenCalledOnce();
	});

	it("preserves nullable autofill prompts and validates both prompt channels", () => {
		const { bridge, listeners } = fixture();
		const password = vi.fn();
		const payment = vi.fn();
		bridge.onPasswordPrompt(password);
		bridge.onPaymentPrompt(payment);
		listeners.get("password-prompt")!(null);
		listeners.get("payment-prompt")!(null);
		listeners.get("password-prompt")!({ password: "invalid" });
		listeners.get("payment-prompt")!({ card: "invalid" });
		expect(password).toHaveBeenCalledExactlyOnceWith(null);
		expect(payment).toHaveBeenCalledExactlyOnceWith(null);
	});

	it("registers focus and deep-link listeners before announcing readiness", () => {
		const { bridge, transport } = fixture();
		const focus = bridge.onWindowFocus(vi.fn());
		const link = bridge.onDeepLink(vi.fn());
		bridge.onExternalIntake(vi.fn());
		expect(vi.mocked(transport.notify!).mock.calls).toEqual([
			["window-focus-ready"], ["deep-link-ready"], ["external-intake-ready"],
		]);
		expect(vi.mocked(transport.subscribe).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(transport.notify!).mock.invocationCallOrder[0]!,
		);
		focus();
		link();
		link();
		expect(transport.notify).toHaveBeenLastCalledWith("deep-link-not-ready");
		expect(transport.notify).toHaveBeenCalledTimes(4);
	});

	it("works without Electron readiness signals and freezes the public API", () => {
		const { transport, listeners } = fixture();
		delete transport.notify;
		const bridge = createRendererBridge(transport);
		const callback = vi.fn();
		bridge.onWindowFocus(callback);
		listeners.get("window-focus")!(true);
		listeners.get("window-focus")!({ focused: true });
		expect(callback).toHaveBeenCalledExactlyOnceWith(true);
		expect(Object.isFrozen(bridge)).toBe(true);
	});

	it("removes a subscription if the host rejects readiness", () => {
		const { bridge, transport, listeners, cleanup } = fixture();
		vi.mocked(transport.notify!).mockImplementation(() => { throw new Error("host closed"); });
		const callback = vi.fn();
		expect(() => bridge.onWindowFocus(callback)).toThrow("host closed");
		listeners.get("window-focus")!(true);
		expect(cleanup).toHaveBeenCalledOnce();
		expect(callback).not.toHaveBeenCalled();
	});
});
