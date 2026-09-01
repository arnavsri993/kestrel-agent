import type { ArtifactRecordContract } from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import {
	artifactPreviewState,
	supportsArtifactPreview,
} from "./App";

function artifact(mediaType: string, artifactKind?: "media" | "widget"): ArtifactRecordContract {
	return {
		id: `artifact-${mediaType}`,
		filename: "fixture",
		path: "/tmp/fixture",
		mediaType,
		bytes: 4,
		sha256: "0".repeat(64),
		...(artifactKind ? { artifactKind } : {}),
		createdAt: "2026-08-31T10:00:00.000Z",
	};
}

describe("artifact renderer presentation", () => {
	it("supports bounded previews for image, audio, video, PDF, text, and widgets", () => {
		for (const mediaType of [
			"image/png",
			"audio/mpeg",
			"video/mp4",
			"application/pdf",
			"text/plain",
			"application/json",
		])
			expect(supportsArtifactPreview(artifact(mediaType))).toBe(true);
		expect(supportsArtifactPreview(artifact("text/html", "widget"))).toBe(true);
		expect(supportsArtifactPreview(artifact("text/html", "media"))).toBe(false);
		expect(supportsArtifactPreview(artifact("application/octet-stream"))).toBe(false);
	});

	it("turns verified bytes into a safe data URL or bounded text preview", () => {
		const encoded = "aGVsbG8=";
		expect(
			artifactPreviewState(artifact("image/png"), {
				mediaType: "image/png",
				dataBase64: encoded,
				truncated: false,
			}),
		).toMatchObject({
				mediaType: "image/png",
				dataUrl: `data:image/png;base64,${encoded}`,
				truncated: false,
			});
		expect(
			artifactPreviewState(artifact("text/plain"), {
				mediaType: "text/plain",
				dataBase64: encoded,
				truncated: true,
			}),
		).toEqual({ mediaType: "text/plain", text: "hello", truncated: true });
	});
});
