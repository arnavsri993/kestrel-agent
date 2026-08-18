import { describe, expect, it } from "vitest";
import { frequentBrowserSites, siteInitial } from "./new-tab";

const tabId = "tab-00000000-0000-4000-8000-000000000000";

describe("new tab shortcuts", () => {
  it("groups history by origin and keeps the most recent useful URL", () => {
    const sites = frequentBrowserSites([
      {
        id: "visit-00000000-0000-4000-8000-000000000001",
        tabId,
        url: "https://example.com/old",
        title: "Old example",
        visitedAt: "2026-08-12T12:00:00.000Z",
      },
      {
        id: "visit-00000000-0000-4000-8000-000000000002",
        tabId,
        url: "https://example.com/new",
        title: "New example",
        visitedAt: "2026-08-14T12:00:00.000Z",
      },
      {
        id: "visit-00000000-0000-4000-8000-000000000003",
        tabId,
        url: "https://kestrel.example/docs",
        title: "Kestrel docs",
        visitedAt: "2026-08-13T12:00:00.000Z",
      },
    ]);

    expect(sites).toHaveLength(2);
    expect(sites[0]).toMatchObject({
      hostname: "example.com",
      title: "New example",
      url: "https://example.com/new",
      visits: 2,
    });
  });

	it("derives stable neutral glyph text", () => {
		expect(siteInitial({ hostname: "www.example.com", title: "Example" })).toBe("E");
	});
});
