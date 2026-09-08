import { describe, expect, it } from "vitest";
import {
	compactDownloadBytes,
	downloadProgress,
	downloadSizeLabel,
	downloadTimeRemaining,
} from "./browser-download-format";

describe("browser download presentation", () => {
	it("formats sizes and determinate progress without hiding unknown totals", () => {
		expect(compactDownloadBytes(2_500_000)).toBe("2.5 MB");
		expect(
			downloadProgress({ receivedBytes: 25, totalBytes: 100 }),
		).toBe(25);
		expect(
			downloadProgress({ receivedBytes: 25, totalBytes: 0 }),
		).toBeUndefined();
	});

	it("shows received and total size while downloading, then only final size", () => {
		const progressing = {
			receivedBytes: 2_500,
			totalBytes: 10_000,
			status: "progressing" as const,
		};
		const completed = { ...progressing, status: "completed" as const };

		expect(downloadSizeLabel(progressing)).toBe("3 KB of 10 KB");
		expect(downloadSizeLabel(completed)).toBe("10 KB");
	});

	it("estimates remaining time from real download progress", () => {
		const startedAt = "2026-09-05T12:00:00.000Z";
		const download = {
			receivedBytes: 500,
			totalBytes: 1_500,
			startedAt,
		};

		expect(
			downloadTimeRemaining(download, Date.parse(startedAt) + 1_000),
		).toBe("2s left");
		expect(
			downloadTimeRemaining(
				{ ...download, receivedBytes: 0 },
				Date.parse(startedAt) + 1_000,
			),
		).toBe("Estimating…");
	});
});
