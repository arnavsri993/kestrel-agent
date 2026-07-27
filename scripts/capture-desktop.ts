import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const captureName = process.argv.includes("--natural-controls") ? "natural-controls" : process.argv.includes("--model-tiers") ? "model-tiers" : process.argv.includes("--native-graphite") ? "native-graphite" : process.argv.includes("--mineral-current") ? "mineral-current" : process.argv.includes("--setup-revised") ? "setup-revised" : process.argv.includes("--workstrand-pass1") ? "workstrand-pass1" : process.argv.includes("--workstrand-revised") ? "workstrand-revised" : process.argv.includes("--revised") ? "revised" : "initial";
const output = join(root, "artifacts", "screenshots", "desktop", captureName);
const testData = join(root, ".tmp", "desktop-capture-data");
await rm(testData, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const application = await electron.launch({
  args: [join(root, "apps", "desktop", "out", "main", "index.js")],
  env: { ...process.env, KESTREL_TEST_USER_DATA: testData }
});
const page = await application.firstWindow();
const runtimeErrors: string[] = [];
page.on("console", (message) => { if (message.type() === "error") runtimeErrors.push(message.text()); });
page.on("pageerror", (error) => runtimeErrors.push(error.message));
await page.waitForLoadState("domcontentloaded");
await page.setViewportSize({ width: 1320, height: 860 });
await page.screenshot({ path: join(output, "onboarding.png"), fullPage: false });
await page.getByRole("button", { name: "Continue" }).click();
await page.getByRole("heading", { name: "Choose what stays on this Mac." }).waitFor();
await page.screenshot({ path: join(output, "setup-warning.png"), fullPage: false });
await page.getByLabel("I understand these boundaries").check();
await page.getByRole("button", { name: "Continue" }).click();
await page.getByRole("heading", { name: "Choose a model." }).waitFor();
await page.screenshot({ path: join(output, "setup-accounts.png"), fullPage: false });
await page.getByRole("button", { name: /Keep it on this Mac/ }).click();
await page.getByRole("heading", { name: "Set up a local model." }).waitFor();
await page.screenshot({ path: join(output, "setup-local-models.png"), fullPage: false });
await page.getByRole("button", { name: "Back" }).click();
await page.getByRole("button", { name: /Start with free accounts/ }).click();
await page.getByRole("heading", { name: /Connect a free account/ }).waitFor();
await page.screenshot({ path: join(output, "setup-more-providers.png"), fullPage: false });
await page.setViewportSize({ width: 640, height: 760 });
await page.screenshot({ path: join(output, "setup-compact.png"), fullPage: false });
const setupOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
if (setupOverflow) throw new Error("Compact setup layout has page-level horizontal overflow.");
await page.setViewportSize({ width: 1320, height: 860 });
await page.getByRole("button", { name: "Continue" }).click();
await page.getByRole("heading", { name: /Kestrel is ready|Your model route is configured\.|Your workspace is ready\./ }).waitFor();
await page.screenshot({ path: join(output, "setup-ready.png"), fullPage: false });
await page.getByRole("button", { name: /Start using Kestrel|Open Kestrel|Open local preview/ }).click();
await page.getByRole("heading", { name: /^Good (morning|afternoon|evening)\.$/ }).waitFor();
await page.getByRole("button", { name: "New chat" }).waitFor();
await page.getByText("Kestrel", { exact: true }).first().waitFor();
await page.waitForTimeout(200);
await page.screenshot({ path: join(output, "today.png"), fullPage: false });
await page.getByRole("button", { name: "Connections" }).click();
await page.getByRole("heading", { name: "Access only what helps." }).waitFor();
await page.screenshot({ path: join(output, "connections-google-oauth.png"), fullPage: false });
await page.getByRole("button", { name: "New chat" }).click();
await page.getByText("Model and tools", { exact: true }).click();
await page.getByLabel("Execution").waitFor();
await page.screenshot({ path: join(output, "task-setup.png"), fullPage: false });
await page.getByText("Model and tools", { exact: true }).click();
const firstSession = page.locator(".recent-section button").first();
if (await firstSession.count()) {
  await firstSession.click();
  await page.locator(".conversation-view").waitFor();
  await page.screenshot({ path: join(output, "conversation.png"), fullPage: false });
}
await page.getByRole("button", { name: "More" }).click();
await page.screenshot({ path: join(output, "more-tools.png"), fullPage: false });
await page.getByRole("button", { name: "Readiness" }).click();
await page.getByRole("heading", { name: "What can work right now" }).waitFor();
await page.screenshot({ path: join(output, "readiness.png"), fullPage: false });
await page.getByRole("button", { name: "Approvals" }).click();
await page.getByRole("heading", { name: "Review the exact changes." }).waitFor();
await page.screenshot({ path: join(output, "approval.png"), fullPage: false });
await page.getByRole("button", { name: "New chat" }).click();
await page.setViewportSize({ width: 760, height: 760 });
await page.getByRole("heading", { name: /^Good (morning|afternoon|evening)\.$/ }).waitFor();
await page.screenshot({ path: join(output, "compact.png"), fullPage: false });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
if (overflow) throw new Error("Compact desktop layout has page-level horizontal overflow.");
await page.getByLabel("Message Kestrel").fill("RC not connected to mobile device.");
await page.getByLabel("Message Kestrel").press("Tab");
const keyboardFocus = await page.evaluate(() => {
  const active = document.activeElement as HTMLElement | null;
  if (!active) return { label: "", outline: "none" };
  return { label: active.getAttribute("aria-label") ?? active.textContent ?? "", outline: getComputedStyle(active).outlineStyle };
});
if (keyboardFocus.label !== "Record voice" || keyboardFocus.outline === "none") throw new Error("Compact keyboard focus did not move visibly to the voice control.");
if (await page.getByRole("button", { name: "Send message" }).isEnabled()) {
  await page.getByRole("button", { name: "Send message" }).press("Enter");
}
await page.emulateMedia({ reducedMotion: "reduce" });
await page.getByRole("button", { name: "Approvals" }).click();
await page.getByRole("heading", { name: "Review the exact changes." }).waitFor();
if (runtimeErrors.length > 0) throw new Error(`Renderer errors: ${runtimeErrors.join(" | ")}`);
await application.close();
console.log(output);
