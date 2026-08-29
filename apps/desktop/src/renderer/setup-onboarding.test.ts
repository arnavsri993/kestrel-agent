import { describe, expect, it } from "vitest";
import { canCompleteOnboarding } from "./setup-onboarding";

describe("canCompleteOnboarding", () => {
	it("allows explore-only completion when no model route is saved", () => {
		expect(canCompleteOnboarding(false, false)).toBe(true);
	});

	it("requires a live-verified route before finishing configured setup", () => {
		expect(canCompleteOnboarding(true, false)).toBe(false);
		expect(canCompleteOnboarding(true, true)).toBe(true);
	});
});
