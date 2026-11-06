import { describe, expect, it } from "vitest";
import {
	FIRST_TASK_PROMPT,
	FIRST_TASK_PURPOSE,
	FIRST_TASK_PROMPT_SIGNATURE,
	FIRST_TASK_SLOW_MODEL_NOTICE,
	isFirstTaskPrompt,
} from "./first-task";

describe("first-task onboarding prompt", () => {
	it("grants the first-run purpose only to the exact onboarding prompt", () => {
		expect(isFirstTaskPrompt(FIRST_TASK_PROMPT)).toBe(true);
		expect(FIRST_TASK_PURPOSE).toBe("first-run-read-only-check");
		expect(isFirstTaskPrompt("  " + FIRST_TASK_PROMPT)).toBe(false);
		expect(isFirstTaskPrompt(FIRST_TASK_PROMPT + " Please also inspect settings.")).toBe(false);
		expect(isFirstTaskPrompt(FIRST_TASK_PROMPT_SIGNATURE)).toBe(false);
		expect(isFirstTaskPrompt("Help me finish setup")).toBe(false);
	});

	it("requires a deterministic read-only path without network or approvals", () => {
		const prompt = FIRST_TASK_PROMPT.toLowerCase();
		expect(prompt).toContain("no network");
		expect(prompt).toContain("tools.search");
		expect(prompt).toContain("workspace.list");
		expect(prompt).toContain("do not edit files");
		expect(prompt).not.toContain("suggest one");
	});

	it("documents slow-model expectations for the first guided run", () => {
		expect(FIRST_TASK_SLOW_MODEL_NOTICE).toMatch(/1.?2 minutes/i);
		expect(FIRST_TASK_SLOW_MODEL_NOTICE).toMatch(/retry/i);
	});
});
