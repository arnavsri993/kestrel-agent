import { describe, expect, it } from "vitest";
import {
	agentUniverseColorFor,
	defaultAgentUniverseColorId,
} from "./agent-universe-theme";

describe("agent universe system colors", () => {
	it("assigns a stable traffic-light identity independent of status", () => {
		const color = defaultAgentUniverseColorId("system", "active");
		expect(color).toBe(defaultAgentUniverseColorId("system", "failed"));
		expect(["red", "yellow", "green"]).toContain(color);
	});

	it("keeps an explicit system color ahead of status", () => {
		expect(agentUniverseColorFor("system", { system: "red" }, "active").id).toBe(
			"red",
		);
	});
});
