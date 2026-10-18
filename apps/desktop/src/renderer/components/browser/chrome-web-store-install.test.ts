import { describe, expect, it, vi } from "vitest";
import type { NativeBrowserStatus, RendererBridge, RendererResponse } from "@kestrel/shared-types";
import { chromeWebStoreInstallErrorMessage, openNativeChromeWebStore } from "./chrome-web-store-install";

const running: NativeBrowserStatus = {
	available: true, running: true, profile: "persistent",
	credentialStorage: "system_keychain_unverified",
};

describe("native Chrome Web Store", () => {
	it("opens the Store through the native browser without an embedded install request", async () => {
		const request = vi.fn<RendererBridge["request"]>().mockResolvedValue({ ok: true, nativeBrowser: running });
		await expect(openNativeChromeWebStore(request)).resolves.toEqual(running);
		expect(request.mock.calls).toEqual([[{ type: "browser-open-native", input: "https://chromewebstore.google.com/" }]]);
	});

	it("preserves the listing identity when handing a legacy Store link to Chromium", async () => {
		const request = vi.fn<RendererBridge["request"]>().mockResolvedValue({ ok: true, nativeBrowser: running });
		const id = "bcjindcccaagfpapjjmafapmmgkkhgoa";
		await openNativeChromeWebStore(request, `https://chrome.google.com/webstore/detail/json-formatter/${id}?hl=en`);
		expect(request).toHaveBeenCalledExactlyOnceWith({ type: "browser-open-native", input: `https://chromewebstore.google.com/detail/${id}` });
	});

	it.each([
		"https://chromewebstore.google.com.evil.test/detail/bcjindcccaagfpapjjmafapmmgkkhgoa",
		"https://user:password@chromewebstore.google.com/detail/bcjindcccaagfpapjjmafapmmgkkhgoa",
		"file:///private/profile",
	])("rejects non-Store or credential-bearing links before making a request: %s", async (url) => {
		const request = vi.fn<RendererBridge["request"]>();
		await expect(openNativeChromeWebStore(request, url)).rejects.toThrow(/official Chrome Web Store/);
		expect(request).not.toHaveBeenCalled();
	});

	it.each<RendererResponse>([
		{ ok: false, error: "private native diagnostics" },
		{ ok: true, nativeBrowser: { ...running, available: false } },
		{ ok: true, nativeBrowser: { ...running, running: false } },
		{ ok: true, nativeBrowser: { ...running, error: "private profile details" } },
		{ ok: true },
	])("does not report success when native startup fails", async (response) => {
		const request = vi.fn<RendererBridge["request"]>().mockResolvedValue(response);
		await expect(openNativeChromeWebStore(request)).rejects.toThrow(/^The native Chrome Web Store could not open\./);
	});
});

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
