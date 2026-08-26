import type { CoreRequest } from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import {
	coreRequestTimeoutMs,
	timedOutAgentStreamId,
} from "./core-request-lifecycle";

describe("Agent Core request lifecycle", () => {
	it("allows interactive agent work to outlive the old 15 second timeout", () => {
		const requests: Array<[CoreRequest, string]> = [
			[
				{
					type: "runtime-run-agent",
					sessionId: "session-1",
					message: "Complete the task",
					model: "auto",
					providerIds: ["auto"],
					streamId: "stream-run",
				},
				"stream-run",
			],
			[
				{
					type: "runtime-resume-agent",
					runId: "run-1",
					approvalDecision: "approved",
					streamId: "stream-resume",
				},
				"stream-resume",
			],
			[
				{
					type: "runtime-retry-agent",
					sessionId: "session-1",
					model: "auto",
					providerIds: ["auto"],
					streamId: "stream-retry",
				},
				"stream-retry",
			],
		];
		for (const [request, streamId] of requests) {
			expect(coreRequestTimeoutMs(request)).toBe(30 * 60_000);
			expect(timedOutAgentStreamId(request)).toBe(streamId);
		}
	});

	it("retains a bounded transcription timeout and a short control timeout", () => {
		expect(
			coreRequestTimeoutMs({
				type: "media-transcribe",
				dataBase64: "YXVkaW8=",
				mediaType: "audio/webm",
			}),
		).toBe(125_000);
		expect(coreRequestTimeoutMs({ type: "snapshot" })).toBe(30_000);
		expect(timedOutAgentStreamId({ type: "snapshot" })).toBeUndefined();
	});

	it("does not time out delegated work, direct tools, or generated pets as control requests", () => {
		expect(
			coreRequestTimeoutMs({
				type: "runtime-call-tool",
				sessionId: "session-1",
				toolName: "media.generate",
				input: {},
			}),
		).toBe(30 * 60_000);
		expect(
			coreRequestTimeoutMs({
				type: "writing-generate",
				purpose: "Draft a note",
				genre: "email",
				adaptationStrength: "balanced",
				includeSensitive: false,
				providerIds: ["auto"],
			}),
		).toBe(30 * 60_000);
		expect(
			coreRequestTimeoutMs({
				type: "orchestration-delegate",
				parentSessionId: "session-1",
				title: "Long task",
				prompt: "Complete and verify the task.",
				model: "auto",
				providerIds: ["auto"],
				isolateWorktree: false,
			}),
		).toBe(30 * 60_000);
		expect(
			coreRequestTimeoutMs({
				type: "pet-hatch-drafts",
				concept: "Paperclip bird",
				style: "auto",
				count: 4,
			}),
		).toBe(30 * 60_000);
	});
});
