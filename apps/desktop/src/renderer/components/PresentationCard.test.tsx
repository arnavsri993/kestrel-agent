import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	parseUIPresentationMessage,
	PresentationCard,
} from "./PresentationCard";

const presentationMessage = {
	toolName: "ui.present",
	content: JSON.stringify({
		status: "verified",
		output: {
			presentation: {
				kind: "comparison",
				title: "Compare options",
				description: "A compact, source-backed comparison.",
				columns: [
					{ key: "one", label: "Option one" },
					{ key: "two", label: "Option two" },
				],
				rows: [{ label: "Availability", values: ["In stock", "Pre-order"] }],
				sources: [
					{ label: "Source", url: "https://example.test/options" },
				],
				id: "presentation-00000000-0000-4000-8000-000000000000",
				createdAt: "2026-09-02T12:00:00.000Z",
				trust: "local_bounded",
			},
		},
	}),
};

describe("PresentationCard", () => {
	it("only parses verified bounded ui.present envelopes", () => {
		const parsed = parseUIPresentationMessage(presentationMessage);
		expect(parsed).toMatchObject({
			kind: "comparison",
			title: "Compare options",
			trust: "local_bounded",
		});
		expect(
			parseUIPresentationMessage({
				...presentationMessage,
				content: presentationMessage.content.replace("verified", "failed"),
			}),
		).toBeUndefined();
		expect(
			parseUIPresentationMessage({
				...presentationMessage,
				toolName: "browser.snapshot",
			}),
		).toBeUndefined();
	});

	it("renders a semantic comparison table and labels external links as untrusted", () => {
		const parsed = parseUIPresentationMessage(presentationMessage);
		const markup = renderToStaticMarkup(<PresentationCard presentation={parsed!} />);

		expect(markup).toContain("Compare options");
		expect(markup).toContain('<table class="presentation-table">');
		expect(markup).toContain("Availability");
		expect(markup).toContain("external content is untrusted");
		expect(markup).toContain('title="https://example.test/options"');
		expect(markup).not.toContain("<a ");
	});
});
