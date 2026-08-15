import { describe, expect, it } from "vitest";
import {
	DeepLinkQueue,
	deepLinksFromArgv,
	parseKestrelDeepLink,
	parseWebUrl,
	urlsFromArgv,
} from "./deep-links";

describe("desktop deep links", () => {
	it("accepts only bounded canonical Kestrel URLs", () => {
		expect(parseKestrelDeepLink("kestrel://chat/session-1?focus=1")).toBe(
			"kestrel://chat/session-1?focus=1",
		);
		expect(parseKestrelDeepLink("https://example.com/")).toBeUndefined();
		expect(
			parseKestrelDeepLink("kestrel://user:secret@chat/session-1"),
		).toBeUndefined();
		expect(parseKestrelDeepLink("kestrel://chat/\nnext")).toBeUndefined();
	});

	it("parses valid web URLs for browser tabs", () => {
		expect(parseWebUrl("https://example.com/page?query=1")).toBe(
			"https://example.com/page?query=1",
		);
		expect(parseWebUrl("http://localhost:3000/")).toBe(
			"http://localhost:3000/",
		);
		expect(parseWebUrl("file:///Users/user/index.html")).toBe(
			"file:///Users/user/index.html",
		);
		expect(parseWebUrl("kestrel://chat/session-1")).toBeUndefined();
		expect(parseWebUrl("javascript:alert(1)")).toBeUndefined();
		expect(parseWebUrl("data:text/html,<h1>hi</h1>")).toBeUndefined();
		expect(parseWebUrl("not a url")).toBeUndefined();
	});

	it("extracts launch URLs and queues them until delivery succeeds", () => {
		expect(
			deepLinksFromArgv([
				"/Applications/Kestrel.app/Contents/MacOS/Kestrel",
				"--flag",
				"kestrel://chat/session-1",
			]),
		).toEqual(["kestrel://chat/session-1"]);

		const queue = new DeepLinkQueue();
		expect(queue.enqueue("kestrel://chat/session-1")).toBe(true);
		expect(queue.enqueue("kestrel://chat/session-1")).toBe(true);
		expect(queue.enqueue("https://example.com/")).toBe(false);
		expect(queue.size).toBe(1);
		expect(
			queue.drain(() => {
				throw new Error("renderer not ready");
			}),
		).toBe(0);
		expect(queue.size).toBe(1);
		const delivered: string[] = [];
		expect(queue.drain((value) => delivered.push(value))).toBe(1);
		expect(delivered).toEqual(["kestrel://chat/session-1"]);
		expect(queue.size).toBe(0);
	});

	it("extracts both deep links and web URLs from argv", () => {
		const result = urlsFromArgv([
			"/Applications/Kestrel.app/Contents/MacOS/Kestrel",
			"--flag",
			"kestrel://chat/session-1",
			"https://news.ycombinator.com",
			"http://localhost:8080/dashboard",
			"invalid-url",
		]);
		expect(result.deepLinks).toEqual(["kestrel://chat/session-1"]);
		expect(result.webUrls).toEqual([
			"https://news.ycombinator.com/",
			"http://localhost:8080/dashboard",
		]);
	});
});
