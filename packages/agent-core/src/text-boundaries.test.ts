import { describe, expect, it } from "vitest";
import { stripTrailingCharacters } from "./text-boundaries";

describe("untrusted text suffixes", () => {
	it("preserves embedded punctuation and removes only the trailing suffix", () => {
		expect(stripTrailingCharacters("https://example.org/a!?b!?", ".,;:!?")).toBe("https://example.org/a!?b");
		expect(stripTrailingCharacters("YWJj==", "=")).toBe("YWJj");
		expect(stripTrailingCharacters("", "=")).toBe("");
	});

	it("handles long malformed suffix candidates without rescanning each position", () => {
		for (const characters of ["=", ".,;:!?"]) {
			const repeated = characters.at(-1)!.repeat(200_000);
			expect(stripTrailingCharacters(`${repeated}x`, characters)).toBe(`${repeated}x`);
			expect(stripTrailingCharacters(`x${repeated}`, characters)).toBe("x");
		}
	});
});
