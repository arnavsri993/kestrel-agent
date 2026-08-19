import { describe, expect, it } from "vitest";
import {
	type BrowserAction,
	type BrowserAutomationBackend,
	BrowserController,
	type BrowserSnapshot,
	 type ScreenshotFrame,
} from "./browser-automation";
import { diffBrowserSnapshots } from "./browser-observation";

function snapshot(
	url: string,
	title: string,
	accessibilityTree: unknown,
): BrowserSnapshot {
	return { url, title, accessibilityTree };
}

describe("browser observation diffs", () => {
	it("reports semantic changes without returning raw trees or sensitive URL parts", () => {
		const before = snapshot(
			"https://example.test/?token=old#private-fragment",
			" Example   page ",
			{
				nodes: [
					{
						nodeId: "1",
						role: { value: "RootWebArea" },
						name: { value: "Example" },
					},
					{
						nodeId: "2",
						role: { value: "button" },
						name: { value: "Save" },
						properties: [
							{ name: "disabled", value: { value: false } },
						],
					},
					{
						nodeId: "3",
						role: { value: "status" },
						name: { value: "Idle" },
					},
				],
			},
		);
		const after = snapshot(
			"https://example.test/?token=new#changed",
			"Saved",
			{
				nodes: [
					{
						nodeId: "1",
						role: { value: "RootWebArea" },
						name: { value: "Example" },
					},
					{
						nodeId: "2",
						role: { value: "button" },
						name: { value: "Save" },
						properties: [
							{ name: "disabled", value: { value: true } },
						],
					},
					{
						nodeId: "4",
						role: { value: "alert" },
						name: { value: "Saved" },
					},
				],
			},
		);

		const result = diffBrowserSnapshots(before, after);

		expect(result).toMatchObject({
			before: { url: "https://example.test/", title: "Example page" },
			after: { url: "https://example.test/", title: "Saved" },
			trust: "untrusted_browser",
			truncated: false,
		});
		expect(result.changed).toEqual([
			expect.objectContaining({
				key: "node:2",
				before: expect.objectContaining({
					role: "button",
					states: { disabled: "false" },
				}),
				after: expect.objectContaining({
					role: "button",
					states: { disabled: "true" },
				}),
			}),
		]);
		expect(result.added).toEqual([
			expect.objectContaining({ key: "node:4", role: "alert", name: "Saved" }),
		]);
		expect(result.removed).toEqual([
			expect.objectContaining({ key: "node:3", role: "status", name: "Idle" }),
		]);
		expect(JSON.stringify(result)).not.toContain("private-fragment");
		expect(JSON.stringify(result)).not.toContain("token");
	});

	it("bounds change buckets and marks truncation", () => {
		const before = snapshot("https://example.test", "Before", {
			nodes: [{ nodeId: "root", role: { value: "document" } }],
		});
		const after = snapshot(
			"https://example.test",
			"After",
			{
				nodes: Array.from({ length: 125 }, (_, index) => ({
					nodeId: `added-${index}`,
				role: { value: "button" },
				name: { value: `Action ${index}` },
			})),
			},
		);

		const result = diffBrowserSnapshots(before, after);

		expect(result.added).toHaveLength(100);
		expect(result.truncated).toBe(true);
	});

	it("returns the same observation contract for autonomous and visible actions", async () => {
		let autonomousVersion = 0;
		let visibleVersion = 0;
		const backend: BrowserAutomationBackend = {
			async createSession() {
				return "backend-session";
			},
			async navigate() {},
			async act(_id: string, _action: BrowserAction) {
				autonomousVersion += 1;
			},
			async snapshot() {
				return snapshot("https://example.test", "Example", {
					nodes: [
						{
							nodeId: "button",
							role: { value: "button" },
							name: { value: `Version ${autonomousVersion}` },
						},
					],
				});
			},
			async screenshot(): Promise<ScreenshotFrame> {
				return { width: 1, height: 1, rgba: Uint8Array.from([0, 0, 0, 255]) };
			},
			async visibleSnapshot() {
				return {
					...snapshot("https://example.test", "Visible", {
						nodes: [
							{
								nodeId: "visible-button",
								role: { value: "button" },
								name: { value: `Version ${visibleVersion}` },
							},
						],
					}),
					trust: "untrusted_browser" as const,
				};
			},
			async visibleAct() {
				visibleVersion += 1;
			},
			async close() {},
		};
		const controller = new BrowserController(backend);
		const signal = new AbortController().signal;
		const autonomous = await controller.create("owner", ["https://example.test"]);

		const autonomousResult = await controller.act(
			"owner",
			autonomous.browserSessionId,
			{ type: "click", target: "#save" },
			signal,
		);
		const visibleResult = await controller.visibleAct(
			"tab-00000000-0000-4000-8000-000000000000",
			{ type: "click", target: "#save" },
			signal,
		);

		expect(autonomousResult).toMatchObject({
			performed: true,
			observation: { trust: "untrusted_browser" },
		});
		expect(visibleResult).toMatchObject({
			performed: true,
			observation: { trust: "untrusted_browser" },
		});
		expect(autonomousResult.observation.changed).toHaveLength(1);
		expect(visibleResult.observation.changed).toHaveLength(1);
	});

	it("redacts userinfo and password query keys when the URL cannot be parsed", () => {
		const diff = diffBrowserSnapshots(
			snapshot("not a url user:pass@host?password=secret#frag", "Before", {
				nodes: [],
			}),
			snapshot("https://example.test/", "After", { nodes: [] }),
		);
		expect(diff.before.url).not.toMatch(/user:pass/);
		expect(diff.before.url).not.toMatch(/password=secret/);
		expect(diff.before.url).not.toMatch(/#frag/);
		expect(diff.trust).toBe("untrusted_browser");
	});

	it("marks truncated when a title exceeds the observation text bound", () => {
		const diff = diffBrowserSnapshots(
			snapshot("https://example.test/", "a".repeat(600), { nodes: [] }),
			snapshot("https://example.test/", "After", { nodes: [] }),
		);
		expect(diff.truncated).toBe(true);
		expect(diff.before.title).toHaveLength(500);
	});
});
