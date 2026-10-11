import type { UserBrowserDownload } from "@kestrel/shared-types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { UserBrowserController } from "../../browser/useUserBrowser";
import { BrowserDownloads } from "./BrowserLibrary";

function render(download: Pick<UserBrowserDownload, "receivedBytes" | "totalBytes" | "status">) {
	const browser = { state: { downloads: [{
		id: "stream", filename: "stream.txt", canReveal: false, ...download,
	}] } } as unknown as UserBrowserController;
	return renderToStaticMarkup(<BrowserDownloads browser={browser} />);
}

describe("Downloaded files progress", () => {
	it.each([0, 4096])("keeps an unknown total indeterminate after %i bytes", (receivedBytes) => {
		const markup = render({ receivedBytes, totalBytes: 0, status: "progressing" });
		const progress = markup.match(/<progress\b[^>]*>/)?.[0];
		expect(progress).toBeDefined();
		expect(progress).not.toMatch(/\bvalue=/);
		expect(progress).toContain('aria-label="Download progress for stream.txt"');
		expect(progress).toContain("total size unknown");
		expect(markup).not.toContain("0%");
		expect(markup).toContain(receivedBytes ? "4 KB downloaded" : "0 B downloaded");
		expect(markup).toContain(">Cancel<");
	});

	it.each([{ receivedBytes: 25, totalBytes: 100 }, { receivedBytes: 999, totalBytes: 1000 }])(
		"keeps known totals precise at $receivedBytes/$totalBytes bytes",
		({ receivedBytes, totalBytes }) => {
			const markup = render({ receivedBytes, totalBytes, status: "progressing" });
			expect(markup).toContain(`value="${receivedBytes}"`);
			expect(markup).toContain(`max="${totalBytes}"`);
			expect(markup).toContain(`aria-valuetext="${receivedBytes} of ${totalBytes} bytes downloaded"`);
			expect(markup).not.toContain("% complete");
		},
	);

	it.each(["completed", "failed", "cancelled"] as const)("removes progress for a %s transfer", (status) => {
		const markup = render({ receivedBytes: 4096, totalBytes: 0, status });
		expect(markup).not.toContain("<progress");
		expect(markup).not.toContain(">Cancel<");
		expect(markup).toContain("4 KB");
	});
});
