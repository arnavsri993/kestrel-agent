import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";
const root = mkdtempSync(join(tmpdir(), "kestrel-thinking-"));
const evidence = resolve(".tmp/thinking");
mkdirSync(evidence, { recursive: true });
const executable = process.env.KESTREL_DESKTOP_EXECUTABLE;
let app;
try {
 app = await electron.launch({ executablePath: executable || createRequire(resolve("apps/desktop/package.json"))("electron"), args: process.env.KESTREL_DESKTOP_USE_SOURCE === "1" ? [resolve("apps/desktop"), "--use-mock-keychain"] : executable ? ["--use-mock-keychain"] : [resolve("apps/desktop")], env: { ...process.env, KESTREL_TEST_USER_DATA: root, KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1", KESTREL_DISABLE_UPDATES: "1", KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1" } });
 const page = await app.firstWindow();
 const errors = [];
 page.on("pageerror", e => errors.push(e.message));
 await page.waitForLoadState("domcontentloaded");
 await page.evaluate(() => { localStorage.setItem("kestrel:onboarded", "yes"); localStorage.setItem("kestrel:default-browser-prompted", "yes"); });
 const request = async input => {
  const response = await page.evaluate(input => window.kestrel.request(input), input);
  assert(response.ok, response.error); return response;
 };
 const sessionId = (await request({ type: "runtime-create-session", title: "Thinking disclosure fixture" })).session.id;
 for (const [role, content] of [
  ["user", "Check the disposable fixture and report the result."],
  ["tool", JSON.stringify({ status: "verified", output: { observation: "Intermediate fixture evidence 123456" } })],
  ["tool", JSON.stringify({ status: "verified", output: { observation: "Second intermediate fixture evidence" } })],
  ["tool", JSON.stringify({ status: "failed", error: "The fixture needs attention. Please choose another page." })],
  ["tool", "Error: The plain fixture failed to open."],
  ["assistant", "The useful answer stays readable here."],
 ]) await request({ type: "runtime-append-message", sessionId, role, content });
 await request({ type: "runtime-select-session", sessionId });
 await page.reload();
 const toggle = page.locator("#browser-agent-toggle");
 await toggle.waitFor();
 if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
 const chat = page.locator(".agent-conversation-host");
 const thinking = chat.locator(".thinking-disclosure").first();
 await expect(thinking.locator(":scope > summary")).toHaveText("Thinking");
 await expect(thinking).not.toHaveAttribute("open", "");
 await expect(thinking.getByText(/Intermediate fixture evidence 123456/)).toBeHidden();
 await expect(chat.getByText("The fixture needs attention. Please choose another page.", { exact: true })).toBeVisible();
 await expect(chat.getByText("Error: The plain fixture failed to open.", { exact: true }).first()).toBeVisible();
 await expect(chat.getByText("The useful answer stays readable here.", { exact: true })).toBeVisible();
 await page.screenshot({ path: join(evidence, "collapsed.png"), animations: "disabled" });
 await thinking.locator(":scope > summary").focus();
 await page.keyboard.press("Enter");
 const evidenceText = thinking.getByText(/Intermediate fixture evidence 123456/);
 if (!await evidenceText.isVisible()) await evidenceText.evaluate(node => { const nested = node.closest("details"); if (nested) nested.open = true; });
 await expect(evidenceText).toBeVisible();
 await page.keyboard.press("Enter");
 await expect(thinking.getByText(/Intermediate fixture evidence 123456/)).toBeHidden();
 assert.deepEqual(errors, []);
 console.log("Thinking smoke passed: adjacent activity collapsed, keyboard disclosure, final answer and failures visible.");
} finally { await app?.close(); rmSync(root, { recursive: true, force: true }); }
