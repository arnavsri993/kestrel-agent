import { describe, expect, it } from "vitest";
import { parseExplicitMemoryCapture } from "./memory-capture";

describe("parseExplicitMemoryCapture", () => {
	it("recognizes remember-that commands and normalizes whitespace", () => {
		expect(parseExplicitMemoryCapture("Remember that I prefer concise updates")).toBe(
			"I prefer concise updates",
		);
		expect(parseExplicitMemoryCapture("  remember I work best before noon  ")).toBe(
			"I work best before noon",
		);
	});

	it("ignores ordinary chat messages", () => {
		expect(parseExplicitMemoryCapture("Please remember to send the deck")).toBeUndefined();
		expect(parseExplicitMemoryCapture("The sky is blue")).toBeUndefined();
		expect(parseExplicitMemoryCapture("")).toBeUndefined();
	});
});
