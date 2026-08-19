import { describe, expect, it } from "vitest";
import {
	clampTabWidth,
	computeLockedTabStyle,
	shouldRetainTabWidthOnClose,
} from "./tab-strip-layout";

describe("tab strip layout and cursor anchoring", () => {
	it("retains tab width on close only for horizontal tabs with remaining tabs", () => {
		expect(shouldRetainTabWidthOnClose("horizontal", 5)).toBe(true);
		expect(shouldRetainTabWidthOnClose("horizontal", 2)).toBe(true);
		expect(shouldRetainTabWidthOnClose("horizontal", 1)).toBe(false);
		expect(shouldRetainTabWidthOnClose("vertical", 5)).toBe(false);
	});

	it("clamps tab width to valid min/max bounds", () => {
		expect(clampTabWidth(180)).toBe(180);
		expect(clampTabWidth(20)).toBe(112);
		expect(clampTabWidth(400)).toBe(280);
		expect(clampTabWidth(NaN)).toBe(280);
	});

	it("computes fixed style when locked for horizontal tabs and returns undefined otherwise", () => {
		expect(computeLockedTabStyle(150, "horizontal")).toEqual({
			flex: "0 0 auto",
			width: "150px",
			maxWidth: "150px",
		});

		expect(computeLockedTabStyle(null, "horizontal")).toBeUndefined();
		expect(computeLockedTabStyle(150, "vertical")).toBeUndefined();
	});
});
