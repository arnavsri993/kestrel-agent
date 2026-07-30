import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "kestrel-desktop-fresh-profile-"));
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const packagedExecutable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const executablePath = packagedExecutable
  ? resolve(packagedExecutable)
  : requireFromDesktop("electron");
const launchArgs = packagedExecutable
  ? ["--use-mock-keychain"]
  : [resolve("apps/desktop")];
let application;

async function launch() {
  application = await electron.launch({
    executablePath,
    args: launchArgs,
    env: {
      ...process.env,
      KESTREL_TEST_USER_DATA: join(root, "user-data"),
      KESTREL_REAL_USER_PROFILE: "1",
      KESTREL_DISABLE_UPDATES: "1",
    },
  });
  return application.firstWindow();
}

async function assertFresh(page) {
  await page.getByRole("heading", { name: "What should we get done?" }).waitFor();
  const response = await page.evaluate(() => window.kestrel.request({ type: "snapshot" }));
  assert.equal(response.ok, true);
  assert.equal(response.snapshot?.agentState, "idle");
  assert.deepEqual(response.snapshot?.approvals, []);
  assert.deepEqual(response.snapshot?.memories, []);
  assert.deepEqual(response.snapshot?.activity, []);
  assert.equal(await page.getByText("Finalize the Monday test plan?", { exact: true }).count(), 0);
  assert.equal(await page.getByText("Needs Your Approval", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Review a project" }).waitFor();
  await page.getByRole("button", { name: "Plan a task" }).waitFor();
}

try {
  let page = await launch();
  await page.evaluate(() => localStorage.setItem("kestrel:onboarded", "yes"));
  await page.reload();
  await assertFresh(page);
  await application.close();
  application = undefined;

  page = await launch();
  await assertFresh(page);
  process.stdout.write("Fresh desktop profile starts idle, empty, and restart-safe without development fixtures.\n");
} finally {
  await application?.close();
  rmSync(root, { recursive: true, force: true });
}
