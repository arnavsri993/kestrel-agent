import { describe, expect, it } from "vitest";
import {
	BrowserBackendRequestMessageSchema,
	BrowserBackendWireRequestSchema,
	DesktopActionSchema,
} from "./browser-backend-wire";

describe("browser backend wire schema", () => {
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
