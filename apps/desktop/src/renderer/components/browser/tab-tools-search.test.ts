import { describe, expect, it } from "vitest";
import { findTabToolMatches } from "./tab-tools-search";

describe("tab tools search", () => {
	it("matches titles and URLs without changing the original restore index", () => {
		const closedTabs = [
			{ title: "First", url: "https://first.example" },
			{ title: "Other", url: "https://mail.example/inbox" },
			{ title: "Mail settings", url: "https://settings.example" },
			{ title: "More mail", url: "https://more.example" },
		];

		expect(findTabToolMatches(closedTabs, " MAIL ", 2)).toEqual([
			{ entry: closedTabs[1], originalIndex: 1 },
			{ entry: closedTabs[2], originalIndex: 2 },
		]);
	});

	it("finds older closed tabs beyond the unfiltered eight-row preview", () => {
		const closedTabs = Array.from({ length: 10 }, (_, index) => ({
			title: index === 9 ? "Research notes" : `Tab ${index}`,
			url: `https://example.com/${index}`,
		}));

		expect(findTabToolMatches(closedTabs, "research", 8)).toEqual([
			{ entry: closedTabs[9], originalIndex: 9 },
		]);
	});
});
