import { describe, expect, it } from "vitest";
import { petTaskSessionRequest } from "./pet-task";

describe("pet quick-task session", () => {
	it("creates a visible session without inheriting a workspace", () => {
		const request = petTaskSessionRequest("  Summarize the next safe step  ");
		expect(request).toEqual({
			type: "runtime-create-session",
			title: "Pet · Summarize the next safe step",
		});
		expect(request).not.toHaveProperty("workspaceRoot");
	});

	it("rejects empty and oversized tasks before creating a session", () => {
		expect(() => petTaskSessionRequest("   ")).toThrow("required");
		expect(() => petTaskSessionRequest("x".repeat(10_001))).toThrow(
			"10,000 characters",
		);
	});
});
