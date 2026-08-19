import { describe, expect, it } from "vitest";
import { RendererRequestSchema } from "@kestrel/shared-types";
import { canRegisterAsDefaultBrowser } from "./default-browser";

describe("default browser registration", () => {
	it("does not expose the Electron development shell as Kestrel", () => {
		expect(canRegisterAsDefaultBrowser(false)).toBe(false);
	});

	it("allows registration for the packaged Kestrel app", () => {
		expect(canRegisterAsDefaultBrowser(true)).toBe(true);
	});
});

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
