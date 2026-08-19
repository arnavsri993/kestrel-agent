import { describe, expect, it } from "vitest";
import {
	annotateAccessibilityTree,
	isBrowserElementRef,
	normalizeBrowserElementRef,
} from "./browser-element-refs";

describe("browser element refs", () => {
	it("assigns e1/e2 to a button and link without mutating frozen input", () => {
		const button = Object.freeze({
			nodeId: "1",
			role: { value: "button" },
			name: { value: "Save" },
			backendDOMNodeId: 11,
		});
		const link = Object.freeze({
			nodeId: "2",
			role: { value: "link" },
			name: { value: "Docs" },
			backendDOMNodeId: 12,
		});
		const tree = Object.freeze({
			nodes: Object.freeze([
				Object.freeze({
					nodeId: "root",
					role: { value: "WebArea" },
					name: { value: "Example" },
				}),
				button,
				link,
			]),
		});

		const result = annotateAccessibilityTree(tree);

		expect(result.truncated).toBe(false);
		expect(result.interactive).toEqual([
			{ ref: "e1", role: "button", name: "Save", backendDOMNodeId: 11 },
			{ ref: "e2", role: "link", name: "Docs", backendDOMNodeId: 12 },
		]);
		expect(result.accessibilityTree).toMatchObject({
			nodes: [
				{ nodeId: "root", role: { value: "WebArea" } },
				{ nodeId: "1", ref: "e1", role: { value: "button" } },
				{ nodeId: "2", ref: "e2", role: { value: "link" } },
			],
		});
		expect(button).not.toHaveProperty("ref");
		expect(link).not.toHaveProperty("ref");
		expect(tree.nodes[1]).toBe(button);
	});

	it("skips ignored nodes and still annotates nested children", () => {
		const result = annotateAccessibilityTree({
			role: "WebArea",
			name: "Page",
			children: [
				{
					role: "button",
					name: "Hidden",
					ignored: true,
					backendDOMNodeId: 1,
				},
				{
					role: "generic",
					children: [{ role: "link", name: "Visible", backendDOMNodeId: 2 }],
				},
			],
		});

		expect(result.interactive).toEqual([
			{ ref: "e1", role: "link", name: "Visible", backendDOMNodeId: 2 },
		]);
		expect(result.accessibilityTree).toMatchObject({
			children: [
				{ role: "button", name: "Hidden", ignored: true },
				{ children: [{ ref: "e1", role: "link" }] },
			],
		});
		expect(
			(result.accessibilityTree as { children: Array<{ ref?: string }> })
				.children[0],
		).not.toHaveProperty("ref");
	});

	it("normalizes snapshot refs and rejects CSS selectors", () => {
		expect(normalizeBrowserElementRef("@e3")).toBe("e3");
		expect(normalizeBrowserElementRef("ref=e1")).toBe("e1");
		expect(normalizeBrowserElementRef("e12")).toBe("e12");
		expect(normalizeBrowserElementRef("#main")).toBeUndefined();
		expect(normalizeBrowserElementRef("e0")).toBeUndefined();
		expect(isBrowserElementRef("@e3")).toBe(true);
		expect(isBrowserElementRef("#main")).toBe(false);
	});

	it("does not advertise refs that cannot be resolved", () => {
		const result = annotateAccessibilityTree({
			nodes: [
				{ nodeId: "1", role: "button", name: "Ghost" },
				{ nodeId: "2", role: "link", name: "Real", backendDOMNodeId: 9 },
			],
		});

		expect(result.interactive).toEqual([
			{ ref: "e1", role: "link", name: "Real", backendDOMNodeId: 9 },
		]);
		expect(result.accessibilityTree).toMatchObject({
			nodes: [
				{ nodeId: "1", role: "button", name: "Ghost" },
				{ nodeId: "2", ref: "e1", role: "link" },
			],
		});
		expect(
			(result.accessibilityTree as { nodes: Array<{ ref?: string }> }).nodes[0],
		).not.toHaveProperty("ref");
	});

	it("caps interactive refs and marks truncation", () => {
		const result = annotateAccessibilityTree(
			{
				nodes: [
					{ nodeId: "1", role: "button", name: "One", backendDOMNodeId: 1 },
					{ nodeId: "2", role: "link", name: "Two", backendDOMNodeId: 2 },
					{ nodeId: "3", role: "textbox", name: "Three", backendDOMNodeId: 3 },
				],
			},
			2,
		);

		expect(result.interactive.map((item) => item.ref)).toEqual(["e1", "e2"]);
		expect(result.truncated).toBe(true);
		expect(result.accessibilityTree).toMatchObject({
			nodes: [{ ref: "e1" }, { ref: "e2" }, { nodeId: "3", role: "textbox" }],
		});
		expect(
			(result.accessibilityTree as { nodes: Array<{ ref?: string }> }).nodes[2],
		).not.toHaveProperty("ref");
	});
});
