import { describe, expect, it } from "vitest";
import { RendererRequestSchema } from "@kestrel/shared-types";

describe("default browser requests", () => {
	it("validates get-default-browser-status and set-default-browser renderer requests", () => {
		expect(
			RendererRequestSchema.safeParse({ type: "get-default-browser-status" })
				.success,
		).toBe(true);
		expect(
			RendererRequestSchema.safeParse({ type: "set-default-browser" }).success,
		).toBe(true);
		expect(
			RendererRequestSchema.safeParse({ type: "get-system-state" }).success,
		).toBe(true);
	});
});
