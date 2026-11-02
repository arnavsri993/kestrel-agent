import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { candidateDigest } from './native-retirement-evidence.mjs';
import { selectSettingsSection } from './desktop-browser-test-helpers.mjs';
import { markDisposableNativeTestProfile } from './native-test-profile.mjs';

// This test launches only a caller-selected, noncanonical candidate with a new
// private profile. Never use it to exercise the user's installed application.
assert(process.env.KESTREL_NATIVE_TEST_APP, 'Set KESTREL_NATIVE_TEST_APP to the exact disposable candidate.');
const app = await realpath(resolve(process.env.KESTREL_NATIVE_TEST_APP));
const canonical = await realpath('/Applications/Kestrel.app').catch(() => '/Applications/Kestrel.app');
assert.notEqual(app, canonical, 'The canonical app cannot be used by this canary.');
assert(app.endsWith('.app'), 'Candidate must be an app bundle.');
const executable = join(app, 'Contents/MacOS/Kestrel');
await readFile(executable);
const candidateExecutable = await realpath(executable);
const processRows = execFileSync('/bin/ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' }).split('\n');
for (const row of processRows) {
 const match = row.trim().match(/^(\d+)\s+(.+)$/);
 if (!match || !match[2].endsWith('/Contents/MacOS/Kestrel')) continue;
 const existing = await realpath(match[2]).catch(() => '');
 assert.notEqual(existing, candidateExecutable, 'The candidate is already running; the canary requires its own single instance.');
}
const profile = await mkdtemp(join(tmpdir(), 'kestrel-settings-canary-'));
await markDisposableNativeTestProfile(profile);
const helper = join(profile, 'send-external-url');
try { execFileSync('/usr/bin/xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-framework', 'Foundation', resolve('apps/native-chromium-host/tests/send_external_url.mm'), '-o', helper], { timeout: 30000, stdio: 'pipe' }); }
catch (error) { await rm(profile, { recursive: true, force: true }); throw error; }
const evidence = resolve(process.env.KESTREL_NATIVE_SETTINGS_EVIDENCE || '.tmp/native-browser-settings-evidence');
await mkdir(evidence, { recursive: true, mode: 0o700 });
const receipt = { version: 1, startedAt: new Date().toISOString(), candidate: app, candidateSha256: await candidateDigest(app), phases: [] };
const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Owned URL canary</title><h1>Owned URL canary</h1>'); });
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
let child, browser, endpoint, output = '', home, settings;
let currentOperation = 'launch native Chromium candidate';
const phase = (name, details = {}) => { receipt.phases.push({ phase: name, passed: true, ...details }); currentOperation = name; console.log(`PASS ${name}`); };
function diagnosticOutput(value) {
 return String(value)
  .replace(/\b(?:https?|chrome-extension|chrome):\/\/[^\s"'<>]+/gi, '[redacted URL]')
  .replace(/((?:api[_-]?key|token|secret|password|cookie|authorization)[=: ]+)\S+/gi, '$1[redacted]');
}
async function eventually(fn, description, timeout = 30000) {
 const end = Date.now() + timeout; let last;
 while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (error) { last = error; } await delay(150); }
 throw new Error(`${description}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}
async function cdpTargets() { const s = await browser.newBrowserCDPSession(); try { return (await s.send('Target.getTargets')).targetInfos; } finally { await s.detach(); } }
async function windowId(targetId) { const s = await browser.newBrowserCDPSession(); try { return (await s.send('Browser.getWindowForTarget', { targetId })).windowId; } finally { await s.detach(); } }
async function targetFor(url) { return eventually(async () => (await cdpTargets()).find(t => t.type === 'page' && t.url === url), `Missing target ${url}`); }
async function pageFor(predicate) {
 let page = browser.contexts().flatMap(c => c.pages()).find(p => predicate(p.url()));
 if (page) return page;
 await eventually(async () => (await cdpTargets()).some(target => target.type === 'page' && predicate(target.url)), 'Owned target was not created');
 // CEF can create a target after Playwright auto-attachment; reconnect only to
 // the child-owned endpoint, without closing product tabs.
 await browser.close(); browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
 return eventually(() => browser.contexts().flatMap(c => c.pages()).find(p => predicate(p.url())), 'Could not attach target');
}
async function installIdentityFault(page) {
 // Fault injection is confined to this disposable first-party document. The
 // native API itself and every web tab remain unchanged.
 await page.addInitScript(() => {
  if (location.protocol !== 'chrome-extension:' || location.search) return;
  const getCurrent = chrome.tabs.getCurrent.bind(chrome.tabs);
  let calls = 0;
  chrome.tabs.getCurrent = (...args) => {
   window.__nativeIdentityAttempts = ++calls;
   if (sessionStorage.getItem('kestrel-test-document-id') === 'unavailable' || calls === 1) return Promise.resolve(undefined);
   return getCurrent(...args);
  };
 });
}
async function start(coldUrl) {
 output = '';
 const args = ['--kestrel-chromium-desktop', '--kestrel-cache-path', profile, '--kestrel-durable-profile', '--kestrel-test-profile-key', '--remote-debugging-port=0'];
 if (coldUrl) args.push(coldUrl);
 child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
 child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
 endpoint = await eventually(() => {
  assert.equal(child.exitCode, null, output);
  return output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+)/)?.[1];
 }, 'Owned DevTools endpoint missing');
 await eventually(() => {
  assert.equal(child.exitCode, null, output);
  return output.includes('KESTREL_CHROMIUM_DESKTOP_DOCUMENT_LOADED') && output.includes('KESTREL_CHROMIUM_DESKTOP_BRIDGE_READY');
 }, 'Owned UI document and authenticated bridge were not ready');
 browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
 home = await pageFor(url => /^chrome-extension:\/\/[^/]+\/index\.html$/.test(url));
 await home.waitForFunction(() => typeof window.kestrel?.request === 'function');
 await home.evaluate(() => { localStorage.setItem('kestrel:onboarded', 'yes'); localStorage.setItem('kestrel:default-browser-prompted', 'yes'); });
 await installIdentityFault(home);
 await home.reload(); await home.waitForFunction(() => typeof window.kestrel?.request === 'function');
 await home.locator('.kestrel-sidebar').waitFor();
 assert((await home.evaluate(() => window.__nativeIdentityAttempts)) >= 2, 'Transient missing native identity must recover through a fresh API read');
 return home;
}
async function stop() {
 if (!child || child.exitCode !== null || child.signalCode !== null) return;
 const exited = new Promise(done => child.once('exit', (code, signal) => done({ code, signal })));
 child.kill('SIGTERM');
 const result = await Promise.race([exited, delay(15000).then(() => null)]);
 if (!result) { child.kill('SIGKILL'); throw new Error('Owned candidate did not shut down.'); }
 assert.deepEqual(result, { code: 0, signal: null }, output);
 await browser?.close().catch(() => {}); browser = undefined; child = undefined;
}
function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const name = Buffer.from(type); const size = Buffer.alloc(4); size.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([size, name, data, crc]); }
function imageFixture() {
 const width = 640, height = 640, rows = Buffer.alloc(height * (1 + width * 3));
 for (let y = 0; y < height; y++) randomBytes(width * 3).copy(rows, y * (1 + width * 3) + 1);
 const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
async function pageByNativeTabId(id) {
 return eventually(async () => {
  for (const page of browser.contexts().flatMap(context => context.pages())) {
   if (!page.url().startsWith('chrome-extension://') || !page.url().includes('/index.html')) continue;
   try { if (await page.evaluate(async () => (await chrome.tabs.getCurrent())?.id) === id) return page; } catch {}
  }
 }, `Could not attach own UI tab ${id}`);
}
async function reconnect() {
 await browser.close();
 browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
}
function ownedCorePid() {
 const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).split('\n')
  .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean)
  .map(match => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }));
 const owned = new Set([child.pid]);
 let changed = true;
 while (changed) { changed = false; for (const row of rows) if (owned.has(row.ppid) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; } }
 const nodes = rows.filter(row => owned.has(row.pid) && row.command.endsWith('/node'));
 const core = nodes.find(node => !nodes.some(other => other.ppid === node.pid));
 assert.equal(nodes.length, 3, 'Expected the owned broker, relay, and Core');
 assert(core, 'Could not identify the owned Core process');
 return core.pid;
}
async function sendOwnedUrl(url) {
 assert.equal(child.exitCode, null, 'Owned candidate is not running');
 const owned = execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'comm='], { encoding: 'utf8' }).trim();
 assert.equal(await realpath(owned), await realpath(executable), 'Owned PID no longer belongs to the candidate executable');
 const parsed = new URL(url);
 assert(['http:', 'https:'].includes(parsed.protocol) && parsed.hostname && !parsed.username && !parsed.password, 'Invalid external URL');
 execFileSync(helper, [String(child.pid), url], { timeout: 10000, stdio: 'pipe' });
}
async function state() { home = await pageFor(url => /^chrome-extension:\/\/[^/]+\/index\.html$/.test(url)); const response = await home.evaluate(() => window.kestrel.request({ type: 'browser-get-state' })); assert(response.ok, response.error); return response.browserState; }
async function activateUi(page) {
 // Playwright bringToFront alone does not select a CEF Chrome tab. Ask the
 // first-party document for its own tab, then activate that exact tab.
 const tab = await page.evaluate(async () => {
  const current = await chrome.tabs.getCurrent();
  if (!Number.isInteger(current?.id) || !Number.isInteger(current?.windowId)) throw new Error('UI document has no own Chromium tab');
  await chrome.tabs.update(current.id, { active: true });
  await chrome.windows.update(current.windowId, { focused: true });
  return { id: current.id, windowId: current.windowId };
 });
 await page.bringToFront();
 await eventually(() => page.evaluate(async ({ id, windowId }) => {
  const active = await chrome.tabs.query({ active: true, windowId });
  if (active.length !== 1 || active[0].id !== id) return false;
  const stored = await chrome.storage.session.get('kestrel.native.browser.tabIds.v1');
  const mapped = stored['kestrel.native.browser.tabIds.v1']?.[String(id)];
  const response = await window.kestrel.request({ type: 'browser-get-state' });
  return !!mapped && response.ok && response.browserState?.activeTabId === mapped;
 }, tab), 'Chromium did not activate the owned UI tab');
}
async function openSettings() {
 home = await pageFor(url => /^chrome-extension:\/\/[^/]+\/index\.html$/.test(url));
 await activateUi(home);
 await home.getByRole('button', { name: 'Open settings', exact: true }).click();
 settings = await pageFor(url => /index\.html\?app=settings(?:&|$)/.test(url));
 await settings.locator('[data-app-page="settings"]').waitFor();
}
async function assertUploadedPreviewLayout() {
 const geometry = await settings.locator('.background-upload-card').evaluate(card => {
  const bounds = element => { const r=element.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
  return {card:bounds(card),preview:bounds(card.querySelector('.background-option-preview')),copy:bounds(card.querySelector('.background-upload-copy')),stacked:matchMedia('(max-width: 760px)').matches};
 });
 assert(geometry.preview.width>0 && geometry.preview.height>0, 'Uploaded background preview must remain visible');
 assert(geometry.preview.left>=geometry.card.left-1 && geometry.preview.right<=geometry.card.right+1, 'Uploaded background preview escaped its card');
 assert(geometry.stacked ? geometry.preview.bottom<=geometry.copy.top+1 : geometry.preview.right<=geometry.copy.left+1, 'Uploaded background preview overlaps its text or controls');
}
async function section(id, label) {
 settings = await pageFor(url => /index\.html\?app=settings(?:&|$)/.test(url));
 await selectSettingsSection(settings, id, label);
}
async function clickChromeRoute(sectionId, sectionLabel, buttonLabel, url, expectedWindow) {
 settings = await pageFor(url => /index\.html\?app=settings(?:&|$)/.test(url));
 await activateUi(settings); await section(sectionId, sectionLabel);
 await settings.getByRole('button', { name: buttonLabel, exact: true }).click();
 const target = await targetFor(url); assert.equal(await windowId(target.targetId), expectedWindow, `${url} opened in a different Chromium window`);
 const panel = await eventually(async () => (await cdpTargets()).find(t => t.url.includes('index.html?surface=panel')), 'Native companion panel did not open');
 assert(panel.targetId); return target;
}
try {
 const cold = `${origin}/cold`; await start(cold);
 const homeTarget = await targetFor(home.url()); const ownerWindow = await windowId(homeTarget.targetId);
 const coldTarget = await targetFor(cold); assert.equal(await windowId(coldTarget.targetId), ownerWindow);
 await delay(1200); assert.equal((await cdpTargets()).filter(t => t.type === 'page' && t.url === cold).length, 1, 'Cold URL opened more than once');
 const coldPage = await pageFor(url => url === cold); assert.equal(await coldPage.evaluate(() => typeof window.kestrel), 'undefined');
 phase('cold-positional-url-same-window-once', { windowId: ownerWindow });
 const warm = `${origin}/warm`;
 // Address only our live child PID, never LaunchServices or another app.
 await sendOwnedUrl(warm);
 const warmTarget = await targetFor(warm); assert.equal(await windowId(warmTarget.targetId), ownerWindow);
 await delay(1200); assert.equal((await cdpTargets()).filter(t => t.type === 'page' && t.url === warm).length, 1, 'Warm URL opened more than once');
 const warmPage = await pageFor(url => url === warm); assert.equal(await warmPage.evaluate(() => typeof window.kestrel), 'undefined');
 phase('warm-pid-targeted-apple-event-url-same-window-once');
 home = await pageFor(url => /^chrome-extension:\/\/[^/]+\/index\.html$/.test(url));
 await activateUi(home);
 // A CDP reconnect creates new Playwright page ownership; register the fault
 // on this attachment before reloading the document.
 await installIdentityFault(home);
 await home.evaluate(() => sessionStorage.setItem('kestrel-test-document-id', 'unavailable'));
 await home.reload();
 await home.waitForFunction(() => window.__nativeIdentityAttempts >= 1);
 await home.getByRole('heading', { name: 'Could not open this tab.', exact: true }).waitFor({ timeout: 15000 });
 await home.evaluate(() => sessionStorage.removeItem('kestrel-test-document-id'));
 await home.getByRole('button', { name: 'Try again', exact: true }).click();
 await home.locator('.kestrel-sidebar').waitFor();
 phase('native-document-identity-transient-failure-and-visible-manual-recovery');
 await activateUi(home);
 const homeId = await home.evaluate(async () => (await chrome.tabs.getCurrent()).id);
 const draft = 'Owned unsent draft for document ownership';
 await home.locator('#new-tab-chat-input').fill(draft);
 const createdSession = await home.evaluate(() => window.kestrel.request({ type: 'runtime-create-session', title: 'Native document ownership canary', kind: 'conversation' }));
 assert(createdSession.ok && createdSession.session?.id, JSON.stringify(createdSession));
 const sessionId = createdSession.session.id;
 await openSettings();
 const systemBefore = await settings.evaluate(() => window.kestrel.request({ type: 'get-system-state' }));
 const defaultStatus = await settings.evaluate(() => window.kestrel.request({ type: 'get-default-browser-status' }));
 assert(systemBefore.ok && defaultStatus.ok, 'Native system status must be connected');
 assert.equal(defaultStatus.canSetAsDefault, false, 'The disposable development candidate must refuse system-setting mutations');
 await selectSettingsSection(settings, 'agent-general', 'General');
 const loginSwitch = settings.getByRole('switch', { name: 'Run Kestrel at login', exact: true });
 await eventually(() => loginSwitch.isEnabled(), 'Run-at-login status did not finish loading');
 const checkedBefore = await loginSwitch.getAttribute('aria-checked');
 // The same production-identity guard protects both setters. This owned dev
 // candidate must return its refusal and display it, without touching macOS.
 await loginSwitch.click();
 await settings.getByRole('alert').filter({ hasText: 'Install the production Kestrel app in /Applications' }).waitFor();
 assert.equal(await loginSwitch.getAttribute('aria-checked'), checkedBefore, 'A refused mutation must not change the displayed state');
 const systemAfter = await settings.evaluate(() => window.kestrel.request({ type: 'get-system-state' }));
 assert.equal(systemAfter.launchAtLogin, systemBefore.launchAtLogin);
 assert.equal(systemAfter.launchStatus, systemBefore.launchStatus);
 phase('native-system-status-and-visible-development-guard-refusal');
 const computerBefore = await settings.evaluate(() => window.kestrel.request({ type: 'computer-use-status' }));
 assert(computerBefore.ok && computerBefore.computerUseStatus?.platform === 'darwin', 'Native computer-use status did not reach the macOS owner');
 assert.equal(computerBefore.computerUseStatus.enabled, false, 'A fresh native profile must not enable desktop access');
 assert.equal(computerBefore.computerUseStatus.captureReady, false);
 assert.equal(computerBefore.computerUseStatus.controlReady, false);
 const disabledComputer = await settings.evaluate(() => window.kestrel.request({ type: 'computer-use-update', enabled: false }));
 assert(disabledComputer.ok && disabledComputer.computerUseStatus?.enabled === false, 'Native opt-out did not report its enforced state');
 await selectSettingsSection(settings, 'agent-permissions', 'Permissions & sandbox');
 const computerSwitch = settings.getByRole('switch', { name: 'Enable whole-desktop computer use', exact: true });
 await eventually(() => computerSwitch.isEnabled(), 'Native computer-use status did not finish rendering');
 assert.equal(await computerSwitch.getAttribute('aria-checked'), 'false');
 await settings.locator('.computer-use-loading').waitFor({ state: 'hidden' });
 await settings.screenshot({ path: join(evidence, 'native-computer-use-off.png') });
 phase('native-computer-use-actual-owner-status-and-enforced-opt-out', { status: disabledComputer.computerUseStatus, scope: 'No desktop capture, input, permission prompt or enablement was invoked.' });
 const firstSettingsId = await settings.evaluate(async () => (await chrome.tabs.getCurrent()).id);
 await selectSettingsSection(settings, 'agent-diagnostics', 'Diagnostics');
 await settings.getByRole('button', { name: 'Check readiness', exact: true }).click();
 const diagnostics = settings.locator('.diagnostics-readiness');
 await diagnostics.getByText('Needs attention', { exact: true }).waitFor();
 await diagnostics.getByText(/Local agent core · The local agent process responded/).waitFor();
 await diagnostics.getByText(/No project folder is granted/).waitFor();
 const readinessCreated = await settings.evaluate(() => window.kestrel.request({ type: 'browser-create-tab', input: 'kestrel://readiness' }));
 assert(readinessCreated.ok, JSON.stringify(readinessCreated));
 const readinessPage = await pageFor(url => /index\.html\?app=readiness(?:&|$)/.test(url));
 await activateUi(readinessPage);
 await readinessPage.getByRole('heading', { name: 'Readiness', exact: true }).waitFor();
 await readinessPage.locator('.readiness-checks .check-pass').filter({ hasText: 'Local agent core' }).waitFor();
 await readinessPage.locator('.readiness-checks .check-fail').filter({ hasText: 'Installed build' }).waitFor();
 await readinessPage.locator('.loading-screen').waitFor({ state: 'hidden' });
 await readinessPage.screenshot({ path: join(evidence, 'native-readiness.png') });
 await readinessPage.close();
 settings = await pageByNativeTabId(firstSettingsId);
 phase('native-settings-diagnostics-and-Readiness-page-live-Core-checks');
 home = await pageByNativeTabId(homeId);
 const second = await home.evaluate(() => window.kestrel.request({ type: 'browser-create-tab', input: 'kestrel://settings' }));
 assert(second.ok, JSON.stringify(second));
 const ids = await eventually(async () => {
  const tabs = await home.evaluate(() => chrome.tabs.query({}));
  const matches = tabs.filter(tab => tab.url?.endsWith('/index.html?app=settings')).map(tab => tab.id);
  return matches.length === 2 && matches.includes(firstSettingsId) ? matches : null;
 }, 'Two independent Settings tabs were not created');
 const secondSettingsId = ids.find(id => id !== firstSettingsId); assert(Number.isInteger(secondSettingsId));
 await reconnect();
 home = await pageByNativeTabId(homeId);
 settings = await pageByNativeTabId(firstSettingsId);
 const duplicateSettings = await pageByNativeTabId(secondSettingsId);
 const warmNativeId = await home.evaluate(async target => (await chrome.tabs.query({})).find(tab => tab.url === target)?.id, warm);
 assert(Number.isInteger(warmNativeId));
 await home.evaluate(id => chrome.tabs.update(id, { active: true }), warmNativeId);
 await eventually(async () => (await home.evaluate(() => chrome.tabs.query({ active: true, currentWindow: true })))[0]?.id === warmNativeId, 'Owned public tab did not become active');
 await home.locator('#new-tab-title').waitFor();
 assert.equal(await home.locator('#new-tab-chat-input').inputValue(), draft, 'Background Home lost its unsent draft');
 await settings.locator('[data-app-page="settings"]').waitFor();
 await duplicateSettings.locator('[data-app-page="settings"]').waitFor();
 const listing = await home.evaluate(sessionId => window.kestrel.request({ type: 'runtime-call-tool', sessionId, toolName: 'browser.tabs', input: {}, approvalStatus: 'approved', idempotencyKey: crypto.randomUUID() }), sessionId);
 assert.equal(listing.execution?.status, 'verified', JSON.stringify(listing));
 assert(listing.execution.output?.tabs?.some(tab => tab.url === warm && tab.active === true), 'Core must observe the actual active public tab');
 await home.evaluate(id => chrome.tabs.remove(id), secondSettingsId);
 await eventually(async () => !(await home.evaluate(() => chrome.tabs.query({}))).some(tab => tab.id === secondSettingsId), 'Duplicate Settings tab did not close');
 phase('document-ownership-and-actual-Core-active-tab', { homeId, firstSettingsId, secondSettingsId, sessionId });
 // Resize only this owned Chromium window, and restore it before other phases.
 const boundsSession = await browser.newBrowserCDPSession();
 const oldBounds = (await boundsSession.send('Browser.getWindowBounds', { windowId: ownerWindow })).bounds;
 try {
  await boundsSession.send('Browser.setWindowBounds', { windowId: ownerWindow, bounds: { windowState: 'normal' } });
  await boundsSession.send('Browser.setWindowBounds', { windowId: ownerWindow, bounds: { width: 1024, height: 800 } });
  await activateUi(home);
  await eventually(() => home.evaluate(() => innerWidth <= 1120), 'Owned Chromium window did not enter narrow layout');
  await eventually(() => home.evaluate(() => {
   const saved = localStorage.getItem('kestrel:navigation-sidebar');
   const expected = saved === 'open' ? 'false' : saved === 'collapsed' ? 'true' : String(matchMedia('(max-width: 1120px)').matches);
   return document.querySelector('.kestrel-sidebar')?.dataset.collapsed === expected;
  }), 'Sidebar did not apply the responsive state before activation');
  const expand = home.getByRole('button', { name: 'Expand sidebar', exact: true });
  if (await expand.isVisible()) await expand.click();
  await home.getByRole('heading', { name: 'Projects', exact: true }).waitFor();
  const sidebarWidth = await eventually(async () => {
   const width = await home.locator('.kestrel-sidebar').evaluate(element => ({ collapsed: element.dataset.collapsed, width: element.getBoundingClientRect().width }));
   return width.collapsed === 'false' && width.width >= 200 ? width.width : false;
  }, 'Expanded sidebar did not reach its readable width');
  assert(sidebarWidth > 56, `Expanded sidebar too narrow: ${sidebarWidth}`);
  await home.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await home.getByRole('heading', { name: 'Projects', exact: true }).waitFor({ state: 'hidden' });
  await home.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
  phase('narrow-window-expand-collapse-projects', { sidebarWidth });
 } finally {
  await boundsSession.send('Browser.setWindowBounds', { windowId: ownerWindow, bounds: { windowState: 'normal' } });
  await boundsSession.send('Browser.setWindowBounds', { windowId: ownerWindow, bounds: { left: oldBounds.left, top: oldBounds.top, width: oldBounds.width, height: oldBounds.height } });
  if (oldBounds.windowState && oldBounds.windowState !== 'normal') await boundsSession.send('Browser.setWindowBounds', { windowId: ownerWindow, bounds: { windowState: oldBounds.windowState } });
  await boundsSession.detach();
 }
 settings = await pageByNativeTabId(firstSettingsId);
 const searchTarget = await clickChromeRoute('browser-search', 'Search & address bar', 'Open Search engine', 'chrome://settings/search', ownerWindow);
 phase('browser-settings-search-and-companion', { windowId: await windowId(searchTarget.targetId) });
 home = await pageFor(url => /^chrome-extension:\/\/[^/]+\/index\.html$/.test(url));
 const supported = await home.evaluate(() => typeof chrome.search?.query === 'function'); assert(supported, 'Chrome search API is unavailable in the extension');
 const searchPage = await pageFor(url => url === 'chrome://settings/search');
 // Chrome 152 exposes the provider choice through a dialog in its actual UI.
 await searchPage.getByRole('button', { name: 'Change', exact: true }).click();
 await searchPage.locator('cr-radio-button').filter({ hasText: 'DuckDuckGo' }).click();
 await searchPage.getByRole('button', { name: 'Set as Default', exact: true }).click();
 const searchQuery = async (suffix) => {
  currentOperation = `run native search query ${suffix}`;
  home = await pageFor(url => /^chrome-extension:\/\/[^/]+\/index\.html$/.test(url));
  const before = new Set((await cdpTargets()).map(t => t.targetId));
  const result = await home.evaluate(input => window.kestrel.request({ type: 'browser-create-tab', input }), `kestrel canary ${suffix}`); assert(result.ok, result.error);
  return eventually(async () => (await cdpTargets()).find(t => { try { const host = new URL(t.url).hostname; return !before.has(t.targetId) && (host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com')); } catch { return false; } }), 'Search did not open a new DuckDuckGo target');
 };
 await searchQuery('before restart'); phase('native-search-provider-change-and-query');
 settings = await pageFor(url => /index\.html\?app=settings(?:&|$)/.test(url));
 await clickChromeRoute('browser-downloads', 'Downloads', 'Open Download settings', 'chrome://settings/downloads', ownerWindow);
 phase('browser-settings-downloads-and-companion');
 settings = await pageFor(url => /index\.html\?app=settings(?:&|$)/.test(url));
 await activateUi(settings); await section('browser-appearance', 'Appearance & new tab');
 const png = imageFixture(); assert(png.length > 1024 * 1024 && png.length < 5 * 1024 * 1024);
 const chooser = settings.waitForEvent('filechooser'); await settings.getByRole('button', { name: 'Choose image' }).click();
 await (await chooser).setFiles({ name: 'owned-canary.png', mimeType: 'image/png', buffer: png });
 await eventually(async () => { const s = await state(); return s.settings.newTabBackground === 'custom' && s.settings.newTabBackgroundCustomDataUrl?.length > 1024 * 1024; }, 'Custom Home image not saved');
 await assertUploadedPreviewLayout();
 await settings.screenshot({ path: join(evidence, 'home-image.png') }); phase('home-image-upload', { bytes: png.length });
 currentOperation = 'stop and restart candidate to verify persisted Home image and search settings';
 await stop(); await start();
 const restoredComputer = await home.evaluate(() => window.kestrel.request({ type: 'computer-use-status' }));
 assert(restoredComputer.ok && restoredComputer.computerUseStatus?.enabled === false && restoredComputer.computerUseStatus.captureReady === false && restoredComputer.computerUseStatus.controlReady === false, 'Desktop opt-out did not survive restart');
 phase('native-computer-use-opt-out-persists-after-restart');
 await eventually(async () => { const s = await state(); return s.settings.newTabBackground === 'custom' && s.settings.newTabBackgroundCustomDataUrl?.length > 1024 * 1024; }, 'Custom Home image did not survive restart');
 await searchQuery('after restart'); phase('home-image-and-search-persist-after-restart');
 currentOperation = 'remove uploaded Home image after restart';
 home = await pageFor(url => /^chrome-extension:\/\/[^/]+\/index\.html$/.test(url)); await openSettings(); await activateUi(settings); await section('browser-appearance', 'Appearance & new tab');
 await assertUploadedPreviewLayout();
 await settings.getByRole('button', { name: 'Remove upload' }).click();
 await eventually(async () => { const s = await state(); return s.settings.newTabBackground !== 'custom' && !s.settings.newTabBackgroundCustomDataUrl; }, 'Custom Home image was not removed');
 phase('home-image-removal');
 currentOperation = 'verify Core session persisted after restart';
 const persistedSession = await home.evaluate(() => window.kestrel.request({ type: 'runtime-list-sessions' }));
 assert(persistedSession.ok && persistedSession.sessions?.some(item => item.id === sessionId), 'Core session did not survive restart');
 currentOperation = 'close and reopen the last native window while preserving Core';
 const corePid = ownedCorePid();
 const worker = await eventually(() => browser.contexts().flatMap(context => context.serviceWorkers()).find(item => item.url().startsWith('chrome-extension://')), 'Owned extension worker not attached');
 const normalWindows = await worker.evaluate(() => chrome.windows.getAll({ windowTypes: ['normal'] }));
 assert(normalWindows.length > 0, 'Expected an owned normal Chromium window');
 for (const window of normalWindows) await worker.evaluate(id => chrome.windows.remove(id), window.id).catch(() => {});
 await eventually(async () => {
  assert.equal(child.exitCode, null, 'Closing windows killed the owned app');
  return (await worker.evaluate(() => chrome.windows.getAll({ windowTypes: ['normal'] }))).length === 0;
 }, 'Normal windows did not close');
 const reopenedUrl = `${origin}/after-last-window`;
 await sendOwnedUrl(reopenedUrl);
 const reopenedTarget = await targetFor(reopenedUrl);
 const reopenedWindow = await windowId(reopenedTarget.targetId);
 await delay(1200);
 assert.equal((await cdpTargets()).filter(target => target.type === 'page' && target.url === reopenedUrl).length, 1, 'Reopen URL did not open exactly once');
 await reconnect();
 home = await pageFor(url => /^chrome-extension:\/\/[^/]+\/index\.html$/.test(url));
 const reopenedHomeTarget = await targetFor(home.url());
 assert.equal(await windowId(reopenedHomeTarget.targetId), reopenedWindow, 'Reopened Home and URL must share Chromium window');
 assert.equal((await cdpTargets()).filter(target => target.type === 'page' && /^chrome-extension:\/\/[^/]+\/index\.html$/.test(target.url)).length, 1, 'Expected exactly one reopened Home');
 const reopenedSessions = await home.evaluate(() => window.kestrel.request({ type: 'runtime-list-sessions' }));
 assert(reopenedSessions.ok && reopenedSessions.sessions?.some(item => item.id === sessionId), 'Core session was lost after all windows closed');
 assert.equal(ownedCorePid(), corePid, 'Closing and reopening windows must reuse the same Core process');
 phase('external-url-reopens-last-window-and-preserves-Core-session', { windowId: reopenedWindow, sessionId, corePid });
 await stop(); receipt.result = 'passed';
} catch (error) {
 receipt.result = 'failed'; receipt.error = String(error?.stack || error);
 try { if (home && !home.isClosed()) receipt.documentAtFailure = await home.evaluate(() => ({ identityAttempts: window.__nativeIdentityAttempts, injectedFailure: sessionStorage.getItem('kestrel-test-document-id'), visibility: document.visibilityState, text: document.body.innerText.slice(0, 2000) })); } catch {}
 try { if (settings && !settings.isClosed()) await settings.screenshot({ path: join(evidence, 'failure.png') }); else if (home && !home.isClosed()) await home.screenshot({ path: join(evidence, 'failure.png') }); } catch {}
 try { if (browser) receipt.targetsAtFailure = (await cdpTargets()).map(({ targetId, type, url }) => ({ targetId, type, url })); } catch {}
 try { if (home && !home.isClosed()) { const s = await state(); receipt.browserStateAtFailure = { activeTabId: s.activeTabId, tabs: s.tabs, settings: { newTabBackground: s.settings.newTabBackground, customImageBytes: s.settings.newTabBackgroundCustomDataUrl?.length || 0 } }; } } catch {}
 const childState = child ? { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, killed: child.killed } : null;
 process.stderr.write(`Native settings smoke failed during ${currentOperation}: ${diagnosticOutput(receipt.error)}\n`);
 process.stderr.write(`Native settings smoke process state: ${JSON.stringify(childState)}\n`);
 process.stderr.write(`Native settings smoke final candidate output (last 40 lines):\n${diagnosticOutput(output.split(/\r?\n/).slice(-40).join('\n'))}\n`);
 process.exitCode = 1;
} finally {
 try { await stop(); } catch (error) {
  receipt.result = 'failed'; receipt.shutdownError = String(error?.stack || error); process.exitCode = 1;
  process.stderr.write(`Native settings smoke shutdown failed during ${currentOperation}: ${diagnosticOutput(receipt.shutdownError)}\n`);
  process.stderr.write(`Native settings smoke shutdown process state: ${JSON.stringify(child ? { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, killed: child.killed } : null)}\n`);
 }
 if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(done => child.once('exit', done)); }
 await browser?.close().catch(() => {});
 await new Promise(done => server.close(done));
 try { receipt.candidateSha256After = await candidateDigest(app); if (receipt.candidateSha256After !== receipt.candidateSha256) { receipt.result = 'failed'; receipt.candidateChanged = true; process.exitCode = 1; } } catch (error) { receipt.result = 'failed'; receipt.digestError = String(error); process.exitCode = 1; }
 receipt.finishedAt = new Date().toISOString();
 await writeFile(join(evidence, 'runtime.log'), output); await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2));
 await rm(profile, { recursive: true, force: true });
}
