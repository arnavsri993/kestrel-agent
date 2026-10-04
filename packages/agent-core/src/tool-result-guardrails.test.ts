import {
	RuntimeMessageSchema,
	type RuntimeToolExecution,
} from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import {
	MAX_MODEL_VISIBLE_TOOL_RESULT_CHARACTERS,
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

	it("bounds an oversized result with a truthful model-facing receipt", () => {
		const oversized = "x".repeat(1_000_001);
		const visible = modelVisibleToolResult(execution({ content: oversized }));
		const parsed = JSON.parse(visible) as {
			status: string;
			output: {
				truncated: boolean;
				originalCharacterCount: number;
				limitCharacterCount: number;
				message: string;
			};
		};

		expect(visible.length).toBeLessThanOrEqual(
			MAX_MODEL_VISIBLE_TOOL_RESULT_CHARACTERS,
		);
		expect(visible).not.toContain(oversized);
		expect(parsed).toMatchObject({
			status: "verified",
			output: {
				truncated: true,
				limitCharacterCount: MAX_MODEL_VISIBLE_TOOL_RESULT_CHARACTERS,
			},
		});
		expect(parsed.output.originalCharacterCount).toBeGreaterThan(
			MAX_MODEL_VISIBLE_TOOL_RESULT_CHARACTERS,
		);
		expect(parsed.output.message).toContain("Do not assume omitted details");
		expect(
			RuntimeMessageSchema.safeParse({
				id: "message-tool-result-limit",
				sessionId: "session-redaction",
				role: "tool",
				content: visible,
				createdAt: "2026-09-30T00:00:00.000Z",
			}).success,
		).toBe(true);
	});

	it("keeps a large browser snapshot usable without replaying its full tree", () => {
		const nodes = Array.from({ length: 1_000 }, (_, index) => ({
			role: { value: "generic" },
			name: { value: `Repeated page text ${index} ${"x".repeat(400)}` },
		}));
		nodes.push({
			role: { value: "heading" },
			name: { value: "apps/desktop/src/renderer/TabStrip.tsx" },
		});
		nodes.push({
			role: { value: "row" },
			name: { value: "995 + onClick={() => dismissTabTools()}" },
		});
		nodes.push({
			role: { value: "heading" },
			name: { value: "scripts/test-desktop-browser.mjs" },
		});
		nodes.push({
			role: { value: "heading" },
			name: { value: `${"-".repeat(20_000)}.not-source` },
		});
		nodes.push({
			role: { value: "row" },
			name: { value: "1585 + assert.equal(openTabsExpanded, true)" },
		});
		const original = {
			...execution({
				url: "https://example.com/pull/802/changes",
				accessibilityTree: { nodes },
				interactive: [{ ref: "e1", name: "Files changed" }],
			}),
			toolName: "browser.visible-snapshot",
		};
		const visible = modelVisibleToolResult(original);
		const output = JSON.parse(visible).output as {
			accessibilityTree: { nodes: unknown[] };
			modelDiffRows: Array<{ file: string; text: string }>;
			truncated: boolean;
			modelSummary: string;
		};
		expect(visible.length).toBeLessThan(33_000);
		expect(output.truncated).toBe(true);
		expect(output.modelSummary).toContain("browser.current-context");
		expect(visible).toContain("TabStrip.tsx");
		expect(output.modelDiffRows).toEqual([
			{
				file: "apps/desktop/src/renderer/TabStrip.tsx",
				text: "995 + onClick={() => dismissTabTools()}",
			},
			{
				file: "scripts/test-desktop-browser.mjs",
				text: "1585 + assert.equal(openTabsExpanded, true)",
			},
		]);
		expect(output.accessibilityTree.nodes.length).toBeLessThan(nodes.length);
		expect((original.output?.accessibilityTree as { nodes: unknown[] }).nodes).toHaveLength(1_005);
	});
});
