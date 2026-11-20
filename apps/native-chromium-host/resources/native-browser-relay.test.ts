import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserBackendWireRequestSchema } from "../../core-service/src/browser-backend-wire";
import { createNativeBrowserRelay } from "./native-browser-relay.mjs";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
function harness() {
	let owner: object | undefined = {};
	const send = vi.fn(), writeCore = vi.fn();
	const relay = createNativeBrowserRelay({ send, writeCore, currentOwner: () => owner,
		validate: (request: unknown) => BrowserBackendWireRequestSchema.safeParse(request) });
	return { relay, send, writeCore, owner: () => owner, setOwner: (next: object | undefined) => { owner = next; } };
}
it("validates Core requests and returns only the matching authenticated owner's response", () => {
	const { relay, send, writeCore, owner } = harness();
	relay.request({ requestId: "core-1", request: { operation: "visible-tabs" } });
	const message = send.mock.calls[0][1];
	relay.response({}, { id: message.id, ok: true, result: ["forged"] });
	expect(writeCore).not.toHaveBeenCalled();
	relay.response(owner(), { id: message.id, ok: true, result: [] });
	expect(writeCore).toHaveBeenCalledExactlyOnceWith({ type: "browser-backend-response", requestId: "core-1", ok: true, result: [] });
	relay.request({ requestId: "invalid", request: { operation: "visible-create", input: { malformed: true } } });
	expect(send).toHaveBeenCalledTimes(1);
	expect(writeCore.mock.calls.at(-1)?.[0].ok).toBe(false);
});
it("cancels, times out and disconnects without delivering old results to Core", async () => {
	const { relay, send, writeCore, owner, setOwner } = harness();
	const oldOwner = owner();
	relay.request({ requestId: "cancel", request: { operation: "visible-tabs" } });
	const cancelledId = send.mock.calls[0][1].id;
	relay.cancel("cancel");
	relay.response(oldOwner, { id: cancelledId, ok: true, result: ["late"] });
	expect(writeCore).not.toHaveBeenCalled();
	relay.request({ requestId: "timeout", request: { operation: "visible-tabs" } });
	await vi.advanceTimersByTimeAsync(30_000);
	expect(writeCore.mock.calls.at(-1)?.[0]).toMatchObject({ requestId: "timeout", ok: false });
	relay.request({ requestId: "lost", request: { operation: "visible-tabs" } });
	relay.disconnect(oldOwner);
	expect(writeCore.mock.calls.at(-1)?.[0]).toMatchObject({ requestId: "lost", ok: false });
	setOwner({});
	expect(send.mock.calls.filter(([, message]) => message.kind === "browser-backend-request")).toHaveLength(3);
});
it("bounds queued Core work and rejects requests without an authenticated owner", () => {
	const { relay, send, writeCore, setOwner } = harness();
	for (let i = 0; i < 17; ++i) relay.request({ requestId: `core-${i}`, request: { operation: "visible-tabs" } });
	expect(send).toHaveBeenCalledTimes(16);
	expect(writeCore.mock.calls.at(-1)?.[0]).toMatchObject({ requestId: "core-16", ok: false });
	setOwner(undefined);
	relay.request({ requestId: "absent", request: { operation: "visible-tabs" } });
	expect(send).toHaveBeenCalledTimes(16);
	expect(writeCore.mock.calls.at(-1)?.[0]).toMatchObject({ requestId: "absent", ok: false });
});
