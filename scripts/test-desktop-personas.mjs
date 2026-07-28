import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "kestrel-personas-test-"));
let application;

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

  // Returning user: onboarding is covered independently; this pass focuses on
  // the complete daily product surface after a successful first run.
  await page.evaluate(() => localStorage.setItem("kestrel:onboarded", "yes"));
  await page.reload();
  await page.getByRole("heading", { name: "What should we get done?" }).waitFor();

  const tools = [
    ["Readiness", /Needs attention|Ready for work/],
    ["Approvals", /Review this action|No approvals waiting/],
    ["Memory", "Memory"],
    ["Research", "Research"],
    ["Artifacts", "Artifacts"],
    ["Work", "Work"],
    ["Opportunities", /Apply with your agent\. Send with your consent\./],
    ["Activity", "Activity"],
    ["Extensions", "Useful surfaces, without hidden code."],
  ];

  const toolsTrigger = page.getByRole("button", { name: "Tools", exact: true });
  await toolsTrigger.focus();
  await toolsTrigger.press("Enter");
  const readinessEntry = page.getByRole("button", {
    name: "Readiness",
    exact: true,
  });
  await readinessEntry.waitFor();
  await readinessEntry.focus();
  await readinessEntry.press("Enter");
  const readinessHeading = page
    .getByRole("heading", { name: /Needs attention|Ready for work/ })
    .first();
  await readinessHeading.waitFor();
  const readinessHeadingHandle = await readinessHeading.elementHandle();
  assert.ok(
    readinessHeadingHandle,
    "readiness heading did not resolve to a DOM element",
  );
  await page.waitForFunction(
    (heading) => document.activeElement === heading,
    readinessHeadingHandle,
  );
  assert.equal(
    await readinessHeading.evaluate(
      (heading) => document.activeElement === heading,
    ),
    true,
    "keyboard tool navigation did not move focus to the destination heading",
  );

  await toolsTrigger.focus();
  await toolsTrigger.press("Enter");
  await readinessEntry.waitFor();
  await readinessEntry.focus();
  await readinessEntry.press("Enter");
  assert.equal(
    await toolsTrigger.getAttribute("aria-expanded"),
    "true",
    "activating the current tool page should keep the menu open",
  );
  assert.equal(
    await readinessEntry.evaluate((entry) => document.activeElement === entry),
    true,
    "activating the current tool page should preserve focus",
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () =>
      document.activeElement?.id === "tools-label" &&
      document.activeElement?.getAttribute("aria-expanded") === "false",
  );

  for (const [label, heading] of tools.slice(1)) {
    await page.getByRole("button", { name: "Tools", exact: true }).click();
    const entry = page.getByRole("button", { name: label, exact: true });
    await entry.waitFor();
    await entry.click();
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
  }

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Settings" }).waitFor();

  const settings = [
    ["Connections", "Accounts and access"],
    ["General", "General settings"],
    ["Models", "Model and routing settings"],
    ["Memory", "Memory and behavior settings"],
    ["Extensions", "Extension settings"],
    ["Privacy", "Privacy and safety settings"],
    ["Advanced", "Advanced settings"],
  ];
  for (const [label, sectionLabel] of settings) {
    await page
      .locator(".settings-nav button")
      .filter({ hasText: label })
      .click();
    if (label === "Connections") {
      await page.getByRole("heading", { name: sectionLabel }).waitFor();
    } else {
      await page.locator(`[aria-label="${sectionLabel}"]`).waitFor();
    }
  }

  await page
    .locator(".settings-nav button")
    .filter({ hasText: "Advanced" })
    .click();
  await page.getByText(/Unmanaged|signed managed policy/).first().waitFor();

  for (const viewport of [
    { width: 640, height: 760 },
    { width: 1320, height: 860 },
  ]) {
    await page.setViewportSize(viewport);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      ),
      false,
      `horizontal overflow at ${viewport.width}px`,
    );
  }

  assert.deepEqual(runtimeErrors, []);
  process.stdout.write(
    "Returning-user persona matrix passed: keyboard tool routing, same-page and Escape focus, all desktop tools, all Settings sections, unmanaged enterprise disclosure, and compact reflow are healthy.\n",
  );
} finally {
  await application?.close();
  rmSync(root, { recursive: true, force: true });
}
