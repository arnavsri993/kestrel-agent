import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const temporaryRoot = mkdtempSync(join(tmpdir(), "workstrand-pets-"));
const screenshotPath = resolve(
  "artifacts/screenshots/desktop/setup-revised/settings-pet-paperclip.png",
);
const overlayScreenshotPath = resolve(
  "artifacts/screenshots/desktop/setup-revised/pet-overlay-paperclip.png",
);
const hatchScreenshotPath = resolve(
  "artifacts/screenshots/desktop/setup-revised/settings-pet-hatch.png",
);
mkdirSync(dirname(screenshotPath), { recursive: true });
let application;

try {
  application = await electron.launch({
    args: [resolve("apps/desktop/out/main/index.js")],
    env: {
      ...process.env,
      KESTREL_TEST_USER_DATA: join(temporaryRoot, "user-data"),
    },
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(30_000);
  const runtimeErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.evaluate(() => localStorage.setItem("kestrel:onboarded", "yes"));
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const setting = page.locator(".pet-setting");
  await setting.getByText("Activity pet", { exact: true }).waitFor();
  await setting
    .getByText("Browse approved Petdex gallery", { exact: true })
    .click();
  await setting
    .getByPlaceholder("Search by pet, kind, or creator")
    .fill("paperclip");
  await setting.getByRole("button", { name: "Search", exact: true }).click();
  const paperclip = setting
    .locator("li")
    .filter({ hasText: "Paperclip" })
    .first();
  await paperclip.getByRole("button", { name: "Install", exact: true }).click();
  await setting
    .getByText("Paperclip installed and adopted.", { exact: true })
    .waitFor();
  const floating = page.locator(".floating-pet");
  await floating.waitFor();
  assert.match(await floating.getAttribute("style"), /data:image\/webp;base64/);
  assert.equal(
    Math.round(
      await floating.evaluate(
        (element) => element.getBoundingClientRect().width,
      ),
    ),
    63,
  );
  assert.match(await floating.getAttribute("aria-label"), /Paperclip pet is/);

  await setting.scrollIntoViewIfNeeded();
  await page.setViewportSize({ width: 1320, height: 900 });
  await page.screenshot({ path: screenshotPath });
  await setting.getByRole("slider", { name: "Pet size" }).fill("0.5");
  await setting.getByText("Pet size changed.", { exact: true }).waitFor();
  await page.waitForTimeout(250);
  assert.equal(
    Math.round(
      await floating.evaluate(
        (element) => element.getBoundingClientRect().width,
      ),
    ),
    96,
  );
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".floating-pet").waitFor();
  assert.equal(
    Math.round(
      await page
        .locator(".floating-pet")
        .evaluate((element) => element.getBoundingClientRect().width),
    ),
    96,
  );
  const reloadedSetting = page.locator(".pet-setting");
  await reloadedSetting.getByRole("button", { name: "Turn off" }).click();
  await page.locator(".floating-pet").waitFor({ state: "detached" });
  await reloadedSetting.getByRole("button", { name: "Turn on" }).click();
  await page.locator(".floating-pet").waitFor();
  const firstOverlayPromise = application.waitForEvent("window");
  await page.locator(".floating-pet").click({ modifiers: ["Shift"] });
  const firstOverlay = await firstOverlayPromise;
  firstOverlay.setDefaultTimeout(30_000);
  firstOverlay.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  firstOverlay.on("pageerror", (error) => runtimeErrors.push(error.message));
  await firstOverlay.locator(".pet-overlay-shell").waitFor();
  await firstOverlay.locator(".pet-overlay-sprite").waitFor();
  assert.match(
    await firstOverlay.locator(".pet-overlay-sprite").getAttribute("style"),
    /data:image\/webp;base64/,
  );
  await page.locator(".floating-pet").waitFor({ state: "detached" });
  const overlayWindowState = await application.evaluate(({ BrowserWindow }) => {
    const overlay = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes("petOverlay=1"),
    );
    if (!overlay) throw new Error("Pet overlay BrowserWindow is missing.");
    const original = overlay.getBounds();
    overlay.setPosition(original.x - 72, original.y - 48);
    return {
      alwaysOnTop: overlay.isAlwaysOnTop(),
      allWorkspaces: overlay.isVisibleOnAllWorkspaces(),
      resizable: overlay.isResizable(),
      moved: { x: original.x - 72, y: original.y - 48 },
    };
  });
  assert.deepEqual(
    {
      alwaysOnTop: overlayWindowState.alwaysOnTop,
      allWorkspaces: overlayWindowState.allWorkspaces,
      resizable: overlayWindowState.resizable,
    },
    { alwaysOnTop: true, allWorkspaces: true, resizable: true },
  );
  await firstOverlay.waitForTimeout(450);
  await firstOverlay.screenshot({ path: overlayScreenshotPath });
  const firstOverlayClosed = firstOverlay.waitForEvent("close");
  await firstOverlay
    .locator(".pet-overlay-sprite")
    .click({ modifiers: ["Shift"] });
  await firstOverlayClosed;
  await page.locator(".floating-pet").waitFor();
  await reloadedSetting
    .getByRole("button", { name: "Pop out", exact: true })
    .waitFor();

  const secondOverlayPromise = application.waitForEvent("window");
  await reloadedSetting
    .getByRole("button", { name: "Pop out", exact: true })
    .click();
  const secondOverlay = await secondOverlayPromise;
  secondOverlay.setDefaultTimeout(30_000);
  secondOverlay.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  secondOverlay.on("pageerror", (error) => runtimeErrors.push(error.message));
  await secondOverlay.locator(".pet-overlay-sprite").waitFor();
  const restoredBounds = await application.evaluate(({ BrowserWindow }) => {
    const overlay = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes("petOverlay=1"),
    );
    if (!overlay)
      throw new Error("Restored pet overlay BrowserWindow is missing.");
    return overlay.getBounds();
  });
  assert.equal(restoredBounds.x, overlayWindowState.moved.x);
  assert.equal(restoredBounds.y, overlayWindowState.moved.y);
  await secondOverlay.locator(".pet-overlay-sprite").click();
  await secondOverlay.locator(".pet-mini-composer").waitFor();
  await secondOverlay.getByRole("button", { name: "Cancel" }).click();
  const secondOverlayClosed = secondOverlay.waitForEvent("close");
  await secondOverlay
    .locator(".pet-overlay-sprite")
    .click({ modifiers: ["Shift"] });
  await secondOverlayClosed;
  await page.locator(".floating-pet").waitFor();
  await page.setViewportSize({ width: 640, height: 760 });
  await reloadedSetting.scrollIntoViewIfNeeded();
  assert.equal(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    ),
    false,
  );
  await page.setViewportSize({ width: 1320, height: 900 });
  const hatch = reloadedSetting.locator(".pet-hatch");
  await hatch
    .getByText("Hatch an original pet with AI", { exact: true })
    .click();
  await hatch.scrollIntoViewIfNeeded();
  await page.screenshot({ path: hatchScreenshotPath });
  assert.deepEqual(runtimeErrors, []);
  process.stdout.write(
    `Live approved Petdex search/install, verified floating animation, sizing, persisted always-on-top pop-out, quick composer, hatch capability UI, toggle, compact reflow, and screenshots passed. Screenshots: ${screenshotPath}, ${overlayScreenshotPath}, ${hatchScreenshotPath}\n`,
  );
} finally {
  await application?.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
}
