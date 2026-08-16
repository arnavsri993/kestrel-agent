import type { RuntimeToolExecution } from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import {
	modelVisibleToolResult,
	redactSensitiveContent,
} from "./tool-result-guardrails";

function execution(output: Record<string, unknown>): RuntimeToolExecution {
	return {
		id: "tool-redaction",
		sessionId: "session-redaction",
		toolName: "fixture.secret-output",
		status: "verified",
		riskLevel: "read_only",
		input: {},
		output,
		startedAt: "2026-08-16T00:00:00.000Z",
		completedAt: "2026-08-16T00:00:01.000Z",
	};
}

describe("model-facing tool result guardrails", () => {
	it("redacts structured secrets with stable indexed placeholders", () => {
		const openAiKey = `sk-proj-${"a".repeat(32)}`;
		const bearerToken = "b".repeat(32);
		const result = modelVisibleToolResult(
			execution({
				apiKey: openAiKey,
				pageText: `first ${openAiKey} second ${openAiKey} Bearer ${bearerToken}`,
			}),
		);
		const parsed = JSON.parse(result) as {
			output: { apiKey: string; pageText: string };
			safety?: { redactedSensitiveData: boolean; redactionCount: number };
		};

		expect(parsed.output.apiKey).toBe("[API_KEY_1]");
		expect(parsed.output.pageText).not.toContain(openAiKey);
		expect(parsed.output.pageText).toContain("[API_KEY_1]");
		expect(parsed.output.pageText).toContain("[BEARER_TOKEN_1]");
		expect(parsed.output.pageText.match(/\[API_KEY_1\]/g)).toHaveLength(2);
		expect(parsed.safety).toMatchObject({
			redactedSensitiveData: true,
			redactionCount: 4,
		});
	});

	it("redacts private keys and secret-bearing errors without changing the execution record", () => {
		const privateKey = [
			"-----BEGIN PRIVATE KEY-----",
			"secret-key-material",
			"-----END PRIVATE KEY-----",
		].join("\n");
		const original = execution({ privateKey });
		const visible = modelVisibleToolResult({
			...original,
			error: `provider returned api_key=${"c".repeat(24)}`,
		});

		expect(visible).not.toContain(privateKey);
		expect(visible).not.toContain("c".repeat(24));
		expect(original.output).toEqual({ privateKey });
	});

	it("redacts legacy persisted tool payloads before context replay", () => {
		const secret = `sk-proj-${"d".repeat(32)}`;
		const persisted = JSON.stringify({
			status: "verified",
			output: { apiKey: secret },
		});

		expect(redactSensitiveContent(persisted)).not.toContain(secret);
	});

	it("does not add a safety envelope when no sensitive value is present", () => {
		const visible = modelVisibleToolResult(
			execution({
				author: "A normal local result.",
				content: "A normal local result.",
			}),
		);

		expect(JSON.parse(visible)).toEqual({
			status: "verified",
			output: {
				author: "A normal local result.",
				content: "A normal local result.",
			},
		});
	});
});
