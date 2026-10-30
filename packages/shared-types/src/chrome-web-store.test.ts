import { describe, expect, it } from "vitest";
import {
	isChromeWebStoreUrl,
	parseChromeWebStoreExtensionId,
	parseChromeWebStoreListingUrl,
} from "./chrome-web-store";

const EXTENSION_ID = "fmkadmapgofadopljbjfkapdkoienihi";

describe("Chrome Web Store URL parsing", () => {
	it("matches the exact official origin without lookalikes or embedded credentials", () => {
		expect(isChromeWebStoreUrl("https://chromewebstore.google.com/")).toBe(true);
		expect(isChromeWebStoreUrl("https://chromewebstore.google.com/category/extensions")).toBe(true);
		for (const url of ["https://chromewebstore.google.com.evil.example/", "https://chromewebstore.google.com@evil.example/", "https://user@chromewebstore.google.com/", "http://chromewebstore.google.com/", "https://chromewebstore.google.com:8443/", "invalid"]) {
			expect(isChromeWebStoreUrl(url)).toBe(false);
		}
	});
	it("accepts current listing URLs and exact extension IDs", () => {
		expect(parseChromeWebStoreExtensionId(EXTENSION_ID.toUpperCase())).toBe(
			EXTENSION_ID,
		);
		expect(
			parseChromeWebStoreListingUrl(
				`https://chromewebstore.google.com/detail/react-developer-tools/${EXTENSION_ID}?hl=en`,
			),
		).toBe(EXTENSION_ID);
		expect(
			parseChromeWebStoreExtensionId(
				`https://chromewebstore.google.com/detail/${EXTENSION_ID}`,
			),
		).toBe(EXTENSION_ID);
	});

	it("accepts legacy official listing URLs", () => {
		expect(
			parseChromeWebStoreExtensionId(
				`https://chrome.google.com/webstore/detail/react-developer-tools/${EXTENSION_ID}`,
			),
		).toBe(EXTENSION_ID);
	});

	it("rejects lookalike hosts, credentials, non-listing paths, and embedded IDs", () => {
		for (const input of [
			`https://example.com/detail/tool/${EXTENSION_ID}`,
			`https://chromewebstore.google.com.evil.example/detail/tool/${EXTENSION_ID}`,
			`https://user@chromewebstore.google.com/detail/tool/${EXTENSION_ID}`,
			`http://chromewebstore.google.com/detail/tool/${EXTENSION_ID}`,
			`https://chromewebstore.google.com/category/extensions?item=${EXTENSION_ID}`,
			`prefix-${EXTENSION_ID}-suffix`,
			`https://chromewebstore.google.com/detail/tool/${EXTENSION_ID}/reviews`,
		]) {
			expect(parseChromeWebStoreExtensionId(input)).toBeNull();
		}
	});
});
