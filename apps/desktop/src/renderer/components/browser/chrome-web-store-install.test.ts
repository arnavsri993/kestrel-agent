import { describe, expect, it } from "vitest";
import { chromeWebStoreInstallErrorMessage } from "./chrome-web-store-install";

describe("Chrome Web Store install errors", () => {
	it("turns installer failures into actionable compatibility messages", () => {
		expect(
			chromeWebStoreInstallErrorMessage(
				new Error("Electron could not start this extension's background service worker."),
			),
		).toMatch(/Chrome features/i);
		expect(
			chromeWebStoreInstallErrorMessage(
				new Error("Chrome Web Store download timed out."),
			),
		).toMatch(/connection/i);
	});

	it("does not expose unexpected native error details", () => {
		const rendered = chromeWebStoreInstallErrorMessage(
			new Error("Electron failed at /private/profile token=secret-value"),
		);
		expect(rendered).not.toContain("/private/profile");
		expect(rendered).not.toContain("secret-value");
	});
});
