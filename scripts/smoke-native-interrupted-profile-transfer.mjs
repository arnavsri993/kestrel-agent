import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { tsImport } from 'tsx/esm/api';
import { candidateDigest } from './native-retirement-evidence.mjs';
import { markDisposableNativeTestProfile } from './native-test-profile.mjs';

// Operator drives the actual native menu and dialogs using the desktop UI.
// Acknowledgement files only mark that a visible step has been performed;
// each following assertion independently verifies the resulting files/IPC.
assert(process.env.KESTREL_NATIVE_TEST_APP, 'Set the exact disposable native candidate.');
const app = await realpath(resolve(process.env.KESTREL_NATIVE_TEST_APP));
assert(app.endsWith('.app') && !app.startsWith('/Applications/'), 'Use a disposable candidate.');
const executable = await realpath(join(app, 'Contents/MacOS/Kestrel'));
async function assertCandidateStopped() {
 for (const row of execFileSync('/bin/ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' }).split('\n')) {
  const match = row.trim().match(/^(\d+)\s+(.+)$/);
  if (match?.[2].endsWith('/Contents/MacOS/Kestrel')) assert.notEqual(await realpath(match[2]).catch(() => ''), executable, 'Candidate already running.');
 }
}
await assertCandidateStopped();
const evidence = resolve(process.env.KESTREL_NATIVE_INTERRUPTED_TRANSFER_EVIDENCE || `.tmp/native-interrupted-transfer-${Date.now()}`);
await mkdir(evidence, { recursive: true, mode: 0o700 }); assert.equal((await readdir(evidence)).length, 0, 'Use an empty evidence directory.');
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'kestrel-interrupted-transfer-')));
const profile = join(temporary, 'browser'), source = join(temporary, 'source');
await mkdir(profile, { mode: 0o700 }); await markDisposableNativeTestProfile(profile);
await mkdir(source, { mode: 0o700 }); await mkdir(join(source, 'secure'), { mode: 0o700 });
await writeFile(join(source, '.kestrel-native-transfer-source-test-v1'), 'kestrel-transfer-source-test-v1\n', { mode: 0o600 });
const sourceKey = randomBytes(32), sourceKeyPath = join(source, 'secure/database-key.bin');
await writeFile(sourceKeyPath, Buffer.from(`kestrel-plaintext-v1\n${sourceKey.toString('base64')}`), { mode: 0o600 });
const sourceDatabase = join(source, 'database/kestrel.sqlite');
const { KestrelDatabase } = await tsImport('../packages/database/src/index.ts', import.meta.url);
const { writeCoreTransferCrashPreload, launchCoreTransferFixture } = await tsImport('./native-core-transfer-crash-fixture.ts', import.meta.url);
const receipt = { version: 1, startedAt: new Date().toISOString(), candidate: app, candidateSha256: await candidateDigest(app),
 scope: 'Generated profiles, generated keys, loopback CDP and actual native menu/dialogs. No real Keychain, user profile, Messages, microphone or privacy settings.', phases: [] };
const clients = []; let running, browser, interrupted = false, stage = 'prepare', stopped = true;
const fixtureKeys = [];
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = true; if (running?.child.exitCode === null) running.child.kill('SIGTERM'); });
const phase = name => { receipt.phases.push({ phase: name, passed: true }); console.log(`PASS ${name}`); };
async function eventually(fn, message, timeout = 30000) {
 const end = Date.now() + timeout;
 while (Date.now() < end) { if (interrupted) throw Error('Interrupted.'); if (await fn()) return; await delay(100); }
 throw Error(message);
}
async function selection() {
 try { return JSON.parse(await readFile(join(profile, 'native-core-profile.json'), 'utf8')); }
 catch (error) { if (error.code === 'ENOENT') return { active: '', previous: '' }; throw error; }
}
function assertPreparedHandoffRegistered(actual, before, relative) {
 assert.equal(actual.version, 2, 'Review must persist the v2 handoff registry.');
 assert.equal(actual.active, before.active, 'Review must preserve the active profile.');
 assert.equal(actual.previous, before.previous, 'Review must preserve the previous profile.');
 const handoffs = actual.handoffs;
 assert(handoffs && typeof handoffs === 'object' && !Array.isArray(handoffs), 'Review must persist a handoff map.');
 const legacyKeys = [...new Set(['', before.active, before.previous])];
 assert.deepEqual(Object.keys(handoffs).sort(), [...legacyKeys, relative].sort(), 'Registration must add only the selected prepared profile.');
 for (const key of legacyKeys) assert.equal(handoffs[key], null, `Legacy selection ${key || '(current profile)'} must remain unregistered.`);
 assert.match(handoffs[relative], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'Prepared profile must receive a canonical lowercase UUIDv4.');
 return actual;
}
async function hashFile(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
async function treeDigest(root) {
 const rows = [];
 async function visit(path, relative) {
  const info = await lstat(path); assert(info.uid === process.getuid() && !info.isSymbolicLink());
  if (info.isDirectory()) { rows.push([relative, 'dir', info.mode & 0o777]); for (const name of (await readdir(path)).sort()) await visit(join(path, name), `${relative}/${name}`); }
  else { assert(info.isFile()); rows.push([relative, 'file', info.mode & 0o777, info.nlink, info.size, await hashFile(path)]); }
 }
 await visit(root, '.'); return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
async function exists(path) { try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function start() {
 await assertCandidateStopped(); const state = { output: '' };
 state.child = spawn(executable, ['--kestrel-chromium-desktop', '--kestrel-cache-path', profile, '--kestrel-durable-profile', '--kestrel-test-profile-key', '--remote-debugging-port=0'], { stdio: ['ignore', 'pipe', 'pipe'] });
 stopped = false; running = state;
 state.exited = new Promise(resolveExit => state.child.once('exit', (code, signal) => resolveExit({ code, signal })));
 for (const stream of [state.child.stdout, state.child.stderr]) stream.on('data', bytes => { state.output = (state.output + bytes).slice(-300000); });
 let endpoint;
 await eventually(() => { if (state.child.exitCode !== null || state.child.signalCode !== null) throw Error('Owned app exited.'); endpoint = state.output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+)/)?.[1]; return endpoint; }, 'Owned native endpoint missing.');
 browser = await chromium.connectOverCDP(endpoint, { noDefaults: true }); let home;
 await eventually(async () => {
  home = browser.contexts().flatMap(context => context.pages()).find(page => /chrome-extension:\/\/[^/]+\/index.html$/.test(page.url()));
  if (home) return true;
  const session = await browser.newBrowserCDPSession(); const targets = await session.send('Target.getTargets'); await session.detach();
  if (targets.targetInfos.some(target => /chrome-extension:\/\/[^/]+\/index.html$/.test(target.url))) { await browser.close(); browser = await chromium.connectOverCDP(endpoint, { noDefaults: true }); }
  return false;
 }, 'Owned native Home missing.');
 await home.waitForFunction(() => typeof window.kestrel?.request === 'function');
 await home.evaluate(() => { localStorage.setItem('kestrel:onboarded', 'yes'); localStorage.setItem('kestrel:default-browser-prompted', 'yes'); });
 await home.reload(); await home.locator('.kestrel-sidebar').waitFor();
 return { state, home };
}
async function stop() {
 if (!running) return;
 const current = running; running = undefined;
 if (current.child.exitCode === null && current.child.signalCode === null) current.child.kill('SIGTERM');
 const result = await Promise.race([current.exited, delay(15000, undefined, { ref: false }).then(() => { current.child.kill('SIGKILL'); throw Error('Owned app shutdown unconfirmed.'); })]);
 stopped = true; assert.deepEqual(result, { code: 0, signal: null });
 await browser?.close().catch(() => {}); browser = undefined;
}
async function waitOperator(name, instruction) {
 const acknowledgement = join(evidence, `continue-${name}`);
 await writeFile(join(evidence, 'live-state.json'), JSON.stringify({ stage: name, instruction, acknowledgement, candidate: app, pid: running?.child.pid, source, browserProfile: profile }, null, 2), { mode: 0o600 });
 console.log(`NATIVE_INTERRUPTED_TRANSFER_${name.toUpperCase().replaceAll('-', '_')} ${instruction}; acknowledge ${acknowledgement}`);
 await eventually(() => exists(acknowledgement), `Operator did not acknowledge ${name}.`, 10 * 60_000);
}
try {
 const time = new Date().toISOString(), sourceSessionId = randomUUID();
 const sourceDb = new KestrelDatabase(sourceDatabase, sourceKey);
 try {
  sourceDb.saveRuntimeSession({ id: sourceSessionId, title: 'Generated recovered conversation', kind: 'conversation', allowedTools: [], status: 'active', checkpoints: [], createdAt: time, updatedAt: time });
  sourceDb.saveRuntimeMessage({ id: randomUUID(), sessionId: sourceSessionId, role: 'user', content: 'Generated interrupted transfer recovery proof.', createdAt: time });
 } finally { sourceDb.close(); }
 const sourceDigest = await treeDigest(source);
 const first = await start();
 const created = await first.home.evaluate(() => window.kestrel.request({ type: 'runtime-create-session', title: 'Generated original conversation', kind: 'conversation' }));
 assert(created.ok && created.session?.id); const originalId = created.session.id;
 await stop(); await assertCandidateStopped();
 phase('original-native-profile-seeded-and-stopped');
 stage = 'stage-interrupted-transfer';
 const parent = join(profile, 'native-core-profiles'); await mkdir(parent, { mode: 0o700 });
 const relative = `native-core-profiles/${randomUUID()}`, destinationRoot = join(profile, relative);
 await mkdir(destinationRoot, { mode: 0o700 }); await markDisposableNativeTestProfile(destinationRoot);
 const destinationKeyPath = join(destinationRoot, '.kestrel-native-test-core-key-v1');
 const destinationKey = await readFile(destinationKeyPath); fixtureKeys.push(destinationKey); assert.equal(destinationKey.length, 32);
 const destinationKeyHash = await hashFile(destinationKeyPath);
 const database = join(destinationRoot, 'native-core/database/kestrel.sqlite'); await mkdir(dirname(database), { recursive: true, mode: 0o700 });
 const orphan = join(parent, randomUUID()); await mkdir(orphan, { mode: 0o700 }); await writeFile(join(orphan, 'unknown-evidence'), 'generated unknown orphan\n', { mode: 0o600 });
 const orphanDigest = await treeDigest(orphan);
 const preload = join(temporary, 'crash-before-link.mjs'); await writeCoreTransferCrashPreload(preload, database, 'before-link');
 const workerOptions = { executable: join(app, 'Contents/Resources/agent-core/node/bin/node'), entry: join(app, 'Contents/Resources/agent-core/service/host-profile-file-transfer.js'), home: temporary };
 const owner = launchCoreTransferFixture({ ...workerOptions, preload }); clients.push(owner);
 const planned = await owner.request('plan', { sourceDatabasePath: sourceDatabase, destinationDatabasePath: database, sourceKeyBase64: sourceKey.toString('base64') }); assert.equal(planned.ok, true);
 owner.send('apply', { planId: planned.planId, acceptedPlanSha256: planned.preview.planSha256, approved: true, destinationKeyBase64: destinationKey.toString('base64') });
 assert.deepEqual(await owner.exited, { code: null, signal: 'SIGKILL' }); assert.equal(owner.errors(), '');
 const inspector = launchCoreTransferFixture(workerOptions); clients.push(inspector);
 const reviewed = await inspector.request('inspect-interrupted', { destinationDatabasePath: database }); assert.equal(reviewed.ok, true); assert.equal(reviewed.preview.state, 'staged');
 assert.deepEqual(await inspector.stop(), { code: 0, signal: null });
 assert.equal(await hashFile(destinationKeyPath), destinationKeyHash); assert.equal(await treeDigest(source), sourceDigest);
 assert.equal(await treeDigest(orphan), orphanDigest); assert.equal(await exists(join(orphan, '.kestrel-native-test-core-key-v1')), false);
 phase('actual-bundled-worker-crash-created-reviewable-unselected-stage');
 stage = 'native-review';
 const second = await start(); const initialSelection = await selection(); assert.notEqual(initialSelection.active, relative);
 await waitOperator('review', 'Open Review Interrupted Transfers and display the generated staged transfer review; do not accept it yet.');
 assert(second.state.output.includes('KESTREL_NATIVE_INTERRUPTED_TRANSFER_REVIEW_READY'), 'Native reviewed transfer dialog was not confirmed.');
 const registeredSelection = assertPreparedHandoffRegistered(await selection(), initialSelection, relative);
 assert(await exists(`${database}.kestrel-transfer-journal`));
 assert.equal(await hashFile(destinationKeyPath), destinationKeyHash); assert.equal(await treeDigest(orphan), orphanDigest);
 phase('real-native-review-registers-unselected-prepared-handoff-without-changing-profile-selection');
 stage = 'native-recover';
 await waitOperator('recover', 'Confirm the source is closed, review and accept the separate project-link counts dialog, then stop at Use Recovered Data Profile without selecting it.');
 for (const marker of ['KESTREL_NATIVE_INTERRUPTED_TRANSFER_WORKER_STOPPED', 'KESTREL_NATIVE_INTERRUPTED_TRANSFER_RECOVERED', 'KESTREL_NATIVE_INTERRUPTED_TRANSFER_SELECTION_READY'])
  assert(second.state.output.includes(marker), `Native recovery did not confirm ${marker}.`);
 assert.deepEqual(await selection(), registeredSelection, 'Recovery alone must not activate the profile or change registered handoffs.');
 assert.equal(await exists(`${database}.kestrel-transfer-journal`), true, 'The published recovery journal must remain available for review.');
 const journalHash = await hashFile(`${database}.kestrel-transfer-journal`);
 assert(await exists(database)); assert.equal(await hashFile(destinationKeyPath), destinationKeyHash);
 // The recovery controller must have reaped its actual bundled transfer worker
 // before offering profile activation. Inspect only this candidate's worker.
 await eventually(() => !execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').some(row => row.includes(workerOptions.executable) && row.includes(workerOptions.entry)), 'Native recovery worker did not stop.');
 assert.equal(await treeDigest(source), sourceDigest); assert.equal(await treeDigest(orphan), orphanDigest);
 phase('native-recovery-preserves-selection-source-and-destination-key');
 stage = 'keep-current';
 await waitOperator('keep-current', 'Choose Keep Current Profile at the recovered transfer choice, then dismiss any notice.');
 assert.deepEqual(await selection(), registeredSelection, 'Keep Current Profile must not change the selection.');
 assert.equal(await hashFile(`${database}.kestrel-transfer-journal`), journalHash);
 assert.equal(await hashFile(destinationKeyPath), destinationKeyHash); assert.equal(await treeDigest(source), sourceDigest); assert.equal(await treeDigest(orphan), orphanDigest);
 await stop();
 stage = 'restart-keep-current';
 const afterKeep = await start();
 assert.deepEqual(await selection(), registeredSelection);
 const currentSessions = await afterKeep.home.evaluate(() => window.kestrel.request({ type: 'runtime-list-sessions' }));
 assert(currentSessions.ok && currentSessions.sessions.some(item => item.id === originalId) && !currentSessions.sessions.some(item => item.id === sourceSessionId));
 const expandOriginal = afterKeep.home.getByRole('button', { name: 'Expand sidebar', exact: true });
 if (await expandOriginal.isVisible()) await expandOriginal.click();
 await afterKeep.home.locator('.kestrel-sidebar').getByText('Generated original conversation', { exact: true }).first().click();
 await afterKeep.home.screenshot({ path: join(evidence, 'kept-current-conversation.png') });
 assert.equal(await hashFile(`${database}.kestrel-transfer-journal`), journalHash);
 assert.equal(await hashFile(destinationKeyPath), destinationKeyHash); assert.equal(await treeDigest(source), sourceDigest); assert.equal(await treeDigest(orphan), orphanDigest);
 phase('keep-current-survives-restart-with-published-review-preserved');
 stage = 'review-published';
 await waitOperator('review-published', 'Open Review Interrupted Transfers again and display the published transfer review; do not accept it yet.');
 assert(afterKeep.state.output.includes('KESTREL_NATIVE_INTERRUPTED_TRANSFER_REVIEW_READY'), 'Published transfer review was not confirmed after restart.');
 assert.deepEqual(await selection(), registeredSelection); assert.equal(await hashFile(`${database}.kestrel-transfer-journal`), journalHash);
 assert.equal(await hashFile(destinationKeyPath), destinationKeyHash); assert.equal(await treeDigest(source), sourceDigest); assert.equal(await treeDigest(orphan), orphanDigest);
 phase('published-transfer-rediscovered-after-restart');
 stage = 'recover-published';
 await waitOperator('recover-published', 'Confirm the source is closed, review and accept the separate project-link counts dialog, then stop at Use Recovered Data Profile.');
 for (const marker of ['KESTREL_NATIVE_INTERRUPTED_TRANSFER_WORKER_STOPPED', 'KESTREL_NATIVE_INTERRUPTED_TRANSFER_RECOVERED', 'KESTREL_NATIVE_INTERRUPTED_TRANSFER_SELECTION_READY'])
  assert(afterKeep.state.output.includes(marker), `Published recovery did not confirm ${marker}.`);
 assert.deepEqual(await selection(), registeredSelection);
 assert.equal(await hashFile(`${database}.kestrel-transfer-journal`), journalHash);
 assert.equal(await hashFile(destinationKeyPath), destinationKeyHash); assert.equal(await treeDigest(source), sourceDigest); assert.equal(await treeDigest(orphan), orphanDigest);
 await eventually(() => !execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').some(row => row.includes(workerOptions.executable) && row.includes(workerOptions.entry)), 'Published recovery worker did not stop.');
 phase('published-transfer-reverified-before-activation');
 stage = 'explicit-activation';
 await waitOperator('activate', 'Choose Use Recovered Data Profile, then dismiss the restart notice.');
 assert(afterKeep.state.output.includes('KESTREL_NATIVE_INTERRUPTED_TRANSFER_SELECTED'), 'Explicit native selection was not confirmed.');
 const activated = await selection(); assert.equal(activated.active, relative); assert.equal(activated.previous, initialSelection.active);
 assert.deepEqual(activated.handoffs, registeredSelection.handoffs, 'Activation must preserve the registered handoff map.');
 assert.equal(await hashFile(destinationKeyPath), destinationKeyHash); phase('separate-native-acceptance-selects-recovered-profile');
 await stop(); stage = 'restart-recovered'; const third = await start();
 const sessions = await third.home.evaluate(() => window.kestrel.request({ type: 'runtime-list-sessions' }));
 assert(sessions.ok && sessions.sessions.some(item => item.id === sourceSessionId) && !sessions.sessions.some(item => item.id === originalId));
 await third.home.locator('.kestrel-sidebar').getByText('Generated recovered conversation', { exact: true }).first().click();
 await third.home.getByText('Generated interrupted transfer recovery proof.', { exact: true }).waitFor();
 await third.home.screenshot({ path: join(evidence, 'recovered-conversation.png') });
 phase('recovered-conversation-visible-after-app-restart');
 stage = 'rollback';
 await waitOperator('rollback', 'Use the native previous data profile action, confirm it, and dismiss the restart notice.');
 assert(third.state.output.includes('KESTREL_NATIVE_CORE_PREVIOUS_SELECTED'), 'Previous profile selection was not confirmed.');
 const rolledBack = await selection(); assert.equal(rolledBack.active, initialSelection.active); assert.equal(rolledBack.previous, relative);
 assert.deepEqual(rolledBack.handoffs, registeredSelection.handoffs, 'Rollback must preserve the registered handoff map.');
 await stop(); const fourth = await start();
 const restored = await fourth.home.evaluate(() => window.kestrel.request({ type: 'runtime-list-sessions' }));
 assert(restored.ok && restored.sessions.some(item => item.id === originalId) && !restored.sessions.some(item => item.id === sourceSessionId));
 phase('previous-native-profile-restored-after-second-restart');
 await stop(); assert.equal(await hashFile(destinationKeyPath), destinationKeyHash); assert.equal(await treeDigest(source), sourceDigest);
 assert.equal(await treeDigest(orphan), orphanDigest); assert.equal(await exists(join(orphan, '.kestrel-native-test-core-key-v1')), false);
 phase('source-key-and-unknown-orphan-preserved'); receipt.result = 'passed';
} catch (error) {
 receipt.result = 'failed'; receipt.failedStage = stage; receipt.error = interrupted ? 'Canary interrupted.' : String(error?.message || error).slice(0, 500);
 console.error(`Native interrupted transfer canary failed at ${stage}: ${receipt.error}`); process.exitCode = 1;
} finally {
 await stop().catch(() => { receipt.result = 'failed'; receipt.shutdownUnconfirmed = true; process.exitCode = 1; });
 for (const client of clients) { if (client.child.exitCode === null && client.child.signalCode === null) client.child.kill('SIGKILL'); await client.exited.catch(() => {}); }
 for (const key of fixtureKeys) key.fill(0); sourceKey.fill(0);
 receipt.candidateSha256After = await candidateDigest(app);
 if (receipt.candidateSha256After !== receipt.candidateSha256) { receipt.result = 'failed'; process.exitCode = 1; }
 receipt.finishedAt = new Date().toISOString();
 // Retain failed fixtures for diagnosis; successful runs clean only after owned exit.
 if (stopped && receipt.result === 'passed') { await rm(temporary, { recursive: true, force: true }); receipt.generatedProfileRemoved = true; }
 else { receipt.generatedProfileRemoved = false; receipt.retainedFixture = temporary; }
 await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
}
