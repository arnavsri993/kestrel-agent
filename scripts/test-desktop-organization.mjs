import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
import { openCommandCenter, openKestrelDestination } from "./desktop-browser-test-helpers.mjs";

const root = mkdtempSync(join(tmpdir(), "kestrel-organization-"));
const shots = resolve("artifacts/screenshots/desktop/organization");
mkdirSync(shots, { recursive: true });
const packaged = process.env.KESTREL_DESKTOP_EXECUTABLE;
let application;
try {
  application = await electron.launch({
    executablePath: packaged || createRequire(resolve("apps/desktop/package.json"))("electron"),
    args: packaged ? ["--use-mock-keychain"] : [resolve("apps/desktop")],
    env: { ...process.env, KESTREL_DISABLE_UPDATES: "1", KESTREL_TEST_USER_DATA: join(root, "profile") },
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.evaluate(() => {
    localStorage.setItem("kestrel:onboarded", "yes");
    localStorage.setItem("kestrel:agent-sidebar", "collapsed");
    localStorage.setItem("kestrel:default-browser-prompted", "yes");
  });
  await page.reload();
  await page.setViewportSize({ width: 1280, height: 900 });
  const search = await openCommandCenter(page);
  const directory = page.locator(".command-center");
  const categories = directory.getByRole("group", { name: "Explore categories" });
  await categories.getByRole("button", { name: "Library", exact: true }).click();
  assert.equal(await directory.locator(".command-groups button").count(), 3);
  await search.fill("goals schedules");
  assert.equal(await directory.locator(".command-groups button").count(), 1);
  assert.match(await directory.locator(".command-groups").innerText(), /Work/);
  await search.fill("no-such-place-fixture");
  await directory.getByText(/No matches/).waitFor();
  await directory.getByRole("button", { name: "Show all destinations" }).click();
  assert.equal(await directory.locator(".command-groups button").count(), 20);
  assert.equal(await search.evaluate(element => element === document.activeElement), true);
  await page.screenshot({ path: join(shots, "directory-wide.png") });
  await categories.getByRole("button", { name: "Work", exact: true }).click();
  await page.screenshot({ path: join(shots, "directory-work.png") });
  await directory.locator(".command-groups button").filter({ has: page.getByText("Work", { exact: true }) }).click();
  await page.getByRole("heading", { name: "Goal board", exact: true }).waitFor();
  const sections = page.getByRole("group", { name: "Work sections" });
  assert.equal(await page.locator("#work-schedules").isVisible(), false);
  await page.getByRole("button", { name: "Create a goal", exact: true }).click();
  const title = page.locator("#work-goals").getByLabel("Title", { exact: true });
  assert.equal(await title.evaluate(element => element === document.activeElement), true);
  await title.fill("Retained goal draft");
  await sections.getByRole("button", { name: "Schedules", exact: true }).click();
  const scheduleTitle = page.locator("#work-schedules").getByLabel("Title", { exact: true });
  await scheduleTitle.fill("Retained schedule draft");
  await sections.getByRole("button", { name: "Delegation", exact: true }).click();
  await page.locator("#work-delegation").getByLabel("Title", { exact: true }).fill("Retained delegation draft");
  await sections.getByRole("button", { name: "Teams", exact: true }).click();
  await page.getByText("No teams yet.", { exact: false }).waitFor();
  await sections.getByRole("button", { name: "Schedules", exact: true }).click();
  assert.equal(await scheduleTitle.inputValue(), "Retained schedule draft");
  await page.screenshot({ path: join(shots, "schedules-wide.png") });
  await sections.getByRole("button", { name: "Delegation", exact: true }).click();
  assert.equal(await page.locator("#work-delegation").getByLabel("Title", { exact: true }).inputValue(), "Retained delegation draft");
  await sections.getByRole("button", { name: "Goals", exact: true }).focus();
  await page.keyboard.press("Space");
  assert.equal(await sections.getByRole("button", { name: "Goals", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await title.inputValue(), "Retained goal draft");
  await page.locator(".work-create-goal > summary").click();
  await page.screenshot({ path: join(shots, "goals-wide.png") });
  await page.setViewportSize({ width: 640, height: 860 });
  await sections.getByRole("button", { name: "Schedules", exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(shots, "schedules-compact.png") });
  await openCommandCenter(page);
  await page.screenshot({ path: join(shots, "directory-compact.png") });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log("Directory search, category recovery, goal focus, section draft retention and compact reflow passed.");
} finally {
  await application?.close();
  rmSync(root, { recursive: true, force: true });
}
