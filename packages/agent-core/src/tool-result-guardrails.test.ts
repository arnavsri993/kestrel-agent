import {
	RuntimeMessageSchema,
	type RuntimeToolExecution,
} from "@kestrel/shared-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	MAX_MODEL_VISIBLE_TOOL_RESULT_CHARACTERS,
	modelVisibleToolResult,
	redactSensitiveContent,
} from "./tool-result-guardrails";

const cryptoProbe = vi.hoisted(() => ({ keys: [] as Buffer[], fail: false, fingerprints: [] as string[] }));
vi.mock("node:crypto", async (importOriginal) => {
 const actual = await importOriginal<typeof import("node:crypto")>();
 return { ...actual,
  randomBytes: (size: number) => {
   if (cryptoProbe.fail) throw new Error("RNG unavailable");
   const key = actual.randomBytes(size); cryptoProbe.keys.push(key); return key;
  },
  createHmac: (algorithm: string, key: Buffer) => {
   const hmac = actual.createHmac(algorithm, key);
   const digest = hmac.digest.bind(hmac);
   hmac.digest = ((encoding: "hex") => { const value = digest(encoding); cryptoProbe.fingerprints.push(value); return value; }) as typeof hmac.digest;
   return hmac;
  },
 };
});
beforeEach(() => { cryptoProbe.keys.length = 0; cryptoProbe.fingerprints.length = 0; cryptoProbe.fail = false; });

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

	it("uses one transient key across nested values, errors, and cross-kind matches", () => {
		const same = "generated-fixture-123456";
		const result = modelVisibleToolResult({ ...execution({ password: same, nested: { apiKey: same, password: "different-fixture-123" }, list: [{ secret: same }] }), error: `password=${same}` });
		const parsed = JSON.parse(result);
		expect(parsed.output).toEqual({ password: "[PASSWORD_1]", nested: { apiKey: "[PASSWORD_1]", password: "[PASSWORD_2]" }, list: [{ secret: "[PASSWORD_1]" }] });
		expect(parsed.error).toBe("password=[PASSWORD_1]");
		expect(parsed.safety.redactionCount).toBe(5);
		expect(cryptoProbe.keys).toHaveLength(1);
		expect(cryptoProbe.keys[0]).toEqual(Buffer.alloc(32));
		expect(cryptoProbe.fingerprints[0]).toBe(cryptoProbe.fingerprints[1]);
		expect(cryptoProbe.fingerprints[0]).not.toBe(cryptoProbe.fingerprints[2]);
		for (const fingerprint of cryptoProbe.fingerprints) expect(result).not.toContain(fingerprint);
		expect(result).not.toContain(same);
	});

	it("scopes fingerprints to each operation while retaining placeholder semantics", () => {
		const text = "password=generated-fixture-123456";
		expect(redactSensitiveContent(text)).toBe("password=[PASSWORD_1]");
		expect(redactSensitiveContent(text)).toBe("password=[PASSWORD_1]");
		expect(cryptoProbe.keys).toHaveLength(2);
		expect(cryptoProbe.fingerprints).toHaveLength(2);
		expect(cryptoProbe.fingerprints[0]).not.toBe(cryptoProbe.fingerprints[1]);
		for (const key of cryptoProbe.keys) expect(key).toEqual(Buffer.alloc(32));
	});

	it("clears keys when truncating or when an input getter throws", () => {
		const truncated = modelVisibleToolResult(execution({ password: "generated-fixture-123", content: "x".repeat(250_100) }));
		expect(JSON.parse(truncated).output.truncated).toBe(true);
		expect(cryptoProbe.keys[0]).toEqual(Buffer.alloc(32));
		const bad = execution({ get password() { throw new Error("fixture failure"); } });
		expect(() => modelVisibleToolResult(bad)).toThrow("fixture failure");
		expect(cryptoProbe.keys[1]).toEqual(Buffer.alloc(32));
		const invalid = { replace() { throw new Error("fixture failure"); } } as unknown as string;
		expect(() => redactSensitiveContent(invalid)).toThrow();
		expect(cryptoProbe.keys[2]).toEqual(Buffer.alloc(32));
	});

	it("fails closed if secure randomness is unavailable", () => {
		cryptoProbe.fail = true;
		expect(() => redactSensitiveContent("password=generated-fixture-123")).toThrow("RNG unavailable");
		expect(() => modelVisibleToolResult(execution({ password: "generated-fixture-123" }))).toThrow("RNG unavailable");
		expect(cryptoProbe.fingerprints).toEqual([]);
	});

	it("deduplicates identical PEM blocks using the same redaction state", () => {
		const pem = "-----BEGIN PRIVATE KEY-----\nfixture-material\n-----END PRIVATE KEY-----";
		expect(redactSensitiveContent(`${pem} ${pem}`)).toBe("[PRIVATE_KEY_1] [PRIVATE_KEY_1]");
		expect(cryptoProbe.fingerprints[0]).toBe(cryptoProbe.fingerprints[1]);
		expect(cryptoProbe.keys[0]).toEqual(Buffer.alloc(32));
	});
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
