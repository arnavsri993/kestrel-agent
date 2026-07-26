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
  await page.getByRole("heading", { name: /^Good (morning|afternoon|evening)\.$/ }).waitFor();

  const tools = [
    ["Readiness", /Finish the essentials before live work\.|The core is ready\. Verify the route\./],
    ["Approvals", /Review the exact changes\.|No approvals waiting/],
    ["Memory", "What Kestrel knows."],
    ["Research", "Research with traceable sources."],
    ["Artifacts", "Final files, with receipts."],
    ["Work", "Goals, delegates, teams, and review."],
    ["Opportunities", /Apply with your agent\. Send with your consent\./],
    ["Activity", "A reason for every step."],
    ["Extensions", "Useful surfaces, without hidden code."],
  ];

  for (const [label, heading] of tools) {
    await page.getByRole("button", { name: "Tools", exact: true }).click();
    const entry = page.getByRole("button", { name: label, exact: true });
    await entry.waitFor();
    await entry.click();
    await page.getByRole("heading", { name: heading }).waitFor();
    assert.equal(
      await page.locator(".loading-screen.error-screen").count(),
      0,
      `${label} rendered the startup error screen`,
    );
  }

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Configure Kestrel" }).waitFor();

  const settings = [
    ["Connections", "Accounts and access"],
    ["General", "General settings"],
    ["Models & routing", "Model and routing settings"],
    ["Memory & behavior", "Memory and behavior settings"],
    ["Extensions", "Extension settings"],
    ["Privacy & safety", "Privacy and safety settings"],
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
    "Returning-user persona matrix passed: all desktop tools, all Settings sections, unmanaged enterprise disclosure, and compact reflow are healthy.\n",
  );
} finally {
  await application?.close();
  rmSync(root, { recursive: true, force: true });
}
