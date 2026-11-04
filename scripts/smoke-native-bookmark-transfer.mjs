import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { candidateDigest } from './native-retirement-evidence.mjs';
import { markDisposableNativeTestProfile } from './native-test-profile.mjs';
import { selectSettingsSection } from './desktop-browser-test-helpers.mjs';

assert(process.env.KESTREL_NATIVE_TEST_APP, 'Select the exact disposable native candidate.');
const app = await realpath(resolve(process.env.KESTREL_NATIVE_TEST_APP));
assert(app.endsWith('.app') && !app.startsWith('/Applications/'), 'Use a disposable candidate.');
const executable = await realpath(join(app, 'Contents/MacOS/Kestrel'));
async function assertStopped() {
 for (const row of execFileSync('/bin/ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' }).split('\n')) {
  const match = row.trim().match(/^(\d+)\s+(.+)$/);
  if (match?.[2].endsWith('/Contents/MacOS/Kestrel')) assert.notEqual(await realpath(match[2]).catch(() => ''), executable, 'Candidate already running.');
 }
}
await assertStopped();
const evidence = resolve(process.env.KESTREL_NATIVE_BOOKMARK_TRANSFER_EVIDENCE || `.tmp/native-bookmark-transfer-${Date.now()}`);
await mkdir(evidence, { recursive: true, mode: 0o700 });
assert.equal((await readdir(evidence)).length, 0, 'Use an empty evidence directory.');
const profile = await realpath(await mkdtemp(join(tmpdir(), 'kestrel-native-bookmark-transfer-')));
await markDisposableNativeTestProfile(profile);
const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<title>Generated bookmark page</title><h1>Generated bookmark page</h1>'); });
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const pageUrl = `http://127.0.0.1:${server.address().port}/generated-bookmark`;
const receipt = { version: 1, startedAt: new Date().toISOString(), runnerPid: process.pid, candidate: app, candidateSha256: await candidateDigest(app),
 sourceCheckoutHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceNote: 'Checkout HEAD is context only; candidate hash does not attest its build source.',
 scope: 'Disposable generated native Chromium profile; first-party bookmark transfer controls and real Chromium bookmarks. No real profile, Keychain, or permission prompts.', phases: [] };
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
async function nativeTree() { return home.evaluate(() => chrome.bookmarks.getTree()); }
function flatten(nodes) { return nodes.flatMap(node => [node, ...flatten(node.children || [])]); }
function comparable(tree) {
 return flatten(tree).map(({ id, parentId, title, url }) => ({ id, parentId, title, url }));
}
async function pauseForNativeSave(destination) {
 const acknowledgement = join(evidence, 'continue-native-save');
 await writeFile(join(evidence, 'live-state.json'), JSON.stringify({ stage: 'native-save-dialog', candidate: app, candidateSha256: receipt.candidateSha256, pid: running.child.pid, destination, acknowledgement, instruction: 'Use the owned candidate native save dialog to save to destination, then create acknowledgement. Do not operate another app.' }, null, 2), { mode: 0o600 });
 console.log(`NATIVE_BOOKMARK_TRANSFER_SAVE_READY ${join(evidence, 'live-state.json')}`);
 await eventually(async () => { try { await access(acknowledgement); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }, 'Native save was not acknowledged.', 10 * 60_000);
}
try {
 await start(); stage = 'seed-generated-data';
 const destinationResult = await request({ type: 'browser-create-bookmark-folder', name: 'Generated destination' });
 assert(destinationResult.ok && destinationResult.bookmarkFolderId);
 const destinationId = destinationResult.bookmarkFolderId;
 const seeded = await home.evaluate(async url => {
  const root = (await chrome.bookmarks.getTree())[0].children.find(item => item.folderType === 'bookmarks-bar');
  if (!root) throw Error('Native bookmarks bar missing.');
  return chrome.bookmarks.create({ parentId: root.id, title: 'Keep original duplicate', url });
 }, pageUrl);
 const fixture = {
  format: 'kestrel-bookmarks', version: 1,
  folders: [{ id: 'f0', name: 'Generated research' }, { id: 'f1', name: 'Generated nested', parentId: 'f0' }],
  bookmarks: [
   { url: pageUrl, title: 'Do not replace duplicate', displayMode: 'title' },
   { url: 'https://generated.example/first', title: 'Friendly first', folderId: 'f0', displayMode: 'full' },
   { url: 'https://generated.example/second', title: 'Friendly second', folderId: 'f1', displayMode: 'icon' },
  ],
 };
 const fixturePath = join(evidence, 'generated-import.json');
 await writeFile(fixturePath, JSON.stringify(fixture, null, 2), { mode: 0o600 });
 await openSettings();
 stage = 'open-transfer';
 // The transfer panel is part of the native Browser settings page.
 const panel = settings.locator('[data-settings-panel="browser-bookmarks-transfer"]');
 await selectSettingsSection(settings, 'browser-reset', 'Data & reset');
 await panel.waitFor();
 const input = panel.getByTestId('native-bookmark-import-file');
 const preview = panel.getByTestId('native-bookmark-import-preview');
 const destination = panel.getByTestId('native-bookmark-import-destination');
 const apply = panel.getByTestId('native-bookmark-import-apply');
 const cancel = panel.getByRole('button', { name: 'Cancel import', exact: true });
 const before = comparable(await nativeTree());
 async function plan() {
  await destination.selectOption(destinationId);
  await input.setInputFiles(fixturePath);
  await panel.getByTestId('native-bookmark-import-plan').click();
  await preview.waitFor();
  const text = await preview.innerText();
  assert.match(text, /add 2 bookmarks and 2 folders/i);
  assert.match(text, /1 existing bookmarks will be skipped/i);
 }
 stage = 'preview-and-cancel'; await plan();
 assert.deepEqual(comparable(await nativeTree()), before, 'Preview changed native bookmarks.');
 await settings.screenshot({ path: join(evidence, 'import-preview.png') });
 await cancel.click(); await preview.waitFor({ state: 'hidden' });
 assert.deepEqual(comparable(await nativeTree()), before, 'Cancel changed native bookmarks.');
 phase('selected-file-preview-and-cancel-have-no-native-writes');
 stage = 'stale-preview'; await plan();
 const marker = await home.evaluate(async () => {
  const root = (await chrome.bookmarks.getTree())[0].children.find(item => item.folderType === 'bookmarks-bar');
  return chrome.bookmarks.create({ parentId: root.id, title: 'Generated stale marker', url: 'https://generated.example/stale-marker' });
 });
 const afterExternalChange = comparable(await nativeTree());
 await apply.click();
 await panel.getByTestId('native-bookmark-transfer-error').waitFor();
 assert.deepEqual(comparable(await nativeTree()), afterExternalChange, 'Stale import changed native bookmarks.');
 await home.evaluate(id => chrome.bookmarks.remove(id), marker.id);
 if (await cancel.isVisible().catch(() => false)) await cancel.click();
 phase('stale-preview-rejected-without-import-writes');
 stage = 'explicit-import'; await plan(); await apply.click();
 await eventually(async () => {
  const current = await state();
  return current.bookmarks.some(item => item.url === 'https://generated.example/first' && item.title === 'Friendly first' && item.displayMode === 'full') &&
   current.bookmarks.some(item => item.url === 'https://generated.example/second' && item.title === 'Friendly second' && item.displayMode === 'icon');
 }, 'Imported bookmarks and modes missing.');
 let after = await state();
 const destinationFolder = after.bookmarkFolders.find(item => item.id === destinationId); assert(destinationFolder);
 const tree = flatten(await nativeTree());
 const destinationNative = tree.find(item => item.title === 'Generated destination' && !item.url); assert(destinationNative);
 const parent = tree.find(item => item.title === 'Generated research' && item.parentId === destinationNative.id); assert(parent);
 const child = tree.find(item => item.title === 'Generated nested' && item.parentId === parent.id); assert(child);
 assert(tree.some(item => item.url === 'https://generated.example/first' && item.parentId === parent.id && item.title === 'https://generated.example/first'));
 assert(tree.some(item => item.url === 'https://generated.example/second' && item.parentId === child.id && item.title === ''));
 assert.equal(tree.filter(item => item.url === pageUrl).length, 1);
 assert.equal(tree.find(item => item.id === seeded.id)?.title, 'Keep original duplicate');
 await settings.screenshot({ path: join(evidence, 'import-complete.png') });
 phase('explicit-import-preserves-duplicate-and-Chromium-hierarchy');
 stage = 'legacy-browser-data-import';
 const oldDate = '2020-01-01T00:00:00.000Z';
 const legacyFolderId = `bookmark-folder-${crypto.randomUUID()}`;
 const beforeLegacy = await state();
 const alternateBackground = beforeLegacy.settings.newTabBackground === 'paper' ? 'graphite' : 'paper';
 const legacy = {
  format: 'kestrel-browser-data', version: 1, exportedAt: new Date().toISOString(),
  bookmarkFolders: [{ id: legacyFolderId, name: 'Legacy generated folder', createdAt: oldDate }],
  bookmarks: [{ id: `bookmark-${crypto.randomUUID()}`, folderId: legacyFolderId, url: 'https://generated.example/legacy', title: 'Legacy friendly title', displayMode: 'icon', createdAt: oldDate }],
  history: Array.from({ length: 80 }, (_, index) => ({ id: `visit-${crypto.randomUUID()}`, tabId: `tab-${crypto.randomUUID()}`, url: `https://generated.example/excluded-history/${index}/${'x'.repeat(7800)}`, title: 'Excluded generated history', visitedAt: oldDate })),
  sitePermissions: [], settings: { ...beforeLegacy.settings, newTabBackground: alternateBackground },
 };
 const legacyPath = join(evidence, 'generated-legacy-browser-data.json');
 const legacyBytes = Buffer.from(JSON.stringify(legacy, null, 2));
 assert(legacyBytes.length > 512 * 1024 && legacyBytes.length <= 10 * 1024 * 1024, 'Exercise the larger selected-source boundary without sending its excluded history.');
 receipt.legacySourceBytes = legacyBytes.length;
 receipt.excludedLegacyHistoryEntries = legacy.history.length;
 await writeFile(legacyPath, legacyBytes, { mode: 0o600 });
 await destination.selectOption(destinationId);
 await input.setInputFiles(legacyPath);
 const scope = panel.getByTestId('native-bookmark-import-scope');
 await scope.waitFor();
 const scopeText = await scope.innerText();
 assert.match(scopeText, /80 history entries will not be imported/i);
 assert.match(scopeText, /browser settings will not be imported/i);
 assert.match(scopeText, /original bookmark dates do not transfer/i);
 const beforeLegacyTree = comparable(await nativeTree());
 await panel.getByTestId('native-bookmark-import-plan').click();
 await preview.waitFor();
 assert.match(await preview.innerText(), /add 1 bookmarks and 1 folders/i);
 assert.match(await preview.innerText(), /0 existing bookmarks will be skipped/i);
 assert.deepEqual(comparable(await nativeTree()), beforeLegacyTree, 'Legacy preview changed native bookmarks.');
 await settings.screenshot({ path: join(evidence, 'legacy-import-preview.png') });
 const legacyStartedAt = Date.now();
 await apply.click();
 await eventually(async () => (await state()).bookmarks.some(item => item.url === 'https://generated.example/legacy' && item.title === 'Legacy friendly title' && item.displayMode === 'icon'), 'Legacy bookmark import did not complete.');
 const legacyAfter = await state();
 assert.equal(legacyAfter.settings.newTabBackground, beforeLegacy.settings.newTabBackground);
 assert(!legacyAfter.history.some(item => item.url.startsWith('https://generated.example/excluded-history')));
 assert.deepEqual(await readFile(legacyPath), legacyBytes, 'Legacy source file changed.');
 const legacyTree = flatten(await nativeTree());
 const legacyFolder = legacyTree.find(item => item.title === 'Legacy generated folder' && item.parentId === destinationNative.id);
 assert(legacyFolder);
 const legacyNode = legacyTree.find(item => item.url === 'https://generated.example/legacy');
 assert(legacyNode && legacyNode.parentId === legacyFolder.id && legacyNode.title === '');
 assert(Number.isFinite(legacyNode.dateAdded) && legacyNode.dateAdded >= legacyStartedAt - 2000 && legacyNode.dateAdded <= Date.now());
 phase('legacy-browser-data-import-excludes-history-settings-and-original-dates');
 stage = 'native-save-export';
 await panel.getByTestId('native-bookmark-export-prepare').click();
 await panel.getByTestId('native-bookmark-export-save').click();
 const exportPath = join(evidence, 'generated-export.json');
 await pauseForNativeSave(exportPath);
 await eventually(async () => { try { await access(exportPath); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }, 'Native save did not produce the selected export file.');
 await eventually(async () => (await panel.getByTestId('native-bookmark-transfer-status').innerText().catch(() => '')).trim() === 'Bookmark file saved.', 'Native download completion was not shown.');
 const exported = JSON.parse(await readFile(exportPath, 'utf8'));
 assert.equal(exported.format, 'kestrel-bookmarks'); assert.equal(exported.version, 1);
 assert(exported.bookmarks.some(item => item.url === 'https://generated.example/first' && item.title === 'Friendly first' && item.displayMode === 'full'));
 assert(exported.bookmarks.some(item => item.url === 'https://generated.example/second' && item.title === 'Friendly second' && item.displayMode === 'icon'));
 assert(exported.bookmarks.some(item => item.url === 'https://generated.example/legacy' && item.title === 'Legacy friendly title' && item.displayMode === 'icon'));
 assert.deepEqual(Object.keys(exported).sort(), ['bookmarks', 'folders', 'format', 'version']);
 for (const bookmark of exported.bookmarks) assert(Object.keys(bookmark).every(key => ['url', 'title', 'folderId', 'displayMode'].includes(key)));
 for (const folder of exported.folders) assert(Object.keys(folder).every(key => ['id', 'name', 'parentId'].includes(key)));
 assert(exported.folders.every(item => !tree.some(node => node.id === item.id)), 'Export exposed native folder IDs.');
 phase('native-save-dialog-produced-portable-friendly-title-JSON');
 stage = 'restart'; await stop(); await start();
 after = await state();
 assert(after.bookmarks.some(item => item.url === 'https://generated.example/first' && item.title === 'Friendly first' && item.displayMode === 'full'));
 assert(after.bookmarks.some(item => item.url === 'https://generated.example/second' && item.title === 'Friendly second' && item.displayMode === 'icon'));
 assert(after.bookmarks.some(item => item.url === 'https://generated.example/legacy' && item.title === 'Legacy friendly title' && item.displayMode === 'icon'));
 const restarted = flatten(await nativeTree());
 assert(restarted.some(item => item.id === seeded.id && item.title === 'Keep original duplicate'));
 assert(restarted.some(item => item.url === 'https://generated.example/second' && item.title === ''));
 assert(restarted.some(item => item.url === 'https://generated.example/legacy' && item.title === ''));
 phase('import-survives-clean-app-restart');
 if (process.env.KESTREL_NATIVE_BOOKMARK_TRANSFER_CAPACITY === '1') {
  stage = 'capacity-plan';
  const beforeCapacity = await state();
  const legacyBookmark = beforeCapacity.bookmarks.find(item => item.url === 'https://generated.example/legacy');
  assert(legacyBookmark, 'Generated legacy bookmark missing before capacity test.');
  const nativeCount = tree => flatten(tree).filter(item => typeof item.url === 'string' && /^https?:\/\//i.test(item.url)).length;
  const initialCount = nativeCount(await nativeTree());
  assert.equal(initialCount, beforeCapacity.bookmarks.length, 'Generated native and adapter counts differ.');
  const remaining = 2000 - initialCount;
  assert(remaining > 0, 'Expected room for the generated capacity batch.');
  const data = { format: 'kestrel-bookmarks', version: 1, folders: [], bookmarks: Array.from({ length: remaining }, (_, i) => ({
   url: `https://capacity.generated.invalid/${i}`, title: `Generated ${i}`, displayMode: 'title',
  })) };
  const planned = await request({ type: 'browser-plan-bookmark-import', data });
  assert(planned.ok && planned.bookmarkImportPlan, 'Capacity batch could not be planned.');
  assert.deepEqual(planned.bookmarkImportPlan.summary, { bookmarksToAdd: remaining, duplicateBookmarks: 0, foldersToAdd: 0 });
  const exportDigestBefore = createHash('sha256').update(await readFile(exportPath)).digest('hex');
  stage = 'capacity-apply';
  const started = Date.now();
  let applied;
  try { applied = await request({ type: 'browser-apply-bookmark-import', planId: planned.bookmarkImportPlan.planId }); }
  finally { receipt.capacityElapsedMs = Date.now() - started; }
  assert(applied.ok && applied.bookmarkImportResult, 'Capacity apply did not return a result.');
  assert.deepEqual(applied.bookmarkImportResult, { bookmarksAdded: remaining, duplicateBookmarks: 0, foldersAdded: 0, complete: true });
  assert.equal(nativeCount(await nativeTree()), 2000);
  phase('capacity-batch-completes-at-2000-native-bookmarks');
  stage = 'capacity-refusal';
  const fullTree = comparable(await nativeTree());
  const extra = { format: 'kestrel-bookmarks', version: 1, folders: [], bookmarks: [{ url: 'https://capacity.generated.invalid/extra', title: 'One too many', displayMode: 'title' }] };
  const rejected = await request({ type: 'browser-plan-bookmark-import', data: extra });
  assert.equal(rejected.ok, false, 'A bookmark beyond capacity must be refused.');
  assert.deepEqual(comparable(await nativeTree()), fullTree, 'Over-capacity plan changed native bookmarks.');
  const edited = await request({ type: 'browser-update-bookmark', bookmarkId: legacyBookmark.id, title: 'Updated at capacity', displayMode: 'icon' });
  assert(edited.ok, 'Editing an existing bookmark at capacity failed.');
  assert((await state()).bookmarks.some(item => item.id === legacyBookmark.id && item.title === 'Updated at capacity' && item.displayMode === 'icon'));
  assert.equal(nativeCount(await nativeTree()), 2000);
  assert.equal(createHash('sha256').update(await readFile(exportPath)).digest('hex'), exportDigestBefore, 'Pre-batch export file changed.');
  phase('capacity-refuses-new-bookmark-and-allows-edit');
  stage = 'capacity-restart'; await stop(); await start();
  const restoredCapacity = await state();
  assert.equal(nativeCount(await nativeTree()), 2000);
  assert.equal(restoredCapacity.bookmarks.length, 2000);
  assert(restoredCapacity.bookmarks.some(item => item.id === legacyBookmark.id && item.title === 'Updated at capacity' && item.displayMode === 'icon'));
  assert.equal(createHash('sha256').update(await readFile(exportPath)).digest('hex'), exportDigestBefore);
  phase('capacity-and-edit-survive-clean-app-restart');
 }
 await stop(); receipt.result = 'passed';
} catch (error) {
 receipt.result = 'failed'; receipt.failedStage = stage; receipt.error = String(error?.message || error).slice(0, 500); process.exitCode = 1;
 await settings?.screenshot({ path: join(evidence, 'failed-transfer.png') }).catch(() => {});
 console.error(`Native bookmark transfer canary failed at ${stage}: ${receipt.error}`);
} finally {
 await stop().catch(() => { receipt.result = 'failed'; receipt.shutdownUnconfirmed = true; process.exitCode = 1; });
 await new Promise(resolveClose => server.close(resolveClose));
 receipt.candidateSha256After = await candidateDigest(app);
 if (receipt.candidateSha256 !== receipt.candidateSha256After) { receipt.result = 'failed'; process.exitCode = 1; }
 receipt.finishedAt = new Date().toISOString();
 if (stopped && receipt.result === 'passed') { await rm(profile, { recursive: true, force: true }); receipt.generatedProfileRemoved = true; }
 else { receipt.retainedProfile = profile; receipt.generatedProfileRemoved = false; }
 await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
}
