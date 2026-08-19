import { describe, expect, it } from "vitest";
import { userBrowserRouteForRendererLink } from "./renderer-link-routing";

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
	target: "",
};

describe("userBrowserRouteForRendererLink", () => {
	it("routes ordinary http(s) links into an active persistent tab", () => {
		expect(userBrowserRouteForRendererLink(ordinaryClick, webLink)).toEqual({
			url: "https://example.com/path?q=1",
			active: true,
		});
		expect(
			userBrowserRouteForRendererLink(ordinaryClick, {
				...webLink,
				href: "http://localhost:3000/",
			}),
		).toEqual({ url: "http://localhost:3000/", active: true });
	});

	it("turns every web browsing-context target into a managed tab", () => {
		for (const target of ["_self", "_blank", "_parent", "_top", "provider-help"]) {
			expect(
				userBrowserRouteForRendererLink(ordinaryClick, {
					...webLink,
					target,
				}),
			).toEqual({ url: webLink.href, active: true });
		}
	});

	it("preserves foreground and background tab conventions", () => {
		for (const event of [
			{ ...ordinaryClick, button: 1 },
			{ ...ordinaryClick, metaKey: true },
			{ ...ordinaryClick, ctrlKey: true },
		]) {
			expect(userBrowserRouteForRendererLink(event, webLink)).toEqual({
				url: webLink.href,
				active: false,
			});
		}
		for (const event of [
			{ ...ordinaryClick, shiftKey: true },
			{ ...ordinaryClick, metaKey: true, shiftKey: true },
		]) {
			expect(userBrowserRouteForRendererLink(event, webLink)).toEqual({
				url: webLink.href,
				active: true,
			});
		}
	});

	it("keeps handled, alternate, and unsupported activations with their caller", () => {
		for (const event of [
			{ ...ordinaryClick, defaultPrevented: true },
			{ ...ordinaryClick, button: 2 },
			{ ...ordinaryClick, altKey: true },
		]) {
			expect(
				userBrowserRouteForRendererLink(event, webLink),
			).toBeUndefined();
		}
	});

	it("preserves download, explicit-external, and non-web link boundaries", () => {
		expect(
			userBrowserRouteForRendererLink(ordinaryClick, {
				...webLink,
				hasDownload: true,
			}),
		).toBeUndefined();
		expect(
			userBrowserRouteForRendererLink(ordinaryClick, {
				...webLink,
				openExternally: true,
			}),
		).toBeUndefined();
		for (const href of [
			"mailto:hello@example.com",
			"kestrel://settings",
			"file:///tmp/a",
		]) {
			expect(
				userBrowserRouteForRendererLink(ordinaryClick, { ...webLink, href }),
			).toBeUndefined();
		}
	});
});
