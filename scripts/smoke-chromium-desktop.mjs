import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from '@playwright/test';
import {tsImport} from 'tsx/esm/api';
import {nativeProviderCanary,nativeCodexCanary} from './native-provider-canary.mjs';
import {nativeBrowserActionsCanary} from './native-browser-actions-canary.mjs';
import {createIsolationFixtures,nativeIsolatedBrowserCanary,prepareIsolatedCoreResetCanary,finishIsolatedCoreResetCanary} from './native-isolated-browser-canary.mjs';
import {nativeWorkspaceCanary,finishNativeWorkspaceCanary,prepareNativeWorkspaceFixture} from './native-workspace-canary.mjs';
import {candidateDigest} from './native-retirement-evidence.mjs';

const app=resolve(process.env.KESTREL_NATIVE_TEST_APP||'.tmp/native-chromium-host/Kestrel.app');
const executable=join(app,'Contents/MacOS/Kestrel');
const profile=await mkdtemp(join(tmpdir(),'kestrel-chromium-desktop-canary-'));
const downloadPath=join(profile,'test-downloads');
await mkdir(downloadPath,{mode:0o700});await mkdir(join(profile,'Default'),{mode:0o700});
const workspaceFixture=process.env.KESTREL_TEST_NATIVE_WORKSPACE_FIXTURE==='1';
if(workspaceFixture)await prepareNativeWorkspaceFixture(profile);
// CEF's Chrome profile is not an off-the-record context registered with the
// Browser CDP handler. Configure its real preference before first startup so
// the download canary writes only into this disposable profile.
await writeFile(join(profile,'Default/Preferences'),JSON.stringify({download:{default_directory:downloadPath,prompt_for_download:false,directory_upgrade:true}}),{mode:0o600});
const evidence=resolve('.tmp/chromium-desktop-evidence');
await mkdir(evidence,{recursive:true});
const {UserBrowserStateSchema}=await tsImport('../packages/shared-types/src/contracts.ts',import.meta.url);
const {isChromeWebStoreUrl}=await tsImport('../packages/shared-types/src/chrome-web-store.ts',import.meta.url);
const store=process.env.KESTREL_TEST_REAL_CHROME_WEB_STORE==='1';
const lifecycle=process.env.KESTREL_TEST_NATIVE_WINDOW_LIFECYCLE==='1';
const providers=process.env.KESTREL_TEST_NATIVE_PROVIDERS==='1';
const formatter='bcjindcccaagfpapjjmafapmmgkkhgoa';
const receipt={at:new Date().toISOString(),candidate:app,candidateSha256:await candidateDigest(app),executableSha256:createHash('sha256').update(await readFile(executable)).digest('hex'),storeRequested:store,lifecycleRequested:lifecycle,phases:[]};
const jsonFixture={source:'kestrel-native-canary',nested:{installedExtensionRuns:true},values:[1,2,3]};
const isolationFixtures=createIsolationFixtures();
const server=createServer((req,res)=>{
 if(isolationFixtures.handle(req,res))return;
 if(req.url==='/actions'){
  res.writeHead(200,{'content-type':'text/html'});res.end(`<!doctype html><title>Native browser action canary</title><style>body{min-height:2600px;background:#f6f6f6;font:18px system-ui;padding:20px}input,button,select{font:inherit;margin:10px;padding:10px}</style><h1>Native browser action canary</h1>
  <label>Public query<input id="query" name="query" autocomplete="off"></label><button id="add">Add one</button><p id="click-result">0</p>
  <label>Country<select id="country"><option value="first">First</option><option value="second">Second</option></select></label><p id="selection-result">first</p>
  <script>query.addEventListener('input',event=>window.nativeTrustedInput=event.isTrusted);query.addEventListener('keydown',event=>{if(event.key==='Enter')window.nativeTrustedKey=event.isTrusted});add.addEventListener('click',event=>{window.nativeTrustedClick=event.isTrusted;document.querySelector('#click-result').textContent=String(Number(document.querySelector('#click-result').textContent)+1)});country.addEventListener('change',()=>document.querySelector('#selection-result').textContent=country.value);</script>`);return;
 }
 if(req.url==='/visual'){res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Native screenshot canary</title><style>body{background:#e8edf2;color:#20242a;font:24px system-ui;padding:40px}</style><h1>Native screenshot canary</h1><p>Public static content captured through Chromium and validated inside Core.</p>');return;}
 if(req.url==='/formatter.json'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(jsonFixture));return;}
 if(req.url.startsWith('/download?')){res.writeHead(200,{'content-type':'application/octet-stream','content-disposition':'attachment; filename="canary.txt"'});res.end('Native Chromium download canary.');return;}
 res.writeHead(200,{'content-type':'text/html'});res.end(`<!doctype html><title>Native browser canary</title><h1>Native browser canary</h1>
 <p>Public page text. api_key=canary_secret_abcdefghijklmnop</p>
 <a href="/readable?access_token=canary_url_secret#canary_fragment_secret">Public link</a>
 <a href="/download?access_token=canary_metadata_secret">Download canary</a>
 <label>Password <input type="password" value="canary_password_secret"></label>
 <textarea>canary_textarea_secret</textarea><div contenteditable>canary_editable_secret</div>
 <div data-private>canary_private_secret</div><div hidden>canary_hidden_secret</div>
 <script>window.getSelection=()=>({rangeCount:1,toString:()=>"canary_page_world_spoof_secret"});</script>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let child,browser,output='';
let savedSession,providerEvidence,workspaceEvidence;
function ownedNodeProcesses(){
 const rows=execFileSync('/bin/ps',['-axo','pid=,ppid=,comm='],{encoding:'utf8'}).trim().split('\n').map(line=>line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean);
 const owned=new Set([child.pid]);let changed=true;
 while(changed){changed=false;for(const row of rows)if(owned.has(Number(row[2]))&&!owned.has(Number(row[1]))){owned.add(Number(row[1]));changed=true;}}
 return rows.filter(row=>owned.has(Number(row[1]))&&row[3].endsWith('/node')).map(row=>({pid:Number(row[1]),ppid:Number(row[2])}));
}
async function start(){
 output='';
 child=spawn(executable,['--kestrel-chromium-desktop','--kestrel-cache-path',profile,'--kestrel-durable-profile','--remote-debugging-port=0'],{stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 let endpoint;
 for(let i=0;i<200;i++){
  assert.equal(child.exitCode,null,output);
  endpoint=output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+)/)?.[1];
  if(endpoint)break;await delay(100);
 }
 assert(endpoint,'Owned native endpoint missing: '+output);
 browser=await chromium.connectOverCDP(endpoint,{noDefaults:true});
 let context=browser.contexts()[0];
 let home;
 for(let i=0;i<200;i++){
  home=context.pages().find(page=>/chrome-extension:\/\/[^/]+\/index.html$/.test(page.url()));if(home)break;
  if(i%10===0){
   const session=await browser.newBrowserCDPSession();
   const targets=await session.send('Target.getTargets');await session.detach();
   if(targets.targetInfos.some(target=>target.type==='page'&&/chrome-extension:\/\/[^/]+\/index.html$/.test(target.url))){
    // Chrome may have created the first page between Playwright's discovery
    // and auto-attach setup. Reconnect only when that real target exists.
    await browser.close();browser=await chromium.connectOverCDP(endpoint,{noDefaults:true});context=browser.contexts()[0];
   }
  }
  await delay(100);
 }
 assert(home,'Authenticated native Home did not open: '+output);
 await home.waitForFunction(()=>typeof window.kestrel?.request==='function');
 return {context,home,endpoint};
}
async function close(){
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 // Exercise the production launcher's clean process-stop path. Closing the
 // last browser window intentionally keeps the macOS app and Core alive.
 assert(child.kill('SIGTERM'),'Native process could not receive its stop signal.');
 const result=await Promise.race([exited,delay(12_000,undefined,{ref:false}).then(()=>{throw Error('Native shutdown timed out: '+output);})]);
 assert.deepEqual(result,{code:0,signal:null},output);
 await browser.close().catch(()=>{});browser=undefined;
 await writeFile(join(evidence,'runtime.log'),output);
}
try{
 let {context,home,endpoint}=await start();
 async function createdPage(predicate){
  let page=browser.contexts().flatMap(context=>context.pages()).find(page=>predicate(page.url()));
  if(page)return page;
  // CEF's browser target does not auto-attach every native-created tab.
  // Reconnect to its existing targets; the product tab/window stays intact.
  await browser.close();browser=await chromium.connectOverCDP(endpoint,{noDefaults:true});context=browser.contexts()[0];
  home=context.pages().find(page=>/chrome-extension:\/\/[^/]+\/index.html$/.test(page.url()));
  for(let i=0;i<100;i++){page=browser.contexts().flatMap(context=>context.pages()).find(page=>predicate(page.url()));if(page)return page;await delay(100);}
  throw Error('Native-created target could not be attached by the test connection.');
 }
 async function formatterRuns(phase){
  const url=`http://127.0.0.1:${server.address().port}/formatter.json`;
  const created=await home.evaluate(url=>window.kestrel.request({type:'browser-create-tab',input:url}),url);assert.equal(created.ok,true,created.error);
  const page=await createdPage(candidate=>candidate===url);
  // JSON Formatter explicitly exports the parsed value into the page. Native
  // Chromium's built-in JSON viewer does not supply this extension behavior.
  await page.waitForFunction(()=>window.json?.source==='kestrel-native-canary',{},{timeout:15_000});
  assert.deepEqual(await page.evaluate(()=>window.json),jsonFixture);
  assert.equal(await page.evaluate(()=>typeof window.kestrel),'undefined');
  await page.screenshot({path:join(evidence,phase+'.png')});
  await page.close();
  receipt.phases.push({phase,passed:true});
 }
 const errors=[];home.on('pageerror',error=>errors.push(error.message));
 assert.equal((await home.evaluate(()=>window.kestrel.request({type:'snapshot'}))).ok,true);
 UserBrowserStateSchema.parse((await home.evaluate(()=>window.kestrel.request({type:'browser-get-state'}))).browserState);
 // Only this disposable canary bypasses setup to isolate the browser flow.
 await home.evaluate(()=>{localStorage.setItem('kestrel:onboarded','yes');localStorage.setItem('kestrel:default-browser-prompted','yes');});
 await home.reload();await home.locator('.kestrel-sidebar').waitFor();
 assert.equal(await home.locator('.browser-toolbar,.browser-tab-row').count(),0,'Native Chrome must own its browser controls.');
 const grants=await home.evaluate(()=>window.kestrel.request({type:'get-workspace-grants'}));assert.equal(grants.ok,true);
 const nativeSystem=await home.evaluate(()=>window.kestrel.request({type:'get-system-state'}));assert.equal(nativeSystem.ok,true);assert.equal(typeof nativeSystem.launchAtLogin,'boolean');
 const created=await home.evaluate(()=>window.kestrel.request({type:'runtime-create-session',title:'Chromium restart canary',kind:'conversation'}));assert.equal(created.ok,true);savedSession=created.session?.id;assert(savedSession);
 await home.screenshot({path:join(evidence,'home.png')});
 const fixturePublicUrl=`http://127.0.0.1:${server.address().port}/canary`;
 const fixtureUrl=fixturePublicUrl+'?access_token=canary_metadata_secret';
 const tabResult=await home.evaluate(url=>window.kestrel.request({type:'browser-create-tab',input:url}),fixtureUrl);
 assert.equal(tabResult.ok,true,tabResult.error);
 const external=await createdPage(url=>url===fixtureUrl);
 await external.getByRole('heading',{name:'Native browser canary'}).waitFor();
 assert.deepEqual(await external.evaluate(()=>({bridge:typeof window.kestrel,query:typeof window.__kestrelNativeQuery,transport:typeof window.__kestrelHostTransport})),{bridge:'undefined',query:'undefined',transport:'undefined'});
 await external.getByRole('link',{name:'Download canary',exact:true}).click();
 let nativeDownload;
 for(const deadline=Date.now()+30_000;Date.now()<deadline;){nativeDownload=(await home.evaluate(()=>window.kestrel.request({type:'browser-get-state'}))).browserState.downloads.find(item=>item.filename==='canary.txt'&&item.status==='completed');if(nativeDownload)break;await delay(100);}
 const downloadedFiles=await home.evaluate(()=>chrome.downloads.search({query:['canary_metadata_secret']}));
 const savedPreferences=JSON.parse(await readFile(join(profile,'Default/Preferences'),'utf8'));
 await writeFile(join(evidence,'native-download-diagnostics.json'),JSON.stringify({downloadPath,preferences:savedPreferences.download,files:downloadedFiles.map(item=>({id:item.id,filename:item.filename,state:item.state,exists:item.exists,danger:item.danger,error:item.error,paused:item.paused}))},null,2));
 assert(nativeDownload,'Chromium must record the completed real download.');
 assert(downloadedFiles.some(item=>item.filename===join(downloadPath,'canary.txt')),'The native download must stay in the disposable profile.');
 assert.equal(await readFile(join(downloadPath,'canary.txt'),'utf8'),'Native Chromium download canary.');
 async function coreTool(toolName,input,approved=true){
  const response=await home.evaluate(({sessionId,toolName,input,approved})=>window.kestrel.request({type:'runtime-call-tool',sessionId,toolName,input,
   ...(approved?{approvalStatus:'approved'}:{}),idempotencyKey:crypto.randomUUID()}),{sessionId:savedSession,toolName,input,approved});
  assert.equal(response.ok,true,response.error);return response.execution;
 }
 const listed=await coreTool('browser.tabs',{});
 assert.equal(listed.status,'verified',JSON.stringify(listed));
 assert(listed.output.tabs.some(tab=>tab.url===fixturePublicUrl),'Actual Core must see the native user tab.');
 assert(listed.output.tabs.every(tab=>!tab.url.startsWith('chrome-extension:')),'Core must not receive protected Kestrel UI tabs.');
 assert(!JSON.stringify(listed.output).includes('canary_metadata_secret'),'Core tab metadata must omit URL credentials.');
 const history=await coreTool('browser.search-history',{query:'127.0.0.1',limit:10});
 assert.equal(history.status,'verified',JSON.stringify(history));assert(Array.isArray(history.output.entries));assert(history.output.entries.length<=10);
 assert(!JSON.stringify(history.output).includes('canary_metadata_secret'),'Core history metadata must omit URL credentials.');
 const downloads=await coreTool('browser.visible-downloads',{});
 assert.equal(downloads.status,'verified',JSON.stringify(downloads));assert(downloads.output.downloads.some(item=>item.filename==='canary.txt'&&item.status==='completed'));
 assert(!JSON.stringify(downloads.output).includes('canary_metadata_secret'),'Core download metadata must omit URL credentials.');
 receipt.phases.push({phase:'native-download-and-Core-metadata-redaction',passed:true});
 const readableTab=listed.output.tabs.find(tab=>tab.url===fixturePublicUrl);assert(readableTab);
 const read=await coreTool('browser.current-context',{tabId:readableTab.id});
 assert.equal(read.status,'verified',JSON.stringify(read));
 assert(read.output.visibleText.includes('Public page text.'),JSON.stringify(read));
 assert(read.output.headings.includes('Native browser canary'));
 assert(read.output.forms.some(field=>field.type==='sensitive'));
 assert.equal(read.output.links[0].url,`http://127.0.0.1:${server.address().port}/readable`);
 assert(!/canary_(?:secret|password|textarea|editable|private|hidden|url|fragment|page_world)/.test(JSON.stringify(read.output)),'Sensitive page data must not leave the isolated capture.');
 const uiRead=await home.evaluate(tabId=>window.kestrel.request({type:'browser-get-context',tabId}),readableTab.id);
 assert.equal(uiRead.ok,true,uiRead.error);assert(uiRead.browserContext.visibleText.includes('Public page text.'));
 assert(!/canary_(?:secret|password|textarea|editable|private|hidden|url|fragment|page_world)/.test(JSON.stringify(uiRead.browserContext)),'UI context must be redacted before Core processing too.');
 assert.deepEqual(await external.evaluate(()=>({bridge:typeof window.kestrel,query:typeof window.__kestrelNativeQuery})),{bridge:'undefined',query:'undefined'});
 receipt.phases.push({phase:'native-page-context-and-private-field-isolation',passed:true});
 const accessibility=await coreTool('browser.visible-snapshot',{tabId:readableTab.id});
 assert.equal(accessibility.status,'verified',JSON.stringify(accessibility));
 assert.equal(accessibility.output.url,fixturePublicUrl);
 assert(accessibility.output.interactive.some(item=>item.role==='link'));
 assert(accessibility.output.interactive.some(item=>item.name==='Sensitive field'));
 assert(!/canary_(?:secret|password|textarea|editable|private|hidden|url|fragment|page_world|metadata)/.test(JSON.stringify(accessibility.output)),'Native AX snapshots must not expose private fields, text or URL credentials.');
 const nextAccessibility=await coreTool('browser.visible-snapshot',{tabId:readableTab.id});
 assert.equal(nextAccessibility.status,'verified',JSON.stringify(nextAccessibility));
 const previousRefs=new Set(accessibility.output.interactive.map(item=>item.ref));
 assert(nextAccessibility.output.interactive.every(item=>!previousRefs.has(item.ref)),'A later snapshot must not reuse a stale native action reference.');
 receipt.phases.push({phase:'native-Core-accessibility-and-private-field-isolation',passed:true,interactive:accessibility.output.interactive.length});
 await nativeBrowserActionsCanary({getHome:()=>home,createdPage,coreTool,baseUrl:`http://127.0.0.1:${server.address().port}`,readableTab,evidence,receipt});
 if(process.env.KESTREL_TEST_NATIVE_ISOLATED_AUTOMATION==='1')await nativeIsolatedBrowserCanary({coreTool,origin:`http://127.0.0.1:${server.address().port}`,fixtures:isolationFixtures,createdPage,getHome:()=>home,evidence,receipt});
 if(process.env.KESTREL_TEST_NATIVE_ISOLATED_AUTOMATION==='1')await prepareIsolatedCoreResetCanary({coreTool,origin:`http://127.0.0.1:${server.address().port}`,fixtures:isolationFixtures});
 const originalNodes=ownedNodeProcesses();assert.equal(originalNodes.length,3,'The test must identify its exact broker, relay, and Core.');
 const originalCore=originalNodes.find(node=>!originalNodes.some(child=>child.ppid===node.pid));assert(originalCore);
 process.kill(originalCore.pid,'SIGKILL'); // Only this disposable canary's verified Core child.
 let recoveredCore,recoveredSnapshot;
 for(const deadline=Date.now()+15_000;Date.now()<deadline;){
  assert.equal(child.exitCode,null,'A Core crash must not terminate the browser.');
  recoveredCore=ownedNodeProcesses().find(node=>node.ppid===originalCore.ppid&&node.pid!==originalCore.pid);
  if(recoveredCore){recoveredSnapshot=await home.evaluate(()=>window.kestrel.request({type:'snapshot'}));if(recoveredSnapshot.ok)break;}
  await delay(100);
 }
 assert(recoveredCore&&recoveredSnapshot?.ok,'Native Core did not recover. '+output);
 assert.equal(home.isClosed(),false,'Core recovery must preserve the native Home tab.');
 assert((await home.evaluate(()=>window.kestrel.request({type:'runtime-list-sessions'}))).sessions.some(session=>session.id===savedSession),'Core recovery must retain the real conversation.');
 const afterRecovery=await coreTool('browser.tabs',{});assert.equal(afterRecovery.status,'verified',JSON.stringify(afterRecovery));assert(afterRecovery.output.tabs.some(tab=>tab.id===readableTab.id));
 receipt.phases.push({phase:'native-Core-crash-recovery',passed:true,previousCorePid:originalCore.pid,recoveredCorePid:recoveredCore.pid,browserPid:child.pid});
 if(process.env.KESTREL_TEST_NATIVE_ISOLATED_AUTOMATION==='1')await finishIsolatedCoreResetCanary({coreTool,origin:`http://127.0.0.1:${server.address().port}`,fixtures:isolationFixtures,receipt});
 const coreUrl=fixturePublicUrl+'?created-by=core';
 const blocked=await coreTool('browser.open-tab',{input:coreUrl},false);
 assert.equal(blocked.status,'blocked','Core approval must precede browser dispatch.');
 assert(!(await home.evaluate(()=>window.kestrel.request({type:'browser-get-state'}))).browserState.tabs.some(tab=>tab.url===coreUrl));
 const opened=await coreTool('browser.open-tab',{input:coreUrl});
 assert(opened.output?.tabId,JSON.stringify(opened));
 const coreTab=await createdPage(url=>url===coreUrl);await coreTab.getByRole('heading',{name:'Native browser canary'}).waitFor();
 await home.bringToFront();
 const selected=await coreTool('browser.select-tab',{tabId:opened.output.tabId});assert(!['failed','blocked'].includes(selected.status),JSON.stringify(selected));
 assert.equal((await home.evaluate(()=>window.kestrel.request({type:'browser-get-state'}))).browserState.activeTabId,opened.output.tabId);
 const navigatedUrl=fixturePublicUrl+'?navigated-by=core';
 const navigated=await coreTool('browser.navigate-tab',{tabId:opened.output.tabId,input:navigatedUrl});
 assert(!['failed','blocked'].includes(navigated.status),JSON.stringify(navigated));
 await coreTab.waitForURL(navigatedUrl);
 const uiState=(await home.evaluate(()=>window.kestrel.request({type:'browser-get-state'}))).browserState;
 const protectedTab=uiState.tabs.find(tab=>!tab.url);assert(protectedTab);
 const denied=await coreTool('browser.close-tab',{tabId:protectedTab.id});assert(['failed','blocked'].includes(denied.status),'Core must not control Kestrel UI pages.');
 assert.equal(home.isClosed(),false);
 const closing=coreTab.waitForEvent('close');
 const closed=await coreTool('browser.close-tab',{tabId:opened.output.tabId});assert(!['failed','blocked'].includes(closed.status),JSON.stringify(closed));
 await closing;
 receipt.phases.push({phase:'native-core-tab-tools-and-approval',passed:true});
 // A native-created target may have required a CDP reconnect above. Close
 // through a fresh handle rather than a disconnected Playwright object.
 await (await createdPage(url=>url===fixtureUrl)).close();await home.bringToFront();
 await home.getByRole('button',{name:'Open settings',exact:true}).click();
 const settings=await createdPage(url=>url.includes('index.html?app=settings'));await settings.waitForURL(/index.html\?app=settings/);
 await settings.locator('[data-app-page="settings"]').waitFor();
 if(process.env.KESTREL_TEST_NATIVE_WORKSPACE==='1'||workspaceFixture)workspaceEvidence=await nativeWorkspaceCanary({settings,getHome:()=>home,profile,evidence,receipt,origin:`http://127.0.0.1:${server.address().port}`,fixtures:isolationFixtures,fixtureGranted:workspaceFixture});
 if(providers)providerEvidence=await nativeProviderCanary({settings,home,profile,evidence,receipt,endpoint});
 if(process.env.KESTREL_TEST_REAL_CODEX==='1')await nativeCodexCanary({settings,home,evidence,receipt});
 await settings.bringToFront();
 await settings.getByRole('tab',{name:'Browser',exact:true}).click();
 await settings.getByRole('combobox',{name:'Browser settings section',exact:true}).selectOption('browser-extensions');
 await settings.locator('[data-settings-panel="browser-extensions"]').waitFor();
 assert.equal(await settings.getByRole('button',{name:'Review from Web Store',exact:true}).count(),0);
 await settings.screenshot({path:join(evidence,'extensions-settings.png')});
 receipt.phases.push({phase:'native-ui-core-and-tabs',passed:true,rendererErrors:errors});assert.deepEqual(errors,[]);
 if(lifecycle){
  assert(!store,'Run the window lifecycle and Store prompts as separate canaries.');
  for(const page of context.pages())if(page!==home)await page.close();
  await home.bringToFront();
  const nodeDescendants=()=>ownedNodeProcesses().map(node=>node.pid).sort((a,b)=>a-b);
  const coreProcesses=nodeDescendants();assert(coreProcesses.length>=3,'The browser must own broker, relay, and Core.');
  console.log('OWNED_CHROMIUM_WINDOW_READY: close this candidate’s last window using its normal native control.');
  for(let i=0;i<2400&&!home.isClosed();i++){assert.equal(child.exitCode,null,output);await delay(100);}
  assert(home.isClosed(),'Native last-window close was not exercised.');
  await delay(1_000);assert.equal(child.exitCode,null,'Closing a window must not quit Core.');assert.deepEqual(nodeDescendants(),coreProcesses,'Closing a window must preserve the same Core processes.');
  console.log('OWNED_CHROMIUM_WINDOW_CLOSED: reopen Home with native New Window or Dock activation.');
  let restored;
  for(let i=0;i<2400;i++){
   assert.equal(child.exitCode,null,output);
   const session=await browser.newBrowserCDPSession();const targets=await session.send('Target.getTargets');await session.detach();
   if(targets.targetInfos.some(target=>target.type==='page'&&/chrome-extension:\/\/[^/]+\/index.html$/.test(target.url))){restored=await createdPage(url=>/chrome-extension:\/\/[^/]+\/index.html$/.test(url));break;}
   await delay(100);
  }
  assert(restored,'Native window did not reopen.');home=restored;
  await home.waitForFunction(()=>typeof window.kestrel?.request==='function');
  assert((await home.evaluate(()=>window.kestrel.request({type:'runtime-list-sessions'}))).sessions.some(session=>session.id===savedSession));
  assert.deepEqual(nodeDescendants(),coreProcesses,'Reopening Home must reuse the same Core.');
  receipt.phases.push({phase:'native-last-window-close-and-reopen',passed:true,coreProcesses});
 }
 if(store){
  await settings.getByRole('link',{name:/Browse Chrome Web Store/}).click();
  const listing=await createdPage(isChromeWebStoreUrl);await listing.goto(`https://chromewebstore.google.com/detail/json-formatter/${formatter}`,{waitUntil:'domcontentloaded'});
  await listing.getByRole('button',{name:'Add to Chrome',exact:true}).waitFor();
  const session=await browser.newBrowserCDPSession();
  let panel;
  for(let i=0;i<100;i++){panel=(await session.send('Target.getTargets')).targetInfos.find(t=>t.url.includes('/index.html?surface=panel'));if(panel)break;await delay(100);}
  assert(panel,'Opening Store from Kestrel must retain the actual native agent side panel.');
  const windowIds=[];
  const targets=(await session.send('Target.getTargets')).targetInfos;
  for(const url of [home.url(),settings.url(),listing.url()]){const target=targets.find(target=>target.type==='page'&&target.url===url);assert(target);windowIds.push((await session.send('Browser.getWindowForTarget',{targetId:target.targetId})).windowId);}
  assert.equal(new Set(windowIds).size,1,'Home, Settings and Store must share one native browser window.');
  assert.equal(await listing.evaluate(()=>typeof window.kestrel),'undefined');
  await listing.screenshot({path:join(evidence,'store.png')});
  await writeFile(join(evidence,'live-profile.txt'),profile);
  await writeFile(join(evidence,'receipt.json'),JSON.stringify({...receipt,awaitingNativeInstall:true,windowIds,panelTarget:panel.targetId},null,2));
  console.log('OWNED_CHROMIUM_STORE_READY: native JSON Formatter install prompt can now be exercised in the visible candidate.');
  let installed;
  for(let i=0;i<6000;i++){const result=await home.evaluate(()=>window.kestrel.request({type:'browser-list-extensions'}));installed=result.extensions?.find(item=>item.id===formatter&&item.enabled);if(installed)break;assert.equal(child.exitCode,null,output);await delay(100);}
  assert(installed,'Native Store installation was not observed.');
  receipt.phases.push({phase:'native-web-store-install',passed:true,extension:{id:installed.id,version:installed.version,enabled:installed.enabled},windowIds,panelTarget:panel.targetId});
  await formatterRuns('native-extension-functional');
 }
 await close();
 const restarted=await start();
 home=restarted.home;context=restarted.context;endpoint=restarted.endpoint;
 const sessions=await restarted.home.evaluate(()=>window.kestrel.request({type:'runtime-list-sessions'}));assert.equal(sessions.ok,true);assert(sessions.sessions.some(session=>session.id===savedSession),'Actual Core session must survive full app restart.');
 if(workspaceEvidence)await finishNativeWorkspaceCanary({home,state:workspaceEvidence,receipt});
 if(providerEvidence){
  const accounts=await home.evaluate(()=>window.kestrel.request({type:'provider-account-list'}));assert(accounts.ok&&accounts.providerAccounts.some(account=>account.id===providerEvidence.accountId));
  const messages=await home.evaluate(sessionId=>window.kestrel.request({type:'runtime-list-messages',sessionId}),providerEvidence.sessionId);assert(messages.ok&&messages.messages.some(message=>message.content.includes(providerEvidence.answer)));
  receipt.phases.push({phase:'native-provider-settings-and-conversation-restart',passed:true});
 }
 if(store){const extensions=await restarted.home.evaluate(()=>window.kestrel.request({type:'browser-list-extensions'}));const installed=extensions.extensions?.find(item=>item.id===formatter);assert(installed?.enabled,'Chrome-installed extension must survive full restart.');receipt.phases.push({phase:'native-extension-restart',passed:true,id:installed.id,version:installed.version});await formatterRuns('native-extension-functional-after-restart');}
 await close();receipt.phases.push({phase:'durable-core-and-clean-restart',passed:true});
 assert.equal(await candidateDigest(app),receipt.candidateSha256,'The candidate bundle changed during native desktop verification.');
 await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2));
 console.log('Native Chromium desktop passed: real Kestrel Home/Settings, Core tab tools and approval enforcement, native tabs, web bridge isolation, durable restart, and clean shutdown'+(store?', plus native Store install and functional extension restart.':'.'));
}catch(error){await writeFile(join(evidence,'failure.log'),output+'\n'+String(error));await writeFile(join(evidence,'receipt.json'),JSON.stringify({...receipt,failed:String(error)},null,2));throw error;}
finally{
 await browser?.close().catch(()=>{});
 if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));}
 await new Promise(resolve=>server.close(resolve));
 await rm(profile,{recursive:true,force:true});
}
