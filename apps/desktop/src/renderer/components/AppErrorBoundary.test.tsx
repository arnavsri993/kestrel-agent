import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppErrorBoundary, formatDiagnostics } from "./AppErrorBoundary";

describe("AppErrorBoundary", () => {
	it("renders children when nothing has failed", () => {
		const markup = renderToStaticMarkup(
			<AppErrorBoundary>
				<p>Workspace ready</p>
			</AppErrorBoundary>,
		);
		expect(markup).toBe("<p>Workspace ready</p>");
	});

	it("derives the calm fallback state from a thrown error", () => {
		const state = AppErrorBoundary.getDerivedStateFromError(new Error("boom"));
		expect(state.hasError).toBe(true);

		const boundary = new AppErrorBoundary({ children: null });
		boundary.state = { ...boundary.state, ...state };
		const markup = renderToStaticMarkup(<>{boundary.render()}</>);
		expect(markup).toContain("Kestrel hit a problem");
		expect(markup).toContain("local data are preserved");
		expect(markup).toContain(">Reload</button>");
		expect(markup).toContain(">Copy diagnostics</button>");
	});

	it("formats diagnostics with the error, report path, and component stack", () => {
		const text = formatDiagnostics({
			error: new Error("render failed"),
			componentStack: "\n    at Composer\n    at App",
			reportPath: "/tmp/kestrel-report.json",
			globalError: { message: "late rejection", at: "2026-10-14T00:00:00.000Z" },
		});
		expect(text).toContain("Kestrel renderer error: render failed");
		expect(text).toContain("Diagnostic report: /tmp/kestrel-report.json");
		expect(text).toContain("Component stack:\nat Composer");
		expect(text).toContain("Last global error (2026-10-14T00:00:00.000Z): late rejection");
	});
});
