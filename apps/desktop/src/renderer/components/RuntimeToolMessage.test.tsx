import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RuntimeToolMessage, runtimeAssistantDisplayContent, runtimeToolMessagePresentation, runtimeToolTitle } from "./RuntimeToolMessage";

describe("assistant action-request presentation", () => {
	it("shows the delegated action while retaining the execution details", () => {
		const calls = [{ id: "delegate-fixture", name: "orchestration.delegate", arguments: { allowedTools: [], resourceScope: [] } }];
		expect(runtimeAssistantDisplayContent({ role: "assistant", content: "Requested tools: orchestration.delegate", modelToolCalls: calls })).toBe("Requested action: Delegate task.");
		const message = { id: "delegate-message-fixture", toolName: "orchestration.delegate", content: JSON.stringify({ status: "verified", output: { delegated: { sessionId: "child-fixture" } } }) };
		expect(runtimeToolMessagePresentation(message)?.title).toBe("Delegate task");
		const markup = renderToStaticMarkup(<RuntimeToolMessage message={message} />);
		expect(markup).toContain("Delegate task");
		expect(markup).toContain("orchestration.delegate");
		expect(markup).toContain("child-fixture");
	});

	const calls = [{ id: "call-1", name: "browser.create", arguments: { allowedOrigins: ["https://owned.test"] } }];
	it("labels an exact tool-only request without changing its recorded text or arguments", () => {
		const message = { role: "assistant" as const, content: "Requested tools: browser.create", modelToolCalls: calls };
		const recorded = JSON.stringify(message);
		expect(runtimeAssistantDisplayContent(message)).toBe("Requested action: Create browser session.");
		expect(JSON.stringify(message)).toBe(recorded);
	});
	it.each([
		{ role: "assistant" as const, content: "Requested tools: browser.create" },
		{ role: "user" as const, content: "Requested tools: browser.create", modelToolCalls: calls },
		{ role: "assistant" as const, content: "Requested tools: browser.create\nI will wait for approval.", modelToolCalls: calls },
		{ role: "assistant" as const, content: "Requested tools: workspace.write", modelToolCalls: calls },
		{ role: "assistant" as const, content: "Verification: ALPHA-EXACT\nObserved URL: https://owned.test/page" },
	])("preserves ordinary messages, exact answers and mismatched requests", message => {
		expect(runtimeAssistantDisplayContent(message)).toBe(message.content);
	});
	it("keeps multiple requests descriptive without exposing unknown implementation names", () => {
		expect(runtimeAssistantDisplayContent({ role: "assistant", content: "Requested tools: browser.navigate, custom.internal", modelToolCalls: [
			{ id: "open", name: "browser.navigate", arguments: {} },
			{ id: "custom", name: "custom.internal", arguments: {} },
		] })).toBe("Requested actions: Open page, Run an action.");
	});
});

describe("chat tool result presentation", () => {
	it.each(["toString", "constructor", "__proto__"])("uses a safe label for the unknown tool %s", name => {
		expect(runtimeToolTitle(name, "Requested action")).toBe("Requested action");
		expect(renderToStaticMarkup(<RuntimeToolMessage message={{ id: "unknown", toolName: name, content: JSON.stringify({ status: "blocked" }) }} />)).toContain("Tool result");
	});
	it("keeps a large browser snapshot in closed details", () => {
		const message = { id: "snapshot", toolName: "browser.visible-snapshot", content: JSON.stringify({ status: "verified", output: { url: "https://example.test/page?private=value", accessibilityTree: "Large observation ".repeat(4_000) } }) };
		const result = runtimeToolMessagePresentation(message);
		expect(result).toMatchObject({ title: "Read page", status: "verified", context: "example.test", label: "Done" });
		const markup = renderToStaticMarkup(<RuntimeToolMessage message={message} />);
		expect(markup).toContain("<details><summary>");
		expect(markup).not.toContain("<details open");
		expect(markup.indexOf("Large observation")).toBeGreaterThan(markup.indexOf("</summary>"));
		expect(markup.slice(0, markup.indexOf("</summary>"))).not.toContain("private=value");
	});
	it.each(["failed", "blocked", "cancelled", "running", "unknown"])("never marks a %s result successful", status => {
		const result = runtimeToolMessagePresentation({ toolName: "browser.open-tab", content: JSON.stringify({ status, error: "The page was unavailable." }) });
		expect(result?.status).toBe(status);
		expect(result?.label).not.toBe("Done");
	});
	it("keeps errors visible outside the disclosure", () => {
		const markup = renderToStaticMarkup(<RuntimeToolMessage message={{ id: "failed", toolName: "browser.snapshot", content: JSON.stringify({ status: "failed", error: "Read a visible tab with browser.visible-snapshot." }) }} />);
		expect(markup.indexOf('class="runtime-tool-error"')).toBeGreaterThan(markup.indexOf("</details>"));
		expect(markup).toContain("Read a visible tab with browser.visible-snapshot.");
	});
	it("distinguishes approval from a policy block and a failing command", () => {
		expect(runtimeToolMessagePresentation({ content: JSON.stringify({ status: "blocked", output: { approvalRequired: true } }) })?.label).toBe("Needs approval");
		expect(runtimeToolMessagePresentation({ content: JSON.stringify({ status: "blocked", output: { approvalRequired: false } }) })?.label).toBe("Blocked");
		expect(runtimeToolMessagePresentation({ toolName: "execution.run", content: JSON.stringify({ status: "verified", output: { exitCode: 1 } }) })).toMatchObject({ status: "failed", error: "Command exited with code 1." });
	});
	it("preserves plain cleanup receipts and never verifies malformed JSON", () => {
		const receipt = { id: "cleanup", content: "Temporary credential cleanup verified in Kestrel's temporary store only." };
		expect(runtimeToolMessagePresentation(receipt)).toBeNull();
		expect(renderToStaticMarkup(<RuntimeToolMessage message={receipt} />)).toContain(receipt.content.replaceAll("'", "&#x27;"));
		expect(runtimeToolMessagePresentation({ content: "{broken" })?.status).toBe("unknown");
	});
	it("keeps output withholding explicit", () => {
		expect(runtimeToolMessagePresentation({ content: JSON.stringify({ status: "verified", output: { outputWithheld: true } }) })?.withheld).toBe(true);
	});
});
