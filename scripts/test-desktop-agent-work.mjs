import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

// All sessions, run records and screenshots below belong to a disposable profile.
const root = mkdtempSync(join(tmpdir(), "kestrel-agent-work-"));
const userData = join(root, "profile");
const evidence = resolve(".tmp/agent-work-clarity");
mkdirSync(evidence, { recursive: true });
const requireDesktop = createRequire(resolve("apps/desktop/package.json"));
const packaged = process.env.KESTREL_DESKTOP_EXECUTABLE;
const executablePath = packaged ? resolve(packaged) : requireDesktop("electron");
let app;
let page;
const errors = [];
const request = input => page.evaluate(input => window.kestrel.request(input), input);

async function create(title, privacyMode = "standard") {
  const result = await request({ type: "runtime-create-session", kind: "agent", title, privacyMode });
  assert.equal(result.ok, true);
  assert(result.session);
  return result.session;
}
async function openAgents() {
  const result = await request({ type: "browser-create-tab", input: "kestrel://agent", active: true });
  assert.equal(result.ok, true);
  await page.getByRole("heading", { name: "Agents", exact: true }).waitFor();
}
async function resize(width, height = 800) {
  await app.evaluate(({ BrowserWindow }, [width, height]) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes("renderer/index.html"));
    window.setMinimumSize(400, 400);
    window.setContentSize(width, height);
  }, [width, height]);
  await page.waitForFunction(width => innerWidth === width, width);
}
async function noOverflow() {
  const result = await page.evaluate(() => {
    const region = document.querySelector(".agent-work-home") ?? document.querySelector(".agent-sidebar.is-focused");
    return { document: document.documentElement.scrollWidth <= innerWidth + 1, region: region.scrollWidth <= region.clientWidth + 1 };
  });
  assert.deepEqual(result, { document: true, region: true });
}
try {
  app = await electron.launch({ executablePath, args: packaged ? ["--use-mock-keychain"] : [resolve("apps/desktop")], env: {
    ...process.env, KESTREL_TEST_USER_DATA: userData, KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1", KESTREL_REAL_USER_PROFILE: "1",
    KESTREL_DISABLE_UPDATES: "1", KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
  } });
  page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", error => errors.push(error.message));
  await page.waitForURL(url => url.protocol === "file:" && url.pathname.endsWith("/renderer/index.html"));
  await page.evaluate(() => {
    localStorage.setItem("kestrel:onboarded", "yes");
    localStorage.setItem("kestrel:default-browser-prompted", "yes");
    localStorage.setItem("kestrel:navigation-sidebar", "open");
    // Old preference must not recreate the duplicate rail on initial overview.
    localStorage.setItem("kestrel:agent-universe-rail", "open");
  });
  await page.reload();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const finished = await create("Research lead");
  const working = await create("Build review");
  const attention = await create("Release review");
  const ready = await create("Writing assistant");
  await create("Private hidden agent", "private");
  const fork = await request({ type: "runtime-fork-session", sessionId: finished.id, title: "Review source evidence" });
  assert.equal(fork.ok, true);
  const now = new Date().toISOString();
  const runs = [[finished.id, "completed"], [working.id, "running"], [attention.id, "waiting_input"], [fork.session.id, "completed"]].map(([sessionId, status]) => ({
    id: `fixture-${sessionId}`, sessionId, model: "fixture", providerIds: ["fixture"], status, turn: 1, createdAt: now, updatedAt: now,
  }));
  const fixturePath = join(root, "runs.json");
  writeFileSync(fixturePath, JSON.stringify(runs));
  execFileSync("python3", ["-c", "import json,sqlite3,sys\ndb=sqlite3.connect(sys.argv[1]); runs=json.load(open(sys.argv[2]))\nfor r in runs: db.execute('INSERT INTO agent_runs (id,session_id,payload,status,created_at,updated_at) VALUES (?,?,?,?,?,?)',(r['id'],r['sessionId'],json.dumps(r),r['status'],r['createdAt'],r['updatedAt']))\ndb.commit(); db.close()", join(userData, "database", "kestrel.sqlite"), fixturePath]);
  await openAgents();
  await resize(1360, 860);
  await page.getByRole("heading", { name: "Finished", exact: true }).waitFor();
  for (const label of ["Needs attention", "Working", "Finished", "Ready"]) await page.getByRole("heading", { name: label, exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Open Private hidden agent", exact: true }).count(), 0);
  assert.equal(await page.locator(".agent-sidebar").getAttribute("aria-hidden"), "true");
  assert.equal(await page.locator(".agent-sidebar").evaluate(node => getComputedStyle(node).opacity), "0");
  assert.equal(await page.locator(".kestrel-sidebar-scroll").isVisible(), false);
  assert.match(await page.getByRole("button", { name: "Open Writing assistant", exact: true }).innerText(), /Ready/);
  assert.match(await page.getByRole("button", { name: "Open Research lead", exact: true }).innerText(), /Run finished/);
  await noOverflow();
  await page.screenshot({ path: join(evidence, "overview-desktop.png") });
  const before = (await request({ type: "runtime-list-sessions" })).sessions.length;
  const host = page.locator(".agent-conversation-host");
  await host.evaluate(node => node.dataset.continuityProbe = "retained");
  await page.getByRole("button", { name: "Open Research lead", exact: true }).click();
  await page.getByRole("button", { name: "Back to agents", exact: true }).waitFor();
  assert.equal(await page.locator(".agent-work-home").isVisible(), false);
  await page.locator("#runtime-prompt").fill("Draft retained while reviewing the overview");
  await noOverflow();
  await page.waitForFunction(() => { const composer = document.querySelector(".thread-composer")?.getBoundingClientRect(); return composer && composer.bottom >= innerHeight - 80; });
  await page.screenshot({ path: join(evidence, "conversation-desktop.png") });
  await page.getByRole("button", { name: "Back to agents", exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Open Research lead");
  await page.getByRole("button", { name: "Open Research lead", exact: true }).click();
  assert.equal(await page.locator("#runtime-prompt").inputValue(), "Draft retained while reviewing the overview");
  assert.equal(await host.getAttribute("data-continuity-probe"), "retained");
  assert.equal((await request({ type: "runtime-list-sessions" })).sessions.length, before);
  await page.getByRole("button", { name: "Back to agents", exact: true }).click();
  await page.getByRole("searchbox", { name: "Find agents or tasks", exact: true }).fill("source evidence");
  await page.getByRole("button", { name: "Open delegated work Review source evidence", exact: true }).waitFor();
  assert.equal(await page.locator(".agent-work-overview-item").count(), 1);
  await page.getByRole("searchbox", { name: "Find agents or tasks", exact: true }).fill("");
  await page.getByRole("button", { name: "Map view", exact: true }).click();
  await page.locator(".agent-universe-scene").waitFor();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await page.getByRole("button", { name: "Back to agents", exact: true }).waitFor();
  await page.getByRole("button", { name: "Back to agents", exact: true }).click();
  await resize(760, 740);
  await noOverflow();
  await page.screenshot({ path: join(evidence, "overview-compact.png") });
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes("renderer/index.html")).webContents.setZoomFactor(2);
  });
  await noOverflow();
  await page.waitForFunction(() => innerWidth <= 400);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const zoomCapture = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes("renderer/index.html")).webContents.capturePage()).toPNG().toString("base64"));
  writeFileSync(join(evidence, "overview-zoom.png"), Buffer.from(zoomCapture, "base64"));
  await page.getByRole("button", { name: "Open Research lead", exact: true }).click();
  await page.getByRole("button", { name: "Back to agents", exact: true }).waitFor();
  await noOverflow();
  assert.deepEqual(errors, []);
  process.stdout.write("Agents work smoke passed: truthful groups, privacy, one visible workspace, exact-session navigation, draft/mount continuity, keyboard return, child search, compact and 200% zoom.\n");
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await app?.close();
  rmSync(root, { recursive: true, force: true });
}
