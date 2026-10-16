import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "kestrel-tab-interactions-"));
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const executablePath = process.env.KESTREL_DESKTOP_EXECUTABLE
  ? resolve(process.env.KESTREL_DESKTOP_EXECUTABLE)
  : requireFromDesktop("electron");
const launchArgs = process.env.KESTREL_DESKTOP_EXECUTABLE
  ? ["--use-mock-keychain"]
  : [resolve("apps/desktop")];

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end('<!doctype html><title>Tab interaction fixture</title><h1>Tab interaction fixture</h1><input id="page-input" aria-label="Page input">');
});
await new Promise((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(0, "127.0.0.1", resolveListen);
});
const address = server.address();
assert(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;

let application;
try {
  application = await electron.launch({
    executablePath,
    args: launchArgs,
    env: {
      ...process.env,
      KESTREL_DISABLE_UPDATES: "1",
      KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1",
      KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
      KESTREL_TEST_USER_DATA: join(root, "user-data"),
      KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1",
      KESTREL_REAL_USER_PROFILE: "1",
    },
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(20_000);
  await page.waitForURL((url) =>
    url.protocol === "file:" && url.pathname.endsWith("/renderer/index.html"),
  );
  await page.evaluate(() => {
    localStorage.setItem("kestrel:onboarded", "yes");
    localStorage.setItem("kestrel:default-browser-prompted", "yes");
  });
  await page.reload();
  await page.locator("#browser-address-input").waitFor();
  await page.bringToFront();

  const request = (message) => page.evaluate((input) => window.kestrel.request(input), message);
  const browserState = async () => {
    const response = await request({ type: "browser-get-state" });
    assert(response.ok && "browserState" in response);
    return response.browserState;
  };
  const waitForState = async (predicate, label) => {
    const deadline = Date.now() + 20_000;
    let state;
    while (Date.now() < deadline) {
      state = await browserState();
      if (predicate(state)) return state;
      await page.waitForTimeout(75);
    }
    throw new Error(`${label}: ${JSON.stringify(state)}`);
  };
  const assertAllSelected = () => page.waitForFunction(() => {
    const input = document.querySelector("#browser-address-input");
    return input instanceof HTMLInputElement && document.activeElement === input &&
      input.selectionStart === 0 && input.selectionEnd === input.value.length;
  });

  const first = await request({ type: "browser-create-tab", input: `${origin}/one`, active: true });
  assert(first.ok && "browserState" in first);
  const firstId = first.browserState.activeTabId;
  assert(firstId);
  await waitForState((state) => state.tabs.some((tab) =>
    tab.id === firstId && tab.url === `${origin}/one`), "First tab did not load");

  const input = page.locator("#browser-address-input");
  await input.waitFor();
  await input.click();
  await assertAllSelected();
  await input.evaluate((node) => node.setSelectionRange(node.value.length, node.value.length));
  await input.click();
  await assertAllSelected();
  await page.keyboard.type(`${origin}/replacement`);
  assert.equal(await input.inputValue(), `${origin}/replacement`);
  await input.fill(`${origin}/one`);
  await input.evaluate((node) => node.setSelectionRange(node.value.length, node.value.length));
  await page.keyboard.press(process.platform === "darwin" ? "Meta+L" : "Control+L");
  await assertAllSelected();
  await page.keyboard.type(`${origin}/shortcut-replacement`);
  assert.equal(await input.inputValue(), `${origin}/shortcut-replacement`);
  await input.fill(`${origin}/one`);

  // DOM focus alone does not prove the renderer owns native keyboard input.
  // Reflowing an attached page must preserve either owner, including chrome.
  const settings = (await browserState()).settings;
  assert((await request({
    type: "browser-update-settings",
    settings: { ...settings, addressBarSuggestionsEnabled: false },
  })).ok);
  const typeNativeKey = (key) => application.evaluate(({ webContents }, keyCode) => {
    const owner = webContents.getFocusedWebContents();
    if (!owner) throw new Error("No native keyboard owner");
    owner.sendInputEvent({ type: "keyDown", keyCode });
    owner.sendInputEvent({ type: "char", keyCode });
    owner.sendInputEvent({ type: "keyUp", keyCode });
  }, key);
  const nativeFocus = () => application.evaluate(({ BrowserWindow }, expectedUrl) => {
    const window = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().endsWith("/renderer/index.html"));
    const view = window?.contentView.children.find((candidate) =>
      "webContents" in candidate && candidate.webContents.getURL() === expectedUrl);
    return view && {
      bounds: view.getBounds(),
      chrome: window.webContents.isFocused(),
      page: view.webContents.isFocused(),
    };
  }, `${origin}/one`);
  const attachedDeadline = Date.now() + 20_000;
  let attached;
  while (Date.now() < attachedDeadline && !attached) {
    attached = await nativeFocus();
    if (!attached) await page.waitForTimeout(75);
  }
  assert(attached, "The fixture's native page did not attach");
  await input.click();
  assert((await nativeFocus()).chrome, "Address input did not own native keyboard focus");
  await input.evaluate((node) => node.setSelectionRange(node.value.length, node.value.length));
  const originalBounds = attached.bounds;
  let expectedAddress = `${origin}/one`;
  for (const offset of [1, 2, 2, 0]) {
    const response = await request({
      type: "browser-set-content-bounds",
      bounds: {
        ...originalBounds,
        y: originalBounds.y + offset,
        height: originalBounds.height - offset,
      },
      visible: true,
    });
    assert(response.ok);
    const focus = await nativeFocus();
    assert(focus?.chrome && !focus.page, "Page reflow stole native focus from the address input");
    assert(await input.evaluate((node) => document.activeElement === node));
    await typeNativeKey("x");
    expectedAddress += "x";
    await page.waitForFunction((expected) =>
      document.querySelector("#browser-address-input")?.value === expected, expectedAddress);
  }
  await request({ type: "browser-select-tab", tabId: firstId });
  assert((await nativeFocus()).page, "Explicit tab selection did not restore native page focus");
  await request({ type: "browser-set-content-bounds", bounds: originalBounds, visible: true });
  assert((await nativeFocus()).page, "Page reflow did not preserve native page focus");
  await application.evaluate(async ({ webContents }, expectedUrl) => {
    const page = webContents.getAllWebContents().find((candidate) => candidate.getURL() === expectedUrl);
    await page.executeJavaScript('document.querySelector("#page-input").focus()');
  }, `${origin}/one`);
  await typeNativeKey("y");
  assert.equal(await application.evaluate(async ({ webContents }, expectedUrl) => {
    const page = webContents.getAllWebContents().find((candidate) => candidate.getURL() === expectedUrl);
    return page.executeJavaScript('document.querySelector("#page-input").value');
  }, `${origin}/one`), "y");
  await request({ type: "browser-set-content-bounds", bounds: originalBounds, visible: false });
  await request({ type: "browser-set-content-bounds", bounds: originalBounds, visible: true });
  assert((await nativeFocus()).page, "Returning from an overlay did not restore native page focus");
  await input.fill(`${origin}/one`);
  assert((await request({ type: "browser-update-settings", settings })).ok);

  const second = await request({ type: "browser-create-tab", input: `${origin}/two`, active: false });
  assert(second.ok && "browserState" in second);
  const secondId = second.browserState.tabs.at(-1)?.id;
  assert(secondId);
  await waitForState((state) => state.tabs.some((tab) =>
    tab.id === secondId && tab.url === `${origin}/two`), "Second tab did not load");
  await request({ type: "browser-select-tab", tabId: secondId });
  await page.waitForFunction((expected) =>
    document.querySelector("#browser-address-input")?.value === expected,
  `${origin}/two`);
  await input.click();
  await assertAllSelected();
  await page.keyboard.type(`${origin}/other-replacement`);
  assert.equal(await input.inputValue(), `${origin}/other-replacement`);

  await request({ type: "browser-select-tab", tabId: firstId });
  const tab = page.locator(`.browser-tab[data-tab-id="${secondId}"]`);
  await tab.scrollIntoViewIfNeeded();
  await tab.hover();
  // Start after the native preview opens, as in a normal deliberate drag.
  const previewDeadline = Date.now() + 5_000;
  let previewVisible = false;
  while (Date.now() < previewDeadline && !previewVisible) {
    previewVisible = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) =>
        window.webContents.getURL().startsWith("data:text/html")));
    if (!previewVisible) await page.waitForTimeout(75);
  }
  assert(previewVisible, "Tab hover preview did not open");
  const bounds = await tab.boundingBox();
  assert(bounds);
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 72, y + 28, { steps: 8 });
  assert((await browserState()).tabs.some((item) => item.id === secondId),
    "The source tab left before pointer release");
  await page.mouse.move(x + 170, y + 110, { steps: 8 });
  await page.mouse.up();
  await waitForState((state) => !state.tabs.some((item) => item.id === secondId),
    "Tab did not detach on release");
  const detachedDeadline = Date.now() + 20_000;
  let detached = false;
  while (Date.now() < detachedDeadline && !detached) {
    detached = await application.evaluate(({ BrowserWindow }, expected) =>
      BrowserWindow.getAllWindows().some((window) =>
        window.webContents.getURL().endsWith("/renderer/index.html") &&
        window.contentView.children.some((child) =>
          "webContents" in child && child.webContents.getURL() === expected)),
      `${origin}/two`);
    if (!detached) await page.waitForTimeout(75);
  }
  assert(detached, "Detached window did not load the tab");
  console.log("Focused tab interaction smoke passed: address replacement, native focus through reflow, and tab tear-off after preview.");
} finally {
  await application?.close().catch(() => undefined);
  await new Promise((resolveClose) => server.close(resolveClose));
  rmSync(root, { recursive: true, force: true });
}
