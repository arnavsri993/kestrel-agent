import { describe, expect, it } from "vitest";
import { nativeRendererFrameFits } from "./native-request-frame";
import { NativeHistoryTransferSchema } from "./contracts";

describe("native renderer frame boundaries", () => {
	it("permits a full-size Home image only on the worker-local settings route", () => {
		const serialized = JSON.stringify({ kind: "request", id: 1, request: { type: "browser-update-settings", settings: { newTabBackgroundCustomDataUrl: "data:image/png;base64," + "A".repeat(7_000_000 - 32) } } });
		expect(nativeRendererFrameFits(serialized, "browser-update-settings")).toBe(true);
		expect(nativeRendererFrameFits(serialized, "browser-plan-home-settings-import")).toBe(true);
		expect(nativeRendererFrameFits(serialized, "browser-apply-home-settings-import")).toBe(false);
		expect(nativeRendererFrameFits(serialized, "runtime-run-agent")).toBe(false);
		expect(nativeRendererFrameFits(serialized, "unrecognized-local-route")).toBe(false);
		expect(nativeRendererFrameFits("a".repeat(8 * 1024 * 1024 + 1), "browser-update-settings")).toBe(false);
	});
	it("counts UTF-8 and JSON expansion before native/Core dispatch", () => {
		expect(nativeRendererFrameFits("😀".repeat(260_000), "runtime-run-agent")).toBe(false);
		expect(nativeRendererFrameFits(JSON.stringify("\u0001".repeat(250_000)), "create-pasted-text-attachment")).toBe(false);
		expect(nativeRendererFrameFits(JSON.stringify("hello".repeat(1000)), "create-pasted-text-attachment")).toBe(true);
	});
	it("carries a schema-valid near-limit history review only to its worker-local route", () => {
		const data = NativeHistoryTransferSchema.parse({ format: "kestrel-history", version: 1,
			entries: Array.from({ length: 1500 }, (_, index) => ({ url: `https://history.generated.invalid/${index}`, title: "a".repeat(500), visitedAt: "2020-01-01T00:00:00.000Z" })) });
		const serialized = JSON.stringify({ kind: "request", id: 1, request: { type: "browser-plan-history-import", data } });
		expect(serialized.length).toBeGreaterThan(768 * 1024);
		expect(nativeRendererFrameFits(serialized, "browser-plan-history-import")).toBe(true);
		for (const type of ["browser-apply-history-import", "runtime-run-agent", "create-pasted-text-attachment", "unrecognized-local-route"])
			expect(nativeRendererFrameFits(serialized, type)).toBe(false);
		expect(nativeRendererFrameFits("😀".repeat(524_289), "browser-plan-history-import")).toBe(false);
	});
});
