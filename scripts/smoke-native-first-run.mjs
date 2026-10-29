#!/usr/bin/env node
// Exercise Kestrel's real first-run React UI and one live local model in an
// explicitly supplied native Chromium candidate and an owned disposable profile.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from '@playwright/test';

const supplied=process.env.KESTREL_NATIVE_TEST_APP;
if(!supplied)throw new Error('Set KESTREL_NATIVE_TEST_APP to a disposable candidate. No app was launched.');
const model=process.env.KESTREL_TEST_LOCAL_MODEL;
if(!model)throw new Error('Set KESTREL_TEST_LOCAL_MODEL to an installed Ollama model with tool support. No app was launched.');
const app=await realpath(resolve(supplied));
assert.notEqual(app,'/Applications/Kestrel.app','The canonical app cannot be used for this test.');
assert(!app.startsWith('/Applications/Kestrel.app/'),'The canonical app cannot be used for this test.');
const executable=join(app,'Contents/MacOS/Kestrel');
const candidateSha256=createHash('sha256').update(await readFile(executable)).digest('hex');
const profile=await mkdtemp(join(tmpdir(),'kestrel-native-first-run-profile-'));
await mkdir('.tmp',{recursive:true});
const evidence=await mkdtemp(resolve('.tmp/native-first-run-evidence-'));
const receipt={at:new Date().toISOString(),candidate:app,candidateSha256,model,profile,evidence,phases:[]};
let child,browser,home,endpoint,output='';

async function start(){
 output='';
 // Use the native host's guarded test-only default-profile path. The only CLI
 // switch is Chromium's ephemeral CDP endpoint so this can inspect real React.
 child=spawn(executable,['--remote-debugging-port=0'],{env:{...process.env,KESTREL_NATIVE_TEST_PROFILE_ROOT:profile},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',chunk=>output+=chunk.toString());child.stderr.on('data',chunk=>output+=chunk.toString());
 for(let i=0;i<300;i++){
  assert.equal(child.exitCode,null,`Candidate exited before Chromium was ready: ${output}`);
  endpoint=output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+)/)?.[1];
  if(endpoint)break;await delay(100);
 }
 assert(endpoint,`Native Chromium did not expose its owned test endpoint: ${output}`);
 browser=await chromium.connectOverCDP(endpoint,{noDefaults:true});
 let context=browser.contexts()[0];
 for(let i=0;i<300;i++){
  home=context.pages().find(page=>/chrome-extension:\/\/[^/]+\/index\.html$/.test(page.url()));
  if(home)break;
  if(i%10===0){
   const session=await browser.newBrowserCDPSession();
   const targets=await session.send('Target.getTargets');await session.detach();
   if(targets.targetInfos.some(target=>target.type==='page'&&/chrome-extension:\/\/[^/]+\/index\.html$/.test(target.url))){
    // Native startup can create Home before Playwright begins target discovery.
    await browser.close();browser=await chromium.connectOverCDP(endpoint,{noDefaults:true});context=browser.contexts()[0];
   }
  }
  assert.equal(child.exitCode,null,`Candidate exited before the first-run UI loaded: ${output}`);await delay(100);
 }
 assert(home,'Kestrel Home did not open in the candidate native window.');
 await home.waitForFunction(()=>typeof window.kestrel?.request==='function',{},{timeout:30_000});
 return home;
}
async function stop(){
 if(!child||child.exitCode!==null)return;
 const exited=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`Candidate did not stop cleanly: ${output}`)),15_000);child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});});
 assert(child.kill('SIGTERM'),'Candidate could not receive its normal stop signal.');
 const result=await exited;assert.deepEqual(result,{code:0,signal:null},output);
 await browser?.close().catch(()=>{});browser=undefined;home=undefined;
}
async function waitForAssistant(sessionId,marker,timeout=120_000){
 for(const deadline=Date.now()+timeout;Date.now()<deadline;){
  const response=await home.evaluate(id=>window.kestrel.request({type:'runtime-list-messages',sessionId:id}),sessionId);
  assert(response.ok,response.error);
  const assistant=response.messages?.find(message=>message.role==='assistant'&&message.content.includes(marker));
  if(assistant)return assistant;
  const runs=await home.evaluate(id=>window.kestrel.request({type:'runtime-list-runs',sessionId:id}),sessionId);
  assert(!runs.runs?.some(run=>['failed','cancelled','waiting_approval'].includes(run.status)),JSON.stringify(runs));
  assert.equal(child.exitCode,null,`Candidate exited while the local task was running: ${output}`);await delay(200);
 }
 throw new Error(`No assistant response containing ${marker} arrived from the live local route.`);
}

try{
 await start();
 const rendererErrors=[];home.on('pageerror',error=>rendererErrors.push(error.message));
 assert.equal(await home.locator('.setup-onboarding').count(),1,'A clean profile must show actual first-run onboarding.');
 async function captureStep(name,heading){
  const current=home.getByRole('heading',{name:heading});
  await current.waitFor({timeout:20_000});
  await home.locator('.setup-stage').filter({has:current}).screenshot({path:join(evidence,`first-run-${name}.png`)});
 }
 await captureStep('welcome',/Your AI answers.*Kestrel gets it done/);
 receipt.phases.push({phase:'real-first-run-welcome-rendered',passed:true});
 await home.getByRole('button',{name:'Get started',exact:true}).click();
 await captureStep('before-you-begin','Know what leaves this Mac.');
 await home.getByLabel('I understand these boundaries',{exact:true}).check();
 await home.getByRole('button',{name:'Continue',exact:true}).click();
 await captureStep('choose-model','Where should answers come from?');
 await home.getByRole('button',{name:/^Run on this Mac/}).click();
 await home.getByRole('button',{name:'Continue',exact:true}).click();
 await captureStep('model-setup','Set up a local model.');
 const installed=await home.evaluate(()=>window.kestrel.request({type:'local-model-status'}));
 assert(installed.ok,installed.error);
 const detectedModels=installed.localRuntime?.detectedModels??installed.localRuntime?.localModels??[];
 assert(detectedModels.some(item=>item.name===model||item.name===`${model}:latest`),`The installed local model ${model} was not discovered by Kestrel.`);
 receipt.phases.push({phase:'installed-local-model-discovered',passed:true,models:detectedModels.map(item=>item.name)});
 // Root's in-flight UI change adds the installed-model verification action.
 // It must be clicked through the real UI and must produce a live response.
 const verify=home.getByRole('button',{name:`Verify ${model}`,exact:true});
 await verify.waitFor({timeout:20_000});
 await verify.click();
 await home.getByText(`${model} verified locally`,{exact:false}).waitFor({timeout:120_000});
 const live=await home.evaluate(()=>window.kestrel.request({type:'local-model-status'}));
 assert(live.ok,live.error);assert.equal(live.localRuntime?.verifiedModel,model,'Setup must record the model that returned a real response.');
 receipt.phases.push({phase:'local-model-live-verified-through-setup-ui',passed:true,verifiedModel:live.localRuntime.verifiedModel});
 await home.getByRole('button',{name:'Continue',exact:true}).click();
 await captureStep('ready','Ready for a first task');
 await home.getByText(/returned a real response during setup/).waitFor();
 await home.screenshot({path:join(evidence,'first-run-ready.png')});
 await home.getByRole('button',{name:'Try a first task',exact:true}).click();
 await home.locator('#new-tab-chat-input').waitFor({timeout:30_000});
 let guided;
 for(const deadline=Date.now()+180_000;Date.now()<deadline;){
  const alerts=home.locator('.chat-error[role="alert"]');
  assert.equal(await alerts.count(),0,await alerts.allTextContents());
  const sessions=await home.evaluate(()=>window.kestrel.request({type:'runtime-list-sessions'}));
  const session=sessions.sessions?.find(item=>item.title.startsWith('I just finished Kestrel setup.'));
  if(session){
   const runs=await home.evaluate(id=>window.kestrel.request({type:'runtime-list-runs',sessionId:id}),session.id);
   assert(!runs.runs?.some(run=>['failed','cancelled','waiting_approval'].includes(run.status)),JSON.stringify(runs));
   if(runs.runs?.some(run=>run.status==='completed')){guided=session;break;}
  }
  await delay(200);
 }
 assert(guided,'The automatically submitted first guided task must complete before a second Home prompt.');
 const guidedMessages=await home.evaluate(id=>window.kestrel.request({type:'runtime-list-messages',sessionId:id}),guided.id);
 assert(guidedMessages.messages?.some(message=>message.role==='tool'),'The guided task must actually use a read-only tool.');
 receipt.phases.push({phase:'guided-first-task-completed-with-real-tool-result',passed:true,sessionId:guided.id});
 await home.screenshot({path:join(evidence,'native-first-run-home-before-task.png')});
 const marker=`FIRST_RUN_LOCAL_OK_${Date.now()}`;
 await home.locator('#new-tab-chat-input').fill(`Reply with only ${marker}. Do not use tools.`);
 await home.getByRole('button',{name:/^Send message to /}).click();
 let session;
 for(const deadline=Date.now()+15_000;Date.now()<deadline&&!session;){
  const sessions=await home.evaluate(()=>window.kestrel.request({type:'runtime-list-sessions'}));
  assert(sessions.ok,sessions.error);
  for(const candidate of sessions.sessions??[]){
   const messages=await home.evaluate(id=>window.kestrel.request({type:'runtime-list-messages',sessionId:id}),candidate.id);
   if(messages.messages?.some(message=>message.role==='user'&&message.content.includes(marker))){session=candidate;break;}
  }
  if(!session)await delay(100);
 }
 assert(session,'The first task must create a persisted conversation in the fresh profile.');
 await waitForAssistant(session.id,marker);
 const finalMessages=await home.evaluate(id=>window.kestrel.request({type:'runtime-list-messages',sessionId:id}),session.id);
 assert(finalMessages.messages.some(message=>message.role==='assistant'&&message.content.includes(marker)),'The live local model must answer the first Home task.');
 await home.screenshot({path:join(evidence,'native-first-run-home.png')});
 receipt.phases.push({phase:'first-home-task-live-local-response',passed:true,sessionId:session.id,marker});
 assert.deepEqual(rendererErrors,[],'The actual first-run renderer must not report uncaught errors.');
 receipt.phases.push({phase:'first-run-renderer-errors',passed:true,count:0});
 await stop();
 await start();
 assert.equal(await home.locator('.setup-onboarding').count(),0,'The native first-run completion must survive restart in the same disposable profile.');
 const persisted=await home.evaluate(()=>window.kestrel.request({type:'runtime-list-sessions'}));
 assert(persisted.ok,persisted.error);assert(persisted.sessions.some(item=>item.id===session.id),'Fresh-profile conversation must survive a full native app restart.');
 const persistedMessages=await home.evaluate(id=>window.kestrel.request({type:'runtime-list-messages',sessionId:id}),session.id);
 assert(persistedMessages.ok,persistedMessages.error);assert(persistedMessages.messages.some(message=>message.role==='assistant'&&message.content.includes(marker)),'The model response must survive restart in the same profile.');
 await home.screenshot({path:join(evidence,'native-first-run-home-after-restart.png')});
 receipt.phases.push({phase:'same-profile-restart-preserves-first-task',passed:true,sessionId:session.id});
 await stop();
 await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2));
 console.log(`Native Chromium first-run passed. Evidence: ${evidence}`);
}catch(error){
 await mkdir(evidence,{recursive:true});
 await writeFile(join(evidence,'failure.log'),output+'\n'+String(error));
 await writeFile(join(evidence,'receipt.json'),JSON.stringify({...receipt,failed:String(error)},null,2));
 throw error;
}finally{
 await browser?.close().catch(()=>{});
 if(child&&child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;}
 await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
