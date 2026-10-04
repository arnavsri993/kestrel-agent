import { describe, expect, it } from "vitest";
import { embeddedBrowserUserAgent } from "./browser-user-agent";

const identity = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Kestrel/0.1.0 Chrome/149.0.0.0 Electron/43.4.0 Safari/537.36";

describe("embedded browser identity", () => {
	it("preserves the platform and engine while removing desktop app products", () => {
		expect(embeddedBrowserUserAgent(identity)).toBe("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36");
	});
	it("uses only an actual runtime engine version, never a guessed fallback", () => {
		expect(embeddedBrowserUserAgent(identity, "150.0.7339.0")).toContain("Chrome/150.0.7339.0");
		expect(embeddedBrowserUserAgent(identity, "newest")).toContain("Chrome/149.0.0.0");
		expect(embeddedBrowserUserAgent("Mozilla/5.0 Electron/43.4.0", "150.0.7339.0")).not.toContain("Chrome/");
	});
	it("handles custom app products without dropping unrelated browser metadata", () => {
		expect(embeddedBrowserUserAgent(identity + " WorkBrowser/2 Other/3", undefined, "Work Browser")).toContain("Other/3");
		expect(embeddedBrowserUserAgent(identity + " WorkBrowser/2", undefined, "Work Browser")).not.toContain("WorkBrowser/");
	});
});
