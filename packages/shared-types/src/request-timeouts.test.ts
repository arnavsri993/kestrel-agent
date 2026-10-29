import { describe, expect, it } from "vitest";
import { coreRequestTimeoutMs, nativeRequestTimeoutMs } from "./request-timeouts";

describe("shared request execution and native transport deadlines", () => {
	it("retains Core's bounded agent and transcription budgets", () => {
		for (const type of ["runtime-run-agent", "runtime-resume-agent", "runtime-retry-agent", "runtime-call-tool", "orchestration-delegate", "writing-generate", "pet-install", "pet-hatch-drafts", "pet-hatch-complete"])
			expect(coreRequestTimeoutMs({ type })).toBe(1_800_000);
		expect(coreRequestTimeoutMs({ type: "media-transcribe" })).toBe(125_000);
		expect(coreRequestTimeoutMs({ type: "snapshot" })).toBe(30_000);
	});
	it("leaves room for bounded connection setup and Core's cancellation response", () => {
		for (const type of ["snapshot", "runtime-run-agent", "media-transcribe", "oauth-chatgpt-connect"]) {
			const request = { type };
			const broker = nativeRequestTimeoutMs(request, "broker");
			const worker = nativeRequestTimeoutMs(request, "worker");
			const renderer = nativeRequestTimeoutMs(request, "renderer");
			expect(worker).toBeGreaterThan(broker + 42_000);
			expect(renderer).toBeGreaterThan(worker);
			expect(broker).toBeGreaterThan(coreRequestTimeoutMs(request));
			expect(renderer).toBeLessThan(32 * 60_000);
		}
	});
});
