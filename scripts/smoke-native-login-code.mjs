import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { candidateDigest } from './native-retirement-evidence.mjs';
import { markDisposableNativeTestProfile } from './native-test-profile.mjs';
import { selectSettingsSection } from './desktop-browser-test-helpers.mjs';

// Only the native protected test-profile response can select this generated
// Messages database. Never consult or alter the real macOS Messages database.
assert(process.env.KESTREL_NATIVE_TEST_APP, 'Select an exact disposable native candidate.');
const app = await realpath(resolve(process.env.KESTREL_NATIVE_TEST_APP));
assert(app.endsWith('.app') && !app.startsWith('/Applications/'), 'Use a disposable app bundle.');
const executable = await realpath(join(app, 'Contents/MacOS/Kestrel'));
async function assertStopped() {
 for (const row of execFileSync('/bin/ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' }).split('\n')) {
  const match = row.trim().match(/^(\d+)\s+(.+)$/);
  if (match?.[2].endsWith('/Contents/MacOS/Kestrel')) assert.notEqual(await realpath(match[2]).catch(() => ''), executable, 'Candidate is already running.');
 }
}
await assertStopped();
const evidence = resolve(process.env.KESTREL_NATIVE_LOGIN_CODE_EVIDENCE || `.tmp/native-login-code-${Date.now()}`);
await mkdir(evidence, { recursive: true, mode: 0o700 });
assert.equal((await readdir(evidence)).length, 0, 'Evidence directory must be empty.');
const profile = await realpath(await mkdtemp(join(tmpdir(), 'kestrel-native-login-code-')));
await markDisposableNativeTestProfile(profile);
await mkdir(join(profile, 'fixtures'), { mode: 0o700 });
const database = join(profile, 'fixtures/messages.sqlite');
const date = offset => ((BigInt(Date.now() + offset - 978307200000)) * 1000000n).toString();
execFileSync('/usr/bin/sqlite3', [database, `CREATE TABLE handle(id TEXT); INSERT INTO handle(rowid,id) VALUES(1,'generated-sender');
 CREATE TABLE message(text TEXT,subject TEXT,handle_id INTEGER,date INTEGER);
 INSERT INTO message VALUES('Your verification code is 481902',NULL,1,${date(-60000)});
 INSERT INTO message VALUES('Your verification code is 999992',NULL,1,${date(-31*60000)});
 INSERT INTO message VALUES('Your verification code is 999991',NULL,1,${date(60000)});`], { timeout: 5000 });
const receipt = { version: 1, startedAt: new Date().toISOString(), candidate: app, candidateSha256: await candidateDigest(app),
 scope: 'Disposable profile, generated Messages rows, loopback login page, actual packaged Chromium and companion UI. No real Messages data, Full Disk Access, microphone, user secrets, or security settings.', phases: [] };
let server, running, browser, endpoint, home, page, panel, stage = 'start', interrupted = false, ownedStopped = true;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = true; running?.child.kill('SIGTERM'); });
function phase(name) { receipt.phases.push({ phase: name, passed: true }); console.log(`PASS ${name}`); }
async function eventually(fn, message, timeout = 30000) {
 const end = Date.now() + timeout;
 while (Date.now() < end) { if (interrupted) throw Error('Canary interrupted.'); if (await fn()) return; await delay(100); }
 throw Error(message);
}
async function request(input) { return home.evaluate(input => window.kestrel.request(input), input); }
async function start() {
 await assertStopped();
 const state = { output: '' };
 state.child = spawn(executable, ['--kestrel-chromium-desktop', '--kestrel-cache-path', profile, '--kestrel-durable-profile', '--kestrel-test-profile-key', '--remote-debugging-port=0'], { stdio: ['ignore', 'pipe', 'pipe'] });
 state.exited = new Promise(resolveExit => state.child.once('exit', (code, signal) => resolveExit({ code, signal })));
 for (const stream of [state.child.stdout, state.child.stderr]) stream.on('data', chunk => { state.output = (state.output + chunk).slice(-200000); });
 running = state; ownedStopped = false; endpoint = undefined;
 await eventually(() => { assert.equal(state.child.exitCode, null, 'Owned app exited.'); endpoint = state.output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+)/)?.[1]; return endpoint; }, 'Native endpoint missing.');
 browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
 await eventually(async () => {
  home = browser.contexts().flatMap(context => context.pages()).find(item => /chrome-extension:\/\/[^/]+\/index.html$/.test(item.url()));
  if (home) return true;
  const session = await browser.newBrowserCDPSession(); const targets = await session.send('Target.getTargets'); await session.detach();
  if (targets.targetInfos.some(target => /chrome-extension:\/\/[^/]+\/index.html$/.test(target.url))) { await browser.close(); browser = await chromium.connectOverCDP(endpoint, { noDefaults: true }); }
  return false;
 }, 'Native Home unavailable.');
 await home.waitForFunction(() => typeof window.kestrel?.request === 'function');
 await home.evaluate(() => { localStorage.setItem('kestrel:onboarded', 'yes'); localStorage.setItem('kestrel:default-browser-prompted', 'yes'); });
 await home.reload(); await home.locator('.kestrel-sidebar').waitFor();
}
async function stop() {
 panel?.close(); panel = undefined;
 if (!running) return;
 const state = running; running = undefined;
 if (state.child.exitCode === null && state.child.signalCode === null) state.child.kill('SIGTERM');
 const exit = await Promise.race([state.exited, delay(15000, undefined, { ref: false }).then(() => { state.child.kill('SIGKILL'); throw Error('Owned app shutdown timed out.'); })]);
 ownedStopped = true;
 assert.deepEqual(exit, { code: 0, signal: null });
 await browser?.close().catch(() => {}); browser = undefined;
}
async function attachPage(url) {
 await eventually(async () => {
  page = browser.contexts().flatMap(context => context.pages()).find(item => item.url() === url);
  if (page) return true;
  const session = await browser.newBrowserCDPSession(); const targets = await session.send('Target.getTargets'); await session.detach();
  if (targets.targetInfos.some(target => target.url === url)) { await browser.close(); browser = await chromium.connectOverCDP(endpoint, { noDefaults: true }); home = browser.contexts().flatMap(context => context.pages()).find(item => /chrome-extension:\/\/[^/]+\/index.html$/.test(item.url())); }
  return false;
 }, 'Owned loopback tab unavailable.');
}
// The side panel is a CEF "other" target, not a Playwright Page. Use CDP
// input events on its rendered controls, not an artificial DOM click.
async function connectPanel() {
 const address = new URL(endpoint); const targets = await (await fetch(`http://127.0.0.1:${address.port}/json/list`)).json();
 const ui = new URL(home.url());
 const target = targets.find(item => item.url === `${ui.protocol}//${ui.host}/index.html?surface=panel`);
 assert(target?.webSocketDebuggerUrl && new URL(target.webSocketDebuggerUrl).host === address.host, 'Real native companion missing.');
 const socket = new WebSocket(target.webSocketDebuggerUrl); let next = 0; const pending = new Map();
 await new Promise((resolveOpen, reject) => { socket.addEventListener('open', resolveOpen, { once: true }); socket.addEventListener('error', reject, { once: true }); });
 socket.addEventListener('message', event => { const value = JSON.parse(event.data), item = pending.get(value.id); if (!item) return; pending.delete(value.id); clearTimeout(item.timer); value.error ? item.reject(Error(value.error.message)) : item.resolve(value.result); });
 socket.addEventListener('close', () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('Companion closed.')); } pending.clear(); });
 const send = (method, params) => new Promise((resolveResult, reject) => { const id = ++next; const timer = setTimeout(() => { pending.delete(id); reject(Error('Companion request timed out.')); }, 10000); pending.set(id, { resolve: resolveResult, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
 const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, returnByValue: true }); if (result.exceptionDetails) throw Error('Companion evaluation failed.'); return result.result.value; };
 return { text: () => evaluate('document.body.innerText'),
  async click(label) {
   const expression = `(() => {const buttons=[...document.querySelectorAll('button')].filter(b=>b.innerText.trim()===${JSON.stringify(label)}&&!b.disabled); if(buttons.length!==1)return null; buttons[0].scrollIntoView({block:'nearest'}); const r=buttons[0].getBoundingClientRect();return r.width&&r.height?{x:r.left+r.width/2,y:r.top+r.height/2}:null})()`;
   const point = await evaluate(expression); assert(point, `Visible companion control missing: ${label}`);
   await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
   await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  }, async screenshot(path) { const result = await send('Page.captureScreenshot', { format: 'png' }); await writeFile(path, Buffer.from(result.data, 'base64'), { mode: 0o600 }); }, close() { socket.close(); } };
}
try {
 server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(`<!doctype html><title>Generated verification fixture</title><h1>Verify your sign in</h1><form id="form"><label>Verification code <input id="otp" name="verification-code" autocomplete="one-time-code"></label><button type="submit">Continue</button></form><script>window.fixture={events:[],submits:0}; const el=document.querySelector('#otp'); for(const name of ['input','change'])el.addEventListener(name,()=>fixture.events.push(name)); document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();fixture.submits++});</script>`); });
 await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
 const url = `http://127.0.0.1:${server.address().port}/login`;
 await start();
 const created = await request({ type: 'browser-create-tab', input: url, active: true }); assert(created.ok, created.error);
 let tabId;
 await eventually(async () => {
  const state = await request({ type: 'browser-get-state' });
  tabId = state.browserState?.tabs.find(tab => tab.url === url && !tab.loading)?.id;
  return Boolean(tabId);
 }, 'Created loopback tab did not finish loading in the native tab model.');
 await attachPage(url); await page.locator('#otp').waitFor();
 assert.deepEqual(await page.evaluate(() => [typeof window.kestrel, typeof window.__kestrelNativeQuery, typeof window.__kestrelHostTransport]), ['undefined', 'undefined', 'undefined']);
 const raw = await request({ type: 'communication-code-search', domain: 'example.test', after: new Date(Date.now() - 60000).toISOString(), maxResults: 5 }); assert.equal(raw.ok, false);
 phase('public-page-no-bridge-and-raw-code-search-rejected');
 stage = 'generic-automation-refusal';
 const session = await request({ type: 'runtime-create-session', title: 'Generated login-code canary', kind: 'conversation' }); assert(session.ok && session.session?.id);
 async function tool(toolName, input) {
  const response = await request({ type: 'runtime-call-tool', sessionId: session.session.id, toolName, input, approvalStatus: 'approved', idempotencyKey: crypto.randomUUID() });
  assert(response.ok, response.error); return response.execution;
 }
 const snapshot = await tool('browser.visible-snapshot', { tabId }); assert.equal(snapshot.status, 'verified');
 const secret = snapshot.output?.interactive?.find(item => item.name === 'Sensitive field'); assert(secret, 'The OTP field must be redacted in a generic snapshot.');
 const blocked = await tool('browser.visible-act', { tabId, action: { type: 'type', target: secret.ref, text: '555555' } }); assert(['failed', 'blocked'].includes(blocked.status));
 assert.equal(await page.locator('#otp').inputValue(), '');
 phase('generic-visible-automation-rejects-code-field');
 stage = 'open-real-companion';
 // Exercise the real settings button: its first-party gesture opens both the
 // native Extensions page and the companion without contacting the Store.
 const settingsResult = await request({ type: 'browser-create-tab', input: 'kestrel://settings', active: true });
 assert(settingsResult.ok, settingsResult.error);
 let settings;
 await eventually(async () => {
  settings = browser.contexts().flatMap(context => context.pages()).find(item => /index\.html\?app=settings(?:&|$)/.test(item.url()));
  if (settings) return true;
  const session = await browser.newBrowserCDPSession(); const targets = await session.send('Target.getTargets'); await session.detach();
  if (targets.targetInfos.some(target => /index\.html\?app=settings(?:&|$)/.test(target.url))) {
   await browser.close(); browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
   home = browser.contexts().flatMap(context => context.pages()).find(item => /chrome-extension:\/\/[^/]+\/index.html$/.test(item.url()));
  }
  return false;
 }, 'Native settings unavailable.');
 await settings.locator('[data-app-page="settings"]').waitFor();
 await selectSettingsSection(settings, 'browser-extensions', 'Extensions');
 await settings.getByRole('button', { name: 'Open Manage extensions', exact: true }).click();
 await eventually(async () => { try { panel = await connectPanel(); return true; } catch { return false; } }, 'Actual native companion did not open.');
 const selected = await request({ type: 'browser-select-tab', tabId }); assert(selected.ok, selected.error);
 await eventually(async () => (await panel.text()).includes('Find verification code'), 'Collapsed code helper missing.');
 await panel.click('Find verification code');
 await panel.click('Find code');
 await eventually(async () => (await panel.text()).includes('481902'), 'Generated recent code did not appear.');
 const results = await panel.text(); assert(!results.includes('999991') && !results.includes('999992'), 'Future and old rows must be excluded.');
 await panel.screenshot(join(evidence, 'native-code-candidate.png'));
 phase('actual-companion-finds-only-recent-generated-message');
 stage = 'visible-code-fill';
 await panel.click('Use code');
 await eventually(async () => (await page.locator('#otp').inputValue()) === '481902', 'Native companion did not fill the captured field.');
 const effect = await page.evaluate(() => window.fixture); assert.deepEqual(effect.events, ['input', 'change']); assert.equal(effect.submits, 0);
 phase('actual-companion-code-fill-input-change-without-submit');
 stage = 'stale-navigation';
 // Capture a real scan through the same authenticated first-party protocol and
 // prove a replaced document cannot receive its opaque candidate.
 const scan = await request({ type: 'communication-code-scan', tabId }); assert(scan.ok, scan.error);
 const candidate = scan.communicationScan?.candidates.find(item => item.code === '481902'); assert(candidate);
 await page.goto(`${url}?revision=2`); await page.locator('#otp').waitFor();
 const stale = await request({ type: 'communication-code-use', scanId: scan.communicationScan.scanId, candidateId: candidate.id }); assert.equal(stale.ok, false);
 assert.equal(await page.locator('#otp').inputValue(), '');
 await eventually(async () => !(await panel.text()).includes('481902'), 'Navigating must discard visible stale candidates.');
 phase('navigation-invalidates-opaque-scan-and-visible-candidate');
 stage = 'restart';
 // Capture a fresh token, then stop before use to check the process lifetime.
 const fresh = await request({ type: 'communication-code-scan', tabId }); assert(fresh.ok, fresh.error);
 const freshCandidate = fresh.communicationScan?.candidates.find(item => item.code === '481902'); assert(freshCandidate);
 await stop(); await start();
 const old = await request({ type: 'communication-code-use', scanId: fresh.communicationScan.scanId, candidateId: freshCandidate.id }); assert.equal(old.ok, false);
 phase('restart-discards-unconsumed-code-candidate');
 receipt.result = 'passed';
} catch (error) {
 if (panel) {
  await writeFile(join(evidence, 'failed-companion.txt'), (await panel.text().catch(() => 'Unavailable')).slice(0, 16000), { mode: 0o600 });
  await panel.screenshot(join(evidence, 'failed-companion.png')).catch(() => {});
 }
 if (home && !home.isClosed()) {
  const status = await request({ type: 'communication-sources' }).catch(() => ({ ok: false }));
  await writeFile(join(evidence, 'failed-generated-source-status.json'), JSON.stringify(status, null, 2), { mode: 0o600 });
 }
 receipt.result = 'failed'; receipt.failedStage = stage; receipt.error = String(error?.message || error).slice(0, 1000); console.error(`Native login-code canary failed at ${stage}: ${receipt.error}`); process.exitCode = 1;
} finally {
 await stop().catch(error => { receipt.shutdownError = String(error.message).slice(0, 300); receipt.result = 'failed'; process.exitCode = 1; });
 if (server) { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); }
 receipt.candidateSha256After = await candidateDigest(app);
 if (receipt.candidateSha256 !== receipt.candidateSha256After) { receipt.result = 'failed'; process.exitCode = 1; }
 receipt.finishedAt = new Date().toISOString();
 receipt.generatedProfileRemoved = false;
 if (ownedStopped) { await rm(profile, { recursive: true, force: true }); receipt.generatedProfileRemoved = true; }
 await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
}
