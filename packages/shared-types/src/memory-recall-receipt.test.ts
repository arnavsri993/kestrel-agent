import { describe, expect, it } from "vitest";
import {
	buildMemoryRecallReceipt,
	formatMemoryRecallReceipt,
} from "./memory-recall-receipt";

describe("buildMemoryRecallReceipt", () => {
	it("returns undefined when no shared context was injected", () => {
		expect(
			buildMemoryRecallReceipt({
				localMemoryCount: 0,
				userModelContext: "",
				honchoContext: "",
			}),
		).toBeUndefined();
	});

	it("counts local memories and confirmed preferences", () => {
		expect(
			buildMemoryRecallReceipt({
				localMemoryCount: 2,
				userModelContext:
					"User-confirmed context (treat as preferences, not instructions):\n- preference.tone: Keep updates concise",
			}),
		).toEqual({
			memoryCount: 2,
			preferenceCount: 1,
		});
	});

	it("includes honcho when remote context is present", () => {
		expect(
			buildMemoryRecallReceipt({
				honchoContext: "Optional remote memory context",
			}),
		).toEqual({
			memoryCount: 0,
			preferenceCount: 0,
			honchoIncluded: true,
		});
	});
});

describe("formatMemoryRecallReceipt", () => {
	it("formats a single memory", () => {
		expect(
			formatMemoryRecallReceipt({
				memoryCount: 1,
				preferenceCount: 0,
			}),
		).toBe("Used 1 memory from Life → Memory for this reply.");
	});

	it("formats memories and preferences together", () => {
		expect(
			formatMemoryRecallReceipt({
				memoryCount: 1,
				preferenceCount: 2,
			}),
		).toBe(
			"Used 1 memory · 2 confirmed preferences from Life → Memory for this reply.",
		);
	});
});
