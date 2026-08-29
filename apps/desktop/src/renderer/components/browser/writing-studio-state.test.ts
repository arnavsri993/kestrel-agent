import { describe, expect, it } from "vitest";
import { writingProfilePanelPhase } from "./writing-studio-state";

describe("writingProfilePanelPhase", () => {
	it("shows loading only while the profile request is in flight", () => {
		expect(writingProfilePanelPhase(false, true)).toBe("loading");
	});

	it("shows ready once profile data is available", () => {
		expect(writingProfilePanelPhase(true, true)).toBe("ready");
		expect(writingProfilePanelPhase(true, false)).toBe("ready");
	});

	it("does not keep loading after a failed profile fetch", () => {
		expect(writingProfilePanelPhase(false, false)).toBe("unavailable");
	});
});
