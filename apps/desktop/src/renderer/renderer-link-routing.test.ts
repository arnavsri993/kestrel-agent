import { describe, expect, it } from "vitest";
import { userBrowserUrlForRendererLink } from "./renderer-link-routing";

const ordinaryClick = {
	defaultPrevented: false,
	button: 0,
	metaKey: false,
	ctrlKey: false,
	shiftKey: false,
	altKey: false,
};

const webLink = {
	href: "https://example.com/path?q=1",
	hasDownload: false,
	openExternally: false,
};

describe("userBrowserUrlForRendererLink", () => {
	it("routes an ordinary http(s) link into the persistent user browser", () => {
		expect(userBrowserUrlForRendererLink(ordinaryClick, webLink)).toBe(
			"https://example.com/path?q=1",
		);
		expect(
			userBrowserUrlForRendererLink(ordinaryClick, {
				...webLink,
				href: "http://localhost:3000/",
			}),
		).toBe("http://localhost:3000/");
	});

	it("keeps handled, modified, and non-primary activations with their caller", () => {
		for (const event of [
			{ ...ordinaryClick, defaultPrevented: true },
			{ ...ordinaryClick, button: 1 },
			{ ...ordinaryClick, metaKey: true },
			{ ...ordinaryClick, ctrlKey: true },
			{ ...ordinaryClick, shiftKey: true },
			{ ...ordinaryClick, altKey: true },
		]) {
			expect(userBrowserUrlForRendererLink(event, webLink)).toBeUndefined();
		}
	});

	it("preserves download, explicit-external, and non-web link boundaries", () => {
		expect(
			userBrowserUrlForRendererLink(ordinaryClick, {
				...webLink,
				hasDownload: true,
			}),
		).toBeUndefined();
		expect(
			userBrowserUrlForRendererLink(ordinaryClick, {
				...webLink,
				openExternally: true,
			}),
		).toBeUndefined();
		for (const href of ["mailto:hello@example.com", "kestrel://settings", "file:///tmp/a"]) {
			expect(
				userBrowserUrlForRendererLink(ordinaryClick, { ...webLink, href }),
			).toBeUndefined();
		}
	});
});
