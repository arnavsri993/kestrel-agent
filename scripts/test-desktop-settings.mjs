import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
let page;

async function waitForStableSearchResult(page) {
  await page.waitForFunction(() => {
    const frame = [...document.querySelectorAll(".settings-page-frame")].find((candidate) => {
      const bounds = candidate.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0;
    });
    const result = [...(frame?.querySelectorAll(".settings-search-result") ?? [])].find(
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

async function readSettingsGeometry(page) {
  return page.evaluate(() => {
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && bounds.width > 0 && bounds.height > 0;
    };
    const frames = [...document.querySelectorAll(".settings-page-frame")].filter(isVisible);
    const frame = frames[0];
    const header = frame?.querySelector(":scope > .ui-page-frame-header");
    const title = header?.querySelector("h1");
    const search = frame?.querySelector(".settings-search");
    const layout = frame?.querySelector(":scope > .settings-layout");
    const legacyToolbar = frame?.querySelector(":scope > div.settings-toolbar");
    const headerNavigation = layout?.querySelector(":scope > aside.settings-navigation");
    const asideToolbar = layout?.querySelector(":scope > aside.settings-toolbar");
    const tablist = frame?.querySelector('[role="tablist"][aria-label="Settings category"]');
    const picker = frame?.querySelector(".settings-section-picker");
    const navigation = frame?.querySelector(".settings-nav");
    const legacyNavigation = layout?.querySelector(":scope > nav.settings-nav");
    const legacyContract = Boolean(
      legacyToolbar &&
      legacyToolbar.contains(search ?? null) &&
      legacyToolbar.contains(tablist ?? null) &&
      legacyToolbar.contains(picker ?? null) &&
      legacyNavigation &&
      legacyNavigation === navigation,
    );
    const headerContract = Boolean(
      headerNavigation &&
      header?.contains(search ?? null) &&
      headerNavigation.contains(tablist ?? null) &&
      headerNavigation.contains(picker ?? null) &&
      headerNavigation.contains(navigation ?? null),
    );
    const asideToolbarContract = Boolean(
      asideToolbar &&
      asideToolbar.contains(search ?? null) &&
      asideToolbar.contains(tablist ?? null) &&
      asideToolbar.contains(picker ?? null) &&
      asideToolbar.contains(navigation ?? null),
    );
    const contractMatches = [
      legacyContract,
      headerContract,
      asideToolbarContract,
    ].filter(Boolean).length;
    const contract = legacyContract
      ? "legacy-toolbar"
      : headerContract
        ? "enhanced-header"
        : asideToolbarContract
          ? "enhanced-aside-toolbar"
          : "unknown";
    const toolbar = contract === "legacy-toolbar" ? legacyToolbar : asideToolbar;
    const navigationShell = contract === "enhanced-header" ? headerNavigation : toolbar;
    const rect = (element) => {
      if (!element || !isVisible(element)) return null;
      const value = element.getBoundingClientRect();
      return {
        left: value.left,
        right: value.right,
        top: value.top,
        bottom: value.bottom,
        width: value.width,
        height: value.height,
      };
    };
    return {
      frameCount: frames.length,
      contract,
      contractMatches,
      frame: rect(frame),
      header: rect(header),
      title: rect(title),
      search: rect(search),
      toolbar: rect(toolbar),
      tablist: rect(tablist),
      picker: rect(picker),
      navigation: rect(navigation),
      navigationShell: rect(navigationShell),
      toolbarContainsSearch: Boolean(toolbar?.contains(search ?? null)),
      toolbarScrollWidth: toolbar instanceof HTMLElement ? toolbar.scrollWidth : 0,
      toolbarClientWidth: toolbar instanceof HTMLElement ? toolbar.clientWidth : 0,
      navigationShellScrollWidth: navigationShell instanceof HTMLElement ? navigationShell.scrollWidth : 0,
      navigationShellClientWidth: navigationShell instanceof HTMLElement ? navigationShell.clientWidth : 0,
    };
  });
}

function assertContained(inner, outer, message) {
  assert.ok(
    inner && outer &&
      inner.left >= outer.left - 1 &&
      inner.right <= outer.right + 1 &&
      inner.top >= outer.top - 1 &&
      inner.bottom <= outer.bottom + 1,
    `${message}: ${JSON.stringify({ inner, outer })}`,
  );
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
      KESTREL_TEST_MOCK_KEYCHAIN: "1",
      KESTREL_TEST_USER_DATA: join(root, "user-data"),
    },
  });
  page = await application.firstWindow();
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
  const settingsPage = page.locator(".settings-page-frame:visible");
  assert.equal(await settingsPage.count(), 1, "Exactly one visible Settings page must be active");
  const search = settingsPage.getByLabel("Search Browser and Agent settings", { exact: true });
  const wideGeometry = await readSettingsGeometry(page);
  assert.equal(wideGeometry.frameCount, 1, "Exactly one visible Settings frame must render");
  assert.equal(wideGeometry.contractMatches, 1,
    `Settings must match exactly one supported structural contract: ${JSON.stringify(wideGeometry)}`);
  assert.notEqual(wideGeometry.contract, "unknown",
    `Settings rendered an unsupported structural contract: ${JSON.stringify(wideGeometry)}`);
  process.stdout.write(`Settings structural contract: ${wideGeometry.contract}.\n`);
  const enhancedLayout = wideGeometry.contract !== "legacy-toolbar";
  assert.ok(wideGeometry.frame && wideGeometry.header && wideGeometry.title && wideGeometry.search,
    `Settings frame, header, title, and search must render: ${JSON.stringify(wideGeometry)}`);
  assertContained(wideGeometry.search, wideGeometry.frame, "Settings search must stay within its frame");
  if (wideGeometry.contract === "enhanced-header") {
    assert.ok(
      wideGeometry.search.top < wideGeometry.title.bottom &&
        wideGeometry.search.bottom > wideGeometry.title.top,
      `Header Settings search must sit beside the page title: ${JSON.stringify(wideGeometry)}`,
    );
    assertContained(wideGeometry.navigationShell, wideGeometry.frame,
      "Enhanced Settings navigation must stay within its frame");
  } else {
    assert.equal(wideGeometry.toolbarContainsSearch, true, "Toolbar Settings search must remain inside its toolbar");
    assert.ok(
      wideGeometry.toolbar && wideGeometry.toolbar.top >= wideGeometry.header.bottom - 1,
      `Settings toolbar must follow the page header: ${JSON.stringify(wideGeometry)}`,
    );
    assertContained(wideGeometry.toolbar, wideGeometry.frame, "Settings toolbar must stay within its frame");
    assert.ok(
      wideGeometry.tablist &&
        wideGeometry.search.top < wideGeometry.tablist.bottom &&
        wideGeometry.search.bottom > wideGeometry.tablist.top,
      `Wide Settings toolbar controls must share a row: ${JSON.stringify(wideGeometry)}`,
    );
  }
  assert.ok(
    wideGeometry.navigationShellScrollWidth <= wideGeometry.navigationShellClientWidth + 1,
    `Wide Settings navigation shell overflowed: ${JSON.stringify(wideGeometry)}`,
  );

  const scopeTablist = settingsPage.getByRole("tablist", { name: "Settings category" });
  const browserTab = scopeTablist.getByRole("tab", { name: "Browser", exact: true });
  const agentTab = scopeTablist.getByRole("tab", { name: "Agent", exact: true });
  assert.equal(await scopeTablist.getByRole("tab").count(), 2,
    "Settings scope navigation must expose Browser and Agent tabs");
  await browserTab.click();
  assert.equal(await browserTab.getAttribute("aria-selected"), "true");
  if (enhancedLayout) {
    assert.equal(await browserTab.getAttribute("tabindex"), "0");
    assert.equal(await agentTab.getAttribute("tabindex"), "-1");
    await browserTab.focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Agent");
    assert.equal(await agentTab.getAttribute("aria-selected"), "true");
    assert.equal(await agentTab.getAttribute("tabindex"), "0");
    await page.keyboard.press("Home");
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Browser");
    assert.equal(await browserTab.getAttribute("aria-selected"), "true");
    await page.keyboard.press("End");
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Agent");
    assert.equal(await agentTab.getAttribute("aria-selected"), "true");
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Browser");
    assert.equal(await browserTab.getAttribute("aria-selected"), "true");
  } else {
    assert.equal(await browserTab.getAttribute("tabindex"), null);
    assert.equal(await agentTab.getAttribute("tabindex"), null);
    await agentTab.click();
    assert.equal(await agentTab.getAttribute("aria-selected"), "true");
    await browserTab.click();
    assert.equal(await browserTab.getAttribute("aria-selected"), "true");
    await agentTab.focus();
    await page.keyboard.press("Enter");
    assert.equal(await agentTab.getAttribute("aria-selected"), "true");
    await browserTab.focus();
    await page.keyboard.press("Enter");
    assert.equal(await browserTab.getAttribute("aria-selected"), "true");
  }

  await browserTab.click();
  await page.locator('[data-settings-panel="browser-startup"]').waitFor();
  assert.equal(await settingsPage.locator(".browser-settings-panel").count(), 1,
    "Browser entry must show one focused category");
  assert.equal(await settingsPage.locator(".settings-nav").getByRole("button", { name: "Browser", exact: true }).count(), 0);
  assert.deepEqual(await settingsPage.locator(".settings-nav-group h3").allTextContents(),
    ["Everyday browsing", "Privacy & personal data", "Manage browser"]);
  const desktopPicker = settingsPage.getByLabel("Browser settings section");
  const downloadsNavigation = settingsPage
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Downloads", exact: true });
  if (await downloadsNavigation.isVisible()) {
    await downloadsNavigation.focus();
    assert.equal(await downloadsNavigation.evaluate((node) => document.activeElement === node), true);
    await page.keyboard.press("Enter");
  } else {
    await desktopPicker.waitFor({ state: "visible" });
    await desktopPicker.focus();
    assert.equal(await desktopPicker.evaluate((node) => document.activeElement === node), true);
    await desktopPicker.selectOption("browser-downloads");
  }
  await page.locator('[data-settings-panel="browser-downloads"]').waitFor();
  assert.equal(
    await settingsPage.locator('.settings-nav [aria-current="page"]').textContent(),
    "Downloads",
    "The active Settings section must track keyboard or picker selection",
  );
  assert.equal(await desktopPicker.inputValue(), "browser-downloads");
  await selectSettingsSection(page, "browser-startup", "Startup");
  if (evidence) await page.screenshot({ path: join(evidence, "startup-desktop.png") });
  await agentTab.click();
  await page.getByRole("heading", { name: "Autonomy and behavior" }).waitFor();
  assert.equal(await settingsPage.locator(".agent-config-banner").count(), 0);
  assert.deepEqual(await settingsPage.locator(".settings-nav-group h3").allTextContents(),
    ["Setup & intelligence", "Work & tools", "Safety & maintenance"]);
  if (evidence) await page.screenshot({ path: join(evidence, "agent-desktop.png") });
  await selectSettingsSection(page, "agent-models", "Models & routing");
  await page.locator("#setting-agent-models").waitFor();
  if (evidence) await page.screenshot({ path: join(evidence, "models-wide.png") });

  if (enhancedLayout) {
    assert.equal(await search.getAttribute("aria-controls"), null);
    assert.equal(await search.getAttribute("aria-describedby"), "settings-search-help");
  }
  await search.fill("sleeping tab timeout");
  assert.equal(await search.getAttribute("aria-controls"), "settings-search-results");
  const result = settingsPage
    .locator(".settings-search-result")
    .filter({ hasText: "Sleeping tab timeout" });
  await result.waitFor();
  if (enhancedLayout) {
    await settingsPage.getByRole("region", { name: "Matching settings" }).waitFor();
  } else {
    const results = settingsPage.locator("#settings-search-results");
    await results.waitFor();
    assert.equal(await results.getAttribute("aria-live"), "polite");
  }
  assert.match(await result.textContent(), /Browser · Performance/);
  await waitForStableSearchResult(page);
  for (let tab = 0; tab < 3 && !(await settingsPage.locator(".settings-search-result:focus").count()); tab += 1)
    await page.keyboard.press("Tab");
  assert.equal(await settingsPage.locator(".settings-search-result:focus").count(), 1,
    "Tab must reach a Settings search result");
  await page.keyboard.press("Enter");

  const timeout = settingsPage.getByLabel("Sleeping tab timeout", { exact: true });
  await timeout.waitFor();
  assert.equal(await search.inputValue(), "", "Choosing a result should dismiss search results");
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "Sleeping tab timeout",
  );
  await timeout.selectOption("60");
  await settingsPage.locator(".browser-settings-save-state.saved").waitFor();
  const savedState = await page.evaluate(async () => {
    const response = await window.kestrel.request({ type: "browser-get-state" });
    if (!response.ok || !("browserState" in response)) throw new Error("Browser state unavailable");
    return response.browserState;
  });
  assert.equal(savedState.settings.sleepingTabTimeoutMinutes, 60);

  await page.reload();
  await selectSettingsSection(page, "browser-performance", "Performance");
  await page.waitForFunction(
    () => {
      const frame = [...document.querySelectorAll(".settings-page-frame")].find((candidate) => {
        const bounds = candidate.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0;
      });
      return frame?.querySelectorAll('[aria-label="Sleeping tab timeout"]').length === 1;
    },
  );
  await timeout.waitFor();
  assert.equal(await timeout.inputValue(), "60");

  await search.fill("");
  await selectSettingsSection(page, "browser-reset", "Data & reset");
  const clearHistory = settingsPage.locator("#setting-browser-clear-history");
  await clearHistory.waitFor();
  assert.equal(await clearHistory.getByRole("button", { name: "Clear history" }).count(), 1);

  await search.fill("sleeping tab timeout");
  if (enhancedLayout) {
    await search.press("Escape");
  } else {
    const clearSearch = settingsPage.getByRole("button", { name: "Clear settings search" });
    await clearSearch.focus();
    await page.keyboard.press("Enter");
  }
  assert.equal(await search.inputValue(), "",
    enhancedLayout ? "Escape must clear Settings search" : "The clear button must clear legacy Settings search");
  assert.equal(await search.evaluate((node) => document.activeElement === node), true,
    "Clearing Settings search must restore focus to its input");

  for (const width of [360, 520, 900]) {
    await page.setViewportSize({ width, height: 800 });
    const viewportLayout = await page.evaluate(() => {
      const frame = [...document.querySelectorAll(".settings-page-frame")].find((candidate) => {
        const bounds = candidate.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0;
      });
      return {
        width: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        settingsWidth: frame?.querySelector(".settings-content")?.getBoundingClientRect().width ?? 0,
      };
    });
    assert.ok(
      viewportLayout.documentWidth <= viewportLayout.width + 1,
      `Settings overflowed at ${width}px: ${JSON.stringify(viewportLayout)}`,
    );
  }

  await page.setViewportSize({ width: 600, height: 800 });
  const closeChat = page.getByRole("button", { name: "Close chat", exact: true });
  if (await closeChat.isVisible()) await closeChat.click();
  const picker = settingsPage.locator(".settings-section-picker");
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

  await agentTab.click();
  await page.getByRole("heading", { name: "Autonomy and behavior" }).waitFor();
  const agentPicker = await readPickerScope();
  assert.equal(await pickerSelect.getAttribute("aria-label"), "Agent settings section");
  assert.deepEqual(agentPicker.groups, ["Setup & intelligence", "Work & tools", "Safety & maintenance"]);
  assert.ok(agentPicker.values.length > 0);
  assert.ok(agentPicker.values.every((value) => value.startsWith("agent-")));

  await browserTab.click();
  await page.locator('[data-settings-panel="browser-startup"]').waitFor();
  await pickerSelect.selectOption("browser-extensions");
  await page.locator("#setting-browser-extensions").waitFor();
  const compactGeometry = await readSettingsGeometry(page);
  assert.equal(compactGeometry.contractMatches, 1,
    `Compact Settings must match exactly one supported structural contract: ${JSON.stringify(compactGeometry)}`);
  assert.equal(compactGeometry.contract, wideGeometry.contract,
    `Settings must retain its structural contract across reflow: ${JSON.stringify(compactGeometry)}`);
  assert.equal(compactGeometry.navigation, null, "Settings section navigation must hide at compact width");
  assert.ok(
    compactGeometry.frame && compactGeometry.frame.right <= 601 && compactGeometry.frame.left >= -1,
    `Compact Settings frame must stay in the viewport: ${JSON.stringify(compactGeometry)}`,
  );
  assertContained(compactGeometry.search, compactGeometry.frame,
    "Compact Settings search must stay within its frame");
  assertContained(compactGeometry.tablist, compactGeometry.frame,
    "Compact Settings scope tabs must stay within their frame");
  assertContained(compactGeometry.picker, compactGeometry.frame,
    "Compact Settings picker must stay within its frame");
  if (compactGeometry.contract === "legacy-toolbar" || compactGeometry.contract === "enhanced-aside-toolbar") {
    assertContained(compactGeometry.toolbar, compactGeometry.frame,
      "Compact Settings toolbar must stay within its frame");
    assertContained(compactGeometry.search, compactGeometry.toolbar,
      "Compact Settings search must stay within its toolbar");
    assertContained(compactGeometry.tablist, compactGeometry.toolbar,
      "Compact Settings scope tabs must stay within their toolbar");
    assertContained(compactGeometry.picker, compactGeometry.toolbar,
      "Compact Settings picker must stay within its toolbar");
    assert.ok(
      compactGeometry.search.top >= Math.min(compactGeometry.tablist.bottom, compactGeometry.picker.bottom) - 1,
      `Compact Settings toolbar must reflow search after its navigation controls: ${JSON.stringify(compactGeometry)}`,
    );
    assert.ok(compactGeometry.toolbarScrollWidth <= compactGeometry.toolbarClientWidth + 1,
      `Compact Settings toolbar overflowed: ${JSON.stringify(compactGeometry)}`);
  } else {
    assert.equal(compactGeometry.contract, "enhanced-header");
    assertContained(compactGeometry.header, compactGeometry.frame,
      "Compact Settings header must stay within its frame");
    assertContained(compactGeometry.navigationShell, compactGeometry.frame,
      "Compact Settings navigation must stay within its frame");
    assert.ok(compactGeometry.navigationShellScrollWidth <= compactGeometry.navigationShellClientWidth + 1,
      `Compact Settings navigation overflowed: ${JSON.stringify(compactGeometry)}`);
  }
  const narrowLayout = await page.evaluate(() => ({
    width: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  assert.ok(
    narrowLayout.documentWidth <= narrowLayout.width + 1,
    `Settings overflowed narrow layout: ${JSON.stringify(narrowLayout)}`,
  );
  if (evidence) await page.screenshot({ path: join(evidence, "extensions-narrow.png") });

  await pickerSelect.selectOption("browser-appearance");
  await page.locator('[data-settings-panel="browser-appearance"]').waitFor();
  const readBackgroundGrid = () => settingsPage.locator(".background-option-grid .background-option").evaluateAll((cards, usesContentQueryContract) => {
    const rows = new Set(cards.map((card) => Math.round(card.getBoundingClientRect().top)));
    const frame = cards[0]?.closest(".settings-page-frame");
    const content = frame?.querySelector(".settings-content");
    const stage = content?.closest(".settings-content-stage");
    const contentWidth = content?.getBoundingClientRect().width ?? 0;
    const containerType = stage ? getComputedStyle(stage).containerType : "normal";
    const columns = usesContentQueryContract
      ? contentWidth <= 420 ? 1 : contentWidth <= 760 ? 2 : 3
      : innerWidth <= 760 ? 2 : 3;
    return {
      count: cards.length,
      rows: rows.size,
      contentWidth,
      containerType,
      expectedRows: Math.ceil(cards.length / columns),
    };
  }, wideGeometry.contract === "enhanced-header");
  for (const width of [360, 520]) {
    await page.setViewportSize({ width, height: 800 });
    const wallpaper = await readBackgroundGrid();
    if (enhancedLayout) {
      assert.equal(wallpaper.containerType, "inline-size",
        `Enhanced Settings content must own an inline-size container: ${JSON.stringify(wallpaper)}`);
    }
    assert.equal(wallpaper.rows, wallpaper.expectedRows,
      `Wallpaper cards must follow the active Settings reflow contract at ${width}px: ${JSON.stringify(wallpaper)}`);
    if (evidence) await page.screenshot({ path: join(evidence, `wallpaper-${width}.png`) });
  }

  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.evaluate(() => {
    const frame = [...document.querySelectorAll(".settings-page-frame")].find((candidate) => {
      const bounds = candidate.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0;
    });
    const layout = frame?.querySelector(".settings-layout");
    if (layout instanceof HTMLElement) layout.style.gridTemplateColumns = "184px 700px";
  });
  const constrainedWallpaper = await readBackgroundGrid();
  if (enhancedLayout) {
    assert.equal(constrainedWallpaper.containerType, "inline-size",
      `Enhanced constrained Settings content must retain its inline-size container: ${JSON.stringify(constrainedWallpaper)}`);
  }
  assert.equal(constrainedWallpaper.rows, constrainedWallpaper.expectedRows,
    `Wallpaper cards must follow the active constrained Settings contract: ${JSON.stringify(constrainedWallpaper)}`);
  await page.evaluate(() => {
    const frame = [...document.querySelectorAll(".settings-page-frame")].find((candidate) => {
      const bounds = candidate.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0;
    });
    const layout = frame?.querySelector(".settings-layout");
    if (layout instanceof HTMLElement) layout.style.removeProperty("grid-template-columns");
  });

  await page.setViewportSize({ width: 520, height: 800 });
  await search.fill("tab");
  const longResult = settingsPage.locator(".settings-search-result").first();
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
  if (enhancedLayout) {
    await search.press("Escape");
  } else {
    await settingsPage.getByRole("button", { name: "Clear settings search" }).click();
  }
  assert.equal(await search.inputValue(), "", "Settings search must clear after its supported recovery action");
  assert.equal(await search.evaluate((node) => document.activeElement === node), true,
    "Settings search recovery must restore input focus");
  await page.setViewportSize({ width: 1800, height: 1000 });

  const readPickerSections = () => settingsPage.locator(".settings-section-picker option").evaluateAll(
    (options) => options.map((option) => ({ value: option.value, label: option.textContent.trim() })),
  );
  const scopeSections = [];
  for (const [scopeName, scopeControl] of [["Browser", browserTab], ["Agent", agentTab]]) {
    await scopeControl.click();
    scopeSections.push({ scopeName, sections: await readPickerSections() });
  }
  for (const width of [1800, 1000, 600]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const { scopeName, sections } of scopeSections) {
      await (scopeName === "Browser" ? browserTab : agentTab).click();
      for (const section of sections) {
        await selectSettingsSection(page, section.value, section.label);
        const overflow = await settingsPage.locator(".settings-content").evaluate((element) => ({
          width: element.clientWidth,
          scrollWidth: element.scrollWidth,
        }));
        assert.ok(overflow.scrollWidth <= overflow.width + 1,
          `${scopeName} ${section.value} overflows at ${width}px: ${JSON.stringify(overflow)}`);
      }
    }
  }

  await page.setViewportSize({ width: 1800, height: 480 });
  await selectSettingsSection(page, "agent-migration", "Migration");
  await page.locator("#setting-agent-migration").waitFor();
  const displayedSectionControl = settingsPage.locator(
    '.settings-nav [aria-current="page"]:visible, .settings-section-picker select:visible',
  );
  assert.equal(await displayedSectionControl.count(), 1,
    "The active Settings section must have one displayed navigation control");
  const lastSectionBounds = await displayedSectionControl.boundingBox();
  assert.ok(lastSectionBounds && lastSectionBounds.y >= 0 &&
    lastSectionBounds.y + lastSectionBounds.height <= 480,
    `Last Settings section must remain reachable in a short window: ${JSON.stringify(lastSectionBounds)}`);
  if (evidence) await page.screenshot({ path: join(evidence, "agent-short.png") });

  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedMotion = await settingsPage.locator(".settings-search-field").evaluate((element) => ({
    transitionDuration: getComputedStyle(element).transitionDuration,
  }));
  assert.equal(reducedMotion.transitionDuration, "0s");
  await page.screenshot({ path: join(root, "desktop-settings.png"), fullPage: true });
  assert.deepEqual(pageErrors, [], `Settings renderer page errors: ${pageErrors.join(" | ")}`);
  process.stdout.write(
    `Rendered ${packagedExecutable ? "packaged" : "development"} settings, keyboard navigation, search focus, persistence, and responsive checks passed.\n`,
  );
} catch (error) {
  if (evidence && page) {
    const captureErrors = [];
    try {
      await page.screenshot({ path: join(evidence, "settings-failure.png") });
    } catch (captureError) {
      captureErrors.push(`screenshot: ${captureError instanceof Error ? captureError.message : String(captureError)}`);
    }
    try {
      const geometry = await readSettingsGeometry(page);
      const sanitizedGeometry = {
        viewport: page.viewportSize(),
        contract: geometry.contract,
        contractMatches: geometry.contractMatches,
        frameCount: geometry.frameCount,
        frame: geometry.frame,
        header: geometry.header,
        search: geometry.search,
        toolbar: geometry.toolbar,
        tablist: geometry.tablist,
        picker: geometry.picker,
        navigation: geometry.navigation,
      };
      writeFileSync(
        join(evidence, "settings-failure-geometry.json"),
        `${JSON.stringify(sanitizedGeometry, null, 2)}\n`,
      );
    } catch (captureError) {
      captureErrors.push(`geometry: ${captureError instanceof Error ? captureError.message : String(captureError)}`);
    }
    if (captureErrors.length > 0) {
      process.stderr.write(`Could not capture all Settings failure evidence (${captureErrors.join("; ")}).\n`);
    }
  }
  throw error;
} finally {
  await application?.close();
  rmSync(root, { recursive: true, force: true });
}
