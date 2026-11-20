import { describe, expect, it, vi } from "vitest";
import { createNativeComputerRelay } from "../apps/native-chromium-host/resources/native-computer-relay.mjs";

describe("private native computer relay", () => {
	it("routes a bounded permission request and its response only between Core and the owner", () => {
		const writeCore = vi.fn(); const writeOwner = vi.fn(() => true);
		const relay = createNativeComputerRelay({ writeCore, writeOwner });
		expect(relay.request({ type: "native-computer-request", requestId: "native-computer-1", request: { operation: "native-computer-permissions" } })).toBe(true);
		expect(writeOwner).toHaveBeenCalledWith({ kind: "native-computer-request", id: "native-computer-1", request: { operation: "native-computer-permissions" } });
		expect(relay.response({ kind: "native-computer-response", id: "native-computer-1", ok: true, result: { screenRecording: "not-determined", accessibility: "not-granted" } })).toBe(true);
		expect(writeCore).toHaveBeenCalledWith({ type: "native-computer-response", requestId: "native-computer-1", ok: true, result: { screenRecording: "not-determined", accessibility: "not-granted" } });
		expect(relay.pendingCount).toBe(0);
	});

	it("rejects arbitrary operations and propagates cancellation without using browser wire", () => {
		const writeCore = vi.fn(); const writeOwner = vi.fn(() => true);
		const relay = createNativeComputerRelay({ writeCore, writeOwner });
		expect(relay.request({ requestId: "native-computer-1", request: { operation: "visible-navigate", input: "https://example.com" } })).toBe(false);
		expect(writeOwner).not.toHaveBeenCalled();
		expect(relay.request({ requestId: "native-computer-2", request: { operation: "native-computer-capture" } })).toBe(true);
		expect(relay.cancel({ requestId: "native-computer-2" })).toBe(true);
		expect(writeOwner).toHaveBeenLastCalledWith({ kind: "native-computer-cancel", id: "native-computer-2" });
	});
});
