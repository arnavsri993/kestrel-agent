import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from '@playwright/test';

// Synthetic browser fixtures only: never enter or record account credentials.
const requests = [];
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  requests.push({ path: req.url, method: req.method, body: Buffer.concat(chunks).toString() });
  if (req.url === '/redirect307' || req.url === '/redirect308') {
    res.writeHead(req.url.endsWith('307') ? 307 : 308, {location: '/callback'}); res.end(); return;
  }
  res.setHeader('Content-Type', 'text/html');
  if (req.url === '/callback') {
    res.end('<title>Callback complete</title><h1>Callback complete</h1>'); return;
  }
  if (req.url === '/popup-callback') {
    res.end(`<title>Popup callback</title><script>window.opener.postMessage('fixture-complete', location.origin); window.close();</script>`); return;
  }
  res.end(`<title>Auth fixture</title><h1>Auth fixture</h1>
    <form method="post" action="/callback"><input name="fixture" value="synthetic"><button>Continue</button></form>
    <script>window.addEventListener('message', e => { if (e.origin === location.origin) window.fixtureResult = e.data; });</script>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const root = mkdtempSync(join(tmpdir(), 'kestrel-auth-links-'));
const requireDesktop = createRequire(resolve('apps/desktop/package.json'));
const packaged = process.env.KESTREL_DESKTOP_EXECUTABLE;
let app;
async function until(fn, label) {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(label);
}
try {
  app = await electron.launch({
    executablePath: packaged || requireDesktop('electron'),
    args: packaged ? ['--use-mock-keychain'] : [resolve('apps/desktop')],
    env: {...process.env, KESTREL_TEST_USER_DATA: root, KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: '1',
      KESTREL_REAL_USER_PROFILE: '1', KESTREL_DISABLE_UPDATES: '1', KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: '1',
      KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: '1'},
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(() => { localStorage.setItem('kestrel:onboarded', 'yes'); localStorage.setItem('kestrel:default-browser-prompted', 'yes'); });
  await page.reload();
  await page.waitForFunction(() => !!window.kestrel);
  const state = async () => (await page.evaluate(() => window.kestrel.request({type: 'browser-get-state'}))).browserState;
  const result = await page.evaluate(input => window.kestrel.request({type: 'browser-create-tab', input, active: true}), `${origin}/one`);
  assert(result.ok);
  const tabId = result.browserState.activeTabId;
  const navigate = async () => {
    await page.evaluate(({tabId,input}) => window.kestrel.request({type:'browser-navigate',tabId,input}), {tabId,input:`${origin}/one`});
    await until(() => app.evaluate(({webContents}, url) => webContents.getAllWebContents().some(w => w.getURL() === url && !w.isLoading()), `${origin}/one`), 'Fixture did not load');
  };
  const run = script => app.evaluate(({webContents}, {url,script}) => {
    const wc = webContents.getAllWebContents().find(w => w.getURL() === url);
    if (!wc) throw new Error('Fixture page missing');
    return wc.executeJavaScript(script, true);
  }, {url:`${origin}/one`,script});
  for (const endpoint of ['/callback','/redirect307','/redirect308']) {
    await navigate(); requests.length = 0;
    await run(`document.querySelector('form').action = ${JSON.stringify(endpoint)}; document.querySelector('form').requestSubmit()`);
    await until(() => requests.some(r => r.path === '/callback'), 'POST callback not received');
    assert.deepEqual(requests.filter(r => r.path === '/callback').map(({method,body}) => ({method,body})), [{method:'POST',body:'fixture=synthetic'}]);
  }
  await navigate();
  await page.evaluate(input => window.kestrel.request({type:'browser-create-tab',input,active:false}), `${origin}/other`);
  const before = (await state()).tabs.length;
  await run(`window.fixturePopup = window.open('about:blank', 'fixture-auth'); window.fixturePopup.location = '/popup-callback';`);
  await until(() => run(`window.fixtureResult === 'fixture-complete'`), 'Popup lost window.opener/postMessage');
  await until(async () => (await state()).tabs.length === before, 'Popup did not close its managed tab');
  assert.equal(await run('window.fixturePopup.closed'), true);
  assert.equal((await state()).activeTabId, tabId, 'Closing sign-in must restore its opener');
  for (const target of ['_blank','fixture-post']) {
    await navigate(); requests.length = 0;
    await run(`document.querySelector('form').target = ${JSON.stringify(target)}; document.querySelector('form').requestSubmit()`);
    await until(() => requests.some(r => r.path === '/callback'), 'Popup POST not received');
    assert.equal(requests.find(r => r.path === '/callback').method, 'POST');
    assert.equal(requests.find(r => r.path === '/callback').body, 'fixture=synthetic');
  }
  await navigate();
  await app.evaluate(({shell}) => {
    globalThis.authFixtureExternalLinks = [];
    shell.openExternal = async url => {globalThis.authFixtureExternalLinks.push(url);};
  });
  for (const url of [
    'zoommtg://zoom.us/join?confno=1234567890&action=join',
    'msteams://teams.microsoft.com/l/meetup-join/19%3afixture/0',
  ]) {
    await run(`window.open(${JSON.stringify(url)}, '_blank')`);
    await until(() => app.evaluate(() => globalThis.authFixtureExternalLinks.length > 0), 'App popup handoff failed');
    assert.deepEqual(await app.evaluate(() => globalThis.authFixtureExternalLinks.splice(0)), [url]);
    await run(`(() => { const frame = document.createElement('iframe'); frame.src = ${JSON.stringify(url)}; document.body.append(frame); })()`);
    await until(() => app.evaluate(() => globalThis.authFixtureExternalLinks.length > 0), 'Iframe app handoff failed');
    assert.deepEqual(await app.evaluate(() => globalThis.authFixtureExternalLinks.splice(0)), [url]);
  }
  console.log('Auth links passed: same-tab POST, 307/308 POST redirects, blank popup navigation, opener callback, popup close, target/named popup POST, and Zoom/Teams popup and iframe handoffs.');
} finally {
  await app?.close(); server.closeAllConnections(); await new Promise(r => server.close(r));
  rmSync(root, {recursive:true,force:true});
}
