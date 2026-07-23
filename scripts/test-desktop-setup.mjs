import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "workstrand-setup-test-"));
let application;

try {
  application = await electron.launch({
    args: [resolve("apps/desktop/out/main/index.js")],
    env: { ...process.env, KESTREL_TEST_USER_DATA: join(root, "user-data") }
  });
  const page = await application.firstWindow();
  const runtimeErrors = [];
  page.on("console", (message) => { if (message.type() === "error") runtimeErrors.push(message.text()); });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.waitForLoadState("domcontentloaded");

  await page.getByRole("heading", { name: /Bring your models/ }).waitFor();
  await page.getByRole("button", { name: "Set up Kestrel" }).click();
  const continueButton = page.getByRole("button", { name: "Continue" });
  assert.equal(await continueButton.isDisabled(), true);
  await page.getByLabel("I understand these boundaries").check();
  assert.equal(await continueButton.isEnabled(), true);

  await page.reload();
  await page.getByRole("heading", { name: "You stay in control." }).waitFor();
  assert.equal(await page.getByLabel("I understand these boundaries").isChecked(), true);
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByRole("heading", { name: "Build your model stack." }).waitFor();
  await page.getByRole("tab", { name: /Accounts/ }).waitFor();
  await page.getByText("ChatGPT plan through Codex", { exact: true }).waitFor();
  const openAiGroup = page.locator(".provider-group").filter({ hasText: "OpenAI API" });
  await openAiGroup.getByLabel("Account 1").fill("test-openai-account-one");
  await openAiGroup.getByRole("button", { name: "Save" }).first().click();
  await openAiGroup.getByText("Connected", { exact: true }).waitFor();
  await openAiGroup.getByLabel("Account 2").fill("test-openai-account-two");
  await openAiGroup.getByRole("button", { name: "Save" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".provider-group:first-of-type .configured-account").length === 2);
  await page.getByRole("tab", { name: /On this Mac/ }).click();
  await page.getByRole("button", { name: "Set up local AI automatically" }).waitFor();
  await page.getByRole("button", { name: "Set up manually" }).click();
  await page.getByText("Manual local setup", { exact: true }).waitFor();
  await page.getByRole("link", { name: "Install Ollama from its official download" }).waitFor();
  await page.getByText("Any other Ollama model", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "More options" }).click();
  await page.getByText("Not claimed as native yet", { exact: true }).waitFor();

  await page.setViewportSize({ width: 640, height: 760 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(overflow, false);

  await page.setViewportSize({ width: 1320, height: 860 });
  assert.equal(await page.getByRole("button", { name: "Set up models later" }).count(), 0);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: /Kestrel is ready for a model|Your foundation is set/ }).waitFor();
  await page.getByRole("button", { name: "Continue with setup assistant" }).click();
  await page.getByRole("button", { name: "New chat" }).waitFor();
  const setupAssistantPrompt = await page.getByLabel("Message Kestrel").inputValue();
  assert.match(setupAssistantPrompt, /Help me finish setting up Kestrel/);
  assert.match(setupAssistantPrompt, /Current non-secret setup state:/);
  assert.match(setupAssistantPrompt, /Protected API credentials configured:/);
  assert.match(setupAssistantPrompt, /Project access, tools\/MCP, skills\/plugins, channels, and automations/);
  assert.equal(await page.evaluate(() => localStorage.getItem("kestrel:setup-coach-context")), null);
  assert.equal(await page.evaluate(() => localStorage.getItem("kestrel:onboarded")), "yes");
  await page.getByRole("button", { name: "Connections" }).click();
  await page.getByRole("heading", { name: "Access only what helps." }).waitFor();
  const chatGptConnection = page.locator(".oauth-connection").filter({ hasText: "ChatGPT" });
  await chatGptConnection.getByText("ChatGPT", { exact: true }).waitFor();
  assert.equal(
    await chatGptConnection
      .getByRole("button", {
        name: /Sign in with ChatGPT|Enable model route|Disable model route|Codex not found/,
      })
      .count(),
    1,
  );
  await page.getByLabel("Desktop OAuth client ID").waitFor();
  assert.equal(await page.getByRole("button", { name: "Connect with Google" }).isDisabled(), true);
  await page.getByLabel("Desktop OAuth client ID").fill("1234567890-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com");
  assert.equal(await page.getByRole("button", { name: "Connect with Google" }).isEnabled(), true);
  await page.getByRole("link", { name: "Google Cloud Console" }).waitFor();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Open setup guide" }).click();
  await page.getByRole("heading", { name: /Bring your models/ }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("kestrel:onboarded")), null);
  assert.deepEqual(runtimeErrors, []);
  process.stdout.write("Four-step desktop setup persistence, automatic/manual local setup, setup-assistant handoff, ChatGPT and Google OAuth connection entries, compact reflow, completion, and Settings re-entry passed.\n");
} finally {
  await application?.close();
  rmSync(root, { recursive: true, force: true });
}
