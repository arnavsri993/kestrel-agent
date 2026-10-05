import {
	RuntimeMessageSchema,
	SensitiveTextLimitError,
	type RuntimeToolExecution,
} from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import {
	MAX_MODEL_VISIBLE_TOOL_RESULT_CHARACTERS,
	modelVisibleToolResult,
	redactSensitiveContent,
	redactSensitiveValue,
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

	it("carries sensitive context through mixed arrays and objects and masks earlier echoes", () => {
		const secrets = ["synthetic-before-value", "p!2", "synthetic-array-value", "synthetic-object-value", "synthetic-refresh-value", "synthetic-token-value", "synthetic-credential-value"];
		const output = {
			before: `first ${secrets[0]}; ${secrets[3]}`,
			password: [secrets[0], [secrets[1], secrets[2]], { value: secrets[3], status: "active", count: 12, configured: true, name: "primary" }],
			refresh_token: secrets[4],
			token: secrets[5],
			credentials: secrets[6],
			nested: { password: secrets[0], echo: secrets[0] },
		};
		const original = structuredClone(output);
		const safe = JSON.parse(modelVisibleToolResult(execution(output)));
		for (const secret of secrets) expect(JSON.stringify(safe)).not.toContain(secret);
		expect(safe.output.before).toBe(`first ${safe.output.password[0]}; ${safe.output.password[2].value}`);
		expect(safe.output.nested.echo).toBe(safe.output.password[0]);
		expect(safe.output.password[1][0]).toMatch(/^\[PASSWORD_\d+\]$/);
		expect(safe.output.password[2]).toMatchObject({ status: "active", count: 12, configured: true, name: "primary" });
		expect(output).toEqual(original);
	});

	it.each([
		["passwords", "PASSWORD"], ["provider.APIKeys", "API_KEY"], ["refreshTokens", "REFRESH_TOKEN"],
		["account.access_tokens", "ACCESS_TOKEN"], ["credentials", "CREDENTIAL"], ["clientSecrets", "SECRET"],
		["privateKeys", "PRIVATE_KEY"], ["sessionCookies", "SESSION_COOKIE"], ["IDTokens", "ID_TOKEN"], ["auth.tokens", "TOKEN"],
	])("redacts structured alias %s using the shared kind", (key, kind) => {
		expect(redactSensitiveValue({ [key]: ["synthetic-alias-value"] })).toEqual({ [key]: [`[${kind}_1]`] });
	});

	it("preserves metadata and token usage while protecting numeric credentials", () => {
		const metadata = {
			tokenCount: 12, passwordConfigured: true, status: "active", count: 3,
			prompt_tokens: 12, inputTokens: 12, output_tokens: 12, totalTokens: 12,
			max_tokens: 12, min_tokens: 12, context_tokens: 12,
		};
		expect(redactSensitiveValue({ ...metadata, credentials: { value: "synthetic-value", ...metadata }, password: [12345], token: 67890 })).toEqual({
			...metadata, credentials: { value: "[CREDENTIAL_1]", ...metadata }, password: ["[PASSWORD_1]"], token: "[TOKEN_1]",
		});
	});

	it("masks unlabelled numeric echoes while preserving equal metadata quantities", () => {
		const json = '{ "before": 12345, "password": [12345], "tokenCount": 12345 }';
		expect(redactSensitiveValue({ before: 12345, password: [12345], tokenCount: 12345, content: json })).toEqual({
			before: "[PASSWORD_1]", password: ["[PASSWORD_1]"], tokenCount: 12345,
			content: '{ "before": "[PASSWORD_1]", "password": ["[PASSWORD_1]"], "tokenCount": 12345 }',
		});
	});

	it("protects short secrets and overlapping echoes without rewriting placeholders", () => {
		const references = ["[PASSWORD_1]", "[TASK_SECRET:fixture]", "task-secret-10000000-0000-0000-0000-000000000000"];
		const safe = redactSensitiveValue({
			before: `fixture-long fixture PASSWORD 1 ${references.join(" ")}`,
			password: ["fixture", "PASSWORD", "1", ...references],
			token: "fixture-long",
		}) as { before: string; password: string[]; token: string };
		expect(safe.password.slice(3)).toEqual(references);
		expect(safe.before).toBe(`${safe.token} ${safe.password[0]} ${safe.password[1]} ${safe.password[2]} ${references.join(" ")}`);
		expect(redactSensitiveValue(safe)).toEqual(safe);
	});

	it("discovers secrets in serialized errors and content while preserving JSON formatting", () => {
		const secret = "synthetic-json-value";
		const short = "q!7";
		const json = `{\n  "before": "${secret}",\n  "password": ["${short}"], "credentials": [{"value": "${secret}", "status": "active"}],\n  "tokenCount": 12\n}`;
		const tool = { ...execution({ before: secret, content: json }), error: json };
		const safe = JSON.parse(modelVisibleToolResult(tool));
		for (const value of [safe.output.content, safe.error, redactSensitiveContent(json)]) {
			expect(value).not.toContain(secret);
			expect(value).not.toContain(short);
			expect(value).toContain('{\n  "before": "');
			expect(value).toContain('"tokenCount": 12\n}');
			expect(JSON.parse(value).credentials[0].status).toBe("active");
		}
		expect(safe.output.before).toBe(JSON.parse(safe.error).credentials[0].value);
		expect(tool.error).toBe(json);
	});

	it("handles escaped JSON strings and nested serialized JSON during legacy replay", () => {
		const secret = 'synthetic-"quoted"\\value\nnext';
		const nested = JSON.stringify({ before: secret, credentials: [{ value: secret }], tokenCount: 12 });
		const content = JSON.stringify({ before: secret, content: nested });
		const safe = JSON.parse(redactSensitiveContent(content));
		expect(safe.before).toBe(JSON.parse(safe.content).credentials[0].value);
		expect(safe.before).toMatch(/^\[CREDENTIAL_\d+\]$/);
		expect(JSON.parse(safe.content).tokenCount).toBe(12);
	});

	it("applies caller-known redaction to decoded unlabelled JSON scalars", () => {
		const known = 'synthetic-"vault"\\value\nnext';
		const json = `{\n  "note": ${JSON.stringify(known)}, "tokenCount": 12\n}`;
		const safe = redactSensitiveValue({ content: json, error: json }, text => text.replaceAll(known, "[REDACTED]")) as { content: string; error: string };
		expect(safe.content).toBe('{\n  "note": "[REDACTED]", "tokenCount": 12\n}');
		expect(safe.error).toBe(safe.content);
		expect(JSON.parse(safe.content).note).toBe("[REDACTED]");
	});

	it("fails closed before returning a partial record when discovery exceeds limits", () => {
		const output = { passwords: Array.from({ length: 513 }, (_, index) => `synthetic-secret-${index}`) };
		expect(() => redactSensitiveValue(output)).toThrow(SensitiveTextLimitError);
		expect(() => modelVisibleToolResult(execution(output))).toThrow("Sensitive-value redaction exceeded its processing limit.");
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => redactSensitiveValue(cyclic)).toThrow(SensitiveTextLimitError);
		expect(output.passwords).toHaveLength(513);
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
