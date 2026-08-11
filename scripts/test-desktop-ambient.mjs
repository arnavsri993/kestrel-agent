import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
import { openKestrelDestination } from "./desktop-browser-test-helpers.mjs";

const temporaryRoot = mkdtempSync(join(tmpdir(), "workstrand-ambient-"));
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const memoryScreenshot = resolve("artifacts/screenshots/desktop/setup-revised/memory-dreaming.png");
const presenceScreenshot = resolve("artifacts/screenshots/desktop/setup-revised/settings-presence.png");
mkdirSync(dirname(memoryScreenshot), { recursive: true });
let application;

try {
  application = await electron.launch({
    executablePath: requireFromDesktop("electron"),
    args: [resolve("apps/desktop")],
    env: { ...process.env, KESTREL_TEST_USER_DATA: join(temporaryRoot, "user-data") }
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(12_000);
  const runtimeErrors = [];
  page.on("console", (message) => { if (message.type() === "error") runtimeErrors.push(message.text()); });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.evaluate(() => localStorage.setItem("kestrel:onboarded", "yes"));
  await page.reload();

  await openKestrelDestination(page, "Life Context");
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  const dreaming = page.locator(".dreaming-panel");
  await dreaming.getByRole("heading", { name: "Dreaming" }).waitFor();
  const automatic = dreaming.getByRole("switch", { name: "Automatic memory consolidation" });
  assert.equal(await automatic.getAttribute("aria-checked"), "false");
  await dreaming.getByRole("button", { name: "Preview safely" }).click();
  await dreaming.getByText("Preview complete. Nothing was stored or promoted.").waitFor();
  await dreaming.getByText(/Dream diary · 1 entry/).click();
  assert.match(await dreaming.textContent(), /Preview only · nothing stored/);

  await page.reload();
  await openKestrelDestination(page, "Life Context");
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await dreaming.getByRole("heading", { name: "Dreaming" }).waitFor();
  assert.match(await dreaming.textContent(), /Dream diary · 0 entries/);
  await automatic.click();
  await expectChecked(automatic, "true");
  await dreaming.getByRole("button", { name: "Run now" }).click();
  await dreaming.getByText(/Consolidation complete/).waitFor();
  assert.match(await dreaming.textContent(), /Dream diary · 1 entry/);

  await page.setViewportSize({ width: 1320, height: 900 });
  await dreaming.scrollIntoViewIfNeeded();
  await page.screenshot({ path: memoryScreenshot });

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Preferences", exact: true }).waitFor();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: /^Memory/ })
    .click();
  const presence = page.locator(".presence-setting");
  await presence.getByText("Connected instances", { exact: true }).waitFor();
  await presence.getByText("Local agent core", { exact: true }).waitFor();
  await presence.getByText("Desktop window", { exact: true }).waitFor();
  assert.match(await presence.textContent(), /Local agent core/);
  assert.match(await presence.textContent(), /Desktop window/);
  assert.match(await presence.textContent(), /never stores client IP addresses, hostnames, or probe traffic/);
  const channelPolicy = page.locator(".channel-interaction-setting");
  await channelPolicy.getByText("Channel progress, typing, and reactions", { exact: true }).waitFor();
  await channelPolicy.getByLabel("Channel progress mode").selectOption("block");
  await channelPolicy.getByLabel("Channel typing mode").selectOption("never");
  await channelPolicy.getByLabel("Channel reaction level").selectOption("ack");
  await channelPolicy.getByRole("button", { name: "Save channel policy" }).click();
  await channelPolicy.getByText("Channel interaction policy saved.", { exact: true }).waitFor();
  const channelState = await page.evaluate(() => window.kestrel.request({ type: "channel-interaction-get" }));
  assert.deepEqual(channelState, { ok: true, channelInteractionConfiguration: { progressMode: "block", typingMode: "never", typingIntervalSeconds: 6, reactionLevel: "ack" } });
  await presence.scrollIntoViewIfNeeded();
  await page.screenshot({ path: presenceScreenshot });

  await page.setViewportSize({ width: 640, height: 760 });
  await presence.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  assert.deepEqual(runtimeErrors, []);
  process.stdout.write(`Review-gated dreaming, non-persistent preview, scheduled state, ephemeral presence, compact reflow, and screenshots passed. Screenshots: ${memoryScreenshot}, ${presenceScreenshot}\n`);
} finally {
  await application?.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
}

async function expectChecked(locator, expected) {
  await locator.evaluate((element, value) => new Promise((resolvePromise, reject) => {
    const deadline = Date.now() + 5_000;
    const poll = () => {
      if (element.getAttribute("aria-checked") === value) resolvePromise(undefined);
      else if (Date.now() > deadline) reject(new Error(`Expected aria-checked=${value}.`));
      else setTimeout(poll, 25);
    };
    poll();
  }), expected);
}
