import { describe, expect, it } from "vitest";
import { shouldCheckForUpdates, updaterFeedChannel } from "./update-channel";

describe("internet update channel", () => {
	it("maps product channels to electron-builder feed names", () => {
		expect(updaterFeedChannel("stable")).toBe("latest");
		expect(updaterFeedChannel("development")).toBeUndefined();
	});

	it("never checks from development or an unpackaged process", () => {
		expect(shouldCheckForUpdates(true, "development")).toBe(false);
		expect(shouldCheckForUpdates(false, "stable")).toBe(false);
		expect(shouldCheckForUpdates(true, "stable")).toBe(true);
		expect(shouldCheckForUpdates(true, "stable", true)).toBe(false);
	});
});
