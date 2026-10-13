import { describe, expect, it } from "vitest";
import {
	BrowserBackendRequestMessageSchema,
	BrowserBackendWireRequestSchema,
	DesktopActionSchema,
} from "./browser-backend-wire";

describe("browser backend wire schema", () => {
	it("requires screenshot provenance and validates desktop keyboard chords", () => {
		expect(DesktopActionSchema.safeParse({ type: "key", key: "a", captureId: "capture-1", modifiers: ["Command", "Shift"] }).success).toBe(true);
		expect(DesktopActionSchema.safeParse({ type: "key", key: "PageDown", captureId: "capture-1" }).success).toBe(true);
		for (const action of [
			{ type: "click", x: 1, y: 1 },
			{ type: "key", key: "a", captureId: "capture-1", modifiers: ["Command", "Command"] },
			{ type: "key", key: "a", captureId: "capture-1", modifiers: ["Meta"] },
			{ type: "key", key: "a; quit", captureId: "capture-1" },
		]) expect(DesktopActionSchema.safeParse(action).success).toBe(false);
	});
	it("accepts a valid visible-tabs request envelope", () => {
		expect(
			BrowserBackendRequestMessageSchema.parse({
				type: "browser-backend-request",
				requestId: "req-1",
				request: { operation: "visible-tabs" },
			}).request.operation,
		).toBe("visible-tabs");
	});

	it("rejects desktop-act with a non-integer coordinate or unknown key", () => {
		expect(
			DesktopActionSchema.safeParse({
				type: "click",
				x: "10",
				y: 20,
			}).success,
		).toBe(false);
		expect(
			DesktopActionSchema.safeParse({
				type: "key",
				key: "Meta",
			}).success,
		).toBe(false);
	});

	it("rejects visible-act without an action payload", () => {
		expect(
			BrowserBackendWireRequestSchema.safeParse({
				operation: "visible-act",
			}).success,
		).toBe(false);
	});

	it("accepts bounded semantic select actions and rejects extra value fields", () => {
		expect(
			BrowserBackendWireRequestSchema.safeParse({
				operation: "act",
				sessionId: "electron-browser-1",
				action: { type: "select", target: "e2", value: "us" },
			}).success,
		).toBe(true);
		expect(
			BrowserBackendWireRequestSchema.safeParse({
				operation: "visible-act",
				tabId: "tab-00000000-0000-4000-8000-000000000000",
				action: {
					type: "select",
					target: "#country",
					value: "us",
					label: "United States",
				},
			}).success,
		).toBe(false);
	});

	it("rejects unknown operations and extra keys", () => {
		expect(
			BrowserBackendWireRequestSchema.safeParse({
				operation: "pwn",
			}).success,
		).toBe(false);
		expect(
			BrowserBackendWireRequestSchema.safeParse({
				operation: "snapshot",
				sessionId: "electron-browser-1",
				extra: true,
			}).success,
		).toBe(false);
	});
});
