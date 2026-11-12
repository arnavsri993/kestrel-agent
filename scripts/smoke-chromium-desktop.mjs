import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat,mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
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
import {assertNativeBrowserFixtureStopped,captureNativeBrowserFixtureStorage,nativeBrowserFixtureStorageArgs,nativeBrowserFixtureStorageEnv,prepareNativeBrowserFixtureProfile,selectNativeBrowserFixtureStorage} from './native-browser-fixture-storage.mjs';
import {candidateDigest} from './native-retirement-evidence.mjs';
import {createIsolatedDownloadFixtures,nativeIsolatedDownloadsCanary} from './native-isolated-downloads-canary.mjs';
import {validateDisposableNativeTestProfile} from './native-test-profile.mjs';
import {retainStoreUpdateFixture} from './native-store-update-profile.mjs';
import {CEF_VERSION} from './prepare-native-chromium-runtime.mjs';

const store=process.env.KESTREL_TEST_REAL_CHROME_WEB_STORE==='1';
const requireExtensionParity=process.env.KESTREL_TEST_REQUIRE_CHROMIUM_EXTENSION_PARITY==='1';
const retainUpdateProfile=process.env.KESTREL_TEST_KEEP_STORE_UPDATE_PROFILE==='1';
assert(!requireExtensionParity||store,'Strict Chromium extension parity requires the real Store flow.');
assert(!retainUpdateProfile||(store&&!requireExtensionParity),'Store-update fixture retention requires a real Store preparation run, separate from strict extension acceptance.');
const fixtureStorage=await selectNativeBrowserFixtureStorage({candidate:resolve(process.env.KESTREL_NATIVE_TEST_APP||'.tmp/native-chromium-host/Kestrel.app'),root:process.cwd()});
const app=fixtureStorage.candidate;
const executable=join(app,'Contents/MacOS/Kestrel');
const workspaceFixture=process.env.KESTREL_TEST_NATIVE_WORKSPACE_FIXTURE==='1';
assert(!(fixtureStorage.mode==='production-vault'&&workspaceFixture),'Production-vault browser fixtures cannot seed a workspace before native vault initialization.');
const expectedChromium=CEF_VERSION.split('+chromium-')[1];
const evidence=resolve(process.env.KESTREL_NATIVE_DESKTOP_EVIDENCE||(retainUpdateProfile?`.tmp/chromium-store-update-evidence-${Date.now()}`:'.tmp/chromium-desktop-evidence'));
await mkdir(evidence,{recursive:true,mode:0o700});
if(retainUpdateProfile)assert.equal((await readdir(evidence)).length,0,'Store-update preparation requires a new empty evidence directory; preserve the previous checkpoint and receipt.');
const profile=await prepareNativeBrowserFixtureProfile({
 profile:await mkdtemp(join(tmpdir(),'kestrel-chromium-desktop-canary-')),storage:fixtureStorage,
});
const downloadPath=join(profile,'test-downloads');
if(fixtureStorage.mode==='test-key'){
 await mkdir(downloadPath,{mode:0o700});await mkdir(join(profile,'Default'),{mode:0o700});
 if(workspaceFixture)await prepareNativeWorkspaceFixture(profile);
 // CEF's Chrome profile is not an off-the-record context registered with the
 // Browser CDP handler. Configure its real preference before first startup so
 // the download canary writes only into this disposable profile.
 await writeFile(join(profile,'Default/Preferences'),JSON.stringify({download:{default_directory:downloadPath,prompt_for_download:false,directory_upgrade:true}}),{mode:0o600});
}
const {UserBrowserStateSchema}=await tsImport('../packages/shared-types/src/contracts.ts',import.meta.url);
const {isChromeWebStoreUrl}=await tsImport('../packages/shared-types/src/chrome-web-store.ts',import.meta.url);
const lifecycle=process.env.KESTREL_TEST_NATIVE_WINDOW_LIFECYCLE==='1';
const providers=process.env.KESTREL_TEST_NATIVE_PROVIDERS==='1';
const formatter='bcjindcccaagfpapjjmafapmmgkkhgoa';
// JSON Formatter is a content-only MV3 extension. Use the official uBO Lite
// Store package for the separate background-worker and action-popup probes.
const actionExtension='ddkjiahejlhfcafbddmgiahcphecmpfh';
const receipt={kind:'native-chromium-desktop-receipt',at:new Date().toISOString(),candidate:app,candidateSha256:fixtureStorage.candidateSha256,executableSha256:createHash('sha256').update(await readFile(executable)).digest('hex'),fixtureStorageMode:fixtureStorage.mode,storeRequested:store,extensionParityRequired:requireExtensionParity,lifecycleRequested:lifecycle,phases:[]};
const jsonFixture={source:'kestrel-native-canary',nested:{installedExtensionRuns:true},values:[1,2,3]};
const isolationFixtures=createIsolationFixtures();
const isolatedDownloadFixtures=createIsolatedDownloadFixtures();
const server=createServer((req,res)=>{
 if(isolatedDownloadFixtures.handle(req,res))return;
 if(isolationFixtures.handle(req,res))return;
 if(req.url==='/actions'){
  res.writeHead(200,{'content-type':'text/html'});res.end(`<!doctype html><title>Native browser action canary</title><style>body{min-height:2600px;background:#f6f6f6;font:18px system-ui;padding:20px}input,button,select{font:inherit;margin:10px;padding:10px}</style><h1>Native browser action canary</h1>
  <label>Public query<input id="query" name="query" autocomplete="off"></label><button id="add">Add one</button><p id="click-result">0</p>
  <label>Country<select id="country"><option value="first">First</option><option value="second">Second</option></select></label><p id="selection-result">first</p>
  <script>query.addEventListener('input',event=>window.nativeTrustedInput=event.isTrusted);query.addEventListener('keydown',event=>{if(event.key==='Enter')window.nativeTrustedKey=event.isTrusted});query.addEventListener('keypress',event=>{if(event.key==='Enter')window.nativeTrustedKeypress=event.isTrusted});add.addEventListener('click',event=>{window.nativeTrustedClick=event.isTrusted;document.querySelector('#click-result').textContent=String(Number(document.querySelector('#click-result').textContent)+1)});country.addEventListener('change',()=>document.querySelector('#selection-result').textContent=country.value);</script>`);return;
 }
 if(req.url==='/visual'){res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Native screenshot canary</title><style>body{background:#e8edf2;color:#20242a;font:24px system-ui;padding:40px}</style><h1>Native screenshot canary</h1><p>Public static content captured through Chromium and validated inside Core.</p>');return;}
 if(req.url==='/formatter.json'||req.url.startsWith('/formatter.json?')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(jsonFixture));return;}
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
let child,browser,output='',profileRetained=false,uiActionPage;
let savedSession,providerEvidence,workspaceEvidence;
function ownedNodeProcesses(){
 const rows=execFileSync('/bin/ps',['-axo','pid=,ppid=,comm='],{encoding:'utf8'}).trim().split('\n').map(line=>line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean);
 const owned=new Set([child.pid]);let changed=true;
 while(changed){changed=false;for(const row of rows)if(owned.has(Number(row[2]))&&!owned.has(Number(row[1]))){owned.add(Number(row[1]));changed=true;}}
 return rows.filter(row=>owned.has(Number(row[1]))&&row[3].endsWith('/node')).map(row=>({pid:Number(row[1]),ppid:Number(row[2])}));
}
async function start(){
 output='';
 child=spawn(executable,['--kestrel-chromium-desktop','--kestrel-cache-path',profile,'--kestrel-durable-profile',...nativeBrowserFixtureStorageArgs(fixtureStorage),'--remote-debugging-port=0'],{stdio:['ignore','pipe','pipe'],env:nativeBrowserFixtureStorageEnv(fixtureStorage)});
 child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 let endpoint;
 for(let i=0;i<200;i++){
  assert.equal(child.exitCode,null,output);
  endpoint=output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+)/)?.[1];
  if(endpoint)break;await delay(100);
 }
 assert(endpoint,'Owned native endpoint missing: '+output);
 browser=await chromium.connectOverCDP(endpoint,{noDefaults:true});
 const observedVersion=browser.version();
 assert.equal(observedVersion,expectedChromium,'The running Chromium version must match the verified runtime pin.');
 (receipt.observedChromiumVersions??=[]).push(observedVersion);
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
 await waitForCandidateStop();
 (receipt.stops??=[]).push({pid:child.pid,exitCode:result.code,signal:result.signal,forced:false,candidateProcessesStopped:true});
 await browser.close().catch(()=>{});browser=undefined;
 await writeFile(join(evidence,'runtime.log'),output);
}
async function waitForCandidateStop(){
 const deadline=Date.now()+10_000;
 for(;;){
  try{assertNativeBrowserFixtureStopped(fixtureStorage);return;}
  catch(error){if(Date.now()>=deadline)throw error;}
  await delay(100);
 }
}
async function ownedUiDiagnostics(page) {
 return Promise.race([page.evaluate(async () => {
  const button=document.querySelector('button[aria-label="Open settings"]');
  const bounds=button?.getBoundingClientRect(),style=button&&getComputedStyle(button);
  const hit=bounds&&document.elementFromPoint(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
  const current=await chrome.tabs.getCurrent();
  const active=current&&await chrome.tabs.query({active:true,windowId:current.windowId});
  const window=current&&await chrome.windows.get(current.windowId);
  const rafTicks=await new Promise(resolveTicks=>{
   let ticks=0;const timer=setTimeout(()=>resolveTicks(ticks),750);
   const tick=()=>{if(++ticks===2){clearTimeout(timer);resolveTicks(ticks);}else requestAnimationFrame(tick);};requestAnimationFrame(tick);
  });
  return {visibility:document.visibilityState,hasFocus:document.hasFocus(),rafTicks,
   tabId:current?.id,windowId:current?.windowId,ownTabActive:active?.length===1&&active[0].id===current.id,windowFocused:window?.focused,
   button:button?{disabled:button.disabled,width:bounds.width,height:bounds.height,x:bounds.x,y:bounds.y,
    display:style.display,visibility:style.visibility,opacity:style.opacity,centerHitsButton:hit===button||button.contains(hit)}:null};
 }).catch(()=>({unavailable:true})),delay(2000,{diagnosticTimeout:true},{ref:false})]);
}
async function activateOwnedUi(page) {
 const tab=await page.evaluate(async()=>{
  const current=await chrome.tabs.getCurrent();
  if(!Number.isInteger(current?.id)||!Number.isInteger(current?.windowId))throw Error('Owned UI has no native tab.');
  await chrome.tabs.update(current.id,{active:true});
  await chrome.windows.update(current.windowId,{focused:true});
  return{id:current.id,windowId:current.windowId};
 });
 await page.bringToFront();
 await page.waitForFunction(async({id,windowId})=>{
  const active=await chrome.tabs.query({active:true,windowId});
  const response=await window.kestrel.request({type:'browser-get-state'});
  const stored=await chrome.storage.session.get('kestrel.native.browser.tabIds.v1');
  return active.length===1&&active[0].id===id&&response.ok&&response.browserState.activeTabId===stored['kestrel.native.browser.tabIds.v1']?.[String(id)];
 },tab,{polling:100,timeout:10000});
 return tab;
}
async function inspectActionPopup(endpoint, expectedUrl){
 const socket=new WebSocket(endpoint),pending=new Map();let nextId=0;
 let popupTargetId;
 socket.addEventListener('message',event=>{const message=JSON.parse(event.data),waiter=pending.get(message.id);if(!waiter)return;pending.delete(message.id);clearTimeout(waiter.timer);if(message.error)waiter.reject(Error(message.error.message));else waiter.resolve(message.result);});
 const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++nextId,timer=setTimeout(()=>{pending.delete(id);reject(Error(`CDP ${method} timed out`));},5000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Popup inspector connection timed out.')),5000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});socket.addEventListener('error',error=>{clearTimeout(timer);reject(error);},{once:true});});
  let target;
  for(let i=0;i<50;i++){target=(await send('Target.getTargets')).targetInfos.find(item=>item.type==='page'&&item.url===expectedUrl);if(target)break;await delay(100);}
  if(!target)return{observed:false,reason:'The extension action popup target did not open.'};
  popupTargetId=target.targetId;
  const attached=await send('Target.attachToTarget',{targetId:target.targetId,flatten:true});
  const evaluated=await send('Runtime.evaluate',{expression:'({title:document.title,body:document.body?.innerText||"",kestrel:typeof window.kestrel,nativeQuery:typeof window.__kestrelNativeQuery,nativeTransport:typeof window.__kestrelHostTransport})',returnByValue:true},attached.sessionId);
  const value=evaluated.result?.value;
  const isolated=value&&value.kestrel==='undefined'&&value.nativeQuery==='undefined'&&value.nativeTransport==='undefined';
  const screenshot=await send('Page.captureScreenshot',{format:'png'},attached.sessionId).catch(()=>undefined);
  if(screenshot?.data)await writeFile(join(evidence,'native-extension-action-popup.png'),Buffer.from(screenshot.data,'base64'));
  await send('Target.detachFromTarget',{sessionId:attached.sessionId}).catch(()=>{});
  await send('Target.closeTarget',{targetId:target.targetId}).catch(()=>{});
  return{observed:true,targetId:target.targetId,url:target.url,title:value?.title,isolated,bridgeTypes:value};
 }finally{if(popupTargetId)await send('Target.closeTarget',{targetId:popupTargetId}).catch(()=>{});for(const waiter of pending.values()){clearTimeout(waiter.timer);waiter.reject(Error('Popup inspector closed'));}socket.close();}
}
try{
 let {context,home,endpoint}=await start();
 if(fixtureStorage.mode==='production-vault'){
  // The native host must create the production vault in an otherwise empty
  // profile. Add the canary's browser download preference only after that first
  // clean stop, then restart before any acceptance checks begin.
  await close();
  await captureNativeBrowserFixtureStorage({profile,storage:fixtureStorage});
  await mkdir(downloadPath,{mode:0o700});
  const preferencesPath=join(profile,'Default/Preferences'),preferencesInfo=await lstat(preferencesPath);
  assert(preferencesInfo.isFile()&&!preferencesInfo.isSymbolicLink()&&preferencesInfo.uid===process.getuid()&&preferencesInfo.nlink===1&&preferencesInfo.size<=8*1024*1024);
  const preferencesBytes=await readFile(preferencesPath);assert(preferencesBytes.length<=8*1024*1024);
  const preferences=JSON.parse(preferencesBytes.toString('utf8'));
  preferences.download={...preferences.download,default_directory:downloadPath,prompt_for_download:false,directory_upgrade:true};
  await writeFile(preferencesPath,JSON.stringify(preferences),{mode:0o600});
  ({context,home,endpoint}=await start());
 }
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
 if(process.env.KESTREL_TEST_NATIVE_ISOLATED_DOWNLOADS==='1')await nativeIsolatedDownloadsCanary({coreTool,origin:`http://127.0.0.1:${server.address().port}`,fixtures:isolatedDownloadFixtures,receipt});
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
 await (await createdPage(url=>url===fixtureUrl)).close();
 home=await createdPage(url=>/^chrome-extension:\/\/[^/]+\/index\.html$/.test(url));
 uiActionPage=home;
 receipt.settingsActivationBefore=await ownedUiDiagnostics(home);
 receipt.settingsActivation=await activateOwnedUi(home);
 receipt.settingsActivationAfter=await ownedUiDiagnostics(home);
 await home.getByRole('button',{name:'Open settings',exact:true}).click();
 uiActionPage=undefined;
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
  await home.locator('.kestrel-sidebar').waitFor();
  await home.locator('#new-tab-title').waitFor();
  const reopenedTargets=await browser.newBrowserCDPSession();
  const reopenedHomes=(await reopenedTargets.send('Target.getTargets')).targetInfos.filter(target=>target.type==='page'&&/chrome-extension:\/\/[^/]+\/index.html$/.test(target.url));
  await reopenedTargets.detach();
  assert.equal(reopenedHomes.length,1,'Native New Window must not duplicate restored Kestrel Home');
  assert((await home.evaluate(()=>window.kestrel.request({type:'runtime-list-sessions'}))).sessions.some(session=>session.id===savedSession));
  assert.deepEqual(nodeDescendants(),coreProcesses,'Reopening Home must reuse the same Core.');
  receipt.phases.push({phase:'native-last-window-close-and-reopen',passed:true,coreProcesses});
 }
 if(store){
  // The provider companion phase already opened its own Store fixture tab.
  // Close only those tabs in this disposable profile before measuring one
  // fresh activation; an all-tabs count otherwise mistakes the two phases
  // for duplicate delivery by the product.
  const previousStoreState=await home.evaluate(()=>window.kestrel.request({type:'browser-get-state'}));
  for(const tab of previousStoreState.browserState.tabs.filter(tab=>isChromeWebStoreUrl(tab.url))){const closed=await home.evaluate(tabId=>window.kestrel.request({type:'browser-close-tab',tabId}),tab.id);assert(closed.ok,closed.error);}
  await settings.getByRole('link',{name:/Browse Chrome Web Store/}).click();
  const listing=await createdPage(isChromeWebStoreUrl);
  const storeState=await home.evaluate(()=>window.kestrel.request({type:'browser-get-state'}));
  const storeTabs=storeState.browserState.tabs.filter(tab=>isChromeWebStoreUrl(tab.url));
  assert.equal(storeTabs.length,1,'One Store activation must create exactly one Store tab.');
  const selectedStore=await home.evaluate(tabId=>window.kestrel.request({type:'browser-select-tab',tabId}),storeTabs[0].id);assert(selectedStore.ok,selectedStore.error);
  await listing.goto(`https://chromewebstore.google.com/detail/json-formatter/${formatter}`,{waitUntil:'domcontentloaded'});
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
  const recommendation=listing.getByRole('button',{name:'No thanks',exact:true});if(await recommendation.isVisible())await recommendation.click();
  await listing.getByRole('button',{name:'Add to Chrome',exact:true}).click();
  console.log('OWNED_CHROMIUM_STORE_READY: native JSON Formatter install prompt can now be exercised in the visible candidate.');
  let installed;
  for(let i=0;i<6000;i++){const result=await home.evaluate(()=>window.kestrel.request({type:'browser-list-extensions'}));installed=result.extensions?.find(item=>item.id===formatter&&item.enabled);if(installed)break;assert.equal(child.exitCode,null,output);await delay(100);}
  assert(installed,'Native Store installation was not observed.');
  receipt.phases.push({phase:'native-web-store-install',passed:true,extension:{id:installed.id,version:installed.version,enabled:installed.enabled},windowIds,panelTarget:panel.targetId});
  await formatterRuns('native-extension-functional');
  const actionListingCreated=await home.evaluate(url=>window.kestrel.request({type:'browser-create-tab',input:url}),`https://chromewebstore.google.com/detail/ublock-origin-lite/${actionExtension}`);assert(actionListingCreated.ok,actionListingCreated.error);
  const actionListing=await createdPage(url=>url.includes(`/detail/ublock-origin-lite/${actionExtension}`));
  const actionListingState=await home.evaluate(()=>window.kestrel.request({type:'browser-get-state'}));
  const actionListingTab=actionListingState.browserState.tabs.find(tab=>tab.url.includes(actionExtension));assert(actionListingTab);
  const actionSelected=await home.evaluate(tabId=>window.kestrel.request({type:'browser-select-tab',tabId}),actionListingTab.id);assert(actionSelected.ok,actionSelected.error);
  await actionListing.getByRole('button',{name:'Add to Chrome',exact:true}).waitFor();
  await actionListing.getByRole('button',{name:'Add to Chrome',exact:true}).click();
  await writeFile(join(evidence,'receipt.json'),JSON.stringify({...receipt,awaitingNativeInstall:true,awaitingExtensionId:actionExtension},null,2));
  console.log('OWNED_CHROMIUM_ACTION_EXTENSION_READY: native uBlock Origin Lite install prompt can now be exercised in the visible candidate.');
  let actionInstalled;
  for(let i=0;i<6000;i++){const result=await home.evaluate(()=>window.kestrel.request({type:'browser-list-extensions'}));actionInstalled=result.extensions?.find(item=>item.id===actionExtension&&item.enabled);if(actionInstalled)break;assert.equal(child.exitCode,null,output);await delay(100);}
  assert(actionInstalled,'Official action-extension Store installation was not observed.');
  receipt.phases.push({phase:'native-action-extension-web-store-install',passed:true,extension:{id:actionInstalled.id,version:actionInstalled.version,enabled:actionInstalled.enabled}});
  const extensionParity={extensions:{content:{id:installed.id,version:installed.version,storeInstalled:true},action:{id:actionInstalled.id,version:actionInstalled.version,storeInstalled:true}},checks:{storeInstall:true,extensionCreatedTabs:false,toolbarActionPopup:false,chromeManagerDisableReenable:false,storePersistence:false,storeVersionUpgrade:false},missing:[],updateCheck:{extensionId:actionExtension,status:'not-attempted',installedVersionBefore:actionInstalled.version,reportedVersion:null,installedVersionAfter:actionInstalled.version}};
  const missing=(capability,detail)=>extensionParity.missing.push({capability,detail});
  let manifest,extensionWorker;
  try{
   for(let i=0;i<100&&!extensionWorker;i++){
    extensionWorker=context.serviceWorkers().find(item=>item.url().startsWith(`chrome-extension://${actionExtension}/`));
    if(!extensionWorker&&i%20===0){
     const discovery=await browser.newBrowserCDPSession();const targets=await discovery.send('Target.getTargets');await discovery.detach();
     if(targets.targetInfos.some(target=>target.type==='service_worker'&&target.url.startsWith(`chrome-extension://${actionExtension}/`))){await browser.close();browser=await chromium.connectOverCDP(endpoint,{noDefaults:true});context=browser.contexts()[0];home=context.pages().find(page=>/chrome-extension:\/\/[^/]+\/index.html$/.test(page.url()));}
    }
    if(!extensionWorker)await delay(100);
   }
   if(extensionWorker)manifest=await extensionWorker.evaluate(()=>chrome.runtime.getManifest());
  }catch(error){missing('installed-extension-manifest-or-worker',String(error));}
  if(!extensionWorker)missing('extension-service-worker','Installed uBO Lite has no observable MV3 service worker for tab/action/update API probes.');
  extensionParity.manifestEvidence=manifest?{extensionId:actionExtension,version:manifest.version,manifestVersion:manifest.manifest_version,permissions:manifest.permissions??[],optionalPermissions:manifest.optional_permissions??[],action:manifest.action??manifest.browser_action??null}:null;
  let popupWindowId;
  try{
   const currentNativeTab=await home.evaluate(()=>new Promise(resolve=>chrome.tabs.getCurrent(tab=>resolve(tab?{id:tab.id,windowId:tab.windowId}:null))));
   if(Number.isSafeInteger(currentNativeTab?.windowId))popupWindowId=currentNativeTab.windowId;
  }catch{}
  if(!Number.isSafeInteger(popupWindowId))missing('toolbar-action-popup','Could not obtain the actual Chrome window id from Kestrel’s first-party extension page.');
  let ownedTabId,ownedTabUrl;
  if(extensionWorker){
   ownedTabUrl=`http://127.0.0.1:${server.address().port}/formatter.json?extension-owned=${Date.now()}`;
   let createdByExtension;
   try{createdByExtension=await extensionWorker.evaluate(async url=>{try{const tab=await chrome.tabs.create({url,active:false});return{ok:true,id:tab.id,windowId:tab.windowId,url:tab.url??tab.pendingUrl};}catch(error){return{ok:false,error:String(error)};}},ownedTabUrl);}catch(error){createdByExtension={ok:false,error:String(error)};}
   if(!createdByExtension?.ok||!Number.isSafeInteger(createdByExtension.id))missing('extension-created-tab-ownership',createdByExtension?.error??'The extension worker did not create a real tab.');
   else{
    ownedTabId=createdByExtension.id;
    try{
     const adopted=await createdPage(url=>url===ownedTabUrl);
     // createdPage may reconnect Playwright to attach a CEF-created target;
     // refresh the worker handle from the newly attached context.
     extensionWorker=context.serviceWorkers().find(item=>item.url().startsWith(`chrome-extension://${actionExtension}/`));
     if(!extensionWorker)throw Error('The extension worker disappeared while attaching its created tab.');
     let adoptedByKestrel=false;
     for(let i=0;i<60;i++){const state=await home.evaluate(()=>window.kestrel.request({type:'browser-get-state'}));adoptedByKestrel=state.ok&&state.browserState.tabs.some(tab=>tab.url===ownedTabUrl);if(adoptedByKestrel)break;await delay(100);}
     const sameWindow=Number.isSafeInteger(popupWindowId)&&createdByExtension.windowId===popupWindowId;
     const updatedUrl=`http://127.0.0.1:${server.address().port}/canary?extension-updated=${Date.now()}`;
     const updated=await extensionWorker.evaluate(async ({id,url})=>{try{const tab=await chrome.tabs.update(id,{url});return{ok:true,url:tab.url??tab.pendingUrl};}catch(error){return{ok:false,error:String(error)};}},{id:ownedTabId,url:updatedUrl});
     let updateAdopted=false;
     if(updated.ok)for(let i=0;i<60;i++){const state=await home.evaluate(()=>window.kestrel.request({type:'browser-get-state'}));updateAdopted=state.ok&&state.browserState.tabs.some(tab=>tab.url===updatedUrl);if(updateAdopted)break;await delay(100);}
     await extensionWorker.evaluate(async id=>chrome.tabs.remove(id),ownedTabId);ownedTabId=undefined;
     let removedFromKestrel=false;
     for(let i=0;i<60;i++){const state=await home.evaluate(()=>window.kestrel.request({type:'browser-get-state'}));removedFromKestrel=state.ok&&!state.browserState.tabs.some(tab=>tab.url===ownedTabUrl||tab.url===updatedUrl);if(removedFromKestrel)break;await delay(100);}
     extensionParity.checks.extensionCreatedTabs=adoptedByKestrel&&sameWindow&&updated.ok&&updateAdopted&&removedFromKestrel;
     extensionParity.extensionCreatedTabEvidence={extensionId:actionExtension,created:true,adoptedByKestrel,sameWindow,updated:updated.ok,updateAdopted,removedFromKestrel,chromeWindowId:createdByExtension.windowId};
     if(!extensionParity.checks.extensionCreatedTabs)missing('extension-created-tab-ownership',JSON.stringify(extensionParity.extensionCreatedTabEvidence));
     await adopted.close().catch(()=>{});
    }catch(error){
     if(ownedTabId!==undefined){await extensionWorker.evaluate(async id=>{try{await chrome.tabs.remove(id);}catch{}},ownedTabId).catch(()=>{});ownedTabId=undefined;}
     missing('extension-created-tab-ownership',String(error));
    }
   }
  }
  const popupPath=manifest?.action?.default_popup??manifest?.browser_action?.default_popup;
  if(!extensionWorker||!popupPath)missing('toolbar-action-popup',!extensionWorker?'No observable extension worker was available to open the real action popup.':'Installed uBO Lite manifest does not declare a popup page.');
  else if(!extensionWorker.evaluate)missing('toolbar-action-popup','The installed service worker cannot be inspected.');
  else if(!Number.isSafeInteger(popupWindowId))missing('toolbar-action-popup','No actual Chrome window id was available for the popup probe.');
  else{
   let actionResult;
   try{actionResult=await extensionWorker.evaluate(async windowId=>{try{if(typeof chrome.action?.openPopup!=='function')return{ok:false,error:'chrome.action.openPopup is unavailable.'};await chrome.windows.update(windowId,{focused:true});const targetWindow=await chrome.windows.get(windowId);if(!targetWindow.focused)return{ok:false,error:'The native browser window did not become focused.'};await chrome.action.openPopup({windowId});return{ok:true,windowFocused:true,chromeWindowId:windowId};}catch(error){return{ok:false,error:String(error)};}},popupWindowId);}catch(error){actionResult={ok:false,error:String(error)};}
   const expectedPopup=new URL(popupPath,`chrome-extension://${actionExtension}/`).toString();
   let popup;
   if(actionResult.ok)popup=await inspectActionPopup(endpoint,expectedPopup);
   extensionParity.checks.toolbarActionPopup=Boolean(actionResult.ok&&popup?.observed&&popup.isolated);
   extensionParity.toolbarActionPopupEvidence={extensionId:actionExtension,actionResult,popup:popup??{observed:false,reason:'Popup action was not opened.'}};
   if(!extensionParity.checks.toolbarActionPopup)missing('toolbar-action-popup',JSON.stringify(extensionParity.toolbarActionPopupEvidence));
  }

  let manager,managerFailure,managerState,activateManager;
  try{
   const managerUrl='chrome://extensions/';
   const managerCreated=await home.evaluate(url=>window.kestrel.request({type:'browser-create-tab',input:url}),managerUrl);assert(managerCreated.ok,managerCreated.error);
   manager=await createdPage(url=>url===managerUrl);
   manager.setDefaultTimeout(5000);manager.setDefaultNavigationTimeout(15_000);
   await manager.locator('extensions-manager').waitFor({timeout:15_000});
   managerState=async()=>Promise.race([manager.evaluate(id=>{
    const pending=[document];let item;
    while(pending.length&&!item){const root=pending.shift();if(!root?.querySelectorAll)continue;for(const element of root.querySelectorAll('extensions-item'))if(element.data?.id===id){item=element;break;}for(const element of root.querySelectorAll('*'))if(element.shadowRoot)pending.push(element.shadowRoot);}
    const toggle=item?.shadowRoot?.querySelector('#enableToggle');
    return item?{found:true,name:item.data?.name??'',enabled:typeof toggle?.checked==='boolean'?toggle.checked:undefined}:{found:false};
   },formatter),delay(5000).then(()=>{throw Error('Chrome manager state read exceeded 5 seconds.');})]);
   activateManager=async()=>{
    // createdPage can reconnect CDP when a native-created target was missed.
    // Reacquire both the page and locator after every such discovery.
    manager=await createdPage(url=>url===managerUrl);
    const state=await home.evaluate(()=>window.kestrel.request({type:'browser-get-state'}));
    const tab=state.browserState?.tabs.find(tab=>tab.url===managerUrl);assert(tab,'Chrome manager tab was not adopted into the native browser state.');
    const selected=await home.evaluate(tabId=>window.kestrel.request({type:'browser-select-tab',tabId}),tab.id);assert(selected.ok,selected.error);
    const selectedState=await home.evaluate(()=>window.kestrel.request({type:'browser-get-state'}));assert.equal(selectedState.browserState.activeTabId,tab.id,'Chrome manager must be the active native tab before pointer interaction.');
    await manager.bringToFront();
   };
   await activateManager();
   let current=await managerState();
   if(!current.found||typeof current.enabled!=='boolean')throw Error('Chrome manager did not expose this extension item and its real enable toggle.');
   let toggle=manager.locator('extensions-item').filter({hasText:current.name}).locator('#enableToggle');
   if(await toggle.count()!==1)throw Error('Chrome manager enable-toggle control selector did not match exactly one extension control.');
   if(current.enabled){await toggle.click();for(let i=0;i<60;i++){current=await managerState();if(current.enabled===false)break;await delay(100);}}
   const disabled=await home.evaluate(()=>window.kestrel.request({type:'browser-list-extensions'}));
   assert(current.enabled===false&&disabled.ok&&disabled.extensions?.some(item=>item.id===formatter&&!item.enabled),'Chrome manager did not disable the installed extension.');
   const disabledUrl=`http://127.0.0.1:${server.address().port}/formatter.json?manager-disabled=${Date.now()}`;
   const disabledTab=await home.evaluate(url=>window.kestrel.request({type:'browser-create-tab',input:url}),disabledUrl);assert(disabledTab.ok,disabledTab.error);
   const disabledPage=await createdPage(url=>url===disabledUrl);await delay(1500);
   const disabledStillTransforms=await disabledPage.evaluate(()=>window.json?.source==='kestrel-native-canary');
   const disabledState=await home.evaluate(()=>window.kestrel.request({type:'browser-get-state'}));
   const disabledTabId=disabledState.browserState?.tabs.find(tab=>tab.url===disabledUrl)?.id;assert(disabledTabId,'Could not identify the manager-disabled probe tab.');
   const disabledClose=await home.evaluate(tabId=>window.kestrel.request({type:'browser-close-tab',tabId}),disabledTabId);assert(disabledClose.ok,disabledClose.error);
   if(disabledStillTransforms)throw Error('JSON Formatter continued injecting while disabled in Chrome manager.');
   await activateManager();
   toggle=manager.locator('extensions-item').filter({hasText:current.name}).locator('#enableToggle');
   await toggle.click();for(let i=0;i<60;i++){current=await managerState();const listed=await home.evaluate(()=>window.kestrel.request({type:'browser-list-extensions'}));if(current.enabled===true&&listed.extensions?.some(item=>item.id===formatter&&item.enabled))break;await delay(100);}
   assert(current.enabled===true,'Chrome manager did not re-enable the extension.');
   const enabledListing=await home.evaluate(()=>window.kestrel.request({type:'browser-list-extensions'}));assert(enabledListing.extensions?.some(item=>item.id===formatter&&item.enabled),'Kestrel did not observe manager re-enable.');
   await formatterRuns('native-extension-functional-after-chrome-manager-toggle');
   extensionParity.checks.chromeManagerDisableReenable=!disabledStillTransforms;
   extensionParity.chromeManagerEvidence={extensionId:formatter,disabledVisibleInKestrel:true,disabledRuntimeInactive:!disabledStillTransforms,reenabledVisibleInKestrel:true,runtimeRestored:true};
  }catch(error){managerFailure=String(error);extensionParity.chromeManagerEvidence={error:managerFailure};missing('chrome-manager-disable-reenable',managerFailure);}
  finally{
   try{
    const listed=await home.evaluate(()=>window.kestrel.request({type:'browser-list-extensions'}));
    if(listed.extensions?.some(item=>item.id===formatter&&!item.enabled)){
     await activateManager?.();
     const current=await managerState?.();
     if(current.enabled===false){const toggle=manager.locator('extensions-item').filter({hasText:current.name}).locator('#enableToggle');if(await toggle.count()===1)await toggle.click();}
    }
   }catch{}
   await manager?.close().catch(()=>{});
  }
  if(extensionParity.chromeManagerEvidence&&!extensionParity.checks.chromeManagerDisableReenable&&extensionParity.chromeManagerEvidence.error===undefined)missing('chrome-manager-disable-reenable',JSON.stringify(extensionParity.chromeManagerEvidence));

  const workerAfterManager=context.serviceWorkers().find(item=>item.url().startsWith(`chrome-extension://${actionExtension}/`));
  if(!workerAfterManager)missing('store-update-check','No active official extension service worker was available after Chrome manager re-enable.');
  else{
   const updateResult=await workerAfterManager.evaluate(()=>new Promise(resolve=>{
    const installedVersion=chrome.runtime.getManifest().version;
    if(typeof chrome.runtime.requestUpdateCheck!=='function'){resolve({status:'unavailable',installedVersion,reportedVersion:null,error:'chrome.runtime.requestUpdateCheck is unavailable.'});return;}
    const timer=setTimeout(()=>resolve({status:'timeout',installedVersion,reportedVersion:null,error:'Chrome update check callback timed out.'}),30_000);
    try{chrome.runtime.requestUpdateCheck((status,details)=>{clearTimeout(timer);resolve({status,installedVersion,reportedVersion:typeof details?.version==='string'&&details.version.trim()?details.version:null});});}
    catch(error){clearTimeout(timer);resolve({status:'error',installedVersion,reportedVersion:null,error:String(error)});}
   }));
   extensionParity.updateCheck={extensionId:actionExtension,...updateResult,installedVersionBefore:actionInstalled.version,installedVersionAfter:actionInstalled.version};
   if(updateResult.status==='update_available'&&typeof updateResult.reportedVersion==='string'){
    for(let i=0;i<180;i++){const result=await home.evaluate(()=>window.kestrel.request({type:'browser-list-extensions'}));const current=result.extensions?.find(item=>item.id===actionExtension);if(current?.version===updateResult.reportedVersion){extensionParity.updateCheck.installedVersionAfter=current.version;break;}await delay(1000);}
    extensionParity.checks.storeVersionUpgrade=extensionParity.updateCheck.installedVersionAfter===updateResult.reportedVersion&&extensionParity.updateCheck.installedVersionAfter!==actionInstalled.version;
   }else missing('published-store-version-upgrade',`Observed requestUpdateCheck status=${updateResult.status}; reportedVersion=${updateResult.reportedVersion??'none'}; no version upgrade was observed.`);
   const afterCheck=await home.evaluate(()=>window.kestrel.request({type:'browser-list-extensions'}));
   extensionParity.updateCheck.installedVersionAfter=afterCheck.extensions?.find(item=>item.id===actionExtension)?.version??extensionParity.updateCheck.installedVersionAfter;
   extensionParity.updateCheck.checkSucceeded=updateResult.status==='no_update'||updateResult.status==='update_available';
   extensionParity.updateCheck.currentVersionConfirmed=updateResult.status==='no_update'&&extensionParity.updateCheck.installedVersionAfter===actionInstalled.version;
   if(updateResult.status==='update_available'&&extensionParity.updateCheck.installedVersionAfter!==updateResult.reportedVersion)missing('published-store-version-upgrade',`Chrome reported ${updateResult.reportedVersion}, but the installed version was ${extensionParity.updateCheck.installedVersionAfter}.`);
   extensionParity.updateCheck.observedVersionUpgrade=extensionParity.checks.storeVersionUpgrade;
   if(updateResult.status==='throttled')extensionParity.updateCheck.throttledIsFailure=true;
  }
  receipt.extensionParity=extensionParity;
  receipt.extensionParity.missing=extensionParity.missing;
  receipt.extensionParity.passed=Object.values(extensionParity.checks).every(Boolean);
  receipt.phases.push({phase:'native-chromium-extension-parity-after-official-store-install',passed:receipt.extensionParity.passed,checks:extensionParity.checks,missing:extensionParity.missing,updateCheck:extensionParity.updateCheck});
  if(!receipt.extensionParity.passed)console.log(`Native Chromium extension parity INCOMPLETE: ${extensionParity.missing.map(item=>item.capability).join(', ')||'required check not passed'}.`);
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
 if(store){
  const extensions=await restarted.home.evaluate(()=>window.kestrel.request({type:'browser-list-extensions'}));
  const installed=extensions.extensions?.find(item=>item.id===formatter),actionInstalled=extensions.extensions?.find(item=>item.id===actionExtension);
  assert(installed?.enabled,'Chrome-installed content extension must survive full restart.');
  assert(actionInstalled?.enabled,'Chrome-installed action extension must survive full restart.');
  await formatterRuns('native-extension-functional-after-restart');
  receipt.phases.push({phase:'native-extension-restart',passed:true,id:installed.id,version:installed.version,actionExtension:{id:actionInstalled.id,version:actionInstalled.version,enabled:actionInstalled.enabled}});
  if(receipt.extensionParity){receipt.extensionParity.checks.storePersistence=true;receipt.extensionParity.restartEvidence={extensionId:formatter,installed:true,enabled:installed.enabled,version:installed.version,functionalAfterRestart:true,actionExtension:{id:actionInstalled.id,version:actionInstalled.version,enabled:actionInstalled.enabled}};receipt.extensionParity.passed=Object.values(receipt.extensionParity.checks).every(Boolean);receipt.phases.push({phase:'native-chromium-extension-parity-final',passed:receipt.extensionParity.passed,checks:receipt.extensionParity.checks,missing:receipt.extensionParity.missing,updateCheck:receipt.extensionParity.updateCheck,restartEvidence:receipt.extensionParity.restartEvidence});}
  if(retainUpdateProfile){
   const provenance=await home.evaluate(ids=>Promise.all(ids.map(id=>new Promise((resolve,reject)=>chrome.management.get(id,item=>{const error=chrome.runtime.lastError;if(error)reject(Error(error.message));else resolve({id:item.id,version:item.version,enabled:item.enabled,installType:item.installType});})))),[formatter,actionExtension]);
   receipt.phases.push({phase:'native-store-update-fixture-provenance',passed:provenance.every(item=>item.enabled&&item.installType==='normal'),extensions:provenance});
  }
 }
 await close();receipt.phases.push({phase:'durable-core-and-clean-restart',passed:true});
 const storageEvidence=await captureNativeBrowserFixtureStorage({profile,storage:fixtureStorage});
 receipt.fixtureStorage=storageEvidence;
 receipt.candidateSha256After=await candidateDigest(app);
 assert.equal(receipt.candidateSha256After,receipt.candidateSha256,'The candidate bundle changed during native desktop verification.');
 assert(!requireExtensionParity||receipt.extensionParity?.passed,'Required Chromium extension parity is incomplete; inspect the candidate-bound receipt for missing capabilities.');
 if(retainUpdateProfile)receipt.storeUpdateFixture={profileRoot:fixtureStorage.mode==='test-key'?await validateDisposableNativeTestProfile(profile):profile,checkpointPath:join(evidence,'store-update-checkpoint.json')};
 await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2),{mode:0o600});
 if(retainUpdateProfile){await retainStoreUpdateFixture({profile,receiptPath:join(evidence,'receipt.json'),checkpointPath:receipt.storeUpdateFixture.checkpointPath,storageEvidence,root:process.cwd()});profileRetained=true;console.log('STORE_UPDATE_FIXTURE_RETAINED: '+receipt.storeUpdateFixture.checkpointPath+'; a real published-version upgrade remains a separate acceptance check.');}
 console.log('Native Chromium desktop passed: real Kestrel Home/Settings, Core tab tools and approval enforcement, native tabs, web bridge isolation, durable restart, and clean shutdown'+(store?', plus native Store install and functional extension restart.':'.'));
}catch(error){
 const info=await lstat(executable).catch(()=>undefined);
 if(info)receipt.failedCandidateFileState={uid:info.uid,expectedUid:process.getuid(),mode:info.mode,nlink:info.nlink,nlinkType:typeof info.nlink,isFile:info.isFile(),isSymbolicLink:info.isSymbolicLink()};
 if(uiActionPage){receipt.failedUiState=await ownedUiDiagnostics(uiActionPage);await uiActionPage.screenshot({path:join(evidence,'failed-ui.png'),timeout:5000}).catch(()=>{});}
 await writeFile(join(evidence,'failure.log'),output+'\n'+String(error));await writeFile(join(evidence,'receipt.json'),JSON.stringify({...receipt,failed:String(error)},null,2));throw error;
}
finally{
 await browser?.close().catch(()=>{});
 if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));}
 await new Promise(resolve=>server.close(resolve));
 if(!profileRetained){
  try{await waitForCandidateStop();await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
  catch(error){console.error('Generated fixture retained because candidate shutdown or cleanup could not be verified: '+profile);throw error;}
 }
}
