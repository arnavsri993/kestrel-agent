import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "kestrel-personas-test-"));
let application;

async function openCommand(page, label) {
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("heading", { name: "Kestrel", exact: true }).waitFor();
  const entry = page
    .locator(".command-groups button")
    .filter({ has: page.getByText(label, { exact: true }) });
  await entry.first().click();
}

try {
  application = await electron.launch({
    args: [resolve("apps/desktop/out/main/index.js")],
    env: {
      ...process.env,
      KESTREL_DISABLE_UPDATES: "1",
      KESTREL_TEST_USER_DATA: join(root, "user-data"),
    },
  });
  const page = await application.firstWindow();
  const runtimeErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.waitForLoadState("domcontentloaded");

  // Onboarding is covered independently; this matrix audits every reachable
  // daily surface in the browser-first information architecture.
  await page.evaluate(() => localStorage.setItem("kestrel:onboarded", "yes"));
  await page.reload();
  await page.getByRole("heading", { name: "How can I help?" }).waitFor();
  await page.getByRole("heading", { name: "Where to?" }).waitFor();

  const more = page.getByRole("button", { name: "More", exact: true });
  await more.focus();
  await more.press("Enter");
  const commandSearch = page.getByLabel("Search Kestrel");
  await commandSearch.waitFor();
  assert.equal(
    await commandSearch.evaluate((input) => document.activeElement === input),
    true,
    "command search did not receive focus",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("heading", { name: "Where to?" }).waitFor();
  await page.waitForFunction(
    (button) => document.activeElement === button,
    await more.elementHandle(),
  );

  await more.press("Enter");
  const readinessEntry = page
    .locator(".command-groups button")
    .filter({ hasText: "Readiness" });
  await readinessEntry.focus();
  await readinessEntry.press("Enter");
  const readinessHeading = page
    .getByRole("heading", { name: /Needs attention|Ready for work/ })
    .first();
  await readinessHeading.waitFor();
  await page.waitForFunction(
    (heading) => document.activeElement === heading,
    await readinessHeading.elementHandle(),
  );

  const surfaces = [
    ["Approvals", /Review this action|No approvals waiting/],
    ["Life Context", "Life"],
    ["Research", "Research"],
    ["Artifacts", "Artifacts"],
    ["Work", "Work"],
    ["Opportunities", /Apply with your agent\. Send with your consent\./],
    ["Activity", "Activity"],
    ["Extensions", "Useful surfaces, without hidden code."],
  ];
  for (const [label, heading] of surfaces) {
    await openCommand(page, label);
    await page
      .getByRole("heading", {
        name: heading,
        exact: typeof heading === "string",
      })
      .waitFor();
    assert.equal(
      await page.locator(".loading-screen.error-screen").count(),
      0,
      `${label} rendered the startup error screen`,
    );
    await page.getByRole("button", { name: "Browser", exact: true }).first().waitFor();
  }

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  const settings = [
    ["Connections", "Accounts and access"],
    ["Browser", "Browser"],
    ["General", "General settings"],
    ["Models", "Model and routing settings"],
    ["Memory", "Memory and behavior settings"],
    ["Extensions", "Extension settings"],
    ["Privacy", "Privacy and safety settings"],
    ["Advanced", "Advanced settings"],
  ];
  for (const [label, sectionLabel] of settings) {
    const button = page
      .locator(".settings-nav button")
      .filter({ hasText: label });
    await button.click();
    assert.equal(await button.getAttribute("aria-current"), "page");
    if (label === "Connections" || label === "Browser")
      await page
        .getByRole("heading", { name: sectionLabel, exact: true })
        .first()
        .waitFor();
    else await page.locator(`[aria-label="${sectionLabel}"]`).waitFor();
  }
  await page.getByText(/Unmanaged|signed managed policy/).first().waitFor();

  for (const viewport of [
    { width: 640, height: 760 },
    { width: 1320, height: 860 },
  ]) {
    await page.setViewportSize(viewport);
    assert.equal(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      ),
      false,
      `horizontal overflow at ${viewport.width}px`,
    );
  }

  await page.keyboard.press("Meta+K");
  await page.getByLabel("Search Kestrel").waitFor();
  await page.getByLabel("Search Kestrel").fill("history");
  await page
    .locator(".command-groups button")
    .filter({ hasText: "History" })
    .first()
    .click();
  await page.getByRole("heading", { name: "History", exact: true }).waitFor();

  assert.deepEqual(runtimeErrors, []);
  process.stdout.write(
    "Browser-first persona matrix passed: command routing/focus, all specialist surfaces, Browser plus all existing Settings sections, compact reflow, and command search are healthy.\n",
  );
} finally {
  await application?.close();
  rmSync(root, { recursive: true, force: true });
}
