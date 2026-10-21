import {
	RuntimeMessageSchema,
	type RuntimeToolExecution,
} from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import {
	MAX_MODEL_SCREENSHOT_DATA_URL_BYTES,
	MAX_MODEL_VISIBLE_TOOL_RESULT_CHARACTERS,
	modelScreenshotObservation,
	modelVisibleToolResult,
	redactSensitiveContent,
} from "./tool-result-guardrails";

const ONE_PIXEL_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

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

function screenshotExecution(
	overrides: Partial<RuntimeToolExecution> = {},
): RuntimeToolExecution {
	return {
		...execution({
			width: 1,
			height: 1,
			pngBase64: ONE_PIXEL_PNG_BASE64,
			trust: "untrusted_browser",
		}),
		toolName: "browser.screenshot",
		...overrides,
	};
}

describe("model-facing tool result guardrails", () => {
	it("preserves bounded desktop capture provenance without replaying arbitrary metadata", () => {
		const source = screenshotExecution({ toolName: "computer.screenshot" });
		source.output!.trust = "untrusted_desktop";
		source.output!.desktop = {
			captureId: "capture-1", displayId: "1",
			bounds: { x: -1280, y: 0, width: 1, height: 1 },
			capturedAt: "2026-10-13T12:00:00.000Z", foregroundTitle: "PRIVATE_WINDOW_TITLE",
		};
		const receipt = modelVisibleToolResult(source);
		expect(JSON.parse(receipt).output.desktop).toEqual({
			captureId: "capture-1", displayId: "1", bounds: { x: -1280, y: 0, width: 1, height: 1 }, capturedAt: "2026-10-13T12:00:00.000Z",
		});
		expect(receipt).not.toContain("PRIVATE_WINDOW_TITLE");
		expect(receipt).not.toContain(ONE_PIXEL_PNG_BASE64);
	});
	it("delivers a verified screenshot as an image while persisting only a compact receipt", () => {
		const source = screenshotExecution();
		source.output!.pageText = "SCREENSHOT_ONLY_SECRET_TEXT";
		const observation = modelScreenshotObservation(source);
		const visible = modelVisibleToolResult(source);
		const parsed = JSON.parse(visible) as {
			output: {
				trust: string;
				screenshot: {
					byteLength: number;
					deliveredSeparately: boolean;
				};
			};
		};

		expect(observation).toEqual([
			expect.objectContaining({
				type: "text",
				text: expect.stringContaining("Untrusted screenshot observation"),
			}),
			{
				type: "image",
				data: ONE_PIXEL_PNG_BASE64,
				mediaType: "image/png",
				source: "base64",
			},
		]);
		expect(visible).not.toContain(ONE_PIXEL_PNG_BASE64);
		expect(visible).not.toContain("SCREENSHOT_ONLY_SECRET_TEXT");
		expect(JSON.stringify(observation)).not.toContain(
			"SCREENSHOT_ONLY_SECRET_TEXT",
		);
		expect(parsed.output).toMatchObject({
			trust: "untrusted_browser",
			screenshot: {
				byteLength: Buffer.from(ONE_PIXEL_PNG_BASE64, "base64").byteLength,
				deliveredSeparately: true,
			},
		});
		expect(source.output?.pngBase64).toBe(ONE_PIXEL_PNG_BASE64);
	});

	it("withholds failed, untrusted, malformed, oversized, and non-whitelisted screenshot payloads", () => {
		const oversizedLength =
			Math.ceil(MAX_MODEL_SCREENSHOT_DATA_URL_BYTES / 4) * 4;
		const cases: RuntimeToolExecution[] = [
			screenshotExecution({
				status: "failed",
				error:
					"Kestrel does not share browser screenshots from pages with sensitive input fields.",
			}),
			screenshotExecution({
				status: "blocked",
			}),
			screenshotExecution({
				output: {
					width: 1,
					height: 1,
					pngBase64: ONE_PIXEL_PNG_BASE64,
					trust: "trusted_browser",
				},
			}),
			screenshotExecution({
				output: {
					width: 1,
					height: 1,
					pngBase64: "not-base64!",
					trust: "untrusted_browser",
				},
			}),
			screenshotExecution({
				output: {
					width: 1,
					height: 1,
					pngBase64: "A".repeat(oversizedLength),
					trust: "untrusted_browser",
				},
			}),
			screenshotExecution({ toolName: "plugin.screenshot" }),
		];

		for (const value of cases)
			expect(modelScreenshotObservation(value)).toBeUndefined();
		for (const value of cases.slice(0, -1))
			expect(modelVisibleToolResult(value)).not.toContain(
				String(value.output?.pngBase64 ?? "never"),
			);
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
