import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSidebar } from "./AgentSidebar";

afterEach(() => vi.unstubAllGlobals());
function render(width: number, collapsed = false) {
	vi.stubGlobal("window", { innerWidth: width });
	return renderToStaticMarkup(<AgentSidebar sessions={[]} activeSessionId={null}
		agentName="Agent" collapsed={collapsed} onNewAgent={() => undefined}
		onToggleAgent={() => undefined} onExpandChat={() => undefined}>
		<textarea aria-label="Message Agent" />
	</AgentSidebar>);
}

describe("responsive Agent chat presentation", () => {
	it("presents compact chat as a named modal with a clear close control", () => {
		const markup = render(800);
		expect(markup).toContain('role="dialog"');
		expect(markup).toContain('aria-modal="true"');
		expect(markup).toContain('aria-label="Agent chat"');
		expect(markup).toContain('aria-label="Close chat"');
		expect(markup).not.toContain('role="separator"');
	});
	it("keeps closed compact chat inert and out of the modal interaction path", () => {
		const markup = render(800, true);
		expect(markup).toContain('aria-hidden="true"');
		expect(markup).toContain('inert=""');
		expect(markup).not.toContain('aria-modal="true"');
	});
	it("keeps desktop chat resizable inside useful content and workspace bounds", () => {
		const markup = render(1440);
		expect(markup).toContain('role="separator"');
		expect(markup).toContain('aria-valuemin="480"');
		expect(markup).toContain('aria-valuemax="800"');
		expect(markup).not.toContain('role="dialog"');
	});
});
