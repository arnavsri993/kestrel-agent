import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
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
const evidence = process.env.KESTREL_SETTINGS_EVIDENCE;
if (evidence) mkdirSync(evidence, { recursive: true });
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
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => {
    localStorage.setItem("kestrel:onboarded", "yes");
    localStorage.setItem("kestrel:default-browser-prompted", "yes");
  });
  await page.reload();
  await page.locator("#runtime-prompt").waitFor();

  await page.setViewportSize({ width: 1800, height: 1000 });
  await openKestrelDestination(page, "Settings");
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  const search = page.getByRole("searchbox", { name: "Search Browser and Agent settings" });
  const headerGeometry = await page.evaluate(() => {
    const frame = document.querySelector(".settings-page-frame");
    const heading = frame?.querySelector(":scope > .ui-page-frame-header");
    const search = frame?.querySelector(".settings-search");
    const title = heading?.querySelector("h1");
    if (!heading || !frame || !search || !title) return null;
    const headerRect = heading.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const searchRect = search.getBoundingClientRect();
    const rect = (value) => ({
      left: value.left,
      right: value.right,
      top: value.top,
      bottom: value.bottom,
      width: value.width,
      height: value.height,
    });
    return { header: rect(headerRect), frame: rect(frameRect), title: rect(titleRect), search: rect(searchRect) };
  });
  assert.ok(headerGeometry, "Settings header and search must render together");
  assert.ok(
    headerGeometry.search.top < headerGeometry.title.bottom &&
      headerGeometry.search.bottom > headerGeometry.title.top &&
      headerGeometry.search.right <= headerGeometry.frame.right + 1,
    `Settings search must sit beside the page title: ${JSON.stringify(headerGeometry)}`,
  );

  const scopeTabs = page.locator(".settings-navigation [role=tab]");
  assert.equal(await scopeTabs.count(), 2, "Settings scope navigation must expose Browser and Agent tabs");
  await scopeTabs.filter({ hasText: "Browser" }).click();
  await page.waitForFunction(() => document.querySelector(".settings-navigation [role=tab][aria-selected='true']")?.textContent?.includes("Browser"));
  assert.equal(await scopeTabs.filter({ hasText: "Browser" }).getAttribute("tabindex"), "0");
  assert.equal(await scopeTabs.filter({ hasText: "Agent" }).getAttribute("tabindex"), "-1");
  await scopeTabs.filter({ hasText: "Browser" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.activeElement?.textContent?.includes("Agent"));
  assert.equal(await scopeTabs.filter({ hasText: "Agent" }).getAttribute("aria-selected"), "true");
  assert.equal(await scopeTabs.filter({ hasText: "Agent" }).getAttribute("tabindex"), "0");
  await page.keyboard.press("Home");
  await page.waitForFunction(() => document.activeElement?.textContent?.includes("Browser"));
  await page.keyboard.press("End");
  await page.waitForFunction(() => document.activeElement?.textContent?.includes("Agent"));
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(() => document.activeElement?.textContent?.includes("Browser"));
  await page.getByRole("tab", { name: "Browser", exact: true }).click();
  await page.locator('[data-settings-panel="browser-startup"]').waitFor();
  assert.equal(await page.locator(".browser-settings-panel").count(), 1,
    "Browser entry must show one focused category");
  assert.equal(await page.locator(".settings-nav").getByRole("button", { name: "Browser", exact: true }).count(), 0);
  assert.deepEqual(await page.locator(".settings-nav-group h3").allTextContents(),
    ["Everyday browsing", "Privacy & personal data", "Manage browser"]);
  await page.locator(".settings-nav").getByRole("button", { name: "Downloads", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.locator('[data-settings-panel="browser-downloads"]').waitFor();
  assert.equal(await page.locator('.settings-nav [aria-current="page"]').textContent(), "Downloads");
  await selectSettingsSection(page, "browser-startup", "Startup");
  if (evidence) await page.screenshot({ path: join(evidence, "startup-desktop.png") });
  await page.getByRole("tab", { name: "Agent", exact: true }).click();
  await page.getByRole("heading", { name: "Autonomy and behavior" }).waitFor();
  assert.equal(await page.locator(".agent-config-banner").count(), 0);
  assert.deepEqual(await page.locator(".settings-nav-group h3").allTextContents(),
    ["Setup & intelligence", "Work & tools", "Safety & maintenance"]);
  if (evidence) await page.screenshot({ path: join(evidence, "agent-desktop.png") });
  await page.getByRole("tab", { name: "Agent", exact: true }).click();
  await page.locator(".settings-nav").getByRole("button", { name: "Models & routing", exact: true }).click();
  await page.locator("#setting-agent-models").waitFor();
  if (evidence) await page.screenshot({ path: join(evidence, "models-wide.png") });
  assert.equal(await search.getAttribute("aria-controls"), null);
  assert.equal(await search.getAttribute("aria-describedby"), "settings-search-help");
  await search.fill("sleeping tab timeout");
  assert.equal(await search.getAttribute("aria-controls"), "settings-search-results");
  const result = page
    .locator(".settings-search-result")
    .filter({ hasText: "Sleeping tab timeout" });
  await result.waitFor();
  const resultsRegion = page.getByRole("region", { name: "Matching settings" });
  await resultsRegion.waitFor();
  assert.match(await result.textContent(), /Browser · Performance/);
  await waitForStableSearchResult(page);
  for (let tab = 0; tab < 3 && !(await page.locator(".settings-search-result:focus").count()); tab += 1)
    await page.keyboard.press("Tab");
  assert.equal(await page.locator(".settings-search-result:focus").count(), 1,
    "Tab must reach a Settings search result");
  await page.keyboard.press("Enter");

  const timeout = page.getByLabel("Sleeping tab timeout", { exact: true });
  await timeout.waitFor();
  assert.equal(await search.inputValue(), "", "Choosing a result should dismiss search results");
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

  await search.fill("sleeping tab timeout");
  await search.press("Escape");
  assert.equal(await search.inputValue(), "", "Escape must clear Settings search");
  assert.equal(await page.locator(":focus").getAttribute("aria-label"), "Search Browser and Agent settings");

  for (const width of [360, 520, 900]) {
    await page.setViewportSize({ width, height: 800 });
    const viewportLayout = await page.evaluate(() => ({
      width: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      settingsWidth: document.querySelector(".settings-content")?.getBoundingClientRect().width ?? 0,
    }));
    assert.ok(
      viewportLayout.documentWidth <= viewportLayout.width + 1,
      `Settings overflowed at ${width}px: ${JSON.stringify(viewportLayout)}`,
    );
  }

  await page.setViewportSize({ width: 600, height: 800 });
  const closeChat = page.getByRole("button", { name: "Close chat", exact: true });
  if (await closeChat.isVisible()) await closeChat.click();
  const picker = page.locator(".settings-section-picker");
  await picker.waitFor({ state: "visible" });
  const pickerSelect = picker.locator("select");
  const readPickerScope = () =>
    pickerSelect.evaluate((select) => ({
      groups: [...select.querySelectorAll("optgroup")].map((group) => group.label),
      values: [...select.options].map((option) => option.value),
    }));
  const browserPicker = await readPickerScope();
  assert.equal(await pickerSelect.getAttribute("aria-label"), "Browser settings section");
  assert.deepEqual(browserPicker.groups, ["Everyday browsing", "Privacy & personal data", "Manage browser"]);
  assert.ok(browserPicker.values.length > 0);
  assert.ok(browserPicker.values.every((value) => value === "browser" || value.startsWith("browser-")));

  await page.getByRole("tab", { name: "Agent", exact: true }).click();
  await page.getByRole("heading", { name: "Autonomy and behavior" }).waitFor();
  const agentPicker = await readPickerScope();
  assert.equal(await pickerSelect.getAttribute("aria-label"), "Agent settings section");
  assert.deepEqual(agentPicker.groups, ["Setup & intelligence", "Work & tools", "Safety & maintenance"]);
  assert.ok(agentPicker.values.length > 0);
  assert.ok(agentPicker.values.every((value) => value.startsWith("agent-")));

  await page.getByRole("tab", { name: "Browser", exact: true }).click();
  await page.locator('[data-settings-panel="browser-startup"]').waitFor();
  await pickerSelect.selectOption("browser-extensions");
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

  if (evidence) await page.screenshot({ path: join(evidence, "extensions-narrow.png") });

  await pickerSelect.selectOption("browser-appearance");
  await page.locator('[data-settings-panel="browser-appearance"]').waitFor();
  const backgroundColumns = async () => page.locator(".background-option-grid .background-option").evaluateAll((cards) => {
    const rows = new Set(cards.map((card) => Math.round(card.getBoundingClientRect().top)));
    const content = document.querySelector(".settings-content");
    return {
      count: cards.length,
      rows: rows.size,
      width: cards[0]?.getBoundingClientRect().width ?? 0,
      contentWidth: content?.getBoundingClientRect().width ?? 0,
    };
  });
  await page.setViewportSize({ width: 360, height: 800 });
  const wallpaper360 = await backgroundColumns();
  assert.equal(wallpaper360.rows, wallpaper360.count, "Wallpaper cards must collapse to one column below 420px content");
  if (evidence) await page.screenshot({ path: join(evidence, "wallpaper-360.png") });
  await page.setViewportSize({ width: 520, height: 800 });
  const wallpaper520 = await backgroundColumns();
  const wallpaper520Rows = wallpaper520.contentWidth <= 420
    ? wallpaper520.count
    : Math.ceil(wallpaper520.count / 2);
  assert.equal(wallpaper520.rows, wallpaper520Rows,
    `Wallpaper cards must follow available content width at compact width: ${JSON.stringify(wallpaper520)}`);
  if (evidence) await page.screenshot({ path: join(evidence, "wallpaper-520.png") });

  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.evaluate(() => {
    const layout = document.querySelector(".settings-layout");
    if (layout instanceof HTMLElement) layout.style.gridTemplateColumns = "184px 700px";
  });
  const constrainedWallpaper = await backgroundColumns();
  assert.equal(constrainedWallpaper.rows, Math.ceil(constrainedWallpaper.count / 2), "Wallpaper cards must adapt to a constrained 700px Settings container fixture");
  await page.evaluate(() => {
    const layout = document.querySelector(".settings-layout");
    if (layout instanceof HTMLElement) layout.style.removeProperty("grid-template-columns");
  });
  await page.setViewportSize({ width: 520, height: 800 });
  await search.fill("tab");
  const longResult = page.locator(".settings-search-result").first();
  await longResult.waitFor();
  const longResultLayout = await longResult.evaluate((element) => ({
    width: element.clientWidth,
    scrollWidth: element.scrollWidth,
    copyWhiteSpace: getComputedStyle(element.querySelector(".settings-search-result-copy") ?? element).whiteSpace,
  }));
  assert.ok(longResultLayout.scrollWidth <= longResultLayout.width + 1,
    `Long Settings search result overflowed: ${JSON.stringify(longResultLayout)}`);
  assert.notEqual(longResultLayout.copyWhiteSpace, "nowrap", "Settings search result copy must be allowed to wrap");
  if (evidence) await page.screenshot({ path: join(evidence, "search-narrow.png") });
  await search.press("Escape");
  await page.setViewportSize({ width: 1800, height: 1000 });


  const readPickerSections = async () => page.locator(".settings-section-picker option").evaluateAll(
    (options) => options.map((option) => ({ value: option.value, label: option.textContent.trim() })),
  );
  const scopeSections = [];
  for (const scopeTab of ["Browser", "Agent"]) {
    await page.getByRole("tab", { name: scopeTab, exact: true }).click();
    const sections = await readPickerSections();
    scopeSections.push({ scopeTab, sections });
  }
  for (const width of [1800, 1000, 600]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const { scopeTab, sections } of scopeSections) {
      await page.getByRole("tab", { name: scopeTab, exact: true }).click();
      for (const section of sections) {
        await selectSettingsSection(page, section.value, section.label);
        const overflow = await page.locator(".settings-content").evaluate((element) => ({
          width: element.clientWidth,
          scrollWidth: element.scrollWidth,
        }));
        assert.ok(overflow.scrollWidth <= overflow.width + 1,
          `${scopeTab} ${section.value} overflows at ${width}px: ${JSON.stringify(overflow)}`);
      }
    }
  }

  await page.setViewportSize({ width: 1800, height: 480 });
  await page.getByRole("tab", { name: "Agent", exact: true }).click();
  const lastSection = page.locator(".settings-nav").getByRole("button", { name: "Migration", exact: true });
  await lastSection.focus();
  await page.keyboard.press("Enter");
  const lastSectionBounds = await lastSection.boundingBox();
  assert.ok(lastSectionBounds && lastSectionBounds.y >= 80 &&
    lastSectionBounds.y + lastSectionBounds.height <= 480,
    `Last Settings section must remain reachable in a short window: ${JSON.stringify(lastSectionBounds)}`);
  if (evidence) await page.screenshot({ path: join(evidence, "agent-short.png") });

  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedMotion = await page.locator(".settings-search-field").evaluate((element) => {
    const style = getComputedStyle(element);
    return { transitionDuration: style.transitionDuration };
  });
  assert.equal(reducedMotion.transitionDuration, "0s");
  await page.screenshot({ path: join(root, "desktop-settings.png"), fullPage: true });
  assert.deepEqual(pageErrors, [], `Settings renderer page errors: ${pageErrors.join(" | ")}`);
  process.stdout.write(
    `Rendered ${packagedExecutable ? "packaged" : "development"} settings, search deep-link focus, persistence, and narrow-layout checks passed.\n`,
  );
} finally {
  await application?.close();
  rmSync(root, { recursive: true, force: true });
}
