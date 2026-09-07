import { describe, expect, it } from "vitest";
import {
	annotateAccessibilityTree,
	isBrowserElementRef,
	isSensitiveBrowserInteractiveRef,
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

	it("identifies explicit secret fields without treating ordinary form fields as secret", () => {
		for (const name of [
			"New password",
			"One-time code",
			"Verification code",
			"OTP",
			"one-time-code",
			"Recovery passcode",
			"Security PIN",
			"CVV",
			"CVC",
			"cc-csc",
			"API key",
			"API token",
			"Personal access token",
			"Private key",
		])
			expect(isSensitiveBrowserInteractiveRef({ name })).toBe(true);
		for (const name of ["Email address", "Full name", "Search", "Country"])
			expect(isSensitiveBrowserInteractiveRef({ name })).toBe(false);
	});

	it("redacts sensitive accessibility field values before exposing a snapshot", () => {
		const secret = "not-visible-outside-the-password-field";
		const result = annotateAccessibilityTree({
			nodes: [
				{
					nodeId: "1",
					role: { value: "textbox" },
					name: { value: "Password" },
					value: { value: secret },
					properties: [
						{ name: "autocomplete", value: { value: "current-password" } },
						{ name: "value", value: { value: secret } },
					],
					backendDOMNodeId: 1,
				},
			],
		});

		expect(JSON.stringify(result)).not.toContain(secret);
		expect(result.interactive).toEqual([
			{
				ref: "e1",
				role: "textbox",
				name: "Sensitive field",
				backendDOMNodeId: 1,
			},
		]);
		expect(isSensitiveBrowserInteractiveRef(result.interactive[0]!)).toBe(true);
	});

	it("uses autocomplete metadata to redact OTP and card-security fields", () => {
		const otp = "never-show-otp";
		const csc = "never-show-csc";
		const result = annotateAccessibilityTree({
			nodes: [
				{
					nodeId: "otp",
					role: { value: "textbox" },
					name: { value: "Confirm" },
					value: { value: otp },
					properties: [
						{ name: "autocomplete", value: { value: "one-time-code" } },
					],
					backendDOMNodeId: 1,
				},
				{
					nodeId: "csc",
					role: { value: "textbox" },
					name: { value: "Verification" },
					value: { value: csc },
					properties: [
						{ name: "autocomplete", value: { value: "cc-csc" } },
					],
					backendDOMNodeId: 2,
				},
			],
		});

		expect(result.interactive.every(isSensitiveBrowserInteractiveRef)).toBe(true);
		expect(JSON.stringify(result)).not.toContain(otp);
		expect(JSON.stringify(result)).not.toContain(csc);
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
