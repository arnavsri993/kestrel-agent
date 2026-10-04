import { MemoryDocumentSchema } from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import { isTaskResult, memoryDocumentTitle } from "./memory-document-display";

const result = MemoryDocumentSchema.parse({
	id: "workspace:agent-memory:agent-outcome-fixture", kind: "memory", title: "outcome",
	text: "Compared the two owned pages.\nFull retained result.", sourceIds: ["task:fixture"],
	origin: "legacy", createdAt: "2026-10-04T12:00:00.000Z", updatedAt: "2026-10-04T12:00:00.000Z",
});

describe("memory entry presentation", () => {
	it("recognizes generated results without modifying their full content", () => {
		expect(isTaskResult(result)).toBe(true);
		expect(memoryDocumentTitle(result)).toBe("Compared the two owned pages.");
		expect(result.text).toContain("Full retained result.");
	});
	it("preserves explicit titles and placement of manually saved or edited notes", () => {
		for (const document of [{ ...result, origin: "manual" as const }, { ...result, id: "manual-note" }]) {
			expect(isTaskResult(document)).toBe(false);
			expect(memoryDocumentTitle(document)).toBe("outcome");
		}
		expect(memoryDocumentTitle({ ...result, origin: "manual", title: "semantic" })).toBe("semantic");
	});
	it("keeps unknown legacy records in Notes instead of grouping by title alone", () => {
		expect(isTaskResult({ ...result, sourceIds: ["different-source"] })).toBe(false);
		expect(isTaskResult({ ...result, kind: "knowledge" })).toBe(false);
		expect(isTaskResult({ ...result, id: "legacy-note", title: "outcome" })).toBe(false);
	});
});
