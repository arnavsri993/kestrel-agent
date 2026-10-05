import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./index";

describe("Button action identity", () => {
	it("retains its action text while busy and prevents a second submission", () => {
		const markup = renderToStaticMarkup(<Button busy>Save changes</Button>);
		expect(markup).toContain('aria-busy="true"');
		expect(markup).toContain('disabled=""');
		expect(markup).toContain('class="ui-button-label">Save changes</span>');
		expect(markup).toContain('class="ui-spinner" aria-hidden="true"');
	});

	it("retains the same label wrapper after loading and respects explicit disabled state", () => {
		const markup = renderToStaticMarkup(<Button disabled>Save changes</Button>);
		expect(markup).toContain('class="ui-button-label">Save changes</span>');
		expect(markup).toContain('disabled=""');
		expect(markup).not.toContain("ui-spinner");
		expect(markup).not.toContain("aria-busy");
	});
});
