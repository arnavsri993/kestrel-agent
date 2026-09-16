import { describe, expect, it } from "vitest";
import { installUserBrowserActivityInstrumentation } from "./user-browser-activity";

describe("user browser activity main-world instrumentation", () => {
	it("serializes as a self-contained function for executeInMainWorld", () => {
		const source = installUserBrowserActivityInstrumentation.toString();

		// Electron serializes this function into the page's world. A Vite __name
		// helper closes over the preload bundle and causes the browser injection to
		// fail before it can emit its conservative busy fallback.
		expect(source).not.toContain("__name");
		expect(() => new Function(`return (${source});`)()).not.toThrow();
	});
});
