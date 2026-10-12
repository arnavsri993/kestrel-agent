import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UsageBattery } from "./NewTabWidgets";

describe("UsageBattery accessibility semantics", () => {
	it("exposes a numeric meter only when a usage value is available", () => {
		const markup = renderToStaticMarkup(
			<UsageBattery remainingPercent={42} label="5-hour" />,
		);

		expect(markup).toContain('role="meter"');
		expect(markup).toContain('aria-label="5-hour remaining"');
		expect(markup).toContain('aria-valuenow="42"');
	});

	it("announces unavailable usage as status without inventing a meter value", () => {
		const markup = renderToStaticMarkup(
			<UsageBattery remainingPercent={undefined} label="Unknown" />,
		);

		expect(markup).toContain('role="status"');
		expect(markup).toContain('aria-label="Unknown: unavailable"');
		expect(markup).not.toContain('role="meter"');
		expect(markup).not.toContain("aria-valuenow");
	});
});
