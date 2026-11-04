import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { candidateDigest } from './native-retirement-evidence.mjs';
import { markDisposableNativeTestProfile } from './native-test-profile.mjs';
import { selectSettingsSection } from './desktop-browser-test-helpers.mjs';
import { CEF_VERSION } from './prepare-native-chromium-runtime.mjs';

assert(process.env.KESTREL_NATIVE_TEST_APP, 'Select the exact disposable native candidate.');
const app = await realpath(resolve(process.env.KESTREL_NATIVE_TEST_APP));
assert(app.endsWith('.app') && !app.startsWith('/Applications/'), 'Use a disposable candidate.');
const executable = await realpath(join(app, 'Contents/MacOS/Kestrel'));
const expectedChromium = CEF_VERSION.split('+chromium-')[1];
async function assertStopped() {
 for (const row of execFileSync('/bin/ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' }).split('\n')) {
  const match = row.trim().match(/^(\d+)\s+(.+)$/);
  if (match?.[2].endsWith('/Contents/MacOS/Kestrel')) assert.notEqual(await realpath(match[2]).catch(() => ''), executable, 'Candidate already running.');
 }
}
await assertStopped();
const evidence = resolve(process.env.KESTREL_NATIVE_HOME_SETTINGS_TRANSFER_EVIDENCE || `.tmp/native-home-settings-transfer-${Date.now()}`);
await mkdir(evidence, { recursive: true, mode: 0o700 });
assert.equal((await readdir(evidence)).length, 0, 'Use an empty evidence directory.');
const profile = await realpath(await mkdtemp(join(tmpdir(), 'kestrel-native-home-settings-transfer-')));
await markDisposableNativeTestProfile(profile);
const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<title>Generated Home shortcut</title><h1>Generated Home shortcut</h1>'); });
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const pageUrl = `http://127.0.0.1:${server.address().port}/generated-bookmark`;
const receipt = { version: 1, startedAt: new Date().toISOString(), runnerPid: process.pid, candidate: app, candidateSha256: await candidateDigest(app),
 sourceCheckoutHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceNote: 'Checkout HEAD is context only; candidate hash does not attest its build source.',
 scope: 'Disposable generated native Chromium profile; first-party Home settings review/apply/undo and actual Chromium storage. No real profile, Keychain, or permission prompts.', phases: [] };
let running, browser, home, settings, endpoint, stopped = true, interrupted = false, stage = 'start';
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = true; if (running?.child.exitCode === null) running.child.kill('SIGTERM'); });
const phase = name => { receipt.phases.push({ phase: name, passed: true }); console.log(`PASS ${name}`); };
async function eventually(fn, message, timeout = 30000) {
 const end = Date.now() + timeout;
 while (Date.now() < end) { if (interrupted) throw Error('Canary interrupted.'); if (await fn()) return; await delay(100); }
 throw Error(message);
}
async function request(input) { return home.evaluate(input => window.kestrel.request(input), input); }
async function state() { const result = await request({ type: 'browser-get-state' }); assert(result.ok); return result.browserState; }
async function start() {
 await assertStopped(); const state = { output: '' };
 state.child = spawn(executable, ['--kestrel-chromium-desktop', '--kestrel-cache-path', profile, '--kestrel-durable-profile', '--kestrel-test-profile-key', '--remote-debugging-port=0'], { stdio: ['ignore', 'pipe', 'pipe'] });
 state.exited = new Promise(resolveExit => state.child.once('exit', (code, signal) => resolveExit({ code, signal })));
 running = state; stopped = false; endpoint = undefined;
 for (const stream of [state.child.stdout, state.child.stderr]) stream.on('data', bytes => { state.output = (state.output + bytes).slice(-200000); });
 await eventually(() => { assert.equal(state.child.exitCode, null, 'Owned app exited.'); endpoint = state.output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+)/)?.[1]; return endpoint; }, 'Owned native endpoint missing.');
 browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
 const observedVersion = browser.version();
 assert.equal(observedVersion, expectedChromium, 'The running Chromium version must match the verified runtime pin.');
 (receipt.observedChromiumVersions ??= []).push(observedVersion);
 await eventually(async () => {
  home = browser.contexts().flatMap(context => context.pages()).find(item => /chrome-extension:\/\/[^/]+\/index.html$/.test(item.url()));
  if (home) return true;
  const session = await browser.newBrowserCDPSession(); const targets = await session.send('Target.getTargets'); await session.detach();
  if (targets.targetInfos.some(item => /chrome-extension:\/\/[^/]+\/index.html$/.test(item.url))) { await browser.close(); browser = await chromium.connectOverCDP(endpoint, { noDefaults: true }); }
  return false;
 }, 'Native Kestrel Home missing.');
 await home.waitForFunction(() => typeof window.kestrel?.request === 'function');
 await home.evaluate(() => { localStorage.setItem('kestrel:onboarded', 'yes'); localStorage.setItem('kestrel:default-browser-prompted', 'yes'); });
 await home.reload(); await home.locator('.kestrel-sidebar').waitFor();
}
async function stop() {
 if (!running) return;
 const current = running; running = undefined;
 if (current.child.exitCode === null && current.child.signalCode === null) current.child.kill('SIGTERM');
 const result = await Promise.race([current.exited, delay(15000, undefined, { ref: false }).then(() => { current.child.kill('SIGKILL'); throw Error('Owned app shutdown unconfirmed.'); })]);
 stopped = true; assert.deepEqual(result, { code: 0, signal: null });
 await browser?.close().catch(() => {}); browser = undefined; settings = undefined;
}
async function openSettings() {
 const result = await request({ type: 'browser-create-tab', input: 'kestrel://settings' }); assert(result.ok);
 await eventually(async () => {
  settings = browser.contexts().flatMap(context => context.pages()).find(item => /index.html\?app=settings(?:&|$)/.test(item.url()));
  if (settings) return true;
  const session = await browser.newBrowserCDPSession(); const targets = await session.send('Target.getTargets'); await session.detach();
  if (targets.targetInfos.some(item => /index.html\?app=settings(?:&|$)/.test(item.url))) {
   await browser.close(); browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
   home = browser.contexts().flatMap(context => context.pages()).find(item => /chrome-extension:\/\/[^/]+\/index.html$/.test(item.url()));
  }
  return false;
 }, 'Native Kestrel settings tab missing.');
 await settings.locator('[data-app-page="settings"]').waitFor();
}
async function rawSettings() { return home.evaluate(async () => (await chrome.storage.local.get('kestrel.native.browser.settings.v1'))['kestrel.native.browser.settings.v1'] ?? {}); }
async function update(patch) { const current = await state(); const result = await request({ type: 'browser-update-settings', settings: { ...current.settings, ...patch } }); assert(result.ok); }
async function activate(page) {
 await page.evaluate(async () => { const tab = await chrome.tabs.getCurrent(); await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); }); await page.bringToFront();
}
function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const name = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([size, name, data, crc]); }
function imageFixture() {
 const width = 640, height = 640, rows = Buffer.alloc(height * (1 + width * 3));
 for (let y = 0; y < height; y++) randomBytes(width * 3).copy(rows, y * (1 + width * 3) + 1);
 const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
try {
 await start(); stage = 'seed-generated-settings';
 await update({ newTabBackground: 'graphite', newTabShortcuts: [{ title: 'Keep original shortcut', url: pageUrl }], newTabWidgets: { version: 1, enabled: [], layouts: {}, routeUsageVisible: [] } });
 await home.evaluate(async () => { const key='kestrel.native.browser.settings.v1'; const raw=(await chrome.storage.local.get(key))[key]; await chrome.storage.local.set({[key]:{...raw, compatibility:{generated:true}}}); });
 const baseline = await rawSettings();
 const bookmarks = await home.evaluate(() => chrome.bookmarks.getTree());
 const history = (await state()).history;
 const image = imageFixture().toString('base64'), dataUrl = 'data:image/png;base64,' + image;
 assert(dataUrl.length > 768 * 1024); receipt.imageBytes = Buffer.byteLength(dataUrl);
 const sourceData = { format:'kestrel-browser-data',version:1,exportedAt:new Date().toISOString(),bookmarks:[],bookmarkFolders:[],history:[],sitePermissions:[],settings:{ newTabBackground:'custom',newTabBackgroundCustomDataUrl:dataUrl,newTabShortcuts:[{title:'Imported generated shortcut',url:pageUrl+'/imported'}],newTabWidgets:{version:1,enabled:['frequent-tabs'],layouts:{},routeUsageVisible:[]} } };
 const sourcePath=join(evidence,'generated-home-source.json'), sourceBytes=Buffer.from(JSON.stringify(sourceData));
 await writeFile(sourcePath,sourceBytes,{mode:0o600}); receipt.sourceBytes=sourceBytes.length;
 await openSettings(); await activate(settings); await selectSettingsSection(settings,'browser-reset','Data & reset');
 let panel=settings.locator('[data-settings-panel="browser-home-settings-transfer"]'); await panel.waitFor();
 const input=()=>panel.getByTestId('native-home-settings-import-file'), preview=()=>panel.getByTestId('native-home-settings-import-preview');
 const error=()=>panel.getByTestId('native-home-settings-transfer-error'), status=()=>panel.getByTestId('native-home-settings-transfer-status');
 const apply=()=>panel.getByTestId('native-home-settings-import-apply'), undo=()=>panel.getByTestId('native-home-settings-import-undo');
 async function planFile(path=sourcePath) {
  await input().setInputFiles(path); await panel.getByRole('checkbox',{name:'Background',exact:true}).waitFor();
  await panel.getByRole('checkbox',{name:'Background',exact:true}).check();
  if (await panel.getByRole('checkbox',{name:'Site shortcuts',exact:true}).count()) await panel.getByRole('checkbox',{name:'Site shortcuts',exact:true}).check();
  await panel.getByTestId('native-home-settings-import-plan').click(); await preview().waitFor();
 }
 stage='preview-and-cancel'; await planFile();
 assert.deepEqual(await rawSettings(),baseline); assert.match(await preview().innerText(),/Background, Site shortcuts/);
 await settings.screenshot({path:join(evidence,'home-import-preview.png')});
 await panel.getByRole('button',{name:'Cancel import',exact:true}).click(); await preview().waitFor({state:'hidden'});
 assert.deepEqual(await rawSettings(),baseline); phase('selected-file-review-and-cancel-have-no-writes');
 stage='invalid-source'; const invalidPath=join(evidence,'generated-invalid.json'); await writeFile(invalidPath,JSON.stringify({format:'kestrel-home-settings',version:1,settings:{newTabWidgets:{version:999}}}),{mode:0o600});
 await input().setInputFiles(invalidPath); await error().waitFor(); assert.deepEqual(await rawSettings(),baseline); phase('invalid-caught-settings-refused-without-default-overwrite');
 stage='stale-review'; await planFile(); await update({newTabBackground:'meadow'}); const changed=await rawSettings(); await apply().click(); await error().waitFor(); assert.deepEqual(await rawSettings(),changed); await panel.getByRole('button',{name:'Cancel import',exact:true}).click(); await update({newTabBackground:'graphite'});
 phase('ordinary-Home-edit-invalidates-stale-review');
 stage='explicit-import-and-undo'; await planFile(); await apply().click(); await undo().waitFor();
 const imported=await rawSettings(); assert.equal(imported.newTabBackground,'custom'); assert.equal(imported.newTabBackgroundCustomDataUrl,dataUrl); assert.deepEqual(imported.newTabShortcuts,sourceData.settings.newTabShortcuts); assert.deepEqual(imported.newTabWidgets,baseline.newTabWidgets); assert.deepEqual(imported.compatibility,baseline.compatibility);
 await activate(home); await home.locator('.new-tab-page-custom').waitFor(); await home.locator('.home-site-shortcuts button').filter({hasText:'Imported generated shortcut'}).waitFor(); await home.screenshot({path:join(evidence,'home-import-applied.png')});
 phase('actual-Home-updates-with-large-image-and-selected-shortcuts-only');
 await update({newTabWidgets:{version:1,enabled:['recent-work'],layouts:{},routeUsageVisible:[]}}); const newerWidgets=(await rawSettings()).newTabWidgets;
 await activate(settings); await undo().click(); await eventually(async()=>/Previous Home settings restored/.test(await status().innerText()),'Undo completion missing');
 const restored=await rawSettings(); for(const key of ['newTabBackground','newTabBackgroundCustomDataUrl','newTabShortcuts']) assert.deepEqual(restored[key],baseline[key]); assert.deepEqual(restored.newTabWidgets,newerWidgets); assert.deepEqual(restored.compatibility,baseline.compatibility);
 phase('explicit-undo-restores-selected-presence-and-preserves-later-widget-edit');
 stage='stale-undo'; const smallPath=join(evidence,'generated-small.json'); await writeFile(smallPath,JSON.stringify({format:'kestrel-home-settings',version:1,settings:{newTabBackground:'paper'}}),{mode:0o600});
 await planFile(smallPath); await apply().click(); await undo().waitFor(); await update({newTabBackground:'meadow'}); await undo().click(); await error().waitFor(); assert.equal((await rawSettings()).newTabBackground,'meadow'); phase('undo-refuses-newer-selected-setting-without-overwrite');
 stage='final-import'; await planFile(); await apply().click(); await undo().waitFor();
 await settings.screenshot({path:join(evidence,'home-import-complete.png')});
 await settings.evaluate(async()=>{const tab=await chrome.tabs.getCurrent();await chrome.tabs.setZoom(tab.id,2);});
 await panel.scrollIntoViewIfNeeded();
 const geometry=await panel.evaluate(element=>({overflow:element.scrollWidth-element.clientWidth,width:element.getBoundingClientRect().width})); assert(geometry.width>0&&geometry.overflow<=1,'Home transfer overflows at 200% zoom');
 await settings.screenshot({path:join(evidence,'home-import-zoom200.png')}); await settings.evaluate(async()=>{const tab=await chrome.tabs.getCurrent();await chrome.tabs.setZoom(tab.id,1);}); phase('native-transfer-reflows-at-200-percent-zoom');
 const expected=await rawSettings(); const pending=await request({type:'browser-plan-home-settings-import',settings:{newTabBackground:'paper'},categories:['background']}); assert(pending.ok); const oldPlan=pending.homeSettingsImportPlan.planId;
 await stop(); stage='restart'; await start();
 const afterRestart=await rawSettings();
 receipt.restartChangedSettings=Array.from(new Set([...Object.keys(expected),...Object.keys(afterRestart)])).filter(key=>JSON.stringify(expected[key])!==JSON.stringify(afterRestart[key]));
 // Opening Home records a bounded local greeting visit through its normal UI.
 // Assert every other stored key, including unselected settings, byte for byte.
 for(const key of new Set([...Object.keys(expected),...Object.keys(afterRestart)])) if(key!=='newTabGreetingActivity') assert.deepEqual(afterRestart[key],expected[key]);
 assert.equal((await state()).settings.newTabGreetingActivity.version,1); await activate(home); await home.locator('.new-tab-page-custom').waitFor(); await home.locator('.home-site-shortcuts button').filter({hasText:'Imported generated shortcut'}).waitFor(); await home.screenshot({path:join(evidence,'home-import-after-restart.png')}); phase('selected-Home-settings-and-actual-Home-survive-full-native-restart');
 assert.equal((await request({type:'browser-apply-home-settings-import',planId:oldPlan})).ok,false); phase('worker-restart-invalidates-unapplied-review');
 assert.deepEqual(await home.evaluate(()=>chrome.bookmarks.getTree()),bookmarks); assert.deepEqual((await state()).history,history); assert.deepEqual(await readFile(sourcePath),sourceBytes); assert.deepEqual((await rawSettings()).compatibility,baseline.compatibility); phase('source-bookmarks-history-and-unrelated-storage-preserved');
 await stop(); receipt.result='passed';
} catch(error) {
 receipt.result='failed'; receipt.failedStage=stage; receipt.error={name:error?.name||'Error',code:error?.code,locations:String(error?.stack||'').split('\n').filter(line=>line.trim().startsWith('at ')).map(line=>line.trim()).slice(0,6)}; process.exitCode=1;
 if(settings) await settings.screenshot({path:join(evidence,'failure.png')}).catch(()=>{}); console.error('FAIL',stage,error?.name||'Error');
} finally {
 await stop().catch(()=>{receipt.shutdownUnconfirmed=true;receipt.result='failed';process.exitCode=1;}); await new Promise(done=>server.close(done));
 receipt.candidateSha256After=await candidateDigest(app); if(receipt.candidateSha256After!==receipt.candidateSha256){receipt.result='failed';process.exitCode=1;}
 receipt.finishedAt=new Date().toISOString(); if(stopped&&receipt.result==='passed'){await rm(profile,{recursive:true,force:true});receipt.generatedProfileRemoved=true;}else{receipt.generatedProfileRemoved=false;receipt.retainedFixture=profile;}
 await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2),{mode:0o600});
}
