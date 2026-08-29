import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	isTrustedRendererFrame,
	isTrustedRendererUrl,
	openExternalSafely,
	protectRendererNavigation,
	safeExternalUrl,
	trustedDevelopmentRendererUrl,
} from "./renderer-security";

const entryPath =
	"/Applications/Kestrel.app/Contents/Resources/app/renderer/index.html";

describe("renderer URL trust boundary", () => {
	it("accepts only the packaged renderer file", () => {
		expect(
			isTrustedRendererUrl(pathToFileURL(entryPath).toString(), entryPath),
		).toBe(true);
		expect(
			isTrustedRendererUrl(
				`${pathToFileURL(entryPath).toString()}?petOverlay=1`,
				entryPath,
			),
		).toBe(true);
		expect(isTrustedRendererUrl("file:///tmp/untrusted.html", entryPath)).toBe(
			false,
		);
		expect(isTrustedRendererUrl("https://example.com/", entryPath)).toBe(false);
	});

	it("accepts only the configured loopback development page", () => {
		const developmentUrl = "http://localhost:5173/";
		expect(
			isTrustedRendererUrl("http://localhost:5173/", entryPath, developmentUrl),
		).toBe(true);
		expect(
			isTrustedRendererUrl(
				"http://localhost:5173/?petOverlay=1",
				entryPath,
				developmentUrl,
			),
		).toBe(true);
		expect(
			isTrustedRendererUrl(
				"http://localhost:5173/other",
				entryPath,
				developmentUrl,
			),
		).toBe(false);
		expect(
			isTrustedRendererUrl(
				"http://localhost.evil.example/",
				entryPath,
				developmentUrl,
			),
		).toBe(false);
		expect(
			isTrustedRendererUrl(
				"http://localhost@evil.example/",
				entryPath,
				developmentUrl,
			),
		).toBe(false);
		expect(
			isTrustedRendererUrl(
				"http://[::1]:5173/",
				entryPath,
				"http://[::1]:5173/",
			),
		).toBe(true);
	});

	it("rejects a non-loopback configured development origin", () => {
		expect(
			isTrustedRendererUrl(
				"https://example.com/",
				entryPath,
				"https://example.com/",
			),
		).toBe(false);
		expect(
			trustedDevelopmentRendererUrl("https://example.com/"),
		).toBeUndefined();
		expect(
			trustedDevelopmentRendererUrl("http://user:secret@localhost:5173/"),
		).toBeUndefined();
		expect(trustedDevelopmentRendererUrl("http://127.0.0.1:5173/")).toBe(
			"http://127.0.0.1:5173/",
		);
	});

	it("blocks both direct navigations and server-side redirects", () => {
		const listeners = new Map<
			string,
			(event: { preventDefault(): void }, url: string) => void
		>();
		protectRendererNavigation(
			{
				on(event, listener) {
					listeners.set(event, listener);
				},
			},
			(url) => isTrustedRendererUrl(url, entryPath, "http://localhost:5173/"),
		);
		for (const eventName of ["will-navigate", "will-redirect"]) {
			let prevented = false;
			listeners.get(eventName)?.(
				{ preventDefault: () => (prevented = true) },
				"https://example.com/",
			);
			expect(prevented, eventName).toBe(true);
		}
		let trustedPrevented = false;
		listeners.get("will-redirect")?.(
			{ preventDefault: () => (trustedPrevented = true) },
			"http://localhost:5173/?petOverlay=1",
		);
		expect(trustedPrevented).toBe(false);
	});

	it("accepts privileged IPC only from the trusted top-level frame", () => {
		const mainFrame = { url: pathToFileURL(entryPath).toString() };
		const childFrame = { url: mainFrame.url };
		const trust = (url: string) => isTrustedRendererUrl(url, entryPath);

		expect(isTrustedRendererFrame(mainFrame, mainFrame, trust)).toBe(true);
		expect(isTrustedRendererFrame(childFrame, mainFrame, trust)).toBe(false);
		expect(isTrustedRendererFrame(null, mainFrame, trust)).toBe(false);
		expect(
			isTrustedRendererFrame({ url: "https://example.com/" }, mainFrame, trust),
		).toBe(false);
	});

	it("allows only credential-free http(s) links in the system browser", () => {
		expect(safeExternalUrl("https://example.com/docs")).toBe(
			"https://example.com/docs",
		);
		expect(safeExternalUrl("javascript:alert(1)")).toBeUndefined();
		expect(safeExternalUrl("file:///etc/passwd")).toBeUndefined();
		expect(
			safeExternalUrl("https://user:secret@example.com/"),
		).toBeUndefined();

		const opened: string[] = [];
		expect(
			openExternalSafely((url) => {
				opened.push(url);
			}, "https://example.com/"),
		).toBe(true);
		expect(opened).toEqual(["https://example.com/"]);
		expect(
			openExternalSafely((url) => {
				opened.push(url);
			}, "file:///tmp/x"),
		).toBe(
			false,
		);
	});
});
