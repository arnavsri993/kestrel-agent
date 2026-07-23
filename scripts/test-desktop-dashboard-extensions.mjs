import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const temporaryRoot = mkdtempSync(
  join(tmpdir(), "workstrand-dashboard-extensions-"),
);
const userData = join(temporaryRoot, "user-data");
const pluginRoot = join(userData, "plugins", "release-ops", "1.0.0");
const screenshotPath = resolve(
  "artifacts/screenshots/desktop/setup-revised/dashboard-extension-release-ops.png",
);
mkdirSync(join(pluginRoot, ".codex-plugin"), { recursive: true });
mkdirSync(dirname(screenshotPath), { recursive: true });
writeFileSync(
  join(pluginRoot, ".codex-plugin", "plugin.json"),
  JSON.stringify({
    name: "release-ops",
    version: "1.0.0",
    description: "Bounded release operations for the Kestrel dashboard.",
    interface: {
      displayName: "Release Ops",
      shortDescription: "Release evidence without renderer code.",
      capabilities: ["Read status"],
      defaultPrompt: [],
    },
    dashboard: "./dashboard.json",
  }),
);
writeFileSync(
  join(pluginRoot, "dashboard.json"),
  JSON.stringify({
    version: 1,
    title: "Release operations",
    description:
      "See the delivery boundary and move into the built-in evidence views.",
    navigationLabel: "Release Ops",
    panels: [
      {
        id: "delivery",
        title: "Delivery boundary",
        description:
          "Live values come from Kestrel; the plugin supplies only labels and approved source names.",
        tone: "accent",
        metrics: [
          { label: "Agent", source: "agent-state" },
          { label: "Pending approvals", source: "pending-approvals" },
          { label: "Active sessions", source: "runtime-sessions" },
          { label: "Plugin", source: "plugin-version" },
        ],
        items: [
          "Verify the packaged application before publishing.",
          "Keep approval evidence attached to the release.",
        ],
        actions: [
          { label: "Open readiness", page: "readiness" },
          { label: "Review artifacts", page: "artifacts" },
        ],
      },
    ],
  }),
);

let application;
try {
  application = await electron.launch({
    args: [resolve("apps/desktop/out/main/index.js")],
    env: { ...process.env, KESTREL_TEST_USER_DATA: userData },
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(12_000);
  const runtimeErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.evaluate(() => localStorage.setItem("kestrel:onboarded", "yes"));
  await page.reload();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const pluginSetting = page
    .locator("article.setting-row")
    .filter({ hasText: "Release Ops" });
  await pluginSetting.getByText("Dashboard panels available").waitFor();
  await pluginSetting.getByRole("button", { name: "Enable" }).click();
  await pluginSetting.getByText("Dashboard panels active").waitFor();

  await page.getByRole("button", { name: /More/ }).click();
  await page.getByRole("button", { name: "Extensions", exact: true }).click();
  await page.getByRole("heading", { name: "Release operations" }).waitFor();
  await page.getByText("Declarative only", { exact: true }).waitFor();
  await page.getByText("Delivery boundary", { exact: true }).waitFor();
  await page.getByText("v1.0.0", { exact: true }).waitFor();
  assert.equal(
    await page.locator(".dashboard-panel-data dd").count(),
    4,
  );

  await page
    .getByRole("button", { name: "Open readiness", exact: true })
    .click();
  await page
    .getByRole("heading", {
      name: /The core is ready|Finish the essentials/,
    })
    .waitFor();
  await page.getByRole("button", { name: /More/ }).click();
  await page.getByRole("button", { name: "Extensions", exact: true }).click();
  await page.getByRole("heading", { name: "Release operations" }).waitFor();

  await page.setViewportSize({ width: 1320, height: 900 });
  await page.screenshot({ path: screenshotPath });
  await page.setViewportSize({ width: 640, height: 760 });
  await page.locator(".dashboard-panel").scrollIntoViewIfNeeded();
  assert.equal(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    ),
    false,
  );
  assert.deepEqual(runtimeErrors, []);
  process.stdout.write(
    `Strict dashboard contribution, enablement, live metrics, safe navigation, compact reflow, and screenshot passed. Screenshot: ${screenshotPath}\n`,
  );
} finally {
  await application?.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
}
