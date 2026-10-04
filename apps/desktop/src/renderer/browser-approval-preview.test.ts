import type { RuntimeToolExecution } from "@kestrel/shared-types";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { approvalPreviewText, browserApprovalPreview } from "./browser-approval-preview";
import { RuntimeApprovalPreview } from "./components/RuntimeApprovalPreview";

function execution(toolName: string, input: Record<string, unknown>, preview?: string): RuntimeToolExecution {
	return {
		id: "preview-fixture", sessionId: "fixture-session", toolName, input,
		status: "blocked", riskLevel: "sensitive", startedAt: "2026-10-03T23:00:00.000Z",
		...(preview === undefined ? {} : { output: { preview } }),
	};
}

describe("browser approval preview", () => {
	it("shows every allowed site with its exact scheme and port", () => {
		const allowedOrigins = ["https://alpha.test", "http://127.0.0.1:63660", "https://alpha.test"];
		expect(browserApprovalPreview(execution("browser.create", { allowedOrigins }))?.values).toEqual(allowedOrigins);
	});

	it("preserves the full navigation URL rather than a shortened host label", () => {
		const url = `https://alpha.test/path?complete=${"abc".repeat(600)}#fragment`;
		expect(browserApprovalPreview(execution("browser.navigate", { browserSessionId: "opaque-fixture", url }))?.values).toEqual([url]);
	});

	it("uses the protected preview instead of recovering redacted argument content", () => {
		const item = execution("browser.navigate", { browserSessionId: "opaque", url: "https://alpha.test/?key=private-fixture" },
			JSON.stringify({ browserSessionId: "opaque", url: "https://alpha.test/?key=[REDACTED]" }));
		expect(browserApprovalPreview(item)?.values).toEqual(["https://alpha.test/?key=[REDACTED]"]);
		expect(renderToStaticMarkup(createElement(RuntimeApprovalPreview, { execution: item }))).not.toContain("private-fixture");
	});

	it.each(["Private request expired. Request a fresh approval.", "", '{"allowedOrigins":["https://incomplete.test"'])(
		"keeps a non-JSON or incomplete protected preview verbatim: %s", (preview) => {
			const item = execution("browser.create", { allowedOrigins: ["https://private-fixture.test"] }, preview);
			expect(browserApprovalPreview(item)).toBeNull();
			expect(approvalPreviewText(item)).toBe(preview);
		});

	it.each([
		execution("browser.create", { allowedOrigins: ["https://alpha.test"], futureScope: "important" }),
		execution("browser.navigate", { browserSessionId: "opaque", url: "https://alpha.test", method: "POST" }),
		execution("browser.create", { allowedOrigins: [] }),
		execution("browser.create", { allowedOrigins: [123] }),
		execution("browser.navigate", { browserSessionId: "", url: "https://alpha.test" }),
		execution("browser.act", { action: { kind: "click", target: "e12" } }),
	])("retains the full original preview for unknown fields, tools, or missing scope", (item) => {
		expect(browserApprovalPreview(item)).toBeNull();
		expect(approvalPreviewText(item)).toBe(JSON.stringify(item.input, null, 2));
	});

	it("renders URL text without creating active links or interpreting markup", () => {
		const item = execution("browser.navigate", { browserSessionId: "opaque", url: '<script>alert("fixture")</script>' });
		const markup = renderToStaticMarkup(createElement(RuntimeApprovalPreview, { execution: item }));
		expect(markup).toContain("&lt;script&gt;");
		expect(markup).not.toMatch(/<(?:script|a)\b/);
	});

	it.each([
		[{ type: "click", target: "e12" }, "Click an observed page element", ["e12"]],
		[{ type: "type", target: "e2", text: "Complete text\nSecond line" }, "Enter text", ["e2", "Complete text\nSecond line"]],
		[{ type: "select", target: "e3", value: "Exact option" }, "Select an option", ["e3", "Exact option"]],
		[{ type: "key", key: "Enter" }, "Press a key", ["Enter"]],
		[{ type: "scroll", x: 0, y: -250 }, "Scroll the page", ["Horizontal: 0", "Vertical: -250"]],
	])("explains known actions and retains their complete arguments: %j", (action, description, values) => {
		const item = execution("browser.act", { browserSessionId: "opaque-fixture", action });
		const preview = browserApprovalPreview(item);
		expect(preview?.description).toContain(description);
		expect(preview?.values).toEqual(values);
		const markup = renderToStaticMarkup(createElement(RuntimeApprovalPreview, { execution: item }));
		expect(markup).toContain("Action details");
		expect(markup).toContain("opaque-fixture");
	});

	it("never recovers private typing arguments from an expired or redacted preview", () => {
		const input = { browserSessionId: "opaque", action: { type: "type", target: "e2", text: "private-fixture" } };
		for (const preview of ["Private request expired.", JSON.stringify({ ...input, action: { ...input.action, text: "[REDACTED]" } })]) {
			const markup = renderToStaticMarkup(createElement(RuntimeApprovalPreview, { execution: execution("browser.act", input, preview) }));
			expect(markup).not.toContain("private-fixture");
			expect(markup).toContain(preview.startsWith("{") ? "[REDACTED]" : "Private request expired.");
		}
	});

	it.each([
		{ type: "click", target: "e1", futureFlag: true },
		{ type: "click", target: "#page-selector" },
		{ type: "scroll", x: null, y: 10 },
		{ type: "key", key: "" },
		{ type: "submit", target: "e1" },
	])("keeps unsupported action previews complete: %j", action => {
		const item = execution("browser.act", { browserSessionId: "opaque", action });
		expect(browserApprovalPreview(item)).toBeNull();
		expect(approvalPreviewText(item)).toBe(JSON.stringify(item.input, null, 2));
	});
});
