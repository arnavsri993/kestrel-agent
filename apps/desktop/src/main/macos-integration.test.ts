import { describe, expect, it } from "vitest";
import {
	dockIconSvg,
	menuBarIconSvg,
	visualStateForAgentState,
} from "./macos-integration";

describe("macOS agent presentation", () => {
	it("maps runtime states to restrained Dock and menu bar states", () => {
		expect(visualStateForAgentState("idle")).toBe("idle");
		expect(visualStateForAgentState("observing")).toBe("thinking");
		expect(visualStateForAgentState("working")).toBe("acting");
		expect(visualStateForAgentState("waiting_approval")).toBe("waiting");
		expect(visualStateForAgentState("paused")).toBe("idle");
	});

	it("keeps the idle menu bar icon calm and adds state detail only when needed", () => {
		const idle = menuBarIconSvg("idle");
		const waiting = menuBarIconSvg("waiting");

		expect(idle).toContain('fill="none"');
		expect(idle).not.toContain('<circle');
		expect(waiting).toContain('<circle');
	});

	it("renders completion as a finite Dock settle state", () => {
		const completed = dockIconSvg("completed");
		const acting = dockIconSvg("acting", 1);

		expect(completed).toContain("stroke=\"#b9e67c\"");
		expect(completed).toContain("stroke-linecap=\"round\"");
		expect(acting).toContain("M 252 784 L 772 784");
	});
});
