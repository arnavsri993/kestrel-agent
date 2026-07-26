import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "workstrand-observability-ui-"));
const screenshotPath = resolve("artifacts/screenshots/desktop/setup-revised/settings-observability.png");
mkdirSync(resolve("artifacts/screenshots/desktop/setup-revised"), { recursive: true });
const received = [];
const collector = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  received.push({
    path: request.url,
    contentType: String(request.headers["content-type"] ?? ""),
    authorization: String(request.headers.authorization ?? ""),
    body: Buffer.concat(chunks)
  });
  response.writeHead(200, { "content-type": "application/x-protobuf" });
  response.end();
});
await new Promise((resolvePromise) => collector.listen(0, "127.0.0.1", resolvePromise));
const collectorAddress = collector.address();
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
  await page.evaluate(() => localStorage.setItem("kestrel:onboarded", "yes"));
  await page.reload();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: /^Advanced/ }).click();
  const observability = page.locator(".observability-setting");
  await observability.getByText("External observability", { exact: true }).waitFor();
  assert.match(await observability.textContent(), /never eligible for export/);
  await observability.getByLabel("Enable content-free diagnostics").check();
  await observability.getByText("OpenTelemetry · OTLP/HTTP protobuf", { exact: true }).click();
  await observability.getByLabel("Enable OTLP push").check();
  await observability.getByLabel("Collector base URL").fill(`http://127.0.0.1:${collectorAddress.port}`);
  await observability.getByLabel("Service name").fill("workstrand-desktop-test");
  await observability.getByLabel("Auth header value").fill("Bearer desktop-collector-secret");
  await observability.getByLabel("Trace sample rate").fill("1");
  await observability.getByText("Prometheus", { exact: true }).click();
  await observability.getByLabel("Expose metrics when remote serve is running").check();
  await observability.getByRole("button", { name: "Save observability" }).click();
  await observability.getByText("Observability configuration saved and applied.", { exact: true }).waitFor();
  const session = await page.evaluate(() => window.kestrel.request({ type: "runtime-create-session", title: "private telemetry test title" }));
  assert.equal(session.ok, true);
  await observability.getByRole("button", { name: "Test collector" }).click();
  await observability.getByText("Collector accepted content-free OTLP metrics and traces.", { exact: true }).waitFor();
  assert.deepEqual(received.map((request) => request.path).sort(), ["/v1/metrics", "/v1/traces"]);
  assert.ok(received.every((request) => request.contentType === "application/x-protobuf"));
  assert.ok(received.every((request) => request.authorization === "Bearer desktop-collector-secret"));
  const wire = Buffer.concat(received.map((request) => request.body)).toString("utf8");
  assert.match(wire, /workstrand-desktop-test/);
  assert.doesNotMatch(wire, /private telemetry test title|desktop-collector-secret/);
  const state = await page.evaluate(() => window.kestrel.request({ type: "observability-get" }));
  assert.equal(state.ok, true);
  assert.ok("observabilityStatus" in state && state.observabilityStatus?.hasHeaderValue);
  assert.doesNotMatch(JSON.stringify(state), /desktop-collector-secret/);

  await page.setViewportSize({ width: 1320, height: 900 });
  await observability.scrollIntoViewIfNeeded();
  await page.screenshot({ path: screenshotPath });
  await page.setViewportSize({ width: 640, height: 760 });
  await observability.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  assert.deepEqual(runtimeErrors, []);
  process.stdout.write(`Desktop OTLP protobuf setup/test, encrypted write-only auth header, Prometheus opt-in, compact reflow, and screenshot passed. Screenshot: ${screenshotPath}\n`);
} finally {
  await application?.close();
  await new Promise((resolvePromise, reject) => collector.close((error) => error ? reject(error) : resolvePromise()));
  rmSync(root, { recursive: true, force: true });
}
