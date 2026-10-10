import type { RuntimeMessage } from "@kestrel/shared-types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewedAnswer, supersededAnswerIds } from "./ReviewedAnswer";

const message = (id: string, extra: Partial<RuntimeMessage> = {}): RuntimeMessage => ({
	id, sessionId: "session-one", role: "assistant", content: id,
	createdAt: "2026-10-10T20:00:00.000Z", ...extra,
});

describe("reviewed answer presentation", () => {
	it("folds only explicitly superseded earlier assistant answers in the same session", () => {
		const initial = message("initial");
		const final = message("final", { supersedesMessageId: "initial" });
		expect([...supersededAnswerIds([initial, final])]).toEqual(["initial"]);
		expect([...supersededAnswerIds([initial, message("ordinary")])]).toEqual([]);
		expect([...supersededAnswerIds([final, initial])]).toEqual([]);
		expect([...supersededAnswerIds([initial, { ...final, sessionId: "other" }])]).toEqual([]);
		expect([...supersededAnswerIds([{ ...initial, role: "user" }, final])]).toEqual([]);
		expect([...supersededAnswerIds([initial, { ...final, role: "tool" }])]).toEqual([]);
		const calls = [{ id: "call", name: "test.tool", arguments: {} }];
		expect([...supersededAnswerIds([{ ...initial, modelToolCalls: calls }, final])]).toEqual([]);
		expect([...supersededAnswerIds([initial, { ...final, modelToolCalls: calls }])]).toEqual([]);
		// A newest-page correction cannot hide unrelated loaded history.
		expect([...supersededAnswerIds([message("unrelated"), final])]).toEqual([]);
	});

	it("keeps the original answer recoverable in a closed native disclosure", () => {
		const draft = renderToStaticMarkup(<ReviewedAnswer superseded><p>Initial evidence</p></ReviewedAnswer>);
		expect(draft).toContain("<summary>Earlier draft</summary>");
		expect(draft).toContain("Initial evidence");
		expect(draft).not.toContain(" open=");
		expect(renderToStaticMarkup(<ReviewedAnswer superseded={false}><p>Corrected evidence</p></ReviewedAnswer>))
			.toBe("<p>Corrected evidence</p>");
	});
});
