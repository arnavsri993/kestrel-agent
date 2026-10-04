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
const iframeRequests = [];
let iframeOrigin;
const server = createServer({key: readFileSync(keyPath), cert}, async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  requests.push({ path: req.url, method: req.method, body: Buffer.concat(chunks).toString() });
  if (req.url === '/redirect307' || req.url === '/redirect308') {
    res.writeHead(req.url.endsWith('307') ? 307 : 308, {location: '/callback'}); res.end(); return;
  }
  if (req.url?.startsWith('/app-redirect?')) {
    res.writeHead(302, {location: new URL(req.url, 'http://fixture').searchParams.get('target')}); res.end(); return;
  }
  res.setHeader('Content-Type', 'text/html');
  // Custom protocols otherwise receive no referrer under Chromium's default
  // downgrade policy. Supply the real fixture initiator for authorized tests.
  res.setHeader('Referrer-Policy', 'unsafe-url');
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
      window.addEventListener('message', e => { if (e.origin === location.origin || e.origin === '${iframeOrigin}') window.fixtureResult = e.data; });
      document.querySelector('#handoff').addEventListener('click', event => {
        window.fixtureTrustedClick = event.isTrusted;
        if (window.fixtureMode === 'top') location.href = window.fixtureAppUrl;
        else window.open(window.fixtureAppUrl, '_blank');
      });
    </script>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `https://localhost:${server.address().port}`;
const foreignOrigin = `https://127.0.0.1:${server.address().port}`;
const iframeServer = createServer({key: readFileSync(keyPath), cert}, (req, res) => {
  iframeRequests.push({ path: req.url, method: req.method });
  res.setHeader('Content-Type', 'text/html');
  if (req.url === '/callback') {
    res.end(`<script>window.opener.postMessage('iframe-popup-complete', location.origin); window.close();</script>`);
    return;
  }
  res.end(`<button id="google-like-popup">Continue with provider</button>
    <script>
      document.querySelector('button').addEventListener('click', event => {
        window.fixtureTrustedClick = event.isTrusted;
        window.fixtureClicks = (window.fixtureClicks || 0) + 1;
        window.fixturePopup = window.open('/callback', 'fixture-iframe-auth');
      });
      window.addEventListener('message', e => { if (e.origin === location.origin) parent.postMessage(e.data, ${JSON.stringify(origin)}); });
      window.fixtureIframeReady = true;
    </script>`);
});
await new Promise(r => iframeServer.listen(0, '127.0.0.1', r));
iframeOrigin = `https://127.0.0.1:${iframeServer.address().port}`;
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
  assert((await app.evaluate(({app}) => app.commandLine.getSwitchValue('disable-features'))).split(',').includes('FedCm'),
    'Google button fallback must be configured before Chromium starts');
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(() => { localStorage.setItem('kestrel:onboarded', 'yes'); localStorage.setItem('kestrel:default-browser-prompted', 'yes'); });
  await page.reload();
  await page.waitForFunction(() => !!window.kestrel);
  // Native gesture assertions need the page visible, including on compact CI
  // displays where open Chat deliberately protects and hides the browser.
  const chatToggle = page.locator('#browser-agent-toggle');
  await chatToggle.waitFor();
  if (await chatToggle.getAttribute('aria-expanded') === 'true')
    await page.locator('.agent-sidebar-collapse').click();
  const state = async () => (await page.evaluate(() => window.kestrel.request({type: 'browser-get-state'}))).browserState;
  // Trust only this ephemeral certificate at the two loopback fixture origins.
  // Do not disable certificate checks for the browser or other origins.
  await app.evaluate(({app}, {origins, certPem}) => {
    app.on('certificate-error', (event, _contents, url, _error, certificate, callback) => {
      if (origins.includes(new URL(url).origin) && certificate.data.trim() === certPem.trim()) {
        event.preventDefault(); callback(true);
      }
    });
  }, {origins: [origin, foreignOrigin, iframeOrigin], certPem: cert.toString()});
  const result = await page.evaluate(input => window.kestrel.request({type: 'browser-create-tab', input, active: true}), `${origin}/one`);
  assert(result.ok);
  const tabId = result.browserState.activeTabId;
  const navigate = async () => {
    await page.evaluate(tabId => window.kestrel.request({type:'browser-select-tab',tabId}), tabId);
    await page.evaluate(({tabId,input}) => window.kestrel.request({type:'browser-navigate',tabId,input}), {tabId,input:`${origin}/one`});
    await until(() => app.evaluate(async ({webContents}, url) => {
      const wc = webContents.getAllWebContents().find(w => w.getURL() === url && !w.isLoading());
      return wc && await wc.executeJavaScript("document.title === 'Auth fixture' && !!document.querySelector('form')").catch(() => false);
    }, `${origin}/one`), 'HTTPS fixture did not load');
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
  await until(async () => (await state()).activeTabId === tabId, 'Closing sign-in must restore its opener');
  await navigate();
  await run(`(() => { const frame = document.createElement('iframe'); frame.src = ${JSON.stringify(`${iframeOrigin}/button`)}; frame.width = 300; frame.height = 80; document.body.append(frame); })()`);
  const providerIframeState = () => app.evaluate(async ({webContents}, {url, frameUrl}) => {
    const wc = webContents.getAllWebContents().find(w => w.getURL() === url);
    const frame = wc?.mainFrame.frames.find(candidate => candidate.url === frameUrl);
    return frame && await frame.executeJavaScript(`({
      ready: document.readyState === 'complete' && window.fixtureIframeReady === true,
      buttonPresent: !!document.querySelector('#google-like-popup'),
      trustedClick: window.fixtureTrustedClick === true,
      clicks: window.fixtureClicks || 0,
      popupOpened: !!window.fixturePopup,
      popupClosed: window.fixturePopup?.closed
    })`).catch(() => undefined);
  }, {url: `${origin}/one`, frameUrl: `${iframeOrigin}/button`});
  // A committed iframe URL does not mean its button/listeners are ready.
  await until(async () => {
    const frame = await providerIframeState();
    return frame?.ready && frame.buttonPresent;
  }, 'Provider iframe button and callback handlers did not become ready');
  const point = await run(`(() => { const rect = document.querySelector('iframe').getBoundingClientRect(); return {x:Math.round(rect.x+55), y:Math.round(rect.y+20)}; })()`);
  await app.evaluate(async ({webContents}, {url,point}) => {
    const wc = webContents.getAllWebContents().find(w => w.getURL() === url);
    wc.debugger.attach('1.3');
    try {
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseMoved', ...point});
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mousePressed', ...point, button:'left', clickCount:1});
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseReleased', ...point, button:'left', clickCount:1});
    } finally { wc.debugger.detach(); }
  }, {url:`${origin}/one`,point});
  try {
    const frame = await providerIframeState();
    assert.equal(frame?.trustedClick, true, 'Provider iframe must receive a trusted native click');
    assert.equal(frame?.clicks, 1, 'Provider iframe must receive exactly one click');
    await until(() => run(`window.fixtureResult === 'iframe-popup-complete'`), 'Provider iframe popup lost callback');
  } catch (error) {
    console.error('Disposable iframe callback diagnostic:', JSON.stringify({
      frame: await providerIframeState(), iframeRequests,
      parentResult: await run('window.fixtureResult'), tabs: (await state()).tabs.map(({id, url, title, loading}) => ({id, url, title, loading})),
    }));
    throw error;
  }
  try {
    await until(async () => (await state()).activeTabId === tabId, 'Provider iframe popup did not restore its opener');
  } catch (error) {
    const current = await state();
    console.error('Disposable iframe popup state:', JSON.stringify({expectedOpener: tabId, activeTabId: current.activeTabId, tabs: current.tabs.map(({id, url, title, loading}) => ({id, url, title, loading}))}));
    throw error;
  }
  for (const target of ['_blank','fixture-post']) {
    await navigate(); requests.length = 0;
    await run(`document.querySelector('form').target = ${JSON.stringify(target)}; document.querySelector('form').requestSubmit()`);
    await until(() => requests.some(r => r.path === '/callback'), 'Popup POST not received');
    assert.equal(requests.find(r => r.path === '/callback').method, 'POST');
    assert.equal(requests.find(r => r.path === '/callback').body, 'fixture=synthetic');
  }
  await navigate();
  await app.evaluate(({shell, dialog}, origin) => {
    globalThis.authFixtureExternalLinks = [];
    globalThis.authFixtureConsent = [];
    shell.openExternal = async url => { globalThis.authFixtureExternalLinks.push(url); };
    const original = dialog.showMessageBox.bind(dialog);
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      if (options.type === 'question' && options.message?.startsWith(`${origin} wants to open `) &&
          options.buttons?.[0] === 'Open app' && options.buttons?.[1] === 'Stay here') {
        globalThis.authFixtureConsent.push(options.title);
        return {response: 0, checkboxChecked: false};
      }
      return original(...args);
    };
  }, origin);
  const counts = () => app.evaluate(() => ({links: globalThis.authFixtureExternalLinks.length, prompts: globalThis.authFixtureConsent.length}));
  const nativeClick = async (url, frameUrl) => {
    if (frameUrl) {
      const fixturePage = app.context().pages().find(candidate => candidate.url() === url);
      assert(fixturePage, 'Fixture Playwright page missing');
      await fixturePage.frameLocator('iframe').locator('#handoff').click();
      return;
    }
    const point = await app.evaluate(async ({webContents}, url) => {
      const wc = webContents.getAllWebContents().find(w => w.getURL() === url);
      if (!wc) throw new Error('Fixture page missing');
      return wc.executeJavaScript(`(() => {const r = document.querySelector('#handoff').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    }, url);
    await app.evaluate(({webContents}, {url, point}) => {
      const wc = webContents.getAllWebContents().find(w => w.getURL() === url);
      wc.focus();
      wc.sendInputEvent({type:'mouseDown', button:'left', clickCount:1, ...point});
      wc.sendInputEvent({type:'mouseUp', button:'left', clickCount:1, ...point});
    }, {url, point});
  };
  const assertDenied = async (action, label) => {
    const before = await counts();
    await action();
    await new Promise(r => setTimeout(r, 500));
    assert.deepEqual(await counts(), before, label);
  };
  for (const url of [
    'zoommtg://zoom.us/join?confno=1234567890&action=join',
    'zoomus://zoom.us/join?confno=1234567890&action=join',
    'msteams://teams.microsoft.com/l/meetup-join/19%3afixture/0',
    'itms-appss://apps.apple.com/app/id113517709?mt=12',
    'msteams:/l/meetup-join/19%3afixture/0',
    'msteams://teams.cloud.microsoft/l/chat/fixture/conversations',
    'cursor://cursorAuth?code=synthetic%2Bvalue&state=fixture',
    'cursor://anysphere.cursor-mcp/oauth/callback?code=fixture&state=fixture',
  ]) {
    await navigate();
    await run(`window.fixtureAppUrl = ${JSON.stringify(url)}; window.fixtureMode = 'popup';
      const policy = document.createElement('meta'); policy.name = 'referrer';
      policy.content = 'strict-origin-when-cross-origin'; document.head.append(policy);`);
    await assertDenied(() => run(`document.querySelector('#handoff').click()`), 'Default-policy popup without native input must be denied');
    const defaultBefore = await counts();
    await nativeClick(`${origin}/one`);
    await until(async () => (await counts()).links === defaultBefore.links + 1, `Native default-policy main-frame popup handoff failed for ${url}`);
    assert.equal(await run('window.fixtureTrustedClick'), true, 'Default-policy handoff must receive a trusted native click');
    assert.equal((await counts()).prompts, defaultBefore.prompts + 1, 'Default-policy handoff requires explicit fixture consent');
    assert.deepEqual(await app.evaluate(() => globalThis.authFixtureExternalLinks.splice(0)), [url]);
    for (const mode of ['popup', 'top']) {
      await navigate();
      await run(`window.fixtureAppUrl = ${JSON.stringify(url)}; window.fixtureMode = ${JSON.stringify(mode)};`);
      await assertDenied(() => run(`document.querySelector('#handoff').click()`), `${mode} app handoff without native input must be denied`);
      const before = await counts();
      await nativeClick(`${origin}/one`);
      await until(async () => (await counts()).links === before.links + 1, `Native ${mode} app handoff failed`);
      assert.equal(await run('window.fixtureTrustedClick'), true, 'Fixture must receive a trusted native click');
      assert.equal((await counts()).prompts, before.prompts + 1, 'Every handoff requires explicit fixture consent');
      assert.deepEqual(await app.evaluate(() => globalThis.authFixtureExternalLinks.splice(0)), [url]);
    }
    for (const frameOrigin of [origin, foreignOrigin]) {
      await navigate();
      const frameUrl = `${frameOrigin}/frame`;
      await run(`(() => { const frame = document.createElement('iframe'); frame.src = ${JSON.stringify(frameUrl)}; frame.style.cssText = 'position:fixed;left:8px;top:8px;width:600px;height:250px;border:0'; document.body.append(frame); })()`);
      const fixturePage = app.context().pages().find(candidate => candidate.url() === `${origin}/one`);
      await fixturePage.frameLocator('iframe').locator('#handoff').waitFor({state:'visible'});
      const frameRun = script => app.evaluate(({webContents}, {url, frameUrl, script}) => {
        const wc = webContents.getAllWebContents().find(w => w.getURL() === url);
        const frame = wc.mainFrame.frames.find(f => f.url === frameUrl);
        if (!frame) throw new Error('Fixture frame missing');
        return frame.executeJavaScript(script);
      }, {url:`${origin}/one`, frameUrl, script});
      // The main-frame bridge must never authorize a popup from an iframe.
      await frameRun(`window.fixtureAppUrl = ${JSON.stringify(url)}; window.fixtureMode = 'popup';
        const policy = document.createElement('meta'); policy.name = 'referrer';
        policy.content = 'strict-origin-when-cross-origin'; document.head.append(policy);`);
      await assertDenied(() => nativeClick(`${origin}/one`, frameUrl), 'Default-policy iframe popup must not borrow the main-frame bridge');
      assert.equal(await frameRun('window.fixtureTrustedClick'), true, 'Default-policy iframe denial must exercise native input');
      await frameRun(`document.querySelector('meta[name="referrer"]').content = 'unsafe-url';`);
      for (const mode of ['popup', 'top']) {
        await frameRun(`window.fixtureAppUrl = ${JSON.stringify(url)}; window.fixtureMode = ${JSON.stringify(mode)}; window.fixtureTrustedClick = false;`);
        if (frameOrigin === foreignOrigin) {
          await assertDenied(() => nativeClick(`${origin}/one`, frameUrl), `Foreign-frame ${mode} native input must not borrow the top-frame origin`);
        } else {
          const before = await counts();
          await nativeClick(`${origin}/one`, frameUrl);
          await until(async () => (await counts()).links === before.links + 1, `Same-origin iframe ${mode} app handoff failed`);
          assert.equal((await counts()).prompts, before.prompts + 1, 'Iframe handoff requires explicit fixture consent');
          assert.deepEqual(await app.evaluate(() => globalThis.authFixtureExternalLinks.splice(0)), [url]);
        }
        assert.equal(await frameRun('window.fixtureTrustedClick'), true, 'Iframe must receive a trusted native click');
      }
    }
  }
  console.log('Auth links passed: same-tab POST, 307/308 POST redirects, blank popup navigation, opener callback, popup close, target/named popup POST, and consented native Zoom/Teams/App Store popup/top-frame/same-origin iframe handoffs including default-policy main-frame popups, with no-click, default-policy iframe, and foreign-frame denial.');
} finally {
  await app?.close(); server.closeAllConnections(); iframeServer.closeAllConnections(); await new Promise(r => server.close(r)); await new Promise(r => iframeServer.close(r));
  rmSync(root, {recursive:true,force:true});
}
