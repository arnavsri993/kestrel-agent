import { describe, expect, it } from "vitest";
import { learnedSkillDisplayName } from "./learned-skill-presentation";

describe("learned skill presentation", () => {
	it("turns generated skill slugs into readable labels", () => {
		expect(
			learnedSkillDisplayName(
				"create-a-concise-checklist-for-reviewing-pull-requests",
			),
		).toBe("Create a concise checklist for reviewing pull requests");
		expect(learnedSkillDisplayName("PR_review")).toBe("PR review");
	});

	it("preserves a non-empty fallback for unusual names", () => {
		expect(learnedSkillDisplayName("---")).toBe("---");
	});
});
