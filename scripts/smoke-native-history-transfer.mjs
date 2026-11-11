import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { candidateDigest } from './native-retirement-evidence.mjs';
import { markDisposableNativeTestProfile } from './native-test-profile.mjs';
import { selectSettingsSection } from './desktop-browser-test-helpers.mjs';
import { assertNoExactExecutableRunning, validateRealKeychainCandidate } from './native-real-keychain-candidate.mjs';
import { CEF_VERSION } from './prepare-native-chromium-runtime.mjs';

assert(process.env.KESTREL_NATIVE_TEST_APP, 'Select the exact disposable native candidate.');
const { candidate: app, executable } = await validateRealKeychainCandidate(process.env.KESTREL_NATIVE_TEST_APP, { root: resolve('.') });
assertNoExactExecutableRunning(executable);
const expectedChromium = CEF_VERSION.split('+chromium-')[1];
async function assertStopped() {
 for (const row of execFileSync('/bin/ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' }).split('\n')) {
  const match = row.trim().match(/^(\d+)\s+(.+)$/);
  if (match) assert(!match[2].startsWith(`${app}/`), 'A candidate bundle process is still running.');
 }
}
await assertStopped();
const evidence = resolve(process.env.KESTREL_NATIVE_HISTORY_TRANSFER_EVIDENCE || `.tmp/native-history-transfer-${Date.now()}`);
await mkdir(evidence, { recursive: true, mode: 0o700 });
assert.equal((await readdir(evidence)).length, 0, 'Use an empty evidence directory.');
const profile = await realpath(await mkdtemp(join(tmpdir(), 'kestrel-native-history-transfer-')));
await markDisposableNativeTestProfile(profile);
const receipt = { version: 1, startedAt: new Date().toISOString(), runnerPid: process.pid, candidate: app, candidateSha256: await candidateDigest(app),
 sourceCheckoutHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceNote: 'Checkout HEAD is context only; candidate hash does not attest its build source.',
 scope: 'Disposable generated native Chromium profile; first-party selected-file history review/apply and original metadata in Kestrel storage; no fabricated Chromium visits. File selection is automated; native Save As is only tested with explicit operator opt-in. No real profile, credentials or system permissions.', phases: [] };
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
 assert(!interrupted, 'Canary interrupted.');
 await assertStopped();
 assert.equal(await candidateDigest(app), receipt.candidateSha256, 'Candidate changed before launch.');
 assert(!interrupted, 'Canary interrupted.');
 const state = { output: '' };
 state.child = spawn(executable, ['--kestrel-chromium-desktop', '--kestrel-cache-path', profile, '--kestrel-durable-profile', '--kestrel-test-profile-key', '--remote-debugging-port=0'], { stdio: ['ignore', 'pipe', 'pipe'], env: { HOME: process.env.HOME || '', PATH: process.env.PATH || '', LANG: process.env.LANG || 'en_US.UTF-8', TMPDIR: process.env.TMPDIR || tmpdir(), KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: '1', KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: '1' } });
 state.exited = new Promise(resolveExit => state.child.once('exit', (code, signal) => resolveExit({ code, signal })));
 running = state; stopped = false; endpoint = undefined;
 console.log(`OWNED_HISTORY_APP_PID ${state.child.pid}`);
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
 assert.deepEqual(result, { code: 0, signal: null });
 // CEF's helpers may finish just after the main process. Keep the all-process
 // invariant and wait for their normal exit before reopening or deleting data.
 await eventually(async () => { try { await assertStopped(); return true; } catch { return false; } }, 'Candidate helper shutdown was not confirmed.', 10000);
 stopped = true;
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
// Opening first-party Settings legitimately adds extension-page history. The
// invariant concerns imported HTTP(S) visits, not those normal UI navigations.
const nativeHistory = () => home.evaluate(async () => (await chrome.history.search({ text: '', startTime: 0, maxResults: 5000 })).filter(entry => /^https?:/i.test(entry.url || '')));
const metadata = entries => entries.map(({ url, title, visitedAt, provenance }) => ({ url, title, visitedAt, ...(provenance ? { provenance } : {}) }));
const fixture = { format: 'kestrel-history', version: 1, entries: [
 { url: 'https://history.generated.invalid/first', title: 'Generated original first title', visitedAt: '2019-03-04T10:20:30.000Z' },
 { url: 'https://history.generated.invalid/second', title: 'Generated original second title', visitedAt: '2020-05-06T11:22:33.000Z' },
] };
const fixturePath = join(evidence, 'generated-history.json');
const fixtureBytes = Buffer.from(JSON.stringify(fixture));
await writeFile(fixturePath, fixtureBytes, { mode: 0o600 });
async function panel() { await selectSettingsSection(settings, 'browser-reset', 'Data & reset'); const result = settings.locator('[data-settings-panel="browser-history-transfer"]'); await result.waitFor(); return result; }
async function planFile(p, path, additions, duplicates) {
 await p.getByTestId('native-history-import-file').setInputFiles(path);
 await p.getByTestId('native-history-import-plan').click();
 await p.getByTestId('native-history-import-preview').waitFor();
 const text = await p.getByTestId('native-history-import-preview').innerText();
 assert.match(text, new RegExp(`add ${additions} entries`, 'i'));
 assert.match(text, new RegExp(`${duplicates} duplicates`, 'i'));
 await eventually(() => p.getByTestId('native-history-import-apply').evaluate(el => !el.disabled && el === document.activeElement), 'Import review must have predictable keyboard focus.');
}
async function screenshotLayout(p, name) {
 await p.scrollIntoViewIfNeeded();
 assert(await p.evaluate(element => { const box = element.getBoundingClientRect(); return box.width > 0 && box.left >= -1 && box.right <= innerWidth + 1; }), 'History controls overflow viewport.');
 await settings.screenshot({ path: join(evidence, name) });
}
async function nativeSave(p) {
 const destination = join(evidence, 'generated-saved-history.json');
 const acknowledgement = join(evidence, 'continue-native-save');
 await p.getByTestId('native-history-export-save').click();
 await writeFile(join(evidence, 'live-state.json'), JSON.stringify({ stage: 'native-history-save', pid: running.child.pid, candidate: app, candidateSha256: receipt.candidateSha256, destination, acknowledgement }), { mode: 0o600 });
 console.log(`NATIVE_HISTORY_SAVE_READY ${join(evidence, 'live-state.json')}`);
 await eventually(async () => { try { await access(acknowledgement); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }, 'Native history save was not acknowledged.', 10 * 60_000);
 await eventually(async () => (await p.getByTestId('native-history-transfer-status').innerText().catch(() => '')).trim() === 'History file saved.', 'Native download did not complete.');
 const saved = JSON.parse(await readFile(destination, 'utf8'));
 assert.equal(saved.format, 'kestrel-history');
 for (const entry of fixture.entries) assert(saved.entries.some(row => JSON.stringify(row) === JSON.stringify(entry)), 'Saved history metadata changed.');
 receipt.nativeSaveDialogVerified = true;
 phase('native-save-dialog-completed-original-metadata-export');
}
try {
 await start(); stage = 'preview-and-cancel';
 const before = metadata((await state()).history), beforeNative = await nativeHistory();
 await openSettings(); let p = await panel();
 await planFile(p, fixturePath, 2, 0);
 assert.deepEqual(metadata((await state()).history), before, 'History preview wrote imported data.');
 assert.deepEqual(await nativeHistory(), beforeNative, 'Preview changed Chromium history.');
 await screenshotLayout(p, 'history-import-preview.png');
 await p.getByRole('button', { name: 'Cancel import', exact: true }).click();
 await p.getByTestId('native-history-import-preview').waitFor({ state: 'hidden' });
 assert.deepEqual(metadata((await state()).history), before, 'Cancel changed history.');
 phase('selected-file-review-cancel-without-history-writes');
 stage = 'explicit-import'; await planFile(p, fixturePath, 2, 0);
 // Exercise the focused native button through keyboard activation.
 await p.getByTestId('native-history-import-apply').press('Enter');
 await eventually(async () => { const result = await state(); return fixture.entries.every(entry => result.history.some(row => row.url === entry.url && row.title === entry.title && row.visitedAt === entry.visitedAt && row.provenance === 'imported')); }, 'Imported original history metadata missing.');
 await eventually(async () => (await p.getByTestId('native-history-transfer-status').innerText().catch(() => '')).trim() === 'Imported 2 history entries.', 'UI did not confirm successful import.');
 assert.deepEqual(await nativeHistory(), beforeNative, 'Import fabricated Chromium visits.');
 assert.deepEqual(await readFile(fixturePath), fixtureBytes, 'Selected source changed.');
 phase('explicit-keyboard-import-preserves-dates-titles-without-native-visits');
 stage = 'duplicate-review'; await planFile(p, fixturePath, 0, 2);
 await p.getByRole('button', { name: 'Cancel import', exact: true }).click();
 assert.equal((await state()).history.filter(row => row.provenance === 'imported').length, 2);
 phase('duplicate-review-does-not-overwrite-history');
 stage = 'legacy-scope';
 const baseState = await state(), date = '2018-02-03T04:05:06.000Z';
 const legacyEntry = { url: 'https://history.generated.invalid/legacy', title: 'Legacy generated title', visitedAt: date };
 const legacy = { format: 'kestrel-browser-data', version: 1, exportedAt: new Date().toISOString(), bookmarkFolders: [],
  bookmarks: [{ id: `bookmark-${randomUUID()}`, url: 'https://history.generated.invalid/excluded-bookmark', title: 'Excluded bookmark', displayMode: 'title', createdAt: date }],
  history: [{ ...legacyEntry, id: `visit-${randomUUID()}`, tabId: `tab-${randomUUID()}` }],
  sitePermissions: [{ origin: 'https://history.generated.invalid', permission: 'camera', decision: 'allow', updatedAt: date }], settings: baseState.settings };
 const legacyPath = join(evidence, 'generated-legacy-history.json'), legacyBytes = Buffer.from(JSON.stringify(legacy));
 await writeFile(legacyPath, legacyBytes, { mode: 0o600 });
 await planFile(p, legacyPath, 1, 0);
 assert.match(await p.getByTestId('native-history-import-scope').innerText(), /1 bookmarks and 1 site permissions will not be imported/i);
 await p.getByTestId('native-history-import-apply').click();
 await eventually(async () => (await state()).history.some(row => row.url === legacyEntry.url && row.visitedAt === date && row.provenance === 'imported'), 'Legacy original visit missing.');
 await eventually(async () => (await p.getByTestId('native-history-transfer-status').innerText().catch(() => '')).trim() === 'Imported 1 history entry.', 'UI did not confirm the legacy history import.');
 const afterLegacy = await state();
 assert.deepEqual(afterLegacy.settings, baseState.settings); assert.deepEqual(afterLegacy.bookmarks, baseState.bookmarks); assert.deepEqual(afterLegacy.sitePermissions, baseState.sitePermissions);
 assert.deepEqual(await readFile(legacyPath), legacyBytes); assert.deepEqual(await nativeHistory(), beforeNative);
 phase('legacy-file-imports-history-without-permissions-settings-or-bookmarks');
 stage = 'portable-export';
 const exported = await request({ type: 'browser-export-history' }); assert(exported.ok && exported.historyTransfer);
 assert.deepEqual(Object.keys(exported.historyTransfer).sort(), ['entries', 'format', 'version']);
 for (const entry of [...fixture.entries, legacyEntry]) assert(exported.historyTransfer.entries.some(row => row.url === entry.url && row.title === entry.title && row.visitedAt === entry.visitedAt));
 assert(exported.historyTransfer.entries.every(row => Object.keys(row).every(key => ['url', 'title', 'visitedAt'].includes(key))));
 await p.getByTestId('native-history-export-prepare').click(); await p.getByTestId('native-history-export-save').waitFor();
 phase('portable-export-preserves-original-metadata-without-profile-identifiers');
 if (process.env.KESTREL_TEST_NATIVE_HISTORY_SAVE === '1') { stage = 'native-save'; await nativeSave(p); }
 else receipt.nativeSaveDialogVerified = false;
 stage = 'restart'; await stop(); await start();
 const restored = await state();
 for (const entry of [...fixture.entries, legacyEntry]) assert(restored.history.some(row => row.url === entry.url && row.title === entry.title && row.visitedAt === entry.visitedAt && row.provenance === 'imported'));
 assert.deepEqual(await nativeHistory(), beforeNative);
 phase('imported-history-survives-clean-restart');
 stage = 'imported-label-and-reflow';
 await openSettings(); p = await panel();
 await settings.setViewportSize({ width: 680, height: 900 });
 await screenshotLayout(p, 'history-transfer-narrow.png');
 await settings.setViewportSize({ width: 1280, height: 900 });
 const historyResult = await request({ type: 'browser-create-tab', input: 'kestrel://history', active: true }); assert(historyResult.ok);
 let historyPage;
 await eventually(async () => { historyPage = browser.contexts().flatMap(ctx => ctx.pages()).find(page => /index.html\?app=history(?:&|$)/.test(page.url())); if (historyPage) return true; await browser.close(); browser = await chromium.connectOverCDP(endpoint, { noDefaults: true }); return false; }, 'History page missing.');
 await historyPage.locator('.history-list').waitFor();
 assert((await historyPage.locator('.history-list').innerText()).includes('Imported'));
 assert((await historyPage.locator('.history-list').innerText()).includes(fixture.entries[0].title));
 await historyPage.screenshot({ path: join(evidence, 'imported-history-library.png') });
 home = browser.contexts().flatMap(ctx => ctx.pages()).find(page => /chrome-extension:\/\/[^/]+\/index.html$/.test(page.url()));
 await home.waitForFunction(() => typeof window.kestrel?.request === 'function');
 phase('imported-label-visible-and-transfer-controls-fit-narrow-window');
 stage = 'near-limit-renderer-review';
 const large = { format: 'kestrel-history', version: 1, entries: Array.from({ length: 1500 }, (_, index) => ({
  url: `https://large-history.generated.invalid/${index}`, title: 'a'.repeat(500), visitedAt: '2017-01-01T00:00:00.000Z',
 })) };
 const envelope = JSON.stringify({ kind: 'request', id: 1, request: { type: 'browser-plan-history-import', data: large } });
 assert(envelope.length > 768 * 1024 && Buffer.byteLength(JSON.stringify(large)) <= 1024 * 1024);
 const beforeLarge = metadata((await state()).history);
 const largeReview = await request({ type: 'browser-plan-history-import', data: large });
 assert(largeReview.ok && largeReview.historyImportPlan && largeReview.historyImportPlan.summary.entriesToAdd === 1500);
 const discard = await request({ type: 'browser-discard-history-import', planId: largeReview.historyImportPlan.planId }); assert(discard.ok);
 assert.deepEqual(metadata((await state()).history), beforeLarge); assert.deepEqual(await nativeHistory(), beforeNative);
 phase('near-limit-renderer-history-review-remains-read-only');
 stage = 'Chromium-owned-clear';
 await home.evaluate(() => chrome.history.deleteAll());
 await eventually(async () => (await state()).history.length === 0, 'Chromium clear did not remove imported records.');
 assert.deepEqual(await nativeHistory(), []);
 const replanned = await request({ type: 'browser-plan-history-import', data: fixture }); assert(replanned.ok && replanned.historyImportPlan);
 const reapplied = await request({ type: 'browser-apply-history-import', planId: replanned.historyImportPlan.planId }); assert(reapplied.ok);
 assert.equal((await state()).history.filter(entry => entry.provenance === 'imported').length, 2);
 phase('Chromium-owned-clear-removes-imported-records-and-allows-fresh-review');
 stage = 'storage-failure-feedback';
 const homeOrigin = new URL(home.url());
 const worker = browser.contexts().flatMap(context => context.serviceWorkers()).find(item => {
  const target = new URL(item.url());
  return target.protocol === 'chrome-extension:' && target.hostname === homeOrigin.hostname && target.pathname === '/background.mjs';
 });
 assert(worker, 'The owned first-party browser worker is unavailable.');
 let storageFault = false;
 try {
  await worker.evaluate(() => {
   globalThis.__historyCanarySet = chrome.storage.local.set;
   chrome.storage.local.set = () => Promise.reject(Error('Generated history storage failure.'));
  });
  storageFault = true; receipt.storageFailureInjected = true;
  await home.evaluate(() => chrome.history.deleteAll());
  await historyPage.getByTestId('history-sync-error').waitFor();
  assert.match(await historyPage.getByTestId('history-sync-error').innerText(), /imported history could not be removed/i);
  await historyPage.reload();
  await historyPage.locator('.history-list').waitFor();
  await historyPage.getByTestId('history-sync-error').waitFor();
  assert.match(await historyPage.getByTestId('history-sync-error').innerText(), /imported history could not be removed/i);
  await home.evaluate(async () => {
   window.__historyCanaryStateEvents = 0;
   window.__historyCanaryUnsubscribe = window.kestrel.onBrowserEvent(event => { if (event.type === 'state') window.__historyCanaryStateEvents++; });
   const tab = await chrome.tabs.getCurrent(); await chrome.tabs.update(tab.id, { muted: true });
  });
  await eventually(() => home.evaluate(() => window.__historyCanaryStateEvents > 0), 'Unrelated native state update missing.');
  assert(await historyPage.getByTestId('history-sync-error').isVisible(), 'Unrelated state hid an unresolved deletion warning.');
  await historyPage.screenshot({ path: join(evidence, 'history-sync-failure.png') });
  phase('native-storage-failure-warning-survives-unrelated-state');
 } finally {
  if (storageFault) await worker.evaluate(() => { chrome.storage.local.set = globalThis.__historyCanarySet; delete globalThis.__historyCanarySet; });
  await home.evaluate(() => { window.__historyCanaryUnsubscribe?.(); delete window.__historyCanaryUnsubscribe; }).catch(() => {});
 }
 stage = 'clear-history';
 await historyPage.getByRole('button', { name: 'Clear browsing history', exact: true }).click();
 await eventually(async () => (await state()).history.length === 0, 'Kestrel clear did not remove all history.');
 await historyPage.getByTestId('history-sync-error').waitFor({ state: 'hidden' });
 assert.equal((await state()).history.length, 0); assert.deepEqual(await nativeHistory(), []);
 await stop(); await start(); assert.equal((await state()).history.length, 0); assert.deepEqual(await nativeHistory(), []);
 phase('clear-removes-imported-and-Chromium-history-after-restart');
 await stop(); receipt.result = 'passed';
} catch (error) {
 receipt.result = 'failed'; receipt.failedStage = stage; process.exitCode = 1;
 receipt.error = String(error?.message || error).replace(/\b(?:https?|chrome-extension):\/\/[^\s"'<>]+/gi, '[generated URL]').slice(0, 500);
 await settings?.screenshot({ path: join(evidence, 'failed-history-transfer.png') }).catch(() => {});
 console.error(`Native history transfer canary failed at ${stage}: ${receipt.error}`);
} finally {
 await stop().catch(() => { receipt.result = 'failed'; receipt.shutdownUnconfirmed = true; process.exitCode = 1; });
 try { await assertStopped(); } catch { stopped = false; receipt.result = 'failed'; process.exitCode = 1; }
 receipt.candidateSha256After = await candidateDigest(app);
 if (receipt.candidateSha256After !== receipt.candidateSha256 || interrupted) { receipt.result = 'failed'; process.exitCode = 1; }
 receipt.finishedAt = new Date().toISOString();
 if (stopped && receipt.result === 'passed') { await rm(profile, { recursive: true, force: true }); receipt.generatedProfileRemoved = true; }
 else { receipt.retainedProfile = profile; receipt.generatedProfileRemoved = false; }
 await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
}
