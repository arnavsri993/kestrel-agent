import type { RuntimeMessage, RuntimeToolExecution } from "@kestrel/shared-types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	groupTranscriptMessages,
	isIntermediateTranscriptMessage,
	ThinkingDisclosure,
	toolAttentionCopy,
	toolMessageNeedsAttention,
} from "./ThinkingDisclosure";

function message(
	id: string,
	role: RuntimeMessage["role"],
	content = `${role} ${id}`,
): RuntimeMessage {
	return {
		id,
		sessionId: "session-1",
		role,
		content,
		createdAt: "2026-10-05T12:00:00.000Z",
	};
}

describe("thinking disclosure", () => {
	it("is collapsed by default and keeps its details available", () => {
		const markup = renderToStaticMarkup(
			<ThinkingDisclosure>
				<pre>workspace.read\ntechnical evidence</pre>
			</ThinkingDisclosure>,
		);
		expect(markup).toContain("<summary>");
		expect(markup).toContain("Thinking");
		expect(markup).not.toContain("<details open");
		expect(markup.indexOf("technical evidence")).toBeGreaterThan(
			markup.indexOf("</summary>"),
		);
	});

	it("groups adjacent tool details without swallowing ordinary chat", () => {
		const requested = {
			...message("request", "assistant", "Requested tools: workspace.read"),
			modelToolCalls: [
				{ id: "call-1", name: "workspace.read", arguments: { path: "README.md" } },
			],
		};
		const input = [
			message("user", "user"),
			requested,
			message("tool-1", "tool"),
			message("tool-2", "tool"),
			message("answer", "assistant", "Readable final answer"),
		];
		const grouped = groupTranscriptMessages(
			input,
			(item) => isIntermediateTranscriptMessage(item, []),
		);
		expect(grouped).toHaveLength(3);
		expect(grouped[1]).toMatchObject({
			kind: "thinking",
			messages: [
				{ id: "request" },
				{ id: "tool-1" },
				{ id: "tool-2" },
			],
		});
		expect(grouped[2]).toMatchObject({
			kind: "message",
			message: { id: "answer", content: "Readable final answer" },
		});
	});

	it("keeps failures, policy blocks, cancellations, and approvals out of routine disclosure", () => {
		const blocked = message(
			"blocked",
			"tool",
			JSON.stringify({
				status: "blocked",
				error: "Review this action before continuing.",
				output: { approvalRequired: true },
			}),
		);
		expect(toolMessageNeedsAttention(blocked, [])).toBe(true);
		expect(isIntermediateTranscriptMessage(blocked, [])).toBe(false);
		expect(toolAttentionCopy(blocked)).toEqual({
			title: "Approval required",
			detail: "Review this action before continuing.",
		});
		expect(
			isIntermediateTranscriptMessage(
				{
					...message("configuration", "tool"),
					toolName: "agent.config.apply",
				},
				[],
			),
		).toBe(false);
		expect(
			isIntermediateTranscriptMessage(message("result-card", "tool"), [], true),
		).toBe(false);

		const failedExecution = {
			id: "execution-1",
			status: "failed",
		} as RuntimeToolExecution;
		const referenced = {
			...message("failed", "tool", JSON.stringify({ status: "verified" })),
			toolExecutionId: "execution-1",
		};
		expect(toolMessageNeedsAttention(referenced, [failedExecution])).toBe(true);
	});

	it("collapses verified technical results while treating nonzero commands as failures", () => {
		const verified = message(
			"verified",
			"tool",
			JSON.stringify({ status: "verified", output: { exitCode: 0 } }),
		);
		const failed = message(
			"failed-command",
			"tool",
			JSON.stringify({ status: "verified", output: { exitCode: 2 } }),
		);
		expect(toolMessageNeedsAttention(verified, [])).toBe(false);
		expect(toolMessageNeedsAttention(failed, [])).toBe(true);
		expect(toolAttentionCopy(failed).detail).toBe("Command exited with code 2.");
	});
});
