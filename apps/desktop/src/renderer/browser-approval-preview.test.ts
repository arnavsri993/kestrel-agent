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

	it("shows the manager-observed label, exact ref, and sanitized page for a correlated click", () => {
		const input = { browserSessionId: "opaque-fixture", action: { type: "click", target: "e1" } };
		const item = execution("browser.act", input);
		item.output = { ...item.output, approvalContext: { browserTarget: {
			surface: "isolated", browserSessionId: input.browserSessionId,
			target: "e1", role: "button", observedLabel: "Reveal verification",
			url: "https://example.test/verify?step=1", trust: "untrusted_browser",
		} } };

		expect(browserApprovalPreview(item)).toMatchObject({
			label: "Observed target",
			values: [
				"Reveal verification (button)",
				"Reference: e1",
				"Page: https://example.test/verify?step=1",
			],
		});
		const markup = renderToStaticMarkup(createElement(RuntimeApprovalPreview, { execution: item }));
		expect(markup).toContain("Reveal verification");
		expect(markup).toContain("Reference: e1");
		expect(markup).toContain("opaque-fixture");
	});

	it("ignores hostile or mismatched display metadata and preserves the exact action preview", () => {
		const input = { browserSessionId: "opaque", action: { type: "click", target: "e1" } };
		for (const browserTarget of [
			{ surface: "isolated", browserSessionId: "other", target: "e1" },
			{ surface: "isolated", browserSessionId: "opaque", target: "e2" },
			{ surface: "visible", tabId: "opaque", target: "e1" },
		]) {
			const item = execution("browser.act", input);
			item.output = { ...item.output, approvalContext: { browserTarget: {
				...browserTarget,
				role: "button", observedLabel: "Model supplied override",
				url: "https://attacker.test/", trust: "untrusted_browser",
			} } };
			expect(browserApprovalPreview(item)?.values).toEqual(["e1"]);
			expect(approvalPreviewText(item)).toBe(JSON.stringify(input, null, 2));
		}
	});

	it("renders correlated observed targets for the visible browser scope", () => {
		const tabId = "tab-00000000-0000-4000-8000-000000000000";
		const item = execution("browser.visible-act", { tabId, action: { type: "click", target: "e1" } });
		item.output = { ...item.output, approvalContext: { browserTarget: {
			surface: "visible", tabId, target: "e1", role: "button",
			observedLabel: "Reveal verification", url: "https://example.test/", trust: "untrusted_browser",
		} } };
		expect(browserApprovalPreview(item)).toMatchObject({
			description: expect.stringContaining("user-visible browser"),
			values: expect.arrayContaining(["Reveal verification (button)", "Reference: e1"]),
		});
	});

	it("renders browser-supplied labels as inert text and bounds malformed context", () => {
		const input = { browserSessionId: "opaque", action: { type: "click", target: "e1" } };
		const target = {
			surface: "isolated", browserSessionId: "opaque", target: "e1", role: "button",
			observedLabel: '<script>ownedFixture()</script>', url: "https://example.test/", trust: "untrusted_browser",
		};
		const item = execution("browser.act", input);
		item.output = { approvalContext: { browserTarget: target } };
		const markup = renderToStaticMarkup(createElement(RuntimeApprovalPreview, { execution: item }));
		expect(markup).toContain("&lt;script&gt;");
		expect(markup).not.toMatch(/<(?:script|a)\b/);
		for (const override of [
			{ trust: "trusted" }, { observedLabel: "x".repeat(501) }, { role: "x".repeat(101) }, { url: "x".repeat(2_049) },
		]) {
			item.output = { approvalContext: { browserTarget: { ...target, ...override } } };
			expect(browserApprovalPreview(item)?.values).toEqual(["e1"]);
		}
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
