import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
import { openKestrelDestination } from "./desktop-browser-test-helpers.mjs";

const temporaryRoot = mkdtempSync(join(tmpdir(), "kestrel-life-context-"));
const screenshotRoot = resolve(
  "artifacts/screenshots/desktop/life-context",
);
const wideCalendarScreenshot = join(screenshotRoot, "calendar-wide.png");
const compactCalendarScreenshot = join(screenshotRoot, "calendar-compact.png");
const peopleScreenshot = join(screenshotRoot, "people-wide.png");
const memoryScreenshot = join(screenshotRoot, "memory-wide.png");
mkdirSync(dirname(wideCalendarScreenshot), { recursive: true });

let application;
try {
  const executablePath = process.env.KESTREL_DESKTOP_EXECUTABLE;
  application = await electron.launch({
    ...(executablePath
      ? {
          executablePath: resolve(executablePath),
          args: ["--use-mock-keychain"],
        }
      : { args: [resolve("apps/desktop/out/main/index.js")] }),
    env: {
      ...process.env,
      KESTREL_DISABLE_UPDATES: "1",
      KESTREL_TEST_USER_DATA: join(temporaryRoot, "user-data"),
    },
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(15_000);
  const runtimeErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.evaluate(() => localStorage.setItem("kestrel:onboarded", "yes"));
  await page.reload();

  const fixture = await page.evaluate(async () => {
    const now = new Date();
    const monday = new Date(now);
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const time = (day, hour, minutes = 0) => {
      const date = new Date(monday);
      date.setDate(date.getDate() + day);
      date.setHours(hour, minutes, 0, 0);
      return date.toISOString();
    };
    const requests = [
      {
        type: "calendar-create-local",
        title: "Deep work · Kestrel",
        startsAt: time(0, 9),
        endsAt: time(0, 11),
        origin: "explicit",
        confidence: 1,
        sourceId: "desktop-user",
      },
      {
        type: "calendar-create-local",
        title: "Likely commute",
        startsAt: time(1, 8, 15),
        endsAt: time(1, 8, 50),
        origin: "inferred",
        confidence: 0.76,
        sourceId: "routine-inference",
      },
      {
        type: "calendar-create-local",
        title: "Review project plan",
        startsAt: time(2, 15),
        endsAt: time(2, 16),
        origin: "suggested",
        confidence: 0.64,
        sourceId: "agent-suggestion",
      },
      {
        type: "people-upsert",
        displayName: "Dr. Maya Chen",
        nicknames: ["Professor Chen"],
        relationship: "Professor",
        organization: "Lakeshore University",
        role: "Capstone adviser",
        email: "maya.chen@example.test",
        tone: "Brief, respectful, and prepared",
        formality: "formal",
        sourceId: "desktop-user",
        sensitivity: "personal",
      },
      {
        type: "memory-remember",
        memoryType: "project",
        content:
          "The Kestrel capstone review is the highest-priority project this month.",
        sensitivity: "personal",
        sourceId: "desktop-user",
        layer: "mid_term",
      },
    ];
    const responses = [];
    for (const request of requests) {
      const response = await window.kestrel.request(request);
      if (!response.ok) throw new Error(response.error);
      responses.push(response);
    }
    return {
      explicitEventId: responses[0].calendarEvents?.[0]?.id,
      personId: responses[3].people?.[0]?.id,
    };
  });
  assert.ok(fixture.explicitEventId);
  assert.ok(fixture.personId);
  await page.reload();

  await page.setViewportSize({ width: 1320, height: 900 });
  await openKestrelDestination(page, "Life Context");
  const life = page.locator(".legacy-product-surface");
  await life.getByRole("heading", { name: "Your context", exact: true }).waitFor();

  await life.getByText("Deep work · Kestrel", { exact: true }).waitFor();
  await life.getByText("Inferred · 76%", { exact: true }).waitFor();
  await life.getByText("Suggested · 64%", { exact: true }).waitFor();
  await life.getByText("Apple Calendar", { exact: true }).waitFor();
  await life.getByText("Adapter planned", { exact: true }).first().waitFor();
  assert.equal(
    await life.getByRole("button", { name: "Sync Google" }).isDisabled(),
    true,
  );

  await life.getByRole("button", { name: /Deep work · Kestrel/ }).click();
  await life.getByText("Why this is here", { exact: true }).click();
  await life.getByText("Created directly by the user.", { exact: true }).waitFor();
  await life.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: wideCalendarScreenshot });

  const nextWeek = life.getByRole("button", { name: "Next week" });
  await nextWeek.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  assert.notEqual(
    await nextWeek.evaluate((element) => getComputedStyle(element).outlineStyle),
    "none",
  );

  await life.getByRole("button", { name: "People", exact: true }).click();
  await life.getByText("Dr. Maya Chen", { exact: true }).first().click();
  await life.getByText("Brief, respectful, and prepared", { exact: true }).waitFor();
  await life
    .getByText("Confirmed · 100% · explicit-user-control", { exact: true })
    .first()
    .waitFor();
  await life.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: peopleScreenshot });

  await life.getByRole("button", { name: "Memory", exact: true }).click();
  await life
    .getByText(
      "The Kestrel capstone review is the highest-priority project this month.",
      { exact: true },
    )
    .first()
    .waitFor();
  await life
    .getByPlaceholder("When should I work on the statistics paper?")
    .fill(
    "When should I prepare for my Kestrel capstone review with Professor Chen?",
    );
  await life.getByRole("button", { name: "Show influences" }).click();
  await life.locator(".context-explainer li").first().waitFor();
  await life.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: memoryScreenshot });
  await life.getByRole("button", { name: "Forget this fact" }).click();
  await page.waitForFunction(
    () =>
      document.activeElement instanceof HTMLButtonElement &&
      Boolean(document.activeElement.closest(".memory-ledger-list")),
  );

  await life.getByRole("button", { name: "Calendar", exact: true }).click();
  await page.setViewportSize({ width: 640, height: 760 });
  await life.getByText("Deep work · Kestrel", { exact: true }).waitFor();
  await life.evaluate((element) => {
    element.scrollTop = 0;
  });
  assert.equal(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    ),
    false,
  );
  await page.screenshot({ path: compactCalendarScreenshot, fullPage: true });

  assert.deepEqual(runtimeErrors, []);
  process.stdout.write(
    `Unified calendar provenance, people context, explainable retrieval, focus, compact reflow, and screenshots passed. Screenshots: ${wideCalendarScreenshot}, ${compactCalendarScreenshot}, ${peopleScreenshot}, ${memoryScreenshot}\n`,
  );
} finally {
  await application?.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
}
