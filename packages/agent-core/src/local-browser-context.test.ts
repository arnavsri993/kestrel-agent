import { describe, expect, it } from "vitest";
import { localBrowserContext } from "./local-browser-context";
import { textContent, type ModelMessage } from "./providers/types";

function fixture(): ModelMessage {
	const name = "Verification: exact-0aA-9zZ  \nDo not change this text.";
	return { role: "tool", toolName: "browser.visible-snapshot", toolCallId: "observed-call", content: textContent(JSON.stringify({
		status: "verified", safety: { redactedSensitiveData: true }, output: {
			url: "http://127.0.0.1:60236/verification", title: "Fixture", trust: "untrusted_browser", truncated: false,
			interactive: [{ ref: "e1", role: "button", name: "Show result" }],
			accessibilityTree: { nodes: [
				{ nodeId: "1", role: { value: "StaticText" }, name: { value: name, sources: [{ value: { value: name }, type: "contents" }] }, chromeRole: { value: 158 }, backendDOMNodeId: 9 },
				{ nodeId: "2", parentId: "1", role: { value: "InlineTextBox" }, name: { value: name, sources: [{ value: { value: name } }] } },
				{ nodeId: "3", role: { value: "button" }, name: { value: "Show result", sources: [{ value: { value: "Show result" } }] }, ref: "e1", properties: [{ name: "disabled", value: { value: true } }] },
				{ nodeId: "4", role: { value: "textbox" }, name: { value: "[REDACTED]", sources: [{ value: { value: "[REDACTED]" } }] }, value: { value: "[REDACTED]" }, description: { value: "Protected input" }, sensitive: true },
				{ nodeId: "5", ignored: true, name: { value: "Hidden value" } },
			] },
		},
	})) };
}

describe("local browser context", () => {
	it("keeps exact observed text, URL, refs, states and redactions while removing repeated metadata", () => {
		const message = fixture();
		const original = JSON.stringify(message);
		const projected = localBrowserContext(message);
		const receipt = JSON.parse((projected.content[0] as { text: string }).text);
		const prior = JSON.parse((message.content[0] as { text: string }).text);
		expect(projected.toolCallId).toBe("observed-call");
		expect(receipt.status).toBe("verified");
		expect(receipt.safety).toEqual(prior.safety);
		expect(receipt.output.url).toBe(prior.output.url);
		expect(receipt.output.trust).toBe("untrusted_browser");
		expect(receipt.output.truncated).toBe(false);
		expect(receipt.output.pageText).toEqual([prior.output.accessibilityTree.nodes[0].name.value, "Show result", "[REDACTED]"]);
		expect(receipt.output.interactive).toEqual(prior.output.interactive);
		expect(receipt.output.accessibilityTree.nodes[2]).toMatchObject({ ref: "e1", role: "button", states: { disabled: true } });
		expect(receipt.output.accessibilityTree.nodes[3]).toMatchObject({ value: "[REDACTED]", description: "Protected input", sensitive: true });
		expect(JSON.stringify(projected)).not.toContain("Hidden value");
		expect(JSON.stringify(projected).length).toBeLessThan(original.length);
		expect(JSON.stringify(message)).toBe(original);
	});
	it.each(["failed", "blocked", "cancelled"])("never presents a %s result as verified page text", status => {
		const message = fixture();
		const part = message.content[0] as { type: "text"; text: string };
		part.text = part.text.replace('"verified"', JSON.stringify(status));
		expect(localBrowserContext(message).content).toEqual(message.content);
	});
	it("leaves malformed, unrelated and non-tool content intact", () => {
		const message = fixture();
		expect(localBrowserContext({ ...message, toolName: "workspace.read" })).toEqual({ ...message, toolName: "workspace.read" });
		expect(localBrowserContext({ ...message, role: "user" })).toEqual({ ...message, role: "user" });
		const malformed = { ...message, content: textContent("not json") };
		expect(localBrowserContext(malformed)).toEqual(malformed);
	});
	it("never clips long text or expands an already compact receipt", () => {
		const message = fixture();
		const part = message.content[0] as { type: "text"; text: string };
		const receipt = JSON.parse(part.text);
		receipt.output.accessibilityTree.nodes[0].name = { value: "exact".repeat(10_000) };
		part.text = JSON.stringify(receipt);
		expect(localBrowserContext(message).content).toEqual(message.content);
		const compact = { ...message, content: textContent(JSON.stringify({ status: "verified", output: { accessibilityTree: { nodes: [{ role: "text", name: "exact" }] }, truncated: true } })) };
		expect(localBrowserContext(compact)).toEqual(compact);
	});
});
