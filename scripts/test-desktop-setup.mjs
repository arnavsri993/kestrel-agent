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

  const selectedSkin = await page.evaluate(async () =>
    window.kestrel.request({ type: "skin-select", skinId: "daylight" }),
  );
  assert.equal(selectedSkin.ok, true);
  await page.reload();

  await page.getByRole("heading", { name: /Your AI answers/ }).waitFor();
  const setupTheme = await page.locator(".setup-onboarding").evaluate((element) => ({
    canvas: getComputedStyle(element).getPropertyValue("--canvas").trim(),
    signal: getComputedStyle(element).getPropertyValue("--signal").trim(),
    colorScheme: getComputedStyle(element).colorScheme,
    color: getComputedStyle(element).color,
  }));
  assert.equal(setupTheme.canvas, "#1c1c1e");
  assert.equal(setupTheme.signal, "#78b986");
  assert.equal(setupTheme.colorScheme, "dark");
  assert.equal(setupTheme.color, "rgb(245, 245, 247)");
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim()),
    "#f5f2ea",
  );
  assert.equal(await page.locator(".setup-product-anchor").count(), 1);
  assert.deepEqual(
    await page.locator(".setup-rail li strong").allTextContents(),
    ["Welcome", "Before you begin", "Choose a model", "Model setup", "Ready"],
  );
  await page.getByRole("button", { name: "Get started" }).click();
  const continueButton = page.getByRole("button", { name: "Continue" });
  assert.equal(await continueButton.isDisabled(), true);
  const firstBoundary = page.locator(".warning-panel details").first();
  await firstBoundary.locator("summary").click();
  await page
    .getByText(/retention and training terms/)
    .waitFor();
  await page.getByLabel("I understand these boundaries").check();
  assert.equal(await continueButton.isEnabled(), true);

  await page.reload();
  await page.getByRole("heading", { name: "Know what leaves this Mac." }).waitFor();
  assert.equal(await page.getByLabel("I understand these boundaries").isChecked(), true);
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByRole("heading", { name: "Choose a model." }).waitFor();
  await page.getByRole("button", { name: /Use an account/ }).click();
  await page.getByRole("heading", { name: "Connect an account." }).waitFor();
  await page.getByText("Choose a paid provider", { exact: true }).waitFor();
  await page.getByRole("option", { name: /OpenAI/ }).waitFor();
  await page.getByText("Codex CLI", { exact: true }).waitFor();
  const openAiMethods = page.locator(".paid-provider-methods");
  await openAiMethods.getByLabel("Account 1").fill("test-openai-account-one");
  await openAiMethods.getByRole("button", { name: "Save" }).first().click();
  await openAiMethods.getByText("Connected", { exact: true }).waitFor();
  await openAiMethods.getByLabel("Account 2").fill("test-openai-account-two");
  await openAiMethods.getByRole("button", { name: "Save" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".paid-provider-methods .configured-account").length === 2);
  await page.getByRole("option", { name: /Anthropic/ }).click();
  await page.getByText("Claude Code CLI", { exact: true }).waitFor();
  await page.getByRole("option", { name: /Microsoft Azure/ }).click();
  await page.getByText("Azure CLI / Entra ID", { exact: true }).waitFor();
  await page.getByText("Adapter coming later", { exact: true }).first().waitFor();
  await page.getByLabel("Find a provider").fill("Groq");
  assert.equal(await page.getByRole("option").count(), 1);
  await page.getByLabel("Find a provider").fill("");
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: /Run on this Mac/ }).click();
  await page.getByRole("heading", { name: "Set up a local model." }).waitFor();
  await page.getByText("Balanced is recommended for this Mac.", { exact: true }).waitFor();
  const tierNames = page.locator(".model-tier-name strong");
  await tierNames.first().waitFor();
  const names = await tierNames.allTextContents();
  assert.ok(names.includes("Light"));
  assert.ok(names.length >= 1 && names.length <= 3);
  if (names.length === 3) {
    assert.deepEqual(names, ["Light", "Balanced", "Power"]);
    await page.getByText("Recommended", { exact: true }).waitFor();
  } else {
    assert.ok(!names.includes("Balanced"));
  }
  const tierDetails = page.locator(".model-tier-details");
  const detailIndex = Math.min(1, (await tierDetails.count()) - 1);
  assert.equal(
    await tierDetails.nth(detailIndex).evaluate((details) => details.open),
    false,
  );
  await tierDetails.nth(detailIndex).getByText("Details", { exact: true }).click();
  await tierDetails.nth(detailIndex).getByText(/GB · 256K context/, { exact: true }).waitFor();
  assert.equal(await page.getByText("Automatic setup", { exact: true }).count(), 0);
  await page
    .getByText("huihui_ai/qwen3.5-abliterated:4b", { exact: true })
    .count()
    .then((count) => assert.equal(count, 0));
  assert.equal(await page.getByText("Fast path", { exact: true }).count(), 0);
  assert.equal(
    await page.getByText("Standard Qwen models", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByText("qwen3.5:9b", { exact: true }).count(),
    0,
  );
  await page
    .getByText(/These models use reduced filtering/)
    .waitFor();
  await page.getByRole("button", { name: /Manual setup/ }).click();
  await page.getByRole("link", { name: "Install Ollama from its official download" }).waitFor();
  await page.getByText("Any other Ollama model", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: /Try free providers/ }).click();
  await page.getByRole("heading", { name: "Connect a free account." }).waitFor();
  await page.getByText("More ways to run models", { exact: true }).waitFor();
  await page.getByRole("link", { name: /Hugging Face Inference Providers/ }).waitFor();

  await page.setViewportSize({ width: 640, height: 760 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(overflow, false);
  assert.equal(await page.locator(".setup-product-anchor").count(), 1);
  const railLayout = await page.locator(".setup-rail ol").evaluate((rail) => {
    const items = [...rail.querySelectorAll("li")].map((item) => item.getBoundingClientRect());
    return {
      rows: getComputedStyle(rail).gridTemplateRows.split(" ").filter(Boolean).length,
      topEdges: [...new Set(items.map((item) => Math.round(item.top)))],
    };
  });
  assert.equal(railLayout.rows, 1);
  assert.equal(railLayout.topEdges.length, 1);

  await page.setViewportSize({ width: 1320, height: 860 });
  assert.equal(await page.getByRole("button", { name: "Do this later" }).count(), 0);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: /Kestrel is ready|Your model route is configured\.|Your workspace is ready\./ }).waitFor();
  await page.getByRole("button", { name: "Finish with setup help" }).click();
  await page.getByRole("button", { name: "New chat" }).waitFor();
  const setupAssistantPrompt = await page.getByLabel("Message Kestrel").inputValue();
  assert.match(setupAssistantPrompt, /Help me finish setting up Kestrel/);
  assert.match(setupAssistantPrompt, /Current non-secret setup state:/);
  assert.match(setupAssistantPrompt, /Protected API credentials configured:/);
  assert.match(setupAssistantPrompt, /Project access, tools\/MCP, skills\/plugins, channels, and automations/);
  assert.equal(await page.evaluate(() => localStorage.getItem("kestrel:setup-coach-context")), null);
  assert.equal(await page.evaluate(() => localStorage.getItem("kestrel:onboarded")), "yes");
  await page.getByRole("button", { name: "New chat" }).click();
  const newChatButton = page.getByRole("button", { name: "New chat" });
  assert.equal(await newChatButton.getAttribute("aria-current"), "page");
  await page.getByRole("button", { name: "Add project" }).waitFor();
  await page.getByText("Choose a folder and find the next useful step.").waitFor();
  await page.getByText("Turn an outcome into a clear, reviewable sequence.").waitFor();
  await page.setViewportSize({ width: 640, height: 760 });
  await newChatButton.getByText("New chat", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Tools" }).getByText("Tools", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Settings" }).getByText("Settings", { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    ),
    false,
  );
  await page.getByRole("button", { name: "Tools" }).click();
  await page.getByLabel("Kestrel tools").waitFor();
  const compactTools = await page.locator(".tools-disclosure").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      bottom: bounds.bottom,
      viewport: window.innerHeight,
      scrollable: element.scrollHeight >= element.clientHeight,
    };
  });
  assert.ok(compactTools.bottom <= compactTools.viewport - 64);
  assert.equal(compactTools.scrollable, true);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".tools-disclosure").waitFor({ state: "detached" });
  assert.equal(await page.locator(".tools-disclosure").count(), 0);
  await page.setViewportSize({ width: 1320, height: 860 });
  await page.getByRole("heading", { name: "Settings" }).waitFor();
  assert.equal(await page.locator(".page-header .eyebrow").count(), 0);
  assert.equal(await page.locator(".page-header > p").count(), 0);
  await page.getByRole("heading", { name: "Accounts and access" }).waitFor();
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
  await page.getByRole("button", { name: /General/ }).click();
  const selectedButtonShadows = await page
    .locator(
      ".sidebar-bottom > button.active, .nav-section button.active, .new-task-button.active, .settings-nav button.active, .skin-picker button.selected, [role=\"option\"][aria-selected=\"true\"], .event-application-rail button.active",
    )
    .evaluateAll((buttons) => buttons.map((button) => getComputedStyle(button).boxShadow));
  assert.equal(selectedButtonShadows.some((shadow) => shadow.includes("inset 3px 0")), false);
  await page.getByRole("button", { name: "Open setup guide" }).click();
  await page.getByRole("heading", { name: /Your AI answers/ }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("kestrel:onboarded")), null);
  assert.deepEqual(runtimeErrors, []);
  process.stdout.write("Five-step desktop setup persistence, automatic/manual local setup, setup-assistant handoff, ChatGPT and Google OAuth connection entries, compact reflow, completion, and Settings re-entry passed.\n");
} finally {
  await application?.close();
  rmSync(root, { recursive: true, force: true });
}
