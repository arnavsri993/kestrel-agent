import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { launchChromiumHost } from "../apps/chromium-host/src/host";

let completions = 0;
let toolsExposed = false;
const pending = new Set<import("node:http").ServerResponse>();
const server = createServer(async (request, response) => {
  if (request.url === "/page") {
    response.setHeader("Content-Type", "text/html");
    response.end('<!doctype html><title>Chromium browser fixture</title><h1>Real browser tab</h1><a href="/next">Next page</a><a href="/next" target="_blank">Open popup</a>'); return;
  }
  if (request.url === "/next") { response.end('<!doctype html><title>Next fixture page</title><h1>Navigation works</h1>'); return; }
  if (request.url === "/v1/models") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ data: [{ id: "fixture-model", object: "model" }] })); return; }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  toolsExposed ||= !!body.tools?.length;
  completions++;
  if (JSON.stringify(body.messages).includes("Hold this response")) {
    pending.add(response); response.once("close", () => pending.delete(response)); return;
  }
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
  response.end(`data: ${JSON.stringify({ id: "fixture-response", model: "fixture-model", choices: [{ index: 0, delta: { content: "Hello from the standalone core in Chromium." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
let host: Awaited<ReturnType<typeof launchChromiumHost>> | undefined;
try {
  host = await launchChromiumHost({ headless: process.env.KESTREL_CHROMIUM_HEADED !== "1", model: "fixture-model", secureEnvironment: {
    NOUS_API_KEY: "local-fixture-only", NOUS_BASE_URL: `${origin}/v1`, NOUS_MODEL: "fixture-model",
  } });
  const page = host.shell;
  page.setDefaultTimeout(20_000);
  await expect(page.getByRole("status")).toHaveText("Core connected");
  await page.getByLabel("Message", { exact: true }).fill("Hello Chromium");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Hello from the standalone core in Chromium.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  assert(completions > 0);
  assert.equal(toolsExposed, false, "Conversation preview must not advertise tools");
  await page.reload();
  await expect(page.getByText("Hello from the standalone core in Chromium.", { exact: true })).toBeVisible();
  await page.getByLabel("Web address").fill(`${origin}/page`);
  const remotePromise = page.context().waitForEvent("page");
  await page.getByRole("button", { name: "Open tab", exact: true }).click();
  const remote = await remotePromise;
  await expect(remote.getByRole("heading", { name: "Real browser tab" })).toBeVisible();
  assert.equal(await remote.evaluate(() => typeof (window as any).kestrelHost), "undefined");
  await remote.getByRole("link", { name: "Next page" }).click();
  await expect(remote.getByRole("heading", { name: "Navigation works" })).toBeVisible();
  await remote.goBack();
  await expect(remote.getByRole("heading", { name: "Real browser tab" })).toBeVisible();
  const popupPromise = remote.waitForEvent("popup");
  await remote.getByRole("link", { name: "Open popup" }).click();
  const popup = await popupPromise;
  await expect(popup.getByRole("heading", { name: "Navigation works" })).toBeVisible();
  assert.equal(await popup.evaluate(() => typeof (window as any).kestrelHost), "undefined");
  await page.bringToFront();
  await expect(page.getByRole("button", { name: "Switch to Next fixture page", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close Next fixture page", exact: true }).click();
  await expect.poll(() => popup.isClosed()).toBe(true);
  await expect(page.getByRole("button", { name: "Switch to Next fixture page", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "＋ New conversation" }).click();
  await expect(page.getByRole("heading", { name: "New conversation", exact: true })).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill("Hold this response");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => pending.size).toBe(1);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await expect.poll(() => pending.size).toBe(0);
  await page.getByRole("button", { name: "Hello Chromium", exact: true }).click();
  await expect(page.getByText("Hello from the standalone core in Chromium.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
  await mkdir(".tmp/chromium-host", { recursive: true });
  await page.screenshot({ path: resolve(".tmp/chromium-host/desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: resolve(".tmp/chromium-host/narrow.png"), fullPage: true });
  // Even navigating the formerly privileged page away removes its authority.
  await page.goto(`${origin}/page`);
  const rejection = await page.evaluate(async () => {
    try { await (window as any).kestrelHost({ type: "state" }); return "allowed"; }
    catch { return "denied"; }
  });
  assert.equal(rejection, "denied");
  await host.close();
  host = await launchChromiumHost({ headless: true });
  await expect(host.shell.getByRole("status")).toHaveText("Core connected");
  await expect(host.shell.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await expect(host.shell.getByText(/No model provider configured/)).toBeVisible();
  console.log("Chromium host passed: real Node conversation, reload, cancellation, native web navigation, no tools, isolated bridge and narrow layout.");
} finally {
  await host?.close();
  for (const response of pending) response.destroy();
  await new Promise<void>((done) => server.close(() => done()));
}
