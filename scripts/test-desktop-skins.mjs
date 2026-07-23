import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const temporaryRoot = mkdtempSync(join(tmpdir(), "workstrand-skins-"));
const customSkinPath = join(temporaryRoot, "field-notes.json");
const daylightScreenshot = resolve("artifacts/screenshots/desktop/setup-revised/settings-skin-daylight.png");
const customScreenshot = resolve("artifacts/screenshots/desktop/setup-revised/settings-skin-custom.png");
mkdirSync(dirname(daylightScreenshot), { recursive: true });
writeFileSync(customSkinPath, JSON.stringify({
  version: 1,
  id: "field-notes",
  name: "Field Notes",
  description: "A personal paper-like Kestrel skin.",
  base: "daylight",
  colors: { signal: "#7b2f12", brand: "#536b00" },
  terminal: { promptSymbol: "»", thinkingVerbs: ["noting", "checking"] }
}));

let application;
try {
  application = await electron.launch({
    args: [resolve("apps/desktop/out/main/index.js")],
    env: { ...process.env, KESTREL_TEST_USER_DATA: join(temporaryRoot, "user-data") }
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(12_000);
  const runtimeErrors = [];
  page.on("console", (message) => { if (message.type() === "error") runtimeErrors.push(message.text()); });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.evaluate(() => localStorage.setItem("kestrel:onboarded", "yes"));
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  const skinSetting = page.locator(".skin-setting");
  await skinSetting.getByText("Visual skin", { exact: true }).waitFor();
  const daylight = skinSetting.getByRole("button", { name: /Daylight/ });
  assert.equal(await skinSetting.getByRole("button", { name: /Kestrel/ }).getAttribute("aria-pressed"), "true");
  await daylight.click();
  await page.waitForFunction(() => document.documentElement.dataset.skin === "daylight");
  assert.equal(await daylight.getAttribute("aria-pressed"), "true");
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim()), "#f5f2ea");
  assert.equal(await page.evaluate(() => document.documentElement.style.colorScheme), "light");
  await skinSetting.scrollIntoViewIfNeeded();
  await page.setViewportSize({ width: 1320, height: 900 });
  await page.screenshot({ path: daylightScreenshot });

  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.skin === "daylight");
  assert.equal(await page.locator(".skin-setting").getByRole("button", { name: /Daylight/ }).getAttribute("aria-pressed"), "true");

  await application.evaluate(async ({ dialog }, skinPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [skinPath] });
  }, customSkinPath);
  await page.locator(".skin-setting").getByRole("button", { name: "Install JSON skin" }).click();
  await page.locator(".skin-setting").getByText("Custom skin installed and selected.", { exact: true }).waitFor();
  const fieldNotes = page.locator(".skin-setting").getByRole("button", { name: /^Field Notes/ });
  assert.equal(await fieldNotes.getAttribute("aria-pressed"), "true");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.skin), "field-notes");
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--signal").trim()), "#7b2f12");
  await page.locator(".skin-setting").scrollIntoViewIfNeeded();
  await page.screenshot({ path: customScreenshot });

  await page.locator(".skin-setting").getByRole("button", { name: "Remove Field Notes" }).click();
  await page.locator(".skin-setting").getByText("Custom skin removed; Kestrel restored.", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.skin), "workstrand");
  assert.equal(await page.locator(".skin-setting").getByRole("button", { name: /Kestrel/ }).getAttribute("aria-pressed"), "true");

  const slate = page.locator(".skin-setting").getByRole("button", { name: /Slate/ });
  await slate.click();
  await page.keyboard.press("Tab");
  assert.notEqual(await page.locator(":focus").evaluate((element) => getComputedStyle(element).outlineStyle), "none");
  await page.setViewportSize({ width: 640, height: 760 });
  await page.locator(".skin-setting").scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  assert.deepEqual(runtimeErrors, []);
  process.stdout.write(`Desktop built-in selection, restart persistence, strict custom import, recovery, focus, compact reflow, and screenshots passed. Screenshots: ${daylightScreenshot}, ${customScreenshot}\n`);
} finally {
  await application?.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
}
