import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativeLoginCodeBrowserRequestSchema, parseNativeLoginCodeResult } from "../../../packages/shared-types/src/native-login-code";
import { RendererRequestSchema } from "../../../packages/shared-types/src/contracts";
import { BrowserBackendWireRequestSchema } from "../../core-service/src/browser-backend-wire";
import { createNativeLoginCodeRelay } from "./native-login-code-relay.mjs";

const tabId = "tab-12345678-1234-1234-1234-123456789abc";
const authority = { tabId, chromeTabId: 2, windowId: 3, documentId: "document-1", origin: "https://example.com", fieldId: "12345678-1234-4234-9234-123456789abc" };
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
function harness() {
	let owner: object | undefined = {};
	const send = vi.fn(), writeCore = vi.fn();
	const relay = createNativeLoginCodeRelay({ send, writeCore, currentOwner: () => owner,
		validate: (value: unknown) => NativeLoginCodeBrowserRequestSchema.safeParse(value), validateResult: parseNativeLoginCodeResult });
	return { relay, send, writeCore, owner: () => owner, loseOwner: () => { owner = undefined; } };
}
it("keeps private code operations out of renderer and generic automation protocols", () => {
	for (const request of [{ operation: "inspect", tabId }, { operation: "validate", authority }, { operation: "fill", authority, code: "123456" }]) {
		expect(NativeLoginCodeBrowserRequestSchema.safeParse(request).success).toBe(true);
		expect(RendererRequestSchema.safeParse(request).success).toBe(false);
		expect(BrowserBackendWireRequestSchema.safeParse(request).success).toBe(false);
	}
	expect(NativeLoginCodeBrowserRequestSchema.safeParse({ operation: "fill", authority: { ...authority, origin: "https://user:pass@example.com" }, code: "123456" }).success).toBe(false);
});
it("accepts only the owning authenticated worker and the operation's strict result", () => {
	const { relay, send, writeCore, owner } = harness();
	relay.request({ requestId: "native-login-code-1", request: { operation: "inspect", tabId } });
	const id = send.mock.calls[0][1].id;
	relay.response({}, { id, ok: true, result: authority });
	expect(writeCore).not.toHaveBeenCalled();
	relay.response(owner(), { id, ok: true, result: authority });
	expect(writeCore).toHaveBeenLastCalledWith({ type: "native-login-code-response", requestId: "native-login-code-1", ok: true, result: authority });
	relay.request({ requestId: "native-login-code-2", request: { operation: "fill", authority, code: "123456" } });
	relay.response(owner(), { id: send.mock.calls.at(-1)![1].id, ok: true, result: { filled: true, leakedCode: "123456" } });
	expect(writeCore.mock.calls.at(-1)![0]).toMatchObject({ ok: false });
	expect(JSON.stringify(writeCore.mock.calls.at(-1))).not.toContain("123456");
});
it("drops cancelled, timed out and disconnected results without replay or upstream error disclosure", async () => {
	const { relay, send, writeCore, owner } = harness();
	relay.request({ requestId: "native-login-code-1", request: { operation: "validate", authority } });
	const firstId = send.mock.calls[0][1].id;
	relay.cancel("native-login-code-1");
	relay.response(owner(), { id: firstId, ok: true, result: { valid: true } });
	expect(writeCore).not.toHaveBeenCalled();
	relay.request({ requestId: "native-login-code-2", request: { operation: "validate", authority } });
	await vi.advanceTimersByTimeAsync(15_000);
	expect(writeCore.mock.calls.at(-1)![0]).toMatchObject({ requestId: "native-login-code-2", ok: false });
	relay.request({ requestId: "native-login-code-3", request: { operation: "fill", authority, code: "123456" } });
	relay.response(owner(), { id: send.mock.calls.at(-1)![1].id, ok: false, error: "123456 message body" });
	expect(JSON.stringify(writeCore.mock.calls)).not.toContain("123456");
	relay.request({ requestId: "native-login-code-4", request: { operation: "validate", authority } });
	relay.disconnect(owner());
	expect(writeCore.mock.calls.at(-1)![0]).toMatchObject({ requestId: "native-login-code-4", ok: false });
});
