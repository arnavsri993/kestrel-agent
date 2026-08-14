import { describe, expect, it } from "vitest";
import {
	DeepLinkQueue,
	deepLinksFromArgv,
	parseKestrelDeepLink,
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
});
