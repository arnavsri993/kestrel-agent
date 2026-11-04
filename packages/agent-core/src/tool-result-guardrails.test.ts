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

	it("marks occurrences independently across nested values, kinds, and errors", () => {
		const same = "generated-fixture-123456";
		const result = modelVisibleToolResult({ ...execution({ password: same, nested: { apiKey: same, password: "different-fixture-123" }, list: [{ secret: same }] }), error: `password=${same}` });
		const parsed = JSON.parse(result);
		expect(parsed.output).toEqual({ password: "[PASSWORD_1]", nested: { apiKey: "[API_KEY_1]", password: "[PASSWORD_2]" }, list: [{ secret: "[SECRET_1]" }] });
		expect(parsed.error).toBe("password=[PASSWORD_3]");
		expect(parsed.safety.redactionCount).toBe(5);
		expect(result).not.toContain(same);
	});

	it("does not reveal which known candidate equals an unknown synthetic password", () => {
		const candidates = ["synthetic-wrong-guess-5920", "synthetic-matching-guess-7421"];
		const visible = (password: string) => modelVisibleToolResult(execution({ password,
			candidates: candidates.map((candidate, index) => ({ label: `candidate-${index}`, password: candidate })) }));
		const first = visible(candidates[0]!), second = visible(candidates[1]!);
		expect(first).toBe(second);
		expect(JSON.parse(first).output).toEqual({ password: "[PASSWORD_1]", candidates: [
			{ label: "candidate-0", password: "[PASSWORD_2]" }, { label: "candidate-1", password: "[PASSWORD_3]" }] });
		for (const candidate of candidates) expect(first).not.toContain(candidate);
	});

	it("resets occurrence counters for separate results without exposing secret identity", () => {
		const repeated = "generated-fixture-123456";
		expect(redactSensitiveContent(`password=${repeated} password=${repeated}`)).toBe("password=[PASSWORD_1] password=[PASSWORD_2]");
		expect(redactSensitiveContent(`password=${repeated} password=different-fixture-123`)).toBe("password=[PASSWORD_1] password=[PASSWORD_2]");
		expect(redactSensitiveContent("password=another-fixture-456")).toBe("password=[PASSWORD_1]");
	});

	it("preserves truncation and propagates input errors without changing the execution record", () => {
		const truncated = modelVisibleToolResult(execution({ password: "generated-fixture-123", content: "x".repeat(250_100) }));
		expect(JSON.parse(truncated).output.truncated).toBe(true);
		expect(truncated).not.toContain("generated-fixture-123");
		const bad = execution({ get password() { throw new Error("fixture failure"); } });
		expect(() => modelVisibleToolResult(bad)).toThrow("fixture failure");
		expect(Object.getOwnPropertyDescriptor(bad.output, "password")?.get).toBeTypeOf("function");
		const invalid = { replace() { throw new Error("fixture failure"); } } as unknown as string;
		expect(() => redactSensitiveContent(invalid)).toThrow();
	});

	it("does not correlate repeated PEM material within text or across output and error", () => {
		const pem = "-----BEGIN PRIVATE KEY-----\nfixture-material\n-----END PRIVATE KEY-----";
		expect(redactSensitiveContent(`${pem} ${pem}`)).toBe("[PRIVATE_KEY_1] [PRIVATE_KEY_2]");
		const result = JSON.parse(modelVisibleToolResult({ ...execution({ privateKey: pem }), error: pem }));
		expect(result.output.privateKey).toBe("[PRIVATE_KEY_1]");
		expect(result.error).toBe("[PRIVATE_KEY_2]");
		expect(result.safety.redactionCount).toBe(2);
	});
	it("redacts structured secrets with occurrence markers independent of matching text", () => {
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
		expect(parsed.output.pageText).toContain("[OPENAI_API_KEY_1]");
		expect(parsed.output.pageText).toContain("[OPENAI_API_KEY_2]");
		expect(parsed.output.pageText).toContain("[BEARER_TOKEN_1]");
		expect(parsed.output.pageText).not.toContain("[API_KEY_1]");
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

	it("redacts multiple and incomplete private key blocks conservatively", () => {
		const first = "-----BEGIN PRIVATE KEY-----\nfirst-secret\n-----END PRIVATE KEY-----";
		const second = "-----begin rsa private key-----\nsecond-secret\n-----end rsa private key-----";
		expect(redactSensitiveContent(`before ${first} between ${second} after`))
			.toBe("before [PRIVATE_KEY_1] between [PRIVATE_KEY_2] after");
		expect(redactSensitiveContent("before -----BEGIN\tRSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY----- after"))
			.toBe("before [PRIVATE_KEY_1] after");
		expect(redactSensitiveContent(`prefix -----BEGIN PRIVATE KEY-----\nunfinished-secret`))
			.toBe("prefix [PRIVATE_KEY_1]");
		const mismatched = "-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END EC PRIVATE KEY-----\ntrailing-secret";
		const nested = "-----BEGIN PRIVATE KEY-----\n-----BEGIN EC PRIVATE KEY-----\nsecret\n-----END EC PRIVATE KEY-----\ntrailing-secret";
		for (const malformed of [mismatched, nested]) {
			expect(redactSensitiveContent(`prefix ${malformed}`)).toBe("prefix [PRIVATE_KEY_1]");
		}
		for (const header of [
			"-----BEGIN PRIVATE KEY----",
			"-----BEGIN PRIVATE KEY\n",
			"-----BEGIN\tRSA  PRIVATE\tKEY----",
			"-----BEGIN\nPRIVATE KEY-----",
		]) {
			const value = `prefix ${header}\ntrailing-secret`;
			expect(redactSensitiveContent(value)).toBe("prefix [PRIVATE_KEY_1]");
		}
	});

	it("handles many unterminated private key markers before applying the result limit", () => {
		const markers = "-----BEGIN PRIVATE KEY-----".repeat(40_000);
		const visible = modelVisibleToolResult(execution({ content: `${markers}secret-at-end` }));
		expect(visible).not.toContain("secret-at-end");
		expect(JSON.parse(visible)).toMatchObject({
			output: { content: "[PRIVATE_KEY_1]" },
			safety: { redactedSensitiveData: true },
		});
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
});
