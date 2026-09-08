import { renderToStaticMarkup } from "react-dom/server";
import type { HumanInputRequest } from "@kestrel/shared-types";
import { describe, expect, it, vi } from "vitest";
import {
	focusQuestionCardControl,
	QUESTION_FOCUSABLE_SELECTOR,
	RuntimeQuestionCard,
} from "./RuntimeQuestionCard";

const baseRequest: HumanInputRequest = {
	id: "human-input-1",
	sessionId: "session-1",
	runId: "run-1",
	prompt: "Choose the review path",
	context: "This answer supplies context only.",
	options: [
		{ id: "quick", label: "Quick review", description: "Review the essential checks." },
		{ id: "full", label: "Full review" },
	],
	selectionMode: "single",
	allowFreeText: true,
	allowSkip: true,
	status: "waiting",
	createdAt: "2026-08-31T10:00:00.000Z",
};

describe("RuntimeQuestionCard", () => {
	it("renders an accessible inline choice card with native keyboard controls", () => {
		const markup = renderToStaticMarkup(<RuntimeQuestionCard request={baseRequest} />);

		expect(markup).toContain('aria-labelledby="human-input-prompt-human-input-1"');
		expect(markup).toContain("Choose one option");
		expect(markup).toContain('type="radio"');
		expect(markup).toContain("Quick review");
		expect(markup).toContain("Answer with text instead");
		expect(markup).toContain(">Skip</button>");
		expect(markup).toContain(">Cancel</button>");
		expect(markup).toContain(">Submit answer</button>");
	});

	it("renders multi-choice and free-text alternatives as real form controls", () => {
		const multiMarkup = renderToStaticMarkup(
			<RuntimeQuestionCard
				request={{ ...baseRequest, selectionMode: "multiple" }}
			/>,
		);
		expect(multiMarkup).toContain("Choose one or more options");
		expect(multiMarkup).toContain('type="checkbox"');

		const textMarkup = renderToStaticMarkup(
			<RuntimeQuestionCard
				request={{
					...baseRequest,
					id: "human-input-text",
					options: [],
					selectionMode: undefined,
				}}
			/>,
		);
		expect(textMarkup).toContain("Answer in your own words");
		expect(textMarkup).toContain("textarea");
	});

	it("focuses the first native control when a waiting card becomes active", () => {
		const focus = vi.fn();
		const querySelector = vi.fn(() => ({ focus }));
		focusQuestionCardControl({ querySelector } as unknown as HTMLElement);

		expect(querySelector).toHaveBeenCalledWith(QUESTION_FOCUSABLE_SELECTOR);
		expect(focus).toHaveBeenCalledOnce();
	});
});
