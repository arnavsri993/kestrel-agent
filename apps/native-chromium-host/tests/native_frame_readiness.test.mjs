import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const renderer = readFileSync(new URL('../../desktop/src/renderer/NativeChromiumFrameApp.tsx', import.meta.url), 'utf8');
const effectStart = renderer.indexOf('\tuseEffect(() => {');
const effectEnd = renderer.indexOf('\n\t}, []);', effectStart);
assert(effectStart >= 0 && effectEnd > effectStart, 'frame readiness effect must be present');
const effect = renderer.slice(effectStart + '\tuseEffect(() => {'.length, effectEnd);
const patch = readFileSync(new URL('../cef-patches/chromium-kestrel-vault.patch', import.meta.url), 'utf8');
const preparer = readFileSync(new URL('../../../scripts/prepare-native-vault-cef.mjs', import.meta.url), 'utf8');

function fixture() {
 let now = 1000, controls = false, resolveRequest, rejectRequest, tick, pagehide;
 const dataset = {};
 const document = { documentElement: { dataset }, querySelector: () => controls ? {} : null };
 const window = {
  kestrel: { request: () => new Promise((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; }) },
  setInterval: callback => { tick = callback; return 1; }, clearInterval: () => { tick = undefined; },
  addEventListener: (name, callback) => { if (name === 'pagehide') pagehide = callback; },
  removeEventListener: () => { pagehide = undefined; },
 };
 const stop = runInNewContext(`(function () {${effect}\n})`, { window, document, Date: { now: () => now } })();
 return { dataset, stop, tick: () => tick?.(), hide: () => pagehide?.(),
  setControls: value => { controls = value; }, setTime: value => { now = value; },
  resolve: value => resolveRequest(value), reject: error => rejectRequest(error) };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('frame readiness requires both a live bridge reply and rendered controls', async () => {
 const f = fixture();
 assert.equal(f.dataset.kestrelFrameReady, undefined);
 f.resolve({ ok: true, browserState: {} }); await flush();
 assert.equal(f.dataset.kestrelFrameReady, undefined);
 f.setControls(true); f.tick(); f.resolve({ ok: true, browserState: {} }); await flush();
 assert.equal(f.dataset.kestrelFrameReady, '1000');
 f.setTime(5000); f.tick(); f.resolve({ ok: true, browserState: {} }); await flush();
 assert.equal(f.dataset.kestrelFrameReady, '5000');
 f.tick(); f.resolve({ ok: false }); await flush();
 assert.equal(f.dataset.kestrelFrameReady, undefined);
 f.stop();
});

test('frame readiness clears on bridge errors and cannot revive after pagehide', async () => {
 const f = fixture(); f.setControls(true); f.resolve({ ok: true, browserState: {} }); await flush();
 assert.equal(f.dataset.kestrelFrameReady, '1000');
 f.tick(); f.reject(Error('connection closed')); await flush();
 assert.equal(f.dataset.kestrelFrameReady, undefined);
 f.tick(); f.hide(); f.resolve({ ok: true, browserState: {} }); await flush();
 assert.equal(f.dataset.kestrelFrameReady, undefined);
 f.stop();
});

test('Chromium patch checks the trusted frame lease and recovers stock controls on loss', () => {
 assert.match(patch, /if \(kestrel_frame_ready_\) \{[\s\S]*?top_container_->SetVisible\(false\)/);
 assert.match(patch, /SetVisible\(kestrel_top_was_visible_\)/);
 assert.match(patch, /SetVisible\(kestrel_horizontal_was_visible_\)/);
 assert.match(patch, /SetVisible\(kestrel_vertical_was_visible_\)/);
 assert.match(patch, /GetLastCommittedURL\(\) != expected/);
 assert.match(patch, /extension->path\(\) != extension_path/);
 assert(patch.indexOf('if (!kestrel_frame_extension_observer_)') < patch.indexOf('registry->enabled_extensions().GetByID(extension_id)'), 'unload must be observed even when the extension was already loaded');
 assert.match(patch, /ExecuteJavaScriptInIsolatedWorld\([\s\S]*?ISOLATED_WORLD_ID_CHROME_INTERNAL/);
 assert.match(patch, /Date\.now\(\)-t<15000/);
 assert.match(patch, /kestrel_frame_probe_deadline_ = base::TimeTicks::Now\(\) \+ base::Seconds\(3\)/);
 assert.match(patch, /if \(base::TimeTicks::Now\(\) < kestrel_frame_probe_deadline_\) return;\n\+    InvalidateKestrelBrowserFrame\(\)/);
 assert.match(patch, /generation != kestrel_frame_probe_generation_/);
 for (const event of ['DidStartNavigation', 'DidFailLoad', 'PrimaryMainFrameRenderProcessGone', 'WebContentsDestroyed']) {
  assert.match(patch, new RegExp(`${event}[\\s\\S]{0,300}?invalidate_\\.Run\\(\\)`));
 }
 assert.match(patch, /void BrowserView::DestroyKestrelBrowserFrame\(\) \{\n\+  kestrel_frame_timer_\.Stop\(\);\n\+  InvalidateKestrelBrowserFrame\(\);/);
});

test('Chromium patch insertion offsets account for prior hunks', () => {
 let delta = 0;
 for (const line of patch.split('\n')) {
  if (line.startsWith('diff --git ')) delta = 0;
  const match = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(line);
  if (!match) continue;
  const [, oldStart, oldCount, newStart, newCount] = match.map(Number);
  assert.equal(newStart, oldStart + delta + (oldCount === 0 ? 1 : 0));
  delta += newCount - oldCount;
 }
});

test('the CEF frame patch uses context anchors on apply and rollback', () => {
 assert.doesNotMatch(preparer, /--unidiff-zero/);
 assert.match(preparer, /run\('git', \['apply', '--check'/);
 assert.match(patch, /@@ -4987,2 \+5113,3 @@ void BrowserView::AddedToWidget\(\) \{\n   if \(initialized_\) \{\n\+    MaybeCreateKestrelBrowserFrame\(\);\n     return;/);
 assert.match(patch, /@@ -5179,2 \+5306,165 @@ void BrowserView::AddedToWidget\(\) \{\n   initialized_ = true;\n\+  MaybeCreateKestrelBrowserFrame\(\);\n\+\}/);
 assert.match(patch, /\n void BrowserView::RemovedFromWidget\(\) \{\n\+  DestroyKestrelBrowserFrame\(\);\n   CHECK\(GetFocusManager\(\)\);/);
 let file = '';
 for (const line of patch.split('\n')) {
  if (line.startsWith('diff --git ')) file = line;
  const hunk = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(line);
  if (!hunk || Number(hunk[2]) !== 0) continue;
  assert.match(file, /kestrel_vault_key_provider\.(cc|h) /, 'only new source files may use zero-context creation hunks');
 }
});
