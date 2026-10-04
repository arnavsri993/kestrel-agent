import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { maskSensitiveText, replacePrivateKeyBlocks, replaceSensitiveText } from "./sensitive-text";

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


describe("private key delimiter scanner", () => {
	const block = (label: string, material = "synthetic-material\nsecond-line") =>
		`-----BEGIN ${label}PRIVATE KEY-----\n${material}\n-----END ${label}PRIVATE KEY-----`;

	it("replaces multiline and consecutive blocks once each and protects callback output", () => {
		const first = block("RSA ");
		const second = block("ENCRYPTED ");
		const captured: [string, string][] = [];
		const safe = replaceSensitiveText(`before\n${first}${second}\nafter`, (kind, secret) => {
			captured.push([kind, secret]);
			return `[TASK_SECRET:fixture-${captured.length}]`;
		});
		expect(captured).toEqual([["PRIVATE_KEY", first], ["PRIVATE_KEY", second]]);
		expect(safe).toBe("before\n[TASK_SECRET:fixture-1][TASK_SECRET:fixture-2]\nafter");
		expect(replacePrivateKeyBlocks(first, () => second)).toBe(second);
	});

	it.each(["", "RSA ", "EC ", "ENCRYPTED ", "OPENSSH ", "LABEL 123 "])(
		"retains the allowed header label %s",
		(label) => {
			expect(maskSensitiveText(`before ${block(label)} after`)).toBe("before [REDACTED] after");
		},
	);

	it("keeps shared ingress case sensitive and supports memory's case insensitive mode", () => {
		const lower = block("RSA ").toLowerCase();
		expect(maskSensitiveText(lower)).toBe(lower);
		const captured: [string, string][] = [];
		expect(replacePrivateKeyBlocks(lower, (kind, secret) => {
			captured.push([kind, secret]);
			return "[redacted-private-key]";
		}, { caseInsensitive: true })).toBe("[redacted-private-key]");
		expect(captured).toEqual([["PRIVATE_KEY", lower]]);
	});

	it("retains first-BEGIN/next-END behavior with nested and mismatched labels", () => {
		const unmatched = "-----BEGIN RSA PRIVATE KEY-----\nsynthetic-prefix\n";
		const mismatched = "-----BEGIN EC PRIVATE KEY-----\nsynthetic-material\n-----END RSA PRIVATE KEY-----";
		const orphanEnd = "-----END PRIVATE KEY-----";
		const captured: string[] = [];
		expect(replacePrivateKeyBlocks(`${orphanEnd} before ${unmatched}${mismatched} after`, (_kind, secret) => {
			captured.push(secret);
			return "[REDACTED]";
		})).toBe(`${orphanEnd} before [REDACTED] after`);
		expect(captured).toEqual([unmatched + mismatched]);
	});

	it("finds an END marker overlapping an irrelevant nested BEGIN delimiter", () => {
		const input = "-----BEGIN PRIVATE KEY-----" + "-----BEGIN A PRIVATE KEY----" + "-----END PRIVATE KEY-----";
		const captured: string[] = [];
		expect(replacePrivateKeyBlocks(input, (_kind, secret) => {
			captured.push(secret);
			return "[REDACTED]";
		})).toBe("[REDACTED]");
		expect(captured).toEqual([input]);
		expect(maskSensitiveText(input)).toBe("[REDACTED]");
		expect(replacePrivateKeyBlocks(input.toLowerCase(), () => "[REDACTED]", { caseInsensitive: true })).toBe("[REDACTED]");
	});

	it("finds a BEGIN marker overlapping an irrelevant orphan END delimiter", () => {
		const orphan = "-----END A PRIVATE KEY----";
		const key = "-----BEGIN PRIVATE KEY-----x-----END PRIVATE KEY-----";
		const captured: string[] = [];
		expect(replacePrivateKeyBlocks(orphan + key, (_kind, secret) => {
			captured.push(secret);
			return "[REDACTED]";
		})).toBe(orphan + "[REDACTED]");
		expect(captured).toEqual([key]);
		expect(maskSensitiveText(orphan + key)).toBe(orphan + "[REDACTED]");
		expect(replacePrivateKeyBlocks((orphan + key).toLowerCase(), () => "[REDACTED]", { caseInsensitive: true })).toBe(orphan.toLowerCase() + "[REDACTED]");
	});

	it.each([
		"before -----BEGIN PRIVATE KEY-----\nsynthetic-incomplete-material\nKeep the instructions.",
		"-----BEGIN PRIVATE KEY-----\n-----BEGIN RSA PRIVATE KEY-----\nKeep the instructions.",
		"-----BEGIN RSA-PRIVATE KEY-----\nsynthetic-material\n-----END PRIVATE KEY-----",
		"-----BEGIN PUBLIC KEY-----\nsynthetic-material\n-----END PRIVATE KEY-----",
		"-----BEGIN PRIVATE KEY----\nsynthetic-material\n-----END PRIVATE KEY-----",
		"-----END PRIVATE KEY-----\nKeep the instructions.",
	])("preserves incomplete or malformed markers without deleting trailing text: %s", (input) => {
		let calls = 0;
		expect(replacePrivateKeyBlocks(input, () => {
			calls += 1;
			return "[REDACTED]";
		})).toBe(input);
		expect(maskSensitiveText(input)).toBe(input);
		expect(calls).toBe(0);
	});

	it("preserves incomplete trailing text after replacing a complete block", () => {
		const trailing = "\n-----BEGIN PRIVATE KEY-----\nsynthetic-unfinished-material\nKeep the instructions.";
		expect(maskSensitiveText(block("") + trailing)).toBe("[REDACTED]" + trailing);
	});

	it("finishes adversarial megabyte inputs in a strictly bounded subprocess", () => {
		// A subprocess deadline actually terminates a blocking regex regression;
		// an in-process test timeout cannot interrupt synchronous backtracking.
		const source = new URL("./sensitive-text.ts", import.meta.url).href;
		const script = `
			import assert from "node:assert/strict";
			import { maskSensitiveText, replacePrivateKeyBlocks } from ${JSON.stringify(source)};
			const unmatched = "-----BEGIN PRIVATE KEY-----\\n".repeat(40_000);
			const malformed = "-----BEGIN " + "A ".repeat(600_000) + "PRIVATE KEY----";
			for (const input of [unmatched, malformed]) {
				assert.equal(maskSensitiveText(input), input);
				assert.equal(replacePrivateKeyBlocks(input.toLowerCase(), () => "[REDACTED]", { caseInsensitive: true }), input.toLowerCase());
			}
			console.log("bounded-private-key-scan-ok");
		`;
		expect(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
			encoding: "utf8",
			timeout: 3_000,
			killSignal: "SIGKILL",
			maxBuffer: 16_384,
		})).toBe("bounded-private-key-scan-ok\n");
	});
});
