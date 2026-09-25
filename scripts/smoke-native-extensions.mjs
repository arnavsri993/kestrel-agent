import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { buildNativeChromiumHost } from "./build-native-chromium-host.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// A caller may supply a just-built artifact to avoid rebuilding for every test.
const app = process.env.KESTREL_NATIVE_TEST_APP ?? await buildNativeChromiumHost();
const executable = join(app, "Contents/MacOS/Kestrel");
const invalid = spawnSync(executable, ["--kestrel-extension-workbench", "--kestrel-renderer"], { encoding: "utf8", timeout: 10_000 });
assert.equal(invalid.status, 1);
assert.match(invalid.stderr, /cannot run the privileged shell or Core/);
const profile = await mkdtemp(join(tmpdir(), "kestrel-native-extensions-test-"));
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<!doctype html><title>Native extension test</title><h1>Native Chromium extension test</h1>");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
let child;
let output = "";
try {
  child = spawn(executable, [
    "--kestrel-extension-workbench", "--kestrel-cache-path", profile,
    "--remote-debugging-port=0",
    `--load-extension=${join(root, "tests/fixtures/native-extension")}`,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", bytes => output += bytes);
  child.stderr.on("data", bytes => output += bytes);
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  let endpoint;
  for (let attempt = 0; attempt < 150; attempt++) {
    assert.equal(child.exitCode, null, output);
    try {
      const [port, path] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
      endpoint = `ws://127.0.0.1:${port}${path}`;
      break;
    } catch { await delay(100); }
  }
  assert(endpoint, output);
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.newPage();
  await page.waitForURL("chrome://extensions/");
  await page.locator("extensions-manager").waitFor();
  const children = execFileSync("/bin/ps", ["-axo", "pid,ppid,command"], { encoding: "utf8" });
  const workers = children.split("\n").filter(line => line.includes(join(app, "Contents/Frameworks/")) && /--type=(renderer|gpu-process|utility)/.test(line));
  assert(workers.length > 0);
  assert(workers.every(line => /--seatbelt-client=\d+/.test(line) && !/--no-sandbox\b/.test(line)));
  assert(!workers.some(line => /Electron Framework/.test(line)));
  await page.goto(`http://127.0.0.1:${server.address().port}/probe`);
  await page.waitForFunction(() => document.documentElement.dataset.kestrelExtensionProbe);
  const first = await page.evaluate(() => JSON.parse(document.documentElement.dataset.kestrelExtensionProbe));
  assert.equal(first.manifest, 3);
  assert.equal(first.runs, 1);
  assert.match(first.id, /^[a-p]{32}$/);
  assert.equal(await page.evaluate(() => typeof window.kestrel), "undefined");
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.kestrelExtensionProbe);
  assert.equal(await page.evaluate(() => JSON.parse(document.documentElement.dataset.kestrelExtensionProbe).runs), 2);
  await page.goto(`chrome-extension://${first.id}/popup.html`);
  await page.getByText("Manifest V3 running in native Chromium.").waitFor();
  assert.equal(await page.evaluate(() => typeof window.kestrel), "undefined");
  // Even a file with the privileged shell's real path gets no bridge in this
  // mode. This checks that the mode reaches renderer helpers, not just main.
  await page.goto(pathToFileURL(join(app, "Contents/Resources/kestrel-shell/index.html")).href);
  assert.equal(await page.evaluate(() => typeof window.kestrel), "undefined");
  assert.equal(await page.evaluate(() => typeof window.__kestrelNativeQuery), "undefined");
  await page.goto(`chrome-extension://${first.id}/popup.html`);
  const evidence = join(root, ".tmp/native-extension-evidence");
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, "extension-page.png") });
  await page.goto("chrome://extensions/");
  await page.getByText("Kestrel native extension probe", { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, "extension-manager.png") });
  await page.goto(`http://127.0.0.1:${server.address().port}/popup-opener`);
  const popupPromise = context.waitForEvent("page");
  await page.evaluate(() => window.open("about:blank"));
  const popup = await popupPromise;
  await popup.waitForLoadState();
  await page.close();
  assert.equal(child.exitCode, null, "Closing one window must preserve another live browser.");
  assert.equal(await popup.evaluate(() => typeof window.kestrel), "undefined");
  const session = await browser.newBrowserCDPSession();
  await session.send("Browser.close");
  const result = await Promise.race([exited, delay(10_000, undefined, { ref: false }).then(() => { throw new Error(`Native shutdown timed out: ${output}`); })]);
  assert.deepEqual(result, { code: 0, signal: null }, output);
  assert.doesNotMatch(output, /KESTREL_NATIVE_CHROMIUM_(RENDERER_BRIDGE|CORE)_READY/);
  console.log("Native extensions passed: Chrome manager, MV3 content script, service worker messaging, storage, extension page, popup lifetime, bridge isolation, sandbox and clean shutdown.");
} finally {
  await browser?.close().catch(() => {});
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise(resolve => child.once("exit", resolve));
  }
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
