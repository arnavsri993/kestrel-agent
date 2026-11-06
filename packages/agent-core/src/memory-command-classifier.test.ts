import { describe, expect, it } from "vitest";
import { isForgetConversationCommand } from "./memory-command-classifier";

describe("conversation forget command classification", () => {
	it.each([
		"Forget this conversation?!.",
		"DELETE everything you remembered about the current conversation",
		"Don’t use this conversation for memory!",
		"  Do not\nremember\tthis conversation for memory?  ",
		"remove the current conversation from memory.",
	])("recognizes an explicit command: %s", value => {
		expect(isForgetConversationCommand(value)).toBe(true);
	});

	it.each(["never forget this conversation", "forget this conversation later", "Discuss the command: forget this conversation", "!!!x"])(
		"does not reinterpret other text as deletion: %s", value => {
			expect(isForgetConversationCommand(value)).toBe(false);
		},
	);

	it("bounds long punctuation runs with both matching and nonmatching suffixes", () => {
		const punctuation = "!".repeat(500_000);
		const started = performance.now();
		expect(isForgetConversationCommand(`${punctuation}x`)).toBe(false);
		expect(isForgetConversationCommand(`forget this conversation${punctuation}`)).toBe(true);
		expect(performance.now() - started).toBeLessThan(1_000);
	});
});
