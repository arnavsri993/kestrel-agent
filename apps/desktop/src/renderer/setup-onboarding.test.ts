import { describe, expect, it } from "vitest";
import { canCompleteOnboarding, setupVerificationCopy } from "./setup-onboarding";

describe("canCompleteOnboarding", () => {
	it("allows explore-only completion when no model route is saved", () => {
		expect(canCompleteOnboarding(false, false)).toBe(true);
	});

	it("requires a live-verified route before finishing configured setup", () => {
		expect(canCompleteOnboarding(true, false)).toBe(false);
		expect(canCompleteOnboarding(true, true)).toBe(true);
	});
});

describe("setup verification copy", () => {
	it("describes a route check without claiming a model response", () => {
		expect(setupVerificationCopy(1)).toEqual({
			description: "A configured route check passed. Try one guided task now, or open Kestrel and explore.",
			label: "Model route checked",
			detail: "1 route check passed",
		});
		expect(setupVerificationCopy(2).detail).toBe("2 route checks passed");
	});

	it("reports a real response only for a verified local model", () => {
		expect(setupVerificationCopy(0, "example-model")).toEqual({
			description: "A local model returned a real response. Try one guided task now, or open Kestrel and explore.",
			label: "Local model verified",
			detail: "example-model returned a real response during setup",
		});
	});

	it("does not claim a response when no verification exists", () => {
		expect(setupVerificationCopy(0)).toEqual({
			description: "The route is saved but not live-verified yet.",
			label: "Model route",
			detail: "Configured; check it before live work",
		});
	});
});
