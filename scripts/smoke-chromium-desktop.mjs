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

const app=resolve(process.env.KESTREL_NATIVE_TEST_APP||'.tmp/native-chromium-host/Kestrel.app');
const executable=join(app,'Contents/MacOS/Kestrel');
const profile=await mkdtemp(join(tmpdir(),'kestrel-chromium-desktop-canary-'));
const evidence=resolve('.tmp/chromium-desktop-evidence');
await mkdir(evidence,{recursive:true});
const {UserBrowserStateSchema}=await tsImport('../packages/shared-types/src/contracts.ts',import.meta.url);
const {isChromeWebStoreUrl}=await tsImport('../packages/shared-types/src/chrome-web-store.ts',import.meta.url);
const store=process.env.KESTREL_TEST_REAL_CHROME_WEB_STORE==='1';
const formatter='bcjindcccaagfpapjjmafapmmgkkhgoa';
const receipt={at:new Date().toISOString(),executableSha256:createHash('sha256').update(await readFile(executable)).digest('hex'),storeRequested:store,phases:[]};
const jsonFixture={source:'kestrel-native-canary',nested:{installedExtensionRuns:true},values:[1,2,3]};
const server=createServer((req,res)=>{
 if(req.url==='/formatter.json'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(jsonFixture));return;}
 res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Native browser canary</title><h1>Native browser canary</h1>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let child,browser,output='';
let savedSession;
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
 browser=await chromium.connectOverCDP(endpoint);
 const context=browser.contexts()[0];
 let home;
 for(let i=0;i<200;i++){home=context.pages().find(page=>/chrome-extension:\/\/[^/]+\/index.html$/.test(page.url()));if(home)break;await delay(100);}
 assert(home,'Authenticated native Home did not open: '+output);
 await home.waitForFunction(()=>typeof window.kestrel?.request==='function');
 return {context,home,endpoint};
}
async function close(){
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 const session=await browser.newBrowserCDPSession();await session.send('Browser.close');
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
  await browser.close();browser=await chromium.connectOverCDP(endpoint);context=browser.contexts()[0];
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
 const fixtureUrl=`http://127.0.0.1:${server.address().port}/canary`;
 const tabResult=await home.evaluate(url=>window.kestrel.request({type:'browser-create-tab',input:url}),fixtureUrl);
 assert.equal(tabResult.ok,true,tabResult.error);
 const external=await createdPage(url=>url===fixtureUrl);
 await external.getByRole('heading',{name:'Native browser canary'}).waitFor();
 assert.deepEqual(await external.evaluate(()=>({bridge:typeof window.kestrel,query:typeof window.__kestrelNativeQuery,transport:typeof window.__kestrelHostTransport})),{bridge:'undefined',query:'undefined',transport:'undefined'});
 async function coreTool(toolName,input,approved=true){
  const response=await home.evaluate(({sessionId,toolName,input,approved})=>window.kestrel.request({type:'runtime-call-tool',sessionId,toolName,input,
   ...(approved?{approvalStatus:'approved'}:{}),idempotencyKey:crypto.randomUUID()}),{sessionId:savedSession,toolName,input,approved});
  assert.equal(response.ok,true,response.error);return response.execution;
 }
 const listed=await coreTool('browser.tabs',{});
 assert.equal(listed.status,'verified',JSON.stringify(listed));
 assert(listed.output.tabs.some(tab=>tab.url===fixtureUrl),'Actual Core must see the native user tab.');
 assert(listed.output.tabs.every(tab=>!tab.url.startsWith('chrome-extension:')),'Core must not receive protected Kestrel UI tabs.');
 const coreUrl=fixtureUrl+'?created-by=core';
 const blocked=await coreTool('browser.open-tab',{input:coreUrl},false);
 assert.equal(blocked.status,'blocked','Core approval must precede browser dispatch.');
 assert(!(await home.evaluate(()=>window.kestrel.request({type:'browser-get-state'}))).browserState.tabs.some(tab=>tab.url===coreUrl));
 const opened=await coreTool('browser.open-tab',{input:coreUrl});
 assert(opened.output?.tabId,JSON.stringify(opened));
 const coreTab=await createdPage(url=>url===coreUrl);await coreTab.getByRole('heading',{name:'Native browser canary'}).waitFor();
 await home.bringToFront();
 const selected=await coreTool('browser.select-tab',{tabId:opened.output.tabId});assert(!['failed','blocked'].includes(selected.status),JSON.stringify(selected));
 assert.equal((await home.evaluate(()=>window.kestrel.request({type:'browser-get-state'}))).browserState.activeTabId,opened.output.tabId);
 const navigatedUrl=fixtureUrl+'?navigated-by=core';
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
 await settings.getByRole('tab',{name:'Browser',exact:true}).click();
 await settings.getByRole('combobox',{name:'Browser settings section',exact:true}).selectOption('browser-extensions');
 await settings.locator('[data-settings-panel="browser-extensions"]').waitFor();
 assert.equal(await settings.getByRole('button',{name:'Review from Web Store',exact:true}).count(),0);
 await settings.screenshot({path:join(evidence,'extensions-settings.png')});
 receipt.phases.push({phase:'native-ui-core-and-tabs',passed:true,rendererErrors:errors});assert.deepEqual(errors,[]);
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
 if(store){const extensions=await restarted.home.evaluate(()=>window.kestrel.request({type:'browser-list-extensions'}));const installed=extensions.extensions?.find(item=>item.id===formatter);assert(installed?.enabled,'Chrome-installed extension must survive full restart.');receipt.phases.push({phase:'native-extension-restart',passed:true,id:installed.id,version:installed.version});await formatterRuns('native-extension-functional-after-restart');}
 await close();receipt.phases.push({phase:'durable-core-and-clean-restart',passed:true});
 await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2));
 console.log('Native Chromium desktop passed: real Kestrel Home/Settings, Core tab tools and approval enforcement, native tabs, web bridge isolation, durable restart, and clean shutdown'+(store?', plus native Store install and functional extension restart.':'.'));
}catch(error){await writeFile(join(evidence,'failure.log'),output+'\n'+String(error));throw error;}
finally{
 await browser?.close().catch(()=>{});
 if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));}
 await new Promise(resolve=>server.close(resolve));
 await rm(profile,{recursive:true,force:true});
}
