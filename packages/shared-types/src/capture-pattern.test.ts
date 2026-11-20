import { describe, expect, it } from "vitest";
import { capturePatternMatches, CapturePatternLimitError } from "./capture-pattern";

describe("bounded capture patterns", () => {
	it("preserves wildcard behavior for ordinary literal patterns", () => {
		const combinations = (alphabet: string, length: number): string[] => {
			const all = [""]; let level = [""];
			for (let count = 0; count < length; count++) { level = level.flatMap(prefix => [...alphabet].map(letter => prefix + letter)); all.push(...level); }
			return all;
		};
		for (const pattern of combinations("ab*", 4)) {
			const reference = new RegExp(`^${pattern.replaceAll("*", ".*")}$`, "i");
			for (const value of combinations("ab", 5)) expect(capturePatternMatches(pattern, value)).toBe(reference.test(value));
		}
	});

	it("treats regex operators literally and matches multiline data under a broad wildcard", () => {
		expect(capturePatternMatches("EXAMPLE.COM/*", "example.com/notes")).toBe(true);
		expect(capturePatternMatches("a?b+[c]", "a?b+[c]")).toBe(true);
		expect(capturePatternMatches("a?b+[c]", "abbbc")).toBe(false);
		expect(capturePatternMatches("*", "generated\nprivate text")).toBe(true);
	});

	it("reports an indeterminate adversarial match within a bounded amount of work", () => {
		const started = performance.now();
		expect(() => capturePatternMatches(`*${"a".repeat(1_000)}b`, "a".repeat(8_000))).toThrow(CapturePatternLimitError);
		expect(performance.now() - started).toBeLessThan(1_000);
	});
});
