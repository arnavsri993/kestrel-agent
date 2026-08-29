import { describe, expect, it } from "vitest";
import {
	assertBrowserDevToolsAllowed,
	BROWSER_DEVTOOLS_PACKAGED_ERROR,
	canOpenBrowserDevTools,
} from "./browser-devtools-guard";

describe("browser devtools guard", () => {
	it("allows devtools only outside packaged production builds", () => {
		expect(canOpenBrowserDevTools(false)).toBe(true);
		expect(canOpenBrowserDevTools(true)).toBe(false);
	});

	it("rejects packaged production devtools requests with a clear error", () => {
		expect(() => assertBrowserDevToolsAllowed(false)).not.toThrow();
		expect(() => assertBrowserDevToolsAllowed(true)).toThrow(
			BROWSER_DEVTOOLS_PACKAGED_ERROR,
		);
	});
});
