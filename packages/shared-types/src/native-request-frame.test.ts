import { describe, expect, it } from "vitest";
import { nativeRendererFrameFits } from "./native-request-frame";

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
});
