import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from '@playwright/test';

// Synthetic browser fixtures only: never enter or record account credentials.
const root = mkdtempSync(join(tmpdir(), 'kestrel-auth-links-'));
const keyPath = join(root, 'fixture-key.pem');
const certPath = join(root, 'fixture-cert.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath,
  '-out', certPath, '-days', '1', '-subj', '/CN=localhost',
  '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], {stdio: 'ignore'});
const cert = readFileSync(certPath);
const requests = [];
const server = createServer({key: readFileSync(keyPath), cert}, async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  requests.push({ path: req.url, method: req.method, body: Buffer.concat(chunks).toString() });
  if (req.url === '/redirect307' || req.url === '/redirect308') {
    res.writeHead(req.url.endsWith('307') ? 307 : 308, {location: '/callback'}); res.end(); return;
  }
  if (req.url?.startsWith('/app-redirect-302?') || req.url?.startsWith('/app-redirect-307?')) {
    const target = new URL(req.url, 'https://fixture.invalid').searchParams.get('target');
    res.writeHead(req.url.startsWith('/app-redirect-307?') ? 307 : 302, {location: target}); res.end(); return;
  }
  res.setHeader('Content-Type', 'text/html');
  if (req.url?.startsWith('/committed-callback?')) {
    const parameters = new URL(req.url, 'https://fixture.invalid').searchParams;
    const target = parameters.get('target');
    const status = parameters.get('status');
    res.end(`<title>Committed callback</title><h1>Committed HTTPS callback</h1><script>
      setTimeout(() => location.href = ${JSON.stringify(`/app-redirect-${status}?target=${encodeURIComponent(target)}`)}, 5_500);
    </script>`); return;
  }
  if (req.url === '/callback') {
    res.end('<title>Callback complete</title><h1>Callback complete</h1>'); return;
  }
  if (req.url === '/popup-callback') {
    res.end(`<title>Popup callback</title><script>window.opener.postMessage('fixture-complete', location.origin); window.close();</script>`); return;
  }
  res.end(`<title>Auth fixture</title><h1>Auth fixture</h1>
    <form method="post" action="/callback"><input name="fixture" value="synthetic"><button>Continue</button></form>
    <button id="handoff" type="button">Open synthetic app link</button>
    <script>
      window.addEventListener('message', e => { if (e.origin === location.origin) window.fixtureResult = e.data; });
      document.querySelector('#handoff').addEventListener('click', event => {
        window.fixtureTrustedClick = event.isTrusted;
        if (window.fixtureMode === 'redirect302') location.href = '/app-redirect-302?target=' + encodeURIComponent(window.fixtureAppUrl);
        else if (window.fixtureMode === 'redirect307') location.href = '/app-redirect-307?target=' + encodeURIComponent(window.fixtureAppUrl);
        else if (window.fixtureMode === 'top') location.href = window.fixtureAppUrl;
        else window.open(window.fixtureAppUrl, '_blank');
      });
    </script>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `https://localhost:${server.address().port}`;
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
  await app.evaluate(({app}, {origin, certPem}) => {
    app.on('certificate-error', (event, _contents, url, _error, certificate, callback) => {
      if (new URL(url).origin === origin && certificate.data.trim() === certPem.trim()) {
        event.preventDefault(); callback(true);
      }
    });
  }, {origin, certPem: cert.toString()});
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
  const nativeClick = async (url) => {
    const fixturePage = app.context().pages().find(candidate => candidate.url() === url);
    if (!fixturePage) throw new Error('Fixture Playwright page missing');
    await fixturePage.locator('#handoff').click();
  };
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
  await app.evaluate(({app, shell, dialog}, fixtureOrigin) => {
    globalThis.authFixtureExternalLinks = [];
    globalThis.authFixtureConsent = [];
    app.getApplicationNameForProtocol = protocol => [
      'cursor://', 'itms-apps://', 'itms-appss://', 'macappstore://',
      'msteams://', 'zoommtg://', 'zoomus://',
    ].includes(protocol) ? 'Synthetic installed handler' : '';
    shell.openExternal = async url => {globalThis.authFixtureExternalLinks.push(url);};
    const original = dialog.showMessageBox.bind(dialog);
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      if (options.type === 'question' &&
          (options.message?.startsWith(`${fixtureOrigin} wants to open `) ||
           options.message?.startsWith('https://teams.microsoft.com wants to open ')) &&
          options.buttons?.[0] === 'Open app' && options.buttons?.[1] === 'Stay here') {
        globalThis.authFixtureConsent.push(options.title);
        return {response: 0, checkboxChecked: false};
      }
      return original(...args);
    };
  }, origin);
  const counts = () => app.evaluate(() => ({
    links: globalThis.authFixtureExternalLinks.length,
    prompts: globalThis.authFixtureConsent.length,
  }));
  for (const url of [
    'zoommtg://zoom.us/join?confno=1234567890&action=join',
    'zoomus://zoom.us/join?confno=1234567890&action=join',
    'msteams://teams.microsoft.com/l/meetup-join/19%3afixture/0',
    'msteams:/meet/12345678901234?p=synthetic%2Bvalue',
    'cursor://cursorAuth?code=synthetic%2Bvalue&state=fixture',
    'cursor://anysphere.cursor-mcp/oauth/callback?code=fixture&state=fixture',
    'itms-appss://apps.apple.com/app/id113517709?mt=12',
    'https://teams.microsoft.com/meet/12345678901234?p=synthetic%2Bvalue&anon=true',
  ]) {
    const expectedUrl = url.startsWith('https://teams.microsoft.com/meet/')
      ? url.replace('https:', 'msteams:')
      : url;
    for (const mode of ['popup', 'top', 'redirect302', 'redirect307']) {
      await navigate();
      await run(`window.fixtureAppUrl = ${JSON.stringify(url)}; window.fixtureMode = ${JSON.stringify(mode)};`);
      if (mode === 'popup') {
        const deniedBefore = await counts();
        await run(`document.querySelector('#handoff').click()`);
        await new Promise(r => setTimeout(r, 250));
        assert.deepEqual(await counts(), deniedBefore, `Scripted popup handoff must be denied for ${url}`);
      }
      const beforeHandoff = await counts();
      const tabsBefore = (await state()).tabs.length;
      await nativeClick(`${origin}/one`);
      await until(async () => (await counts()).links === beforeHandoff.links + 1,
        `Native ${mode} app handoff failed for ${url}`);
      assert.equal(await run('window.fixtureTrustedClick'), true);
      assert.equal((await counts()).prompts, beforeHandoff.prompts + 1);
      assert.deepEqual(await app.evaluate(() => globalThis.authFixtureExternalLinks.splice(0)), [expectedUrl]);
      assert.equal((await state()).tabs.length, tabsBefore, 'External handoff must not create an empty tab');
    }

    await navigate();
    await run(`(() => { const frame = document.createElement('iframe'); frame.src = ${JSON.stringify(`${origin}/frame`)}; document.body.append(frame); })()`);
    const fixturePage = app.context().pages().find(candidate => candidate.url() === `${origin}/one`);
    assert(fixturePage, 'Fixture page missing for iframe handoff');
    await fixturePage.frameLocator('iframe').locator('#handoff').waitFor({state: 'visible'});
    await app.evaluate(({webContents}, {mainUrl, frameUrl, appUrl}) => {
      const wc = webContents.getAllWebContents().find(w => w.getURL() === mainUrl);
      const frame = wc.mainFrame.frames.find(candidate => candidate.url === frameUrl);
      return frame.executeJavaScript(`window.fixtureAppUrl = ${JSON.stringify(appUrl)}; window.fixtureMode = 'top';`);
    }, {mainUrl: `${origin}/one`, frameUrl: `${origin}/frame`, appUrl: url});
    const iframeBefore = await counts();
    await fixturePage.frameLocator('iframe').locator('#handoff').click();
    await until(async () => (await counts()).links === iframeBefore.links + 1,
      `Same-origin iframe app handoff failed for ${url}`);
    assert.equal((await counts()).prompts, iframeBefore.prompts + 1);
    assert.deepEqual(await app.evaluate(() => globalThis.authFixtureExternalLinks.splice(0)), [expectedUrl]);
  }
  // A real HTTPS document commits before its automatic callback, after the
  // short-lived click has expired. Native consent still owns the app launch.
  for (const target of ['cursor://cursorAuth?code=synthetic-delayed&state=fixture',
    'msteams:/l/meetup-join/fixture/0']) {
    for (const status of [302, 307]) {
      await navigate();
      const committedUrl = `${origin}/committed-callback?status=${status}&target=${encodeURIComponent(target)}`;
      await run(`window.fixtureAppUrl = ${JSON.stringify(committedUrl)}; window.fixtureMode = 'top';`);
      const beforeCallback = await counts();
      await nativeClick(`${origin}/one`);
      await until(() => app.evaluate(({webContents}, url) => webContents.getAllWebContents().some(w => w.getURL() === url && !w.isLoading()), committedUrl),
        'HTTPS callback page did not commit');
      await until(async () => (await counts()).links === beforeCallback.links + 1,
        `Delayed committed HTTPS ${status} callback was dropped`);
      assert.equal((await counts()).prompts, beforeCallback.prompts + 1);
      assert.deepEqual(await app.evaluate(() => globalThis.authFixtureExternalLinks.splice(0)), [target]);
    }
  }
  // Serve synthetic content at the exact launcher URL, without contacting a
  // meeting service. The navigation really commits before its hidden frame
  // requests the app, exercising the click transfer across documents.
  await navigate();
  const teamsLauncher = 'https://teams.microsoft.com/l/meetup-join/fixture/0';
  const teamsApp = 'msteams:/l/meetup-join/fixture/0';
  await app.evaluate(({ webContents, net }, { fixtureUrl, launcher, appUrl }) => {
    const wc = webContents.getAllWebContents().find(w => w.getURL() === fixtureUrl);
    if (!wc) throw new Error('Fixture page missing for Teams launcher');
    wc.session.protocol.handle('https', request => {
      if (request.url === launcher)
        return new Response('<title>Synthetic Teams launcher</title><h1>Teams launcher</h1><iframe src="https://teams.microsoft.com/kestrel-synthetic-frame"></iframe>',
          { headers: { 'content-type': 'text/html' } });
      if (request.url === 'https://teams.microsoft.com/kestrel-synthetic-frame')
        return new Response(`<script>location.href = ${JSON.stringify(appUrl)};</script>`,
          { headers: { 'content-type': 'text/html' } });
      return net.fetch(request, { bypassCustomProtocolHandlers: true });
    });
  }, { fixtureUrl: `${origin}/one`, launcher: teamsLauncher, appUrl: teamsApp });
  await run(`window.fixtureAppUrl = ${JSON.stringify(teamsLauncher)}; window.fixtureMode = 'top';`);
  const beforeLauncher = await counts();
  await nativeClick(`${origin}/one`);
  await until(async () => (await counts()).links === beforeLauncher.links + 1,
    'Committed Teams launcher iframe app handoff failed');
  assert.equal((await counts()).prompts, beforeLauncher.prompts + 1);
  assert.deepEqual(await app.evaluate(() => globalThis.authFixtureExternalLinks.splice(0)), [teamsApp]);
  assert(app.context().pages().some(candidate => candidate.url() === teamsLauncher),
    'App handoff must retain the committed Teams launcher');
  console.log('Auth links passed: native POST and 307/308 auth requests, opener-preserving popups, consented popup/top/iframe app handoffs, and HTTPS 302/307 redirects including delayed postcommit Cursor/Teams callbacks and a committed Teams launcher iframe.');
} finally {
  await app?.close(); server.closeAllConnections(); await new Promise(r => server.close(r));
  rmSync(root, {recursive:true,force:true});
}
