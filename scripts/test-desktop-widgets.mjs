import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const temporaryRoot = mkdtempSync(join(tmpdir(), "workstrand-widgets-"));
const screenshotPath = resolve(
  "artifacts/screenshots/desktop/setup-revised/artifact-interactive-widget.png",
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
  page.setDefaultTimeout(12_000);
  const runtimeErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.evaluate(() => localStorage.setItem("kestrel:onboarded", "yes"));
  await page.reload();

  const artifact = await page.evaluate(async () => {
    const sessions = await window.kestrel.request({
      type: "runtime-list-sessions",
    });
    if (!sessions.ok || !sessions.sessions?.[0])
      throw new Error("Runtime session unavailable.");
    const result = await window.kestrel.request({
      type: "runtime-call-tool",
      sessionId: sessions.sessions[0].id,
      toolName: "show_widget",
      input: {
        title: "Release confidence",
        widget_code: `<section class="card"><p class="muted">Choose a review lane</p><h2 id="result">No lane selected</h2><div class="row"><button id="visual" class="primary">Visual</button><button id="security">Security</button></div></section><script>document.getElementById("visual").addEventListener("click",()=>document.getElementById("result").textContent="Visual review selected");document.getElementById("security").addEventListener("click",()=>document.getElementById("result").textContent="Security review selected");document.documentElement.dataset.widgetReady="true";</script>`,
      },
      approvalStatus: "approved",
      idempotencyKey: "desktop-widget-fixture",
    });
    if (!result.ok || !result.execution?.output)
      throw new Error(result.ok ? "Widget output unavailable." : result.error);
    return result.execution.output;
  });
  assert.equal(artifact.artifact.mediaType, "text/html");
  assert.equal(artifact.sandbox.opaqueOrigin, true);
  assert.equal(artifact.sandbox.network, false);

  await page.getByRole("button", { name: /Tools/ }).click();
  await page.getByRole("button", { name: "Artifacts", exact: true }).click();
  await page.getByText("Release confidence", { exact: true }).waitFor();
  const iframe = page.locator(".artifact-widget iframe");
  await iframe.waitFor();
  assert.equal(await iframe.getAttribute("sandbox"), "allow-scripts");
  const iframeHandle = await iframe.elementHandle();
  const widget = await iframeHandle?.contentFrame();
  assert.ok(widget, "Interactive artifact frame was not attached.");
  await widget.waitForLoadState("load");
  await widget.locator("html[data-widget-ready='true']").waitFor();
  await widget
    .getByRole("button", { name: "Visual" })
    .evaluate((button) => button.click());
  await widget
    .getByRole("heading", { name: "Visual review selected" })
    .waitFor();
  await page
    .getByText("Interactive · isolated · network off", { exact: true })
    .waitFor();

  await page.setViewportSize({ width: 1320, height: 900 });
  await page.screenshot({ path: screenshotPath });
  await page.setViewportSize({ width: 640, height: 760 });
  await iframe.scrollIntoViewIfNeeded();
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
    `Opaque-origin interactive widget, persistence, native rendering, compact reflow, and screenshot passed. Screenshot: ${screenshotPath}\n`,
  );
} finally {
  await application?.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
}
