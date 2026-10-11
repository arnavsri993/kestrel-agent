import type { UserBrowserHistoryEntry } from "@kestrel/shared-types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { UserBrowserController } from "../../browser/useUserBrowser";
import { BrowserHistory } from "./BrowserLibrary";
import { BrowserHistoryPopover } from "./BrowserHistoryPopover";

const entry = (title: string, visitedAt: string): UserBrowserHistoryEntry => ({
	id: `visit-${title}`, tabId: "tab-fixture", title,
	url: `https://example.com/${title}`, visitedAt,
});
const render = (history: UserBrowserHistoryEntry[], popover = false) => renderToStaticMarkup(
	popover
		? <BrowserHistoryPopover history={history} onOpen={() => {}} onOpenFull={() => {}} onClear={() => {}} />
		: <BrowserHistory browser={{ state: { history } } as unknown as UserBrowserController} onOpenBrowser={() => {}} />,
);
const titles = (markup: string) => [...markup.matchAll(/<li\b[^>]*>[\s\S]*?<strong>(.*?)<\/strong>[\s\S]*?<\/li>/g)].map(match => match[1]);

describe("Browser history chronology", () => {
	it.each([false, true])("orders current and imported visits by time (popover=%s)", popover => {
		const history = [
			entry("Current", "2026-10-11T06:00:00.100Z"),
			entry("Old-import", "2026-10-10T06:00:00.000Z"),
			entry("Later-import", "2026-10-11T06:00:00.090Z"),
		];
		expect(titles(render(history, popover))).toEqual(["Current", "Later-import", "Old-import"]);
	});
	it("selects the newest 50 visits before limiting the popover", () => {
		const history = [entry("Current", "2026-10-11T06:00:00.000Z"), ...Array.from({ length: 52 }, (_, index) =>
			entry(`Imported-${index}`, new Date(Date.parse("2026-10-10T06:00:00.000Z") - index * 60_000).toISOString()))];
		const displayed = titles(render(history, true));
		expect(displayed).toHaveLength(50);
		expect(displayed).toEqual(["Current", ...Array.from({ length: 49 }, (_, index) => `Imported-${index}`)]);
	});
	it("keeps the most recently appended visit first for equal timestamps", () => {
		const history = [entry("First-append", "2026-10-11T06:00:00.000Z"), entry("Last-append", "2026-10-11T06:00:00.000Z")];
		for (const popover of [false, true]) expect(titles(render(history, popover))).toEqual(["Last-append", "First-append"]);
	});
	it("preserves stored entry order while rendering both views", () => {
		const history = [entry("Current", "2026-10-11T06:00:00.000Z"), entry("Old-import", "2026-10-10T06:00:00.000Z")];
		const before = structuredClone(history);
		Object.freeze(history);
		for (const popover of [false, true]) render(history, popover);
		expect(history).toEqual(before);
	});
});
