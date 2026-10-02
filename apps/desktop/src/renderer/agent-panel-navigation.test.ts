import { describe, expect, it } from "vitest";
import { dismissCompactChatForDestination } from "./agent-panel-navigation";

describe("chat and destination navigation", () => {
	it.each(["settings", "memory", "commands", "connections", undefined])(
		"reveals %s and leaves desktop chat available", destination => {
			expect(dismissCompactChatForDestination(800, destination)).toBe(true);
			expect(dismissCompactChatForDestination(1120, destination)).toBe(true);
			expect(dismissCompactChatForDestination(1440, destination)).toBe(false);
		},
	);
	it("preserves chat when starting or resuming a task in the Agent workspace", () => {
		expect(dismissCompactChatForDestination(800, "agent")).toBe(false);
	});
});
