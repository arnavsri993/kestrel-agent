import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "kestrel-desktop-smoke-"));
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const packagedExecutable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const executablePath = packagedExecutable
  ? resolve(packagedExecutable)
  : requireFromDesktop("electron");
const launchArgs = packagedExecutable ? [] : [resolve("apps/desktop")];
let application;
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(`<!doctype html><html><head><title>Kestrel browser smoke</title></head><body><label>Name <input id="name"></label><button id="submit" onclick="document.querySelector('#result').textContent = 'Hello ' + document.querySelector('#name').value">Submit</button><output id="result">Waiting</output></body></html>`);
});
await new Promise((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(0, "127.0.0.1", resolveListen);
});
const address = server.address();
assert(address && typeof address === "object");
const browserOrigin = `http://127.0.0.1:${address.port}`;
try {
  application = await electron.launch({
    executablePath,
    args: launchArgs,
    env: { ...process.env, KESTREL_TEST_USER_DATA: join(root, "user-data") }
  });
  const page = await application.firstWindow();
  await page.evaluate(() => localStorage.setItem("kestrel:onboarded", "yes"));
  await page.reload();
  await page.getByRole("heading", { name: "What should we get done?" }).waitFor();
  await page.locator('summary[aria-label="Task settings"]').click();
  await page.getByLabel("Project").waitFor();
  const execution = page.getByLabel("Execution");
  await execution.waitFor();
  assert.equal(await execution.inputValue(), "automatic");
  await execution.selectOption("manual");
  await page.locator(".runtime-task-controls label", { hasText: /^Provider/ }).locator("select").waitFor();
  await page.locator(".runtime-task-controls label", { hasText: /^Model/ }).locator("input, select").waitFor();
  assert.equal(await page.getByRole("button", { name: "Send message" }).isDisabled(), true);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: /^General/ }).click();
  await page.getByText("Activity pet", { exact: true }).waitFor();
  await page.getByText("Hatch an original pet with AI", { exact: true }).waitFor();

  const petDecoder = await page.evaluate(async () => {
    const result = await window.kestrel.request({ type: "pet-decoder-diagnostic" });
    if (!result.ok) throw new Error(result.error);
    return result.petDecoderDiagnostic;
  });
  assert.deepEqual(
    { decoder: petDecoder?.decoder, ok: petDecoder?.ok },
    { decoder: "sharp", ok: true }
  );
  assert.match(petDecoder?.version ?? "", /^\d+\.\d+\.\d+/);

  const browserSmoke = await page.evaluate(async ({ browserOrigin }) => {
    const sessions = await window.kestrel.request({ type: "runtime-list-sessions" });
    if (!sessions.ok || !sessions.sessions?.length) throw new Error("No runtime session is available.");
    let sessionId;
    for (const candidate of sessions.sessions) {
      const discovered = await window.kestrel.request({ type: "runtime-discover-tools", sessionId: candidate.id, query: "browser.create" });
      if (discovered.ok && discovered.tools?.some((tool) => tool.name === "browser.create")) { sessionId = candidate.id; break; }
    }
    if (!sessionId) throw new Error("Packaged browser tools were not installed.");
    const call = async (toolName, input, idempotencyKey) => {
      const result = await window.kestrel.request({ type: "runtime-call-tool", sessionId, toolName, input, approvalStatus: "approved", ...(idempotencyKey ? { idempotencyKey } : {}) });
      if (!result.ok) throw new Error(result.error);
      if (result.execution?.status !== "verified") throw new Error(`${toolName} was not verified: ${result.execution?.status}${result.execution?.error ? ` — ${result.execution.error}` : ""}`);
      return result.execution.output;
    };
    const created = await call("browser.create", { allowedOrigins: [browserOrigin] }, "desktop-smoke-create");
    const browserSessionId = String(created?.browserSessionId ?? "");
    if (!browserSessionId) throw new Error("Browser session ID is missing.");
    try {
      await call("browser.navigate", { browserSessionId, url: `${browserOrigin}/smoke` }, "desktop-smoke-navigate");
      await call("browser.act", { browserSessionId, action: { type: "type", target: "#name", text: "Kestrel" } }, "desktop-smoke-type");
      await call("browser.act", { browserSessionId, action: { type: "click", target: "#submit" } }, "desktop-smoke-click");
      let snapshot;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        snapshot = await call("browser.snapshot", { browserSessionId });
        if (JSON.stringify(snapshot?.accessibilityTree).includes("Hello Kestrel")) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const screenshot = await call("browser.screenshot", { browserSessionId });
      return {
        title: snapshot?.title,
        snapshotText: JSON.stringify(snapshot?.accessibilityTree),
        screenshotWidth: screenshot?.width,
        screenshotHeight: screenshot?.height,
        pngBase64: screenshot?.pngBase64
      };
    } finally {
      await call("browser.close", { browserSessionId }, "desktop-smoke-close");
    }
  }, { browserOrigin });
  assert.equal(browserSmoke.title, "Kestrel browser smoke");
  assert.match(browserSmoke.snapshotText, /Hello Kestrel/);
  assert.equal(typeof browserSmoke.screenshotWidth, "number");
  assert.equal(typeof browserSmoke.screenshotHeight, "number");
  assert.match(browserSmoke.pngBase64, /^iVBOR/);
  await page.screenshot({ path: join(root, "desktop-smoke.png"), fullPage: true });
  process.stdout.write(`Rendered desktop, native Sharp ${petDecoder.version}, and isolated browser-tool smoke test passed.\n`);
} finally {
  await application?.close();
  await new Promise((resolveClose) => server.close(resolveClose));
  rmSync(root, { recursive: true, force: true });
}
