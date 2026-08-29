import { describe, expect, it } from "vitest";
import {
	browserSiteLabel,
	frequentBrowserSites,
	NEW_TAB_BACKGROUND_OPTIONS,
	newTabGreetingActivityProfile,
	newTabGreetingContext,
	newTabGreetingFallback,
	originFaviconMap,
	recordNewTabGreetingVisit,
	siteInitial,
	suggestedAgentActions,
	validateNewTabGreeting,
} from "./new-tab";

const tabId = "tab-00000000-0000-4000-8000-000000000000";

describe("new tab shortcuts", () => {
	it("ships a readable set of bundled background choices", () => {
		expect(NEW_TAB_BACKGROUND_OPTIONS.map((option) => option.value)).toEqual([
			"graphite",
			"meadow",
			"dawn",
			"mountains",
			"paper",
		]);
		expect(NEW_TAB_BACKGROUND_OPTIONS[0]).toMatchObject({
			label: "Kestrel default",
			description: expect.stringContaining("graphite"),
		});
	});

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

  it("attaches local tab favicons to frequent sites and prefers live tabs", () => {
    const history = [
      {
        id: "visit-00000000-0000-4000-8000-000000000021",
        tabId,
        url: "https://example.com/docs",
        title: "Example",
        visitedAt: "2026-08-18T12:00:00.000Z",
      },
      {
        id: "visit-00000000-0000-4000-8000-000000000022",
        tabId,
        url: "https://kestrel.example/guide",
        title: "Kestrel",
        visitedAt: "2026-08-18T13:00:00.000Z",
      },
    ];
    const persisted = originFaviconMap(
      [
        {
          origin: "https://example.com",
          faviconDataUrl: "data:image/png;base64,PERSISTED",
        },
        {
          origin: "https://kestrel.example",
          faviconDataUrl: "data:image/png;base64,OLD",
        },
      ],
      [
        {
          url: "https://kestrel.example/open",
          faviconDataUrl: "data:image/png;base64,LIVE",
        },
      ],
    );
    const sites = frequentBrowserSites(history, 7, persisted);

    expect(sites).toEqual([
      expect.objectContaining({
        hostname: "kestrel.example",
        faviconDataUrl: "data:image/png;base64,LIVE",
      }),
      expect.objectContaining({
        hostname: "example.com",
        faviconDataUrl: "data:image/png;base64,PERSISTED",
      }),
    ]);
  });

  it("derives stable, bounded labels and glyph text", () => {
    expect(siteInitial({ hostname: "www.example.com", title: "Example" })).toBe("E");
    expect(browserSiteLabel({ hostname: "example.com", title: "  A   useful page  " })).toBe(
      "A useful page",
    );
    expect(
      browserSiteLabel(
        { hostname: "example.com", title: "A very long page title" },
        12,
      ),
    ).toBe("A very long…");
  });

  it("always returns five honest starter actions when history is empty", () => {
    const actions = suggestedAgentActions([]);

    expect(actions).toHaveLength(5);
    expect(actions.every((action) => !action.personalized)).toBe(true);
    expect(new Set(actions.map((action) => action.id))).toHaveLength(5);
  });

  it("prioritizes waiting and recent sessions ahead of generic starters", () => {
    const actions = suggestedAgentActions(
      [],
      5,
      [
        {
          id: "session-completed",
          title: "Ship the landing page",
          status: "completed",
          updatedAt: "2026-08-18T12:00:00.000Z",
        },
        {
          id: "session-waiting",
          title: "Review deployment plan",
          status: "waiting",
          updatedAt: "2026-08-18T11:00:00.000Z",
        },
        {
          id: "session-active",
          title: "Fix flaky desktop test",
          status: "active",
          updatedAt: "2026-08-18T13:00:00.000Z",
        },
      ],
    );

    expect(actions).toHaveLength(5);
    expect(actions[0]?.title).toBe("Check on Review deployment plan");
    expect(actions[1]?.title).toBe("Continue Fix flaky desktop test");
    expect(actions.filter((action) => action.personalized)).toHaveLength(2);
    expect(actions.filter((action) => !action.personalized)).toHaveLength(3);
  });

  it("personalizes actions from local links without carrying query secrets", () => {
    const actions = suggestedAgentActions([
      {
        id: "visit-00000000-0000-4000-8000-000000000011",
        tabId,
        url: "https://user:password@example.com/project?token=private#draft",
        title: "Project notes",
        visitedAt: "2026-08-18T12:00:00.000Z",
      },
      {
        id: "visit-00000000-0000-4000-8000-000000000012",
        tabId,
        url: "https://docs.example.org/guide?session=private",
        title: "Implementation guide",
        visitedAt: "2026-08-18T13:00:00.000Z",
      },
    ]);

    expect(actions).toHaveLength(5);
    expect(actions.filter((action) => action.personalized)).toHaveLength(2);
    const projectAction = actions.find((action) =>
      action.prompt.includes("Project notes"),
    );
    const guideAction = actions.find((action) =>
      action.prompt.includes("Implementation guide"),
    );
    expect(projectAction?.prompt).toContain("https://example.com/project");
    expect(projectAction?.prompt).not.toContain("user:password");
    expect(projectAction?.prompt).not.toContain("token=private");
    expect(projectAction?.prompt).not.toContain("#draft");
    expect(guideAction?.prompt).toContain("https://docs.example.org/guide");
    expect(guideAction?.prompt).not.toContain("session=private");
  });
});

describe("new tab contextual greetings", () => {
  function localTime(hour: number, day = 23): Date {
    return new Date(2026, 7, day, hour, 0, 0, 0);
  }

  it("builds only coarse time and presence labels", () => {
    let activity = undefined;
    for (const day of [18, 19, 20, 21])
      activity = recordNewTabGreetingVisit(activity, localTime(7, day));

    expect(newTabGreetingActivityProfile(activity, localTime(2))).toEqual({
      currentTimeOfDay: "late-night",
      usualVisitTime: "early-morning",
      visitFrequency: "regular",
      todayVisit: "first-today",
    });
    expect(
      newTabGreetingContext(activity, "Arnav Srivastava", localTime(7)),
    ).toEqual({
      firstName: "Arnav",
      currentTimeOfDay: "early-morning",
      usualVisitTime: "early-morning",
      visitFrequency: "regular",
      todayVisit: "first-today",
    });
    expect(JSON.stringify(activity)).not.toMatch(
      /example\.com|Project notes|@|https?:/i,
    );
  });

	it("retains a bounded daily aggregate and recognizes a return today", () => {
		let activity = recordNewTabGreetingVisit(undefined, localTime(22, 1));
		for (let index = 2; index <= 40; index += 1)
			activity = recordNewTabGreetingVisit(activity, localTime(22, index));
		activity = recordNewTabGreetingVisit(activity, localTime(22, 40));

    expect(activity.days.length).toBeLessThanOrEqual(31);
    expect(
      newTabGreetingActivityProfile(activity, localTime(22, 40)).todayVisit,
    ).toBe("returning-today");
		expect(newTabGreetingFallback("Arnav Srivastava")).toBe("Hello, Arnav.");
		expect(newTabGreetingFallback("Arnav <private@example.com>")).toBe(
			"What should we work on?",
		);
		expect(newTabGreetingFallback("Arnav Srivastava", "morning")).toBe(
			"Good morning, Arnav.",
		);
		expect(newTabGreetingFallback(undefined, "afternoon")).toBe(
			"Good afternoon. What should we work on?",
		);
	});

	it("uses visit frequency without retaining visit details", () => {
		let activity = recordNewTabGreetingVisit(undefined, localTime(7));
		for (let index = 0; index < 8; index += 1)
			activity = recordNewTabGreetingVisit(activity, localTime(7));

		expect(newTabGreetingActivityProfile(activity, localTime(7)).visitFrequency).toBe(
			"frequent",
		);
	});

	it("accepts one vague generated sentence and rejects data-bearing output", () => {
    expect(validateNewTabGreeting("Up this late again, Arnav?")).toBe(
      "Up this late again, Arnav?",
    );
    expect(validateNewTabGreeting("Good morning, Arnav!\nHere we go.")).toBe(
      undefined,
    );
		expect(validateNewTabGreeting("I remember your project from yesterday.")).toBe(
			undefined,
		);
		expect(validateNewTabGreeting("Welcome back twice today.")).toBe(undefined);
		expect(validateNewTabGreeting('"Good morning, Arnav."')).toBe(undefined);
		expect(validateNewTabGreeting("Sorry, I can't do that.")).toBe(undefined);
		expect(validateNewTabGreeting("Good morning, Arnav! 👋")).toBe(undefined);
	});
});
