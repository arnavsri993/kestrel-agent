import { describe, expect, it } from "vitest";
import {
	clampKestrelSidebarWidth,
	KESTREL_SIDEBAR_MAX_WIDTH,
	KESTREL_SIDEBAR_MIN_WIDTH,
	KESTREL_SIDEBAR_DEFAULT_WIDTH,
	maxKestrelSidebarWidth,
} from "./kestrel-sidebar-layout";

describe("Kestrel navigation sidebar width", () => {
	it("keeps the resize range useful and bounded", () => {
		expect(clampKestrelSidebarWidth(40)).toBe(
			KESTREL_SIDEBAR_MIN_WIDTH,
		);
		expect(clampKestrelSidebarWidth(800)).toBe(
			KESTREL_SIDEBAR_MAX_WIDTH,
		);
		expect(maxKestrelSidebarWidth()).toBe(KESTREL_SIDEBAR_MAX_WIDTH);
	});

	it("keeps malformed stored widths safe", () => {
		expect(clampKestrelSidebarWidth(120)).toBe(
			KESTREL_SIDEBAR_MIN_WIDTH,
		);
		expect(clampKestrelSidebarWidth(Number.NaN)).toBe(
			KESTREL_SIDEBAR_DEFAULT_WIDTH,
		);
	});
});
