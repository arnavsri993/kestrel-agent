import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "workstrand-readiness-test-"));
const userData = join(root, "user-data");
const backupParent = join(root, "backups");
let application;

try {
  mkdirSync(backupParent, { recursive: true });
  application = await electron.launch({
    args: [resolve("apps/desktop/out/main/index.js")],
    env: { ...process.env, KESTREL_TEST_USER_DATA: userData, KESTREL_CODEX_PATH: "/usr/bin/true" }
  });
  const page = await application.firstWindow();
  const runtimeErrors = [];
  page.on("console", (message) => { if (message.type() === "error") runtimeErrors.push(message.text()); });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => localStorage.setItem("kestrel:onboarded", "yes"));
  await page.reload();

  await page.getByRole("button", { name: "Readiness" }).click();
  await page.getByRole("heading", { name: "Finish the essentials before live work." }).waitFor();
  await page.getByRole("heading", { name: "What can work right now" }).waitFor();
  await page.getByText("No cloud account or local Ollama model is configured.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Run checks" }).focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  assert.notEqual(await page.getByRole("button", { name: "Run checks" }).evaluate((element) => getComputedStyle(element).outlineStyle), "none");
  await page.setViewportSize({ width: 760, height: 760 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1320, height: 860 });
  await page.getByRole("button", { name: "Settings" }).click();
  const subscriptionSetting = page.locator(".subscription-setting");
  await subscriptionSetting.getByText("ChatGPT plan through Codex", { exact: true }).waitFor();
  await subscriptionSetting.getByRole("button", { name: "Enable" }).click();
  await subscriptionSetting.getByRole("button", { name: "Disable" }).waitFor();
  await page.getByRole("button", { name: "Readiness" }).click();
  await page.getByRole("heading", { name: "The core is ready. Verify the route." }).waitFor();
  await page.getByRole("button", { name: "Verify model access" }).click();
  await page.getByText("codex-subscription", { exact: true }).waitFor();
  await page.getByText("account reachable", { exact: false }).waitFor();

  await application.evaluate(async ({ dialog }, destination) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] });
  }, backupParent);
  await page.getByRole("button", { name: "Choose backup folder" }).click();
  await page.getByText("Hashes verified", { exact: false }).waitFor();

  const backupNames = readdirSync(backupParent).filter((name) => !name.endsWith(".partial"));
  assert.equal(backupNames.length, 1);
  const backupPath = join(backupParent, backupNames[0]);
  assert.equal(existsSync(join(backupPath, "database", "kestrel.sqlite")), true);
  assert.equal(existsSync(join(backupPath, "secure", "database-key.bin")), true);
  assert.equal(existsSync(join(backupPath, "runtime-preferences.json")), true);
  const manifest = JSON.parse(readFileSync(join(backupPath, "manifest.json"), "utf8"));
  assert.equal(manifest.format, "workstrand-local-backup");
  assert.equal(manifest.version, 1);
  assert.ok(manifest.files.some((file) => file.path === "database/kestrel.sqlite" && /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.ok(manifest.files.some((file) => file.path === "secure/database-key.bin" && /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.ok(manifest.files.some((file) => file.path === "runtime-preferences.json" && /^[a-f0-9]{64}$/.test(file.sha256)));
  await page.getByText("Verified backup created", { exact: false }).waitFor();
  assert.deepEqual(runtimeErrors, []);
  process.stdout.write("Desktop readiness diagnostics and verified local backup passed.\n");
} finally {
  await application?.close();
  rmSync(root, { recursive: true, force: true });
}
