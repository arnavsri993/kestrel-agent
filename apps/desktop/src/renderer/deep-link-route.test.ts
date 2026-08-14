import { describe, expect, it } from "vitest";
import { desktopDeepLinkAction } from "./deep-link-route";

describe("desktop deep-link routing", () => {
	it("accepts only the two explicit navigation routes", () => {
		expect(desktopDeepLinkAction("kestrel://new-chat")).toBe("new-chat");
		expect(desktopDeepLinkAction("kestrel://new-chat/")).toBe("new-chat");
		expect(desktopDeepLinkAction("kestrel://settings")).toBe("settings");
		expect(desktopDeepLinkAction("kestrel://settings/")).toBe("settings");
	});

	it("does not infer arbitrary session or parameterized navigation", () => {
		expect(
			desktopDeepLinkAction("kestrel://session/private-id"),
		).toBeUndefined();
		expect(
			desktopDeepLinkAction("kestrel://settings?section=privacy"),
		).toBeUndefined();
		expect(desktopDeepLinkAction("kestrel://new-chat#prompt")).toBeUndefined();
		expect(desktopDeepLinkAction("kestrel:new-chat")).toBeUndefined();
		expect(
			desktopDeepLinkAction("https://example.com/settings"),
		).toBeUndefined();
	});
});
