import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
import {
  openKestrelDestination,
  selectSettingsSection,
} from "./desktop-browser-test-helpers.mjs";

const root = mkdtempSync(join(tmpdir(), "kestrel-desktop-settings-"));
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const packagedExecutable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const executablePath = packagedExecutable
  ? resolve(packagedExecutable)
  : requireFromDesktop("electron");
const launchArgs = packagedExecutable
  ? ["--use-mock-keychain"]
  : [resolve("apps/desktop")];
let application;

async function waitForStableSearchResult(page) {
  await page.waitForFunction(() => {
    const result = [...document.querySelectorAll(".settings-search-result")].find(
      (candidate) => candidate.textContent?.includes("Sleeping tab timeout"),
    );
    if (!result) return false;
    let previous = result.getBoundingClientRect();
    let stableFrames = 0;
    return new Promise((resolve) => {
      const sample = () => {
        if (!result.isConnected) {
          resolve(false);
          return;
        }
        const current = result.getBoundingClientRect();
        const stable =
          Math.abs(current.left - previous.left) <= 0.1 &&
          Math.abs(current.top - previous.top) <= 0.1 &&
          Math.abs(current.width - previous.width) <= 0.1 &&
          Math.abs(current.height - previous.height) <= 0.1;
        stableFrames = stable ? stableFrames + 1 : 0;
        previous = current;
        if (stableFrames >= 3) {
          resolve(true);
          return;
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
  });
}

try {
  application = await electron.launch({
    executablePath,
    args: launchArgs,
    env: {
      ...process.env,
      KESTREL_DISABLE_UPDATES: "1",
      KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1",
      KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
      KESTREL_TEST_USER_DATA: join(root, "user-data"),
    },
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(30_000);
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => {
    localStorage.setItem("kestrel:onboarded", "yes");
    localStorage.setItem("kestrel:default-browser-prompted", "yes");
  });
  await page.reload();
  await page.locator("#runtime-prompt").waitFor();

  await openKestrelDestination(page, "Settings");
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  const search = page.getByLabel("Search Browser and Agent settings");
  await search.fill("sleeping tab timeout");
  const result = page
    .locator(".settings-search-result")
    .filter({ hasText: "Sleeping tab timeout" });
  await result.waitFor();
  assert.match(await result.textContent(), /Performance/);
  await waitForStableSearchResult(page);
  await result.click();

  const timeout = page.getByLabel("Sleeping tab timeout", { exact: true });
  await timeout.waitFor();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "Sleeping tab timeout",
  );
  await timeout.selectOption("60");
  await page.locator(".browser-settings-save-state.saved").waitFor();
  const savedState = await page.evaluate(async () => {
    const response = await window.kestrel.request({ type: "browser-get-state" });
    if (!response.ok || !("browserState" in response)) throw new Error("Browser state unavailable");
    return response.browserState;
  });
  assert.equal(savedState.settings.sleepingTabTimeoutMinutes, 60);

  await page.reload();
  await selectSettingsSection(page, "browser-performance", "Performance");
  await page.waitForFunction(
    () => document.querySelectorAll('[aria-label="Sleeping tab timeout"]').length === 1,
  );
  await page.getByLabel("Sleeping tab timeout", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Sleeping tab timeout", { exact: true }).inputValue(),
    "60",
  );

  await search.fill("");
  await selectSettingsSection(page, "browser-reset", "Data & reset");
  await page.getByText("Clear browsing history", { exact: true }).waitFor();
  const clearHistory = page.locator("#setting-browser-clear-history");
  assert.equal(await clearHistory.getByRole("button", { name: "Clear history" }).count(), 1);

  await page.setViewportSize({ width: 600, height: 800 });
  const picker = page.locator(".settings-section-picker");
  await picker.waitFor({ state: "visible" });
  await picker.locator("select").selectOption("browser-extensions");
  await page.locator("#setting-browser-extensions").waitFor();
  const narrowLayout = await page.evaluate(() => ({
    width: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    navVisible: getComputedStyle(document.querySelector(".settings-nav")).display !== "none",
  }));
  assert.equal(narrowLayout.navVisible, false);
  assert.ok(
    narrowLayout.documentWidth <= narrowLayout.width + 1,
    `Settings overflowed narrow layout: ${JSON.stringify(narrowLayout)}`,
  );

  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedMotion = await page.locator(".settings-search-field").evaluate((element) => {
    const style = getComputedStyle(element);
    return { transitionDuration: style.transitionDuration };
  });
  assert.equal(reducedMotion.transitionDuration, "0s");
  await page.screenshot({ path: join(root, "desktop-settings.png"), fullPage: true });
  process.stdout.write(
    `Rendered ${packagedExecutable ? "packaged" : "development"} settings, search deep-link focus, persistence, and narrow-layout checks passed.\n`,
  );
} finally {
  await application?.close();
  rmSync(root, { recursive: true, force: true });
}
