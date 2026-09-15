import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron, expect } from '@playwright/test';
const root = mkdtempSync(join(tmpdir(), 'kestrel-tab-activity-'));
const artifacts = resolve('artifacts/tab-activity'); mkdirSync(artifacts, { recursive: true });
const executable = process.env.KESTREL_DESKTOP_EXECUTABLE;
let app;
try {
 app = await electron.launch({ executablePath: executable || createRequire(resolve('apps/desktop/package.json'))('electron'), args: executable ? ['--use-mock-keychain'] : [resolve('apps/desktop'), '--use-mock-keychain'], env: { ...process.env, KESTREL_TEST_USER_DATA: root, KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: '1', KESTREL_DISABLE_UPDATES: '1', KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: '1', KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: '1' } });
 const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded'); await page.waitForFunction(() => Boolean(window.kestrel));
 await page.evaluate(() => { localStorage.setItem('kestrel:onboarded','yes'); localStorage.setItem('kestrel:default-browser-prompted','yes'); }); await page.reload();
 const request = input => page.evaluate(input => window.kestrel.request(input), input);
 await app.evaluate(async ({ session }) => {
  await session.fromPartition('persist:kestrel-user-browser-v1').protocol.handle('https', request => {
   if (new URL(request.url).pathname === '/pending') return new Promise(() => {});
   return new Response('<!doctype html><title>Activity fixture</title><style>body{background:#254753;color:white;font:24px system-ui;padding:40px}video{width:420px;display:block}input{margin-top:20px;padding:10px}</style><h1>Project workspace</h1><p>Keep this task running while browsing.</p><video muted autoplay></video><form><input placeholder="Draft notes"></form>', { headers: { 'content-type': 'text/html' } });
  });
 });
 const created = await request({type:'browser-create-tab',input:'https://activity.example.test/',active:true}); const tabId = created.browserState.activeTabId;
 let remote; await expect.poll(() => { remote = app.context().pages().find(p => p.url() === 'https://activity.example.test/'); return Boolean(remote); }).toBe(true);
 const state = async () => (await request({type:'browser-get-state'})).browserState;
 // Playwright attaches a capture consumer to inspected WebContents. Isolate
 // that harness-only signal; production capture protection remains enabled.
 await app.evaluate(({webContents}) => { for (const wc of webContents.getAllWebContents()) if(wc.getURL()==='https://activity.example.test/') wc.isBeingCaptured=()=>false; });
 await remote.evaluate(() => { const canvas=document.createElement('canvas'); canvas.width=400;canvas.height=220; const ctx=canvas.getContext('2d'); ctx.fillStyle='#509476';ctx.fillRect(0,0,400,220); const stream=canvas.captureStream(12); window.fixtureStream=stream; document.querySelector('video').srcObject=stream; document.querySelector('video').play(); });
 await expect.poll(async () => (await state()).tabs.find(t => t.id === tabId)?.activity?.playing).toBe(true);
 const second = await request({type:'browser-create-tab',input:'https://idle.example.test/',active:true});
 await expect.poll(async () => Boolean((await state()).tabs.find(t => t.id === tabId)?.preview?.image)).toBe(true);
 await request({type:'browser-sleep-tab',tabId}); assert.equal((await state()).tabs.find(t => t.id === tabId).discarded,false);
 await remote.evaluate(() => { document.querySelector('video').pause(); window.fixtureStream.getTracks().forEach(t => t.stop()); });
 await expect.poll(async () => Boolean((await state()).tabs.find(t => t.id === tabId)?.activity?.playing)).toBe(false);
 await remote.evaluate(() => { window.pendingRequest = new AbortController(); fetch('/pending', {signal:window.pendingRequest.signal}).catch(()=>{}); });
 await expect.poll(async () => (await state()).tabs.find(t => t.id === tabId)?.activity?.busy).toBe(true);
 await request({type:'browser-sleep-inactive-tabs'}); assert.equal((await state()).tabs.find(t => t.id === tabId).discarded,false);
 await remote.evaluate(() => window.pendingRequest.abort());
 await expect.poll(async () => Boolean((await state()).tabs.find(t => t.id === tabId)?.activity?.busy)).toBe(false);
 await remote.locator('input').fill('An unfinished draft');
 await expect.poll(async () => (await state()).tabs.find(t => t.id === tabId)?.activity?.dirty).toBe(true);
 await request({type:'browser-sleep-tab',tabId}); assert.equal((await state()).tabs.find(t => t.id === tabId).discarded,false);
 await remote.evaluate(() => document.querySelector('form').reset());
 await expect.poll(async () => Boolean((await state()).tabs.find(t => t.id === tabId)?.activity?.dirty)).toBe(false);
 await expect.poll(async () => Boolean((await state()).tabs.find(t => t.id === tabId)?.activity?.screen)).toBe(false);
 await request({type:'browser-sleep-tab',tabId}); assert.equal((await state()).tabs.find(t => t.id === tabId).discarded,true);
 await app.evaluate(({BrowserWindow}) => { const owner=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('index.html')); owner.show();owner.focus(); });
 const rect = await page.locator(`[data-tab-id="${tabId}"]`).boundingBox(); assert.ok(rect);
 await page.mouse.move(rect.x + rect.width/2, rect.y + rect.height/2);
 let preview; await expect.poll(() => { preview=app.context().pages().find(p=>p.url().startsWith('data:text/html')); return Boolean(preview); }).toBe(true);
 await expect(preview.locator('img')).toBeVisible();
 await expect(preview.locator('body')).toContainText('Sleeping');
 await expect(preview.locator('[data-label]')).toHaveCount(0);
 await preview.screenshot({path:join(artifacts,'sleeping-preview.png')});
 await page.mouse.move(2,500);
 await expect.poll(() => app.context().pages().filter(p=>p.url().startsWith('data:text/html')).length).toBe(0);
 await request({type:'browser-select-tab',tabId});
 await expect.poll(async () => (await state()).tabs.find(t => t.id === tabId)?.discarded).toBe(false);
 assert.equal((await state()).tabs.find(t=>t.id===tabId).estimatedSavedMemoryBytes,undefined);
 console.log('PASS: real muted playback, abortable background work, unsaved edits, idle sleep/wake, outgoing snapshot, native hover, conditional indicators, and preview dismissal.');
} finally { await app?.close().catch(()=>{}); rmSync(root,{recursive:true,force:true}); }
