import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { markDisposableNativeTestProfile } from '../../../scripts/native-test-profile.mjs';

const candidate = process.env.KESTREL_FIRST_WINDOW_TEST_APP;

test('a directly launched candidate presents its first native window', { skip: !candidate, timeout: 45_000 }, async () => {
 const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
 const allowed = await realpath(join(root, '.tmp'));
 const app = await realpath(candidate);
 assert(app.startsWith(`${allowed}${sep}`) && app.endsWith(`${sep}Kestrel.app`), 'use a disposable .tmp candidate');
 const profile = await mkdtemp(join(tmpdir(), 'kestrel-first-window-'));
 const productionVault = process.env.KESTREL_FIRST_WINDOW_PRODUCTION_VAULT === '1';
 if (!productionVault) await markDisposableNativeTestProfile(profile);
 const child = spawn(join(app, 'Contents/MacOS/Kestrel'), [
  '--kestrel-chromium-desktop', '--kestrel-cache-path', profile,
  '--kestrel-durable-profile', ...(productionVault ? [] : ['--kestrel-test-profile-key']),
 ], { stdio: ['ignore', 'pipe', 'pipe'] });
 let output = '';
 for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-32768); });
 const exited = new Promise(resolveExit => child.once('exit', resolveExit));
 try {
  const deadline = Date.now() + 20_000;
  while (!output.includes('KESTREL_CHROMIUM_WINDOW_PRESENTED visible=1 key=1 active=1') &&
         child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
   await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  assert.match(output, /KESTREL_CHROMIUM_WINDOW_PRESENTED visible=1 key=1 active=1/, 'AppKit must report a visible, key window in the active app');
 } finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const stopped = await Promise.race([exited.then(() => true), new Promise(resolveDelay => setTimeout(() => resolveDelay(false), 10_000).unref())]);
  if (!stopped) { child.kill('SIGKILL'); await exited; }
  await rm(profile, { recursive: true, force: true });
 }
});
