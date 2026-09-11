import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { launchChromiumHost } from "../apps/chromium-host/src/host";

let completions = 0;
let toolsExposed = false;
let browserToolReads = 0;
let savedDrafts = 0;
const pending = new Set<import("node:http").ServerResponse>();
const server = createServer(async (request, response) => {
  if (request.url === "/form") {
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><title>Draft editor</title><label>Draft title<input id="draft"></label><label>Password<input type="password" value="never-expose-this"></label><label>Verification code<input autocomplete="one-time-code" value="123456"></label><button id="save">Save draft</button><p id="preview"></p><p id="result"></p><script>draft.addEventListener('input',()=>preview.textContent='Draft preview: '+draft.value);save.addEventListener('click',async()=>{await fetch('/save',{method:'POST'});result.textContent='Saved draft: '+draft.value;});</script>`); return;
  }
  if (request.url === "/save" && request.method === "POST") { savedDrafts++; response.end("saved"); return; }
  if (request.url === "/page") {
    response.setHeader("Content-Type", "text/html");
    response.end('<!doctype html><title>Chromium browser fixture</title><h1>Real browser tab</h1><input type="password" value="fixture-password-value"><a href="/next">Next page</a><a href="/next" target="_blank">Open popup</a>'); return;
  }
  if (request.url === "/next") { response.end('<!doctype html><title>Next fixture page</title><h1>Navigation works</h1>'); return; }
  if (request.url === "/v1/models") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ data: [{ id: "fixture-model", object: "model" }] })); return; }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  toolsExposed ||= !!body.tools?.length;
  completions++;
  if (JSON.stringify(body.messages.filter((message: any) => message.role === "user").at(-1)).includes("Complete browser form")) {
    const previous = body.messages.filter((message: any) => message.role === "tool");
    const tools = body.tools ?? [];
    const emitTool = (pattern: RegExp, args: object, id: string) => ({ tool_calls: [{ index: 0, id, type: "function", function: { name: tools.find((tool: any) => pattern.test(tool.function.name)).function.name, arguments: JSON.stringify(args) } }] });
    let delta;
    if (!previous.length) delta = emitTool(/tabs/, {}, "form-tabs");
    else {
      const id = JSON.stringify(previous[0]).match(/tab-[a-f0-9-]{36}/)?.[0]; assert(id);
      const findRef = (name: string): string => {
        const visit = (value: any): string | undefined => {
          if (!value || typeof value !== "object") return undefined;
          if (value.name === name && typeof value.ref === "string") return value.ref;
          for (const child of Object.values(value)) { const found = visit(child); if (found) return found; }
        };
        const ref = visit(JSON.parse(previous[1].content)); assert(ref, `Missing inspected ref for ${name}`); return ref;
      };
      if (previous.length === 1) delta = emitTool(/snapshot/, { tabId: id }, "inspect-form");
      else if (previous.length === 2) {
        assert(!previous[1].content.includes("never-expose-this"));
        assert(!previous[1].content.includes("123456"));
        delta = emitTool(/visible_act|visible-act/, { tabId: id, action: { type: "type", target: findRef("Draft title"), text: "Chromium release draft" } }, "fill-draft");
      } else if (previous.length === 3 && JSON.stringify(body.messages.filter((message: any) => message.role === "user").at(-1)).includes("reject")) delta = { content: "Form action rejected; no draft saved." };
      else if (previous.length === 3) delta = emitTool(/snapshot/, { tabId: id }, "verify-entry");
      else if (previous.length === 4) {
        assert(previous[3].content.includes("Draft preview: Chromium release draft"));
        delta = emitTool(/visible_act|visible-act/, { tabId: id, action: { type: "click", target: findRef("Save draft") } }, "save-draft");
      } else if (previous.length === 5) delta = emitTool(/snapshot/, { tabId: id }, "verify-save");
      else { assert(previous[5].content.includes("Saved draft: Chromium release draft")); delta = { content: "Verified saved draft: Chromium release draft." }; }
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "form-response", model: "fixture-model", choices: [{ index: 0, delta, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
    return;
  }
  if (JSON.stringify(body.messages.filter((message: any) => message.role === "user").at(-1)).includes("Navigate the browser")) {
    const previous = body.messages.filter((message: any) => message.role === "tool");
    const tools = body.tools ?? [];
    const emitTool = (pattern: RegExp, args: object, id: string) => ({ tool_calls: [{ index: 0, id, type: "function", function: { name: tools.find((tool: any) => pattern.test(tool.function.name)).function.name, arguments: JSON.stringify(args) } }] });
    let delta;
    if (!previous.length) delta = emitTool(/tabs/, {}, "navigate-tabs");
    else {
      const id = JSON.stringify(previous[0]).match(/tab-[a-f0-9-]{36}/)?.[0];
      assert(id);
      if (previous.length === 1) delta = emitTool(/navigate/, { tabId: id, input: `${origin}/next` }, "navigate-page");
      else if (previous.length === 2) delta = emitTool(/snapshot/, { tabId: id }, "verify-page");
      else delta = { content: JSON.stringify(previous.at(-1)).includes("Navigation works") ? "Verified navigation: Navigation works." : "Navigation was not completed." };
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "navigation-response", model: "fixture-model", choices: [{ index: 0, delta, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
    return;
  }
  if (JSON.stringify(body.messages.filter((message: any) => message.role === "user").at(-1)).includes("Inspect the open browser tab")) {
    const tools = body.tools ?? [];
    assert.equal(tools.length, 2, "Only the two read-only browser tools may be exposed");
    const previous = body.messages.filter((message: { role: string }) => message.role === "tool");
    let delta;
    if (!previous.length) {
      const tool = tools.find((tool: any) => /tabs/.test(tool.function.name));
      assert(tool);
      delta = { tool_calls: [{ index: 0, id: "read-tabs", type: "function", function: { name: tool.function.name, arguments: "{}" } }] };
    } else if (previous.length === 1) {
      const result = JSON.parse(previous[0].content);
      const serialized = JSON.stringify(result);
      const id = serialized.match(/tab-[a-f0-9-]{36}/)?.[0];
      assert(id, `Tab discovery did not return a real tab: ${serialized}`);
      const tool = tools.find((tool: any) => /snapshot/.test(tool.function.name));
      assert(tool);
      delta = { tool_calls: [{ index: 0, id: "read-page", type: "function", function: { name: tool.function.name, arguments: JSON.stringify({ tabId: id }) } }] };
    } else {
      const evidence = JSON.stringify(previous.at(-1));
      assert(evidence.includes("Real browser tab"), "Model must receive actual page evidence");
      assert(!evidence.includes("fixture-password-value"), "Input values must not reach the model");
      browserToolReads++;
      delta = { content: "The open page is titled Chromium browser fixture and contains Real browser tab." };
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "browser-read-response", model: "fixture-model", choices: [{ index: 0, delta, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
    return;
  }
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
  await page.getByLabel("Read open browser tabs for this message").check();
  await page.getByLabel("Message", { exact: true }).fill("Inspect the open browser tab");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("The open page is titled Chromium browser fixture and contains Real browser tab.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  assert.equal(browserToolReads, 1);
  await expect(page.getByLabel("Read open browser tabs for this message")).not.toBeChecked();
  const { sessionId: readerSession } = await page.evaluate(() => (window as any).kestrelHost({ type: "state" }));
  const deniedRead = await host.supervisor.request({ type: "runtime-call-tool", sessionId: readerSession, toolName: "browser.tabs", input: {} });
  assert(deniedRead.ok && "execution" in deniedRead && deniedRead.execution.status === "failed", "Browser reads must fail after the opted-in run finishes");
  const deniedMutation = await host.supervisor.request({ type: "runtime-call-tool", sessionId: readerSession, toolName: "browser.open-tab", input: {}, approvalStatus: "approved", idempotencyKey: "denied-host-action" });
  assert.equal(deniedMutation.ok, false, "Host ceiling must deny even explicitly approved mutation calls");
  // Approval is tied to this conversation and execution, survives shell reload,
  // and cannot be replayed after the one navigation has been dispatched.
  await page.getByRole("button", { name: "＋ New conversation" }).click();
  await page.getByLabel("Allow navigation requests for this message").check();
  await page.getByLabel("Message", { exact: true }).fill("Navigate the browser to the next page");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Approve once", exact: true })).toBeEnabled();
  assert.equal(remote.url(), `${origin}/page`, "No navigation before approval");
  const { approval } = await page.evaluate(() => (window as any).kestrelHost({ type: "state" }));
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Approve once", exact: true })).toBeEnabled();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await mkdir(".tmp/chromium-host", { recursive: true });
  await page.screenshot({ path: resolve(".tmp/chromium-host/approval.png"), fullPage: true });
  await page.setViewportSize({ width: 1180, height: 800 });
  await page.getByRole("button", { name: "Approve once", exact: true }).click();
  await expect(page.getByText("Verified navigation: Navigation works.", { exact: true })).toBeVisible();
  assert.equal(remote.url(), `${origin}/next`);
  const replay = await page.evaluate(async (approval) => {
    try { await (window as any).kestrelHost({ type: "resolve-approval", runId: approval.runId, executionId: approval.executionId, decision: "approved" }); return "allowed"; }
    catch { return "denied"; }
  }, approval);
  assert.equal(replay, "denied");
  await remote.goto(`${origin}/page`);
  await page.getByRole("button", { name: "＋ New conversation" }).click();
  await page.getByLabel("Allow navigation requests for this message").check();
  await page.getByLabel("Message", { exact: true }).fill("Navigate the browser but reject this proposal");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(page.getByText("Navigation was not completed.", { exact: true })).toBeVisible();
  assert.equal(remote.url(), `${origin}/page`, "Rejection must not navigate");
  await page.getByRole("button", { name: "＋ New conversation" }).click();
  await page.getByLabel("Allow navigation requests for this message").check();
  await page.getByLabel("Message", { exact: true }).fill("Navigate the browser with a stale proposal");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Approve once", exact: true })).toBeEnabled();
  await remote.reload(); // The URL is unchanged, but the approved document is gone.
  await page.getByRole("button", { name: "Approve once", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("The approved tab changed");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Approve once", exact: true })).toHaveCount(0);
  assert.equal(remote.url(), `${origin}/page`, "A stale approval must not navigate even at the same URL");
  await remote.goto(`${origin}/form`);
  await page.getByRole("button", { name: "＋ New conversation" }).click();
  await page.getByLabel("Allow form action requests for this message").check();
  await page.getByLabel("Message", { exact: true }).fill("Complete browser form: enter Chromium release draft, then save it");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Approve once", exact: true })).toBeEnabled();
  await expect(remote.getByLabel("Draft title")).toHaveValue("");
  assert.equal(savedDrafts, 0);
  await expect(page.getByRole("region", { name: "Browser action approval" })).toContainText('Enter "Chromium release draft" into Draft title');
  await page.getByRole("button", { name: "Approve once", exact: true }).click();
  await expect(remote.getByLabel("Draft title")).toHaveValue("Chromium release draft").catch(async (error) => { console.error(await page.locator("#error").textContent()); throw error; });
  await expect(page.getByRole("region", { name: "Browser action approval" })).toContainText("Click Save draft");
  assert.equal(savedDrafts, 0, "Typing approval does not authorize saving");
  await page.getByRole("button", { name: "Approve once", exact: true }).click();
  await expect(page.getByText("Verified saved draft: Chromium release draft.", { exact: true })).toBeVisible();
  assert.equal(savedDrafts, 1);
  await remote.goto(`${origin}/form`);
  await page.getByRole("button", { name: "＋ New conversation" }).click();
  await page.getByLabel("Allow form action requests for this message").check();
  await page.getByLabel("Message", { exact: true }).fill("Complete browser form but reject the entry");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(page.getByText("Form action rejected; no draft saved.", { exact: true })).toBeVisible();
  await expect(remote.getByLabel("Draft title")).toHaveValue("");
  assert.equal(savedDrafts, 1);
  await page.getByRole("button", { name: "＋ New conversation" }).click();
  await page.getByLabel("Allow form action requests for this message").check();
  await page.getByLabel("Message", { exact: true }).fill("Complete browser form with a changed field");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Approve once", exact: true })).toBeEnabled();
  await remote.getByLabel("Draft title").evaluate((element) => element.setAttribute("type", "password"));
  await page.getByRole("button", { name: "Approve once", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Inspect this page again");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await expect(remote.getByLabel("Draft title")).toHaveValue("");
  assert.equal(savedDrafts, 1);
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
  console.log("Chromium host passed: real Node conversation, reload, cancellation, native web navigation, opt-in core browser tools, approved navigation with page verification, rejection, stale approval and replay denial, isolated bridge and narrow layout.");
} finally {
  await host?.close();
  for (const response of pending) response.destroy();
  await new Promise<void>((done) => server.close(() => done()));
}
