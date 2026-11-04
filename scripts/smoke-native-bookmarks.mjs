import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { candidateDigest } from './native-retirement-evidence.mjs';
import { markDisposableNativeTestProfile } from './native-test-profile.mjs';

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
const evidence = resolve(process.env.KESTREL_NATIVE_BOOKMARK_EVIDENCE || `.tmp/native-bookmarks-${Date.now()}`);
await mkdir(evidence, { recursive: true, mode: 0o700 });
assert.equal((await readdir(evidence)).length, 0, 'Use an empty evidence directory.');
const profile = await realpath(await mkdtemp(join(tmpdir(), 'kestrel-native-bookmarks-')));
await markDisposableNativeTestProfile(profile);
const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<title>Generated bookmark page</title><h1>Generated bookmark page</h1>'); });
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const pageUrl = `http://127.0.0.1:${server.address().port}/generated-bookmark`;
const receipt = { version: 1, startedAt: new Date().toISOString(), candidate: app, candidateSha256: await candidateDigest(app),
 scope: 'Generated normal native Chromium profile and loopback page; actual Kestrel Saved pages controls and Chrome bookmark APIs. No real profile, Keychain or permissions.', phases: [] };
let running, browser, home, library, endpoint, stopped = true, interrupted = false, stage = 'start';
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
 await browser?.close().catch(() => {}); browser = undefined; library = undefined;
}
async function openLibrary() {
 const result = await request({ type: 'browser-create-tab', input: 'kestrel://bookmarks' }); assert(result.ok);
 await eventually(async () => {
  library = browser.contexts().flatMap(context => context.pages()).find(item => /index.html\?app=bookmarks$/.test(item.url()));
  if (library) return true;
  const session = await browser.newBrowserCDPSession(); const targets = await session.send('Target.getTargets'); await session.detach();
  if (targets.targetInfos.some(item => /index.html\?app=bookmarks$/.test(item.url))) {
   await browser.close(); browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
   home = browser.contexts().flatMap(context => context.pages()).find(item => /chrome-extension:\/\/[^/]+\/index.html$/.test(item.url()));
  }
  return false;
 }, 'Native Saved pages tab missing.');
 await library.getByRole('heading', { name: 'Saved pages', exact: true }).waitFor();
}
async function waitState(check, message) {
 await eventually(async () => {
  if (library && await library.locator('.bookmark-library-error').isVisible()) throw Error(`Saved pages rejected the operation: ${(await library.locator('.bookmark-library-error').innerText()).slice(0, 250)}`);
  return check(await state());
 }, message);
}
async function nativeTree() { return home.evaluate(() => chrome.bookmarks.getTree()); }
function flatten(nodes) { return nodes.flatMap(node => [node, ...flatten(node.children || [])]); }
try {
 await start(); stage = 'seed-bookmark';
 assert((await request({ type: 'browser-toggle-bookmark', url: pageUrl, title: 'Generated saved page' })).ok);
 const seeded = (await state()).bookmarks.find(item => item.url === pageUrl); assert(seeded);
 const nativeBefore = flatten(await nativeTree()).find(item => item.url === pageUrl); assert(nativeBefore);
 phase('bookmark-is-owned-by-Chromium');
 await openLibrary(); stage = 'create-folder';
 await library.getByRole('button', { name: 'New folder', exact: true }).click();
 await library.getByLabel('New folder', { exact: true }).fill('Generated research');
 await library.getByRole('button', { name: 'Create', exact: true }).click();
 await waitState(value => value.bookmarkFolders.some(item => item.name === 'Generated research'), 'Native folder creation failed.');
 let folder = (await state()).bookmarkFolders.find(item => item.name === 'Generated research'); assert(folder);
 phase('actual-Saved-pages-folder-create');
 stage = 'edit-bookmark'; await library.locator('.bookmark-library-controls select').selectOption('all');
 let row = library.locator('.bookmark-library-list > li').filter({ hasText: 'Generated saved page' });
 await row.getByRole('button', { name: 'Edit', exact: true }).click();
 const editor = row.locator('.bookmark-library-edit');
 await editor.getByLabel('Title', { exact: true }).fill('Edited native bookmark');
 await editor.getByRole('combobox', { name: /^Show on bar as/ }).selectOption('full');
 await editor.getByRole('combobox', { name: /^Folder/ }).selectOption(folder.id);
 await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
 await waitState(value => value.bookmarks.some(item => item.id === seeded.id && item.title === 'Edited native bookmark' && item.folderId === folder.id && item.displayMode === 'full'), 'Native bookmark edit did not persist.');
 let tree = flatten(await nativeTree()), nativeBookmark = tree.find(item => item.id === nativeBefore.id), nativeFolder = tree.find(item => item.id === nativeBookmark?.parentId);
 assert.equal(nativeBookmark?.title, pageUrl); assert.equal(nativeFolder?.title, 'Generated research');
 phase('actual-Saved-pages-edit-move-and-native-Chrome-readback');
 for (const [mode, nativeTitle] of [['title', 'Edited native bookmark'], ['icon', '']]) {
  row = library.locator('.bookmark-library-list > li').filter({ hasText: 'Edited native bookmark' });
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  const form = row.locator('.bookmark-library-edit');
  await form.getByRole('combobox', { name: /^Show on bar as/ }).selectOption(mode);
  await form.getByRole('button', { name: 'Save changes', exact: true }).click();
  await waitState(value => value.bookmarks.some(item => item.id === seeded.id && item.title === 'Edited native bookmark' && item.displayMode === mode), 'Native bookmark display choice did not persist.');
  assert.equal(flatten(await nativeTree()).find(item => item.id === nativeBefore.id)?.title, nativeTitle);
  phase(`actual-native-bookmark-label-${mode}`);
 }
 stage = 'rename-folder';
 let folderRow = library.locator('.bookmark-library-folders li').filter({ hasText: 'Generated research' });
 await folderRow.getByRole('button', { name: 'Rename', exact: true }).click();
 await library.getByRole('textbox', { name: 'Rename Generated research', exact: true }).fill('Renamed research');
 await library.locator('.bookmark-library-folder-rename').getByRole('button', { name: 'Save', exact: true }).click();
 await waitState(value => value.bookmarkFolders.some(item => item.id === folder.id && item.name === 'Renamed research'), 'Native folder rename failed.');
 assert.equal(flatten(await nativeTree()).find(item => item.id === nativeFolder.id)?.title, 'Renamed research');
 await library.screenshot({ path: join(evidence, 'native-bookmark-edited.png') });
 phase('actual-Saved-pages-folder-rename');
 if (process.env.KESTREL_NATIVE_BOOKMARK_INSPECT === '1') {
  const acknowledgement = join(evidence, 'continue-inspection');
  await writeFile(join(evidence, 'live-state.json'), JSON.stringify({ stage: 'inspect-edited', candidate: app, pid: running.child.pid, acknowledgement }, null, 2), { mode: 0o600 });
  console.log(`NATIVE_BOOKMARK_INSPECTION_READY ${acknowledgement}`);
  await eventually(async () => { try { await access(acknowledgement); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }, 'Live inspection was not acknowledged.', 10 * 60_000);
 }
 stage = 'restart-edited'; await stop(); await start();
 let restored = (await state()).bookmarks.find(item => item.id === seeded.id);
 assert(restored && restored.title === 'Edited native bookmark' && restored.displayMode === 'icon' && restored.folderId === folder.id);
 assert((await state()).bookmarkFolders.some(item => item.id === folder.id && item.name === 'Renamed research'));
 assert.equal(flatten(await nativeTree()).find(item => item.id === nativeBefore.id)?.title, '');
 phase('bookmark-identity-folder-and-display-mode-survive-app-restart');
 stage = 'remove-folder-keep-bookmark'; await openLibrary();
 folderRow = library.locator('.bookmark-library-folders li').filter({ hasText: 'Renamed research' });
 await folderRow.getByRole('button', { name: 'Delete', exact: true }).click();
 await folderRow.getByText('Move pages to bar?', { exact: true }).waitFor();
 await folderRow.getByRole('button', { name: 'Delete', exact: true }).click();
 await waitState(value => !value.bookmarkFolders.some(item => item.id === folder.id) && value.bookmarks.some(item => item.id === seeded.id && !item.folderId), 'Folder removal must preserve its bookmark.');
 tree = flatten(await nativeTree()); assert(!tree.some(item => item.id === nativeFolder.id));
 nativeBookmark = tree.find(item => item.id === nativeBefore.id); assert(nativeBookmark && nativeBookmark.url === pageUrl);
 await library.getByText('Edited native bookmark', { exact: true }).waitFor();
 await library.screenshot({ path: join(evidence, 'native-folder-removed-bookmark-kept.png') });
 phase('actual-folder-removal-preserves-native-bookmark');
 stage = 'stale-refusal';
 assert.equal((await request({ type: 'browser-rename-bookmark-folder', folderId: folder.id, name: 'Do not recreate' })).ok, false);
 assert(!flatten(await nativeTree()).some(item => item.title === 'Do not recreate'));
 phase('stale-folder-does-not-recreate-or-modify-data');
 stage = 'final-restart'; await stop(); await start();
 restored = (await state()).bookmarks.find(item => item.id === seeded.id);
 assert(restored && !restored.folderId && restored.displayMode === 'icon');
 assert.equal(flatten(await nativeTree()).find(item => item.id === nativeBefore.id)?.url, pageUrl);
 await stop();
 const file = JSON.parse(await readFile(join(profile, 'Default/Bookmarks'), 'utf8'));
 const persisted = flatten(Object.values(file.roots)).find(item => item.url === pageUrl);
 assert.equal(persisted?.name, ''); assert.equal(persisted.id, nativeBefore.id);
 phase('Chromium-bookmarks-file-confirms-final-data-after-clean-exit'); receipt.result = 'passed';
} catch (error) {
 receipt.result = 'failed'; receipt.failedStage = stage; receipt.error = String(error?.message || error).slice(0, 500); process.exitCode = 1;
 await library?.screenshot({ path: join(evidence, 'failed-saved-pages.png') }).catch(() => {});
 console.error(`Native bookmark canary failed at ${stage}: ${receipt.error}`);
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
