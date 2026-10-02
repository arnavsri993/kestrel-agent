import { describe, expect, it } from "vitest";
import { maskSensitiveText, replaceSensitiveText } from "./sensitive-text";

const fixtureSecret = "fixture-sensitive-Alpha123456789";

describe("sensitive text ingress", () => {
	it("masks every repeated value including repeats before the labelled value", () => {
		const text = `${fixtureSecret} then API_KEY=${fixtureSecret}; repeat ${fixtureSecret}`;
		expect(maskSensitiveText(text)).toBe("[REDACTED] then API_KEY=[REDACTED]; repeat [REDACTED]");
		expect(replaceSensitiveText(text, () => "[TASK_SECRET:fixture-ref]")).toBe(
			"[TASK_SECRET:fixture-ref] then API_KEY=[TASK_SECRET:fixture-ref]; repeat [TASK_SECRET:fixture-ref]",
		);
	});
	it.each([
		`{"apiKey":"${fixtureSecret}","message":"keep this"}`,
		`{"googleApiKey":"${fixtureSecret}"}`,
		`GOOGLE_GENERATIVE_AI_API_KEY=${fixtureSecret}`,
		`export OPENAI_API_KEY='${fixtureSecret}'`,
		`My api key is ${fixtureSecret}; use it for setup.`,
		`client secret: "${fixtureSecret}"`,
		`https://example.invalid/setup?api_key=${fixtureSecret}&view=details`,
	])("extracts only the credential from %s", (input) => {
		const captured: string[] = [];
		const safe = replaceSensitiveText(input, (_kind, secret) => {
			captured.push(secret);
			return "[TASK_SECRET:fixture-ref]";
		});
		expect(captured).toEqual([fixtureSecret]);
		expect(safe).toBe(input.replace(fixtureSecret, "[TASK_SECRET:fixture-ref]"));
		expect(maskSensitiveText(input)).toBe(input.replace(fixtureSecret, "[REDACTED]"));
	});

	it("preserves existing opaque references across repeated ingress passes", () => {
		const input = 'api_key=[TASK_SECRET:task-secret-fixture]; token=[TOKEN_1]; secret=[REDACTED_SECRET]';
		let calls = 0;
		const safe = replaceSensitiveText(input, () => {
			calls += 1;
			return "[REDACTED]";
		});
		expect(safe).toBe(input);
		expect(maskSensitiveText(maskSensitiveText(input))).toBe(input);
		expect(calls).toBe(0);
	});

	it("does not rescan newly inserted markers as credential values", () => {
		const input = `api_key=${fixtureSecret} and ${fixtureSecret}`;
		const captured: string[] = [];
		const safe = replaceSensitiveText(input, (_kind, secret) => {
			captured.push(secret);
			return "[TASK_SECRET:task-secret-fixture]";
		});
		expect(captured).toEqual([fixtureSecret]);
		expect(safe).toContain("api_key=[TASK_SECRET:task-secret-fixture]");
		expect(maskSensitiveText(safe)).toBe(safe);
	});

	it("leaves non-secret boolean and status metadata unchanged", () => {
		const input = '{"apiKeyConfigured":true,"tokenStatus":"operational","secretEnabled":false,"tokenCount":10000,"message":"normal setup text"}';
		expect(maskSensitiveText(input)).toBe(input);
		expect(maskSensitiveText("password=enabled api_key=missing token_status=operational")).toBe(
			"password=enabled api_key=missing token_status=operational",
		);
	});

	it("extracts provider keys and private key blocks without losing surrounding text", () => {
		const providerKey = `sk-proj-${"f".repeat(32)}`;
		const privateKey = "-----BEGIN PRIVATE KEY-----\nfixture-private-material\n-----END PRIVATE KEY-----";
		const input = `Use ${providerKey}.\n${privateKey}\nKeep the instructions.`;
		const safe = maskSensitiveText(input);
		expect(safe).toBe("Use [REDACTED].\n[REDACTED]\nKeep the instructions.");
	});

	it("handles URL credentials and encoded query values without retaining their bytes", () => {
		const safe = maskSensitiveText(
			`https://fixture-user:fixture-password@example.invalid/?access_token=${fixtureSecret}%2Bvalue&mode=setup`,
		);
		expect(safe).toBe("https://[REDACTED]@example.invalid/?access_token=[REDACTED]&mode=setup");
	});
});
