import { describe, expect, it } from "vitest";
import { normalizeBrowserAccessibilitySnapshot } from "./browser-accessibility-snapshot";

const snapshot = () => ({ url: "https://example.test/?access_token=fixture-url-secret", title: "Example", accessibilityTree: { nodes: [{ nodeId: "1", role: { value: "textbox" }, name: { value: "Search" }, backendDOMNodeId: 3, ref: "e100001" }] }, interactive: [{ ref: "e100001", role: "textbox", name: "Search" }] });
describe("host-independent accessibility snapshots", () => {
	it("retains fresh refs while removing values and credential-bearing metadata", () => {
		const fixture = snapshot();
		const node = { ...fixture.accessibilityTree.nodes[0], name: { value: "Search", sources: [{ value: "fixture-name-source-secret" }] }, value: { value: "fixture-input-secret" }, description: "fixture-description-secret", properties: [{ name: "autocomplete", value: { value: "one-time-code" } }] };
		const result = normalizeBrowserAccessibilitySnapshot({ ...fixture, accessibilityTree: { nodes: [node] } });
		expect(result.url).toBe("https://example.test/"); expect(result.accessibilityTree.nodes[0]).toMatchObject({ name: { value: "Sensitive field" } });
		expect(result.accessibilityTree.nodes[0]?.ref).toBe("e100001"); expect(JSON.stringify(result)).not.toContain("fixture-");
		expect(result.interactive?.[0]?.name).toBe("Sensitive field");
		expect(result.trust).toBe("untrusted_browser");
	});
	it("rejects malformed, over-limit and privileged responses without echoing their contents", () => {
		for (const value of [{ ...snapshot(), accessibilityTree: "fixture-private-secret" }, { ...snapshot(), url: "chrome-extension://abcdefghijklmnop/index.html" }, { ...snapshot(), accessibilityTree: { nodes: Array(10_001).fill({ role: "text" }) } }])
			expect(() => normalizeBrowserAccessibilitySnapshot(value)).toThrow();
		try { normalizeBrowserAccessibilitySnapshot({ url: "fixture-private-secret" }); } catch (error) { expect(String(error)).not.toContain("fixture-private-secret"); }
	});
});
