import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import type { RendererBridge, RendererTransport } from "@kestrel/shared-types";
import { installNativeRendererBridge } from "../desktop/src/renderer/install-renderer-bridge";

function nativeFixture() {
	const source = readFileSync(new URL("./src/kestrel_chromium_app.cc", import.meta.url), "utf8");
	const script = source.match(/kKestrelBridgeSource\[\] = R"JS\(([\s\S]*?)\)JS";/)![1]!;
	const queries: { request: string; persistent: boolean; onSuccess(response: string): void; onFailure(code: number, message: string): void }[] = [];
	const cancel = vi.fn();
	const host = {
		__kestrelNativeQuery: vi.fn((query) => { queries.push(query); return queries.length; }),
		__kestrelNativeCancel: cancel,
	} as unknown as { __kestrelHostTransport?: RendererTransport; kestrel?: RendererBridge };
	runInNewContext(script, host);
	installNativeRendererBridge(host);
	return { host, bridge: host.kestrel!, queries, cancel };
}

describe("native renderer bridge", () => {
	it("keeps every shared event subscription aligned with CEF's allowlist", () => {
		const { bridge, queries } = nativeFixture();
		const callback = vi.fn();
		const disposals = Object.entries(bridge)
			.filter(([name]) => name !== "request")
			.map(([, subscribe]) => subscribe(callback));
		const source = readFileSync(new URL("./src/kestrel_native_host.mm", import.meta.url), "utf8");
		const allowlist = source.match(/static bool is_allowed_channel[\s\S]*?\n  }/)![0];
		const channels = [...allowlist.matchAll(/channel == "([^"]+)"/g)].map((match) => match[1]).sort();
		expect(queries.map((query) => JSON.parse(query.request).channel).sort()).toEqual(channels);
		for (const query of queries) query.onSuccess('"not-an-event"');
		expect(callback).not.toHaveBeenCalled();
		for (const dispose of disposals) dispose();
	});

	it("uses the actual CEF transport with shared request/event validation", async () => {
		const { host, bridge, queries, cancel } = nativeFixture();
		expect(host.__kestrelHostTransport).toBeUndefined();
		expect((host as any).__kestrelNativeQuery).toBeUndefined();
		expect(Object.getOwnPropertyDescriptor(host, "kestrel")).toMatchObject({ writable: false, configurable: false });
		expect(() => bridge.request({ type: "native-host-status" } as never)).toThrow();
		expect(queries).toHaveLength(0);
		const response = bridge.request({ type: "snapshot" });
		expect(JSON.parse(queries[0]!.request)).toEqual({ kind: "request", request: { type: "snapshot" } });
		queries[0]!.onSuccess('{"ok":true}');
		await expect(response).resolves.toEqual({ ok: true });
		const callback = vi.fn();
		const dispose = bridge.onAgentStream(callback);
		expect(JSON.parse(queries[1]!.request)).toEqual({ kind: "subscribe", channel: "agent-stream" });
		expect(queries[1]!.persistent).toBe(true);
		queries[1]!.onSuccess("invalid JSON");
		queries[1]!.onSuccess('{"delta":2}');
		expect(callback).not.toHaveBeenCalled();
		queries[1]!.onSuccess('{"streamId":"s","sessionId":"c","delta":"hello"}');
		expect(callback).toHaveBeenCalledExactlyOnceWith({ streamId: "s", sessionId: "c", delta: "hello" });
		dispose();
		dispose();
		queries[1]!.onSuccess('{"streamId":"s","sessionId":"c","delta":"late"}');
		expect(cancel).toHaveBeenCalledExactlyOnceWith(2);
		expect(callback).toHaveBeenCalledOnce();
	});

	it("rejects malformed JSON responses and host errors", async () => {
		const { bridge, queries } = nativeFixture();
		const invalid = bridge.request({ type: "snapshot" });
		queries[0]!.onSuccess("invalid JSON");
		await expect(invalid).rejects.toThrow("invalid JSON");
		const failed = bridge.request({ type: "snapshot" });
		queries[1]!.onFailure(1, "host unavailable");
		await expect(failed).rejects.toThrow("host unavailable");
	});

	it("leaves the Electron bridge in place and rejects conflicting transports", () => {
		const bridge = {} as RendererBridge;
		const host = { kestrel: bridge };
		installNativeRendererBridge(host);
		expect(host.kestrel).toBe(bridge);
		expect(() => installNativeRendererBridge({ ...host, __kestrelHostTransport: {} as RendererTransport })).toThrow("conflicting");
	});
});
