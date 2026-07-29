import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "kestrel-model-routing-test-"));
const screenshotPath = process.env.KESTREL_ROUTING_SCREENSHOT;
const testEnvironment = Object.fromEntries(
  ["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "CI"].flatMap(
    (key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
  ),
);
let application;

try {
  application = await electron.launch({
    args: [resolve("apps/desktop/out/main/index.js")],
    env: {
      ...testEnvironment,
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
  await page.evaluate(() => localStorage.setItem("kestrel:onboarded", "yes"));
  await page.reload();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".settings-nav").waitFor();
  await page.locator(".settings-nav button").filter({ hasText: "Models" }).click();
  await page.getByText("How Kestrel chooses models", { exact: true }).waitFor();

  const modes = page.locator(".routing-mode-grid [role=radio]");
  await modes.first().waitFor();
  assert.equal(await modes.count(), 6);
  assert.equal(
    await page
      .getByRole("radio", { name: /Balanced/ })
      .getAttribute("aria-checked"),
    "true",
  );
  await page.getByRole("radio", { name: /Local first/ }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".routing-mode-grid [role=radio]")].some(
      (element) =>
        element.textContent?.includes("Local first") &&
        element.getAttribute("aria-checked") === "true",
    ),
  );
  assert.equal(
    await page
      .getByRole("radio", { name: /Local first/ })
      .getAttribute("aria-checked"),
    "true",
  );
  assert.match(
    await page.locator(".routing-registry-summary").innerText(),
    /configured model endpoint/,
  );
  if (screenshotPath) {
    mkdirSync(dirname(resolve(screenshotPath)), { recursive: true });
    await page.screenshot({ path: resolve(screenshotPath), fullPage: true });
  }
  await page.locator(".routing-advanced summary").click();
  await page.getByLabel("Maximum parallel agents").fill("3");
  await page.getByRole("button", { name: "Save advanced limits" }).click();
  assert.equal(
    await page.getByLabel("Maximum parallel agents").inputValue(),
    "3",
  );

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("button", { name: "Work", exact: true }).click();
  await page.getByText("Override automatic routing", { exact: true }).waitFor();
  assert.match(
    await page.locator(".work-card-note").first().innerText(),
    /capability, quality, reliability, latency, cost, privacy/,
  );
  assert.equal(runtimeErrors.length, 0, runtimeErrors.join("\n"));
  console.log("Desktop intelligent model routing UI passed.");
} finally {
  if (application) await application.close();
  rmSync(root, { recursive: true, force: true });
}
