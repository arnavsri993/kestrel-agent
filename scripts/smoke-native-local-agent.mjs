#!/usr/bin/env node
// Exercise the native CoreSupervisor Auto route against one installed Ollama model.
// The Core profile is owned by this script and is always removed in finally.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {candidateDigest} from './native-retirement-evidence.mjs';

const supplied=process.env.KESTREL_NATIVE_TEST_APP;
const model=process.env.KESTREL_TEST_LOCAL_MODEL;
const earlyHeaders=process.env.KESTREL_NATIVE_LOCAL_AGENT_EARLY_HEADERS==='1';
if(!supplied)throw new Error('Set KESTREL_NATIVE_TEST_APP to a built native candidate. No app was launched.');
if(!model)throw new Error('Set KESTREL_TEST_LOCAL_MODEL to an installed Ollama model.');
assert.match(model,/^[A-Za-z0-9_.:/-]{1,200}$/,'Model name must be a bounded installed Ollama tag.');
const app=await realpath(resolve(supplied));
assert.notEqual(app,'/Applications/Kestrel.app','The canonical app cannot be used by this diagnostic.');
assert(!app.startsWith('/Applications/Kestrel.app/'),'The canonical app cannot be used by this diagnostic.');
const resources=join(app,'Contents/Resources');
const candidateSha256=await candidateDigest(app);
const bundledNode=join(resources,'agent-core/node/bin/node');
const profile=await mkdtemp(join(tmpdir(),'kestrel-native-local-agent-profile-'));
await mkdir('.tmp',{recursive:true});
const evidenceDir=await mkdtemp(resolve('.tmp/native-local-agent-evidence-'));
const taskSource=await readFile(resolve('apps/desktop/src/renderer/first-task.ts'),'utf8');
const signature=taskSource.match(/export const FIRST_TASK_PROMPT_SIGNATURE\s*=\s*"([^"]+)";/)?.[1];
const template=taskSource.match(/export const FIRST_TASK_PROMPT\s*=\s*`([\s\S]*?)`;/)?.[1];
assert(signature&&template,'Could not read the actual first-task prompt.');
const firstTaskPrompt=template.replace('${FIRST_TASK_PROMPT_SIGNATURE}',signature);
const receipt={at:new Date().toISOString(),candidate:app,candidateSha256,model,evidenceDir,proxyMode:earlyHeaders?'synthetic-early-chat-headers':'upstream-chat-headers',phases:[],proxyRequests:[]};

const source=String.raw`
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const [resources,profileRoot,model,firstTaskPrompt,earlyHeadersArg]=process.argv.slice(2);
const earlyHeaders=earlyHeadersArg==='1';
const safe={startedAt:Date.now(),proxyMode:earlyHeaders?'synthetic-early-chat-headers':'upstream-chat-headers',proxyRequests:[],core:{},failure:null};
const MAX_BODY=2*1024*1024;
function safeError(error){
 const name=error instanceof Error?error.name:'Error';
 const message=error instanceof Error?error.message:'';
 if(/Provider connect timed out after \d+s\./.test(message))return {name,category:'provider-connect-timeout'};
 if(/Network unavailable: provider host could not be reached\./.test(message))return {name,category:'provider-network-unavailable'};
 if(/All eligible model providers failed\./.test(message))return {name,category:'all-eligible-providers-failed'};
 if(/timed out|timeout/i.test(name+' '+message))return {name,category:'timeout'};
 if(/All eligible model providers failed/.test(message))return {name,category:'all-eligible-providers-failed'};
 return {name,category:'redacted-error'};
}
function parseLine(line,event){
 if(!line)return;
 try{const item=JSON.parse(line);const calls=item?.message?.tool_calls;if(Array.isArray(calls))event.toolCalls+=calls.length;}catch{}
}
async function readRequestBody(req,event){
 const chunks=[];let bytes=0;const began=performance.now();
 try{for await(const chunk of req){bytes+=chunk.length;event.requestBytes=bytes;if(bytes>MAX_BODY)throw Object.assign(new Error('request-too-large'),{statusCode:413});chunks.push(chunk);}}
 finally{event.requestBodyMs=Math.round(performance.now()-began);event.requestBodyEndedMs=Math.round(performance.now()-event.requestStartedAt);delete event.requestStartedAt;}
 return Buffer.concat(chunks,bytes);
}
const proxy=createServer(async(req,res)=>{
 const path=req.url;const allowed=(req.method==='GET'&&path==='/api/tags')||(req.method==='POST'&&(path==='/api/show'||path==='/api/chat'));
 if(!allowed){res.writeHead(404);res.end();return;}
 const event={path,status:null,headersMs:null,localHeadersMs:null,firstChunkMs:null,totalMs:null,requestBytes:0,requestBodyMs:null,requestBodyEndedMs:null,requestStartedAt:performance.now(),contentLength:Number(req.headers['content-length'])||null,expectContinue:req.headers.expect==='100-continue',forwardStartedMs:null,bodyBytes:0,toolCalls:0};
 safe.proxyRequests.push(event);const began=performance.now();let upstream;let downstreamAborted=false;
 try{
  const body=req.method==='GET'?undefined:await readRequestBody(req,event);
  event.forwardStartedMs=Math.round(performance.now()-began);
  if(path==='/api/chat'&&earlyHeaders){
   // Diagnostic-only transport shim: prove whether Core succeeds once Ollama
   // request prefill is allowed past providerFetch's 20s connect deadline.
   event.syntheticEarlyHeaders=true;res.writeHead(200,{'content-type':'application/x-ndjson'});res.flushHeaders();event.localHeadersMs=Math.round(performance.now()-began);
  }
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(new DOMException('Timed out','TimeoutError')),180000);
 const downstreamClosed=()=>{if(!res.writableEnded){downstreamAborted=true;controller.abort(new DOMException('Downstream closed','AbortError'));}};
  res.once('close',downstreamClosed);
  try{
   upstream=await fetch('http://127.0.0.1:11434'+path,{method:req.method,redirect:'error',signal:controller.signal,...(body?{body,headers:{'content-type':'application/json'}}:{})});
   event.status=upstream.status;event.headersMs=Math.round(performance.now()-began);
   if(!res.headersSent){res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')||'application/octet-stream'});res.flushHeaders();}
   if(upstream.body){const reader=upstream.body.getReader();const decoder=new TextDecoder();let pending='';
    while(true){const {done,value}=await reader.read();if(done)break;event.bodyBytes+=value.byteLength;
     if(event.bodyBytes>MAX_BODY){await reader.cancel().catch(()=>{});if(!res.headersSent)res.writeHead(413);res.destroy();break;}
     if(event.firstChunkMs===null)event.firstChunkMs=Math.round(performance.now()-began);
     if(path==='/api/chat'){pending+=decoder.decode(value,{stream:true});let boundary;while((boundary=pending.indexOf('\n'))>=0){parseLine(pending.slice(0,boundary),event);pending=pending.slice(boundary+1);}if(pending.length>MAX_BODY)pending='';}
     if(!res.destroyed&&!res.write(value))await new Promise(resolve=>{const finish=()=>{res.off('drain',finish);res.off('close',finish);resolve();};res.once('drain',finish);res.once('close',finish);});
    }
    if(path==='/api/chat'&&pending)parseLine(pending,event);
   }
   if(!res.destroyed)res.end();
  }finally{clearTimeout(timer);res.off('close',downstreamClosed);}
 }catch(error){event.failure=downstreamAborted?'downstream-closed':safeError(error).category;if(!res.headersSent){res.writeHead(error?.statusCode===413?413:502);res.end();}else res.destroy();}
 finally{event.totalMs=Math.round(performance.now()-began);}
});
await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve);});
const address=proxy.address();assert(address&&typeof address==='object');
const {openNativeCoreProfile}=await import(pathToFileURL(join(resources,'native-core-profile.mjs')));
const {CoreSupervisor,nodeCoreProcess}=await import(pathToFileURL(join(resources,'agent-core/service/native-desktop-runtime.mjs')));
assert.equal(process.versions.electron,undefined);
const profile=await openNativeCoreProfile(profileRoot,{durable:true});
const core=new CoreSupervisor(undefined,undefined,{processFactory:()=>nodeCoreProcess({executable:process.execPath,entryPath:join(resources,'agent-core/service/index.js'),stdout:'ignore',env:{HOME:profile.root,PATH:process.env.PATH||'',TMPDIR:process.env.TMPDIR||'',KESTREL_DATA_DIR:profile.root,KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY:'1'}})});
const account={id:'native-local-ollama',providerId:'ollama',adapter:'ollama',displayName:'Local Ollama canary',authTransport:'local',enabled:true,baseUrl:'http://127.0.0.1:'+address.port,defaultModel:model,contextWindow:32768};
const config={databasePath:profile.databasePath,encryptionKeyBase64:profile.encryptionKeyBase64,workspaceRoots:[],configuredWorkspaceRoots:[],projects:[],pluginRoots:[],managedPluginRoots:[],learnedSkillRoot:join(profile.root,'learned-skills'),secureEnvironment:{},providerAccounts:[account]};
try{
 await core.start(config);safe.core.started=true;
 const created=await core.request({type:'runtime-create-session',title:'Native local agent diagnostic',kind:'conversation'});
 assert(created.ok&&created.session?.id);safe.core.sessionCreated=true;
 const streamId='native-local-agent-canary';const began=Date.now();let timeoutId;
 const timeout=new Promise((_,reject)=>{timeoutId=setTimeout(()=>reject(new DOMException('Diagnostic run deadline reached','TimeoutError')),120000);});
 let result;
 try{result=await Promise.race([core.request({type:'runtime-run-agent',sessionId:created.session.id,message:firstTaskPrompt,model:'auto',providerIds:['ollama'],providerModels:{ollama:model},maximumTurns:4,reasoningEffort:'none',purpose:'first-run-read-only-check',streamId}),timeout]);}
 catch(error){if(error?.name==='TimeoutError')await core.request({type:'runtime-cancel-stream',streamId}).catch(()=>{});throw error;}
 finally{clearTimeout(timeoutId);}
 safe.core.runElapsedMs=Date.now()-began;safe.core.runOk=Boolean(result?.ok);safe.core.runStatus=result?.run?.status||null;
 if(!result?.ok)safe.core.resultFailure=safeError(new Error(typeof result?.error==='string'?result.error:'run-rejected')).category;
 const [messages,runs,executions,usage]=await Promise.all([
  core.request({type:'runtime-list-messages',sessionId:created.session.id}),
  core.request({type:'runtime-list-runs',sessionId:created.session.id}),
  core.request({type:'runtime-list-executions',sessionId:created.session.id}),
  core.request({type:'runtime-provider-usage'}),
 ]);
 safe.core.messages=(messages.messages||[]).map(message=>({role:message.role,contentChars:typeof message.content==='string'?message.content.length:0,toolName:typeof message.toolName==='string'?message.toolName:undefined,toolCallCount:Array.isArray(message.toolCalls)?message.toolCalls.length:0}));
 safe.core.runs=(runs.runs||[]).map(run=>({status:run.status,providerId:run.providerId,model:run.model,turn:run.turn,toolCallCount:Array.isArray(run.toolCalls)?run.toolCalls.length:undefined}));
 safe.core.executions=(executions.executions||[]).map(item=>({toolName:item.toolName||item.name,status:item.status||item.state,approvalStatus:item.approvalStatus}));
 safe.core.providerUsageSummary={ok:Boolean(usage.ok),providerCount:Array.isArray(usage.providerUsage)?usage.providerUsage.length:undefined};
 safe.core.routing=(result?.routing&&typeof result.routing==='object')?{providerId:result.routing.providerId,model:result.routing.model,reasoningEffort:result.routing.reasoningEffort}:undefined;
}catch(error){safe.failure={...safeError(error),elapsedMs:Date.now()-safe.startedAt};}
finally{await core.stop().catch(()=>{});await profile.close().catch(()=>{});await new Promise(resolve=>proxy.close(resolve));}
console.log('NATIVE_LOCAL_AGENT_RECEIPT '+JSON.stringify(safe));
`;

try{
 const stdout=execFileSync(bundledNode,['--input-type=module','-',resources,profile,model,firstTaskPrompt,earlyHeaders?'1':'0'],{input:source,encoding:'utf8',timeout:170_000,maxBuffer:1024*1024});
 const line=stdout.split(/\r?\n/).find(value=>value.startsWith('NATIVE_LOCAL_AGENT_RECEIPT '));
 assert(line,'Bundled Core diagnostic returned no receipt.');
 const childReceipt=JSON.parse(line.slice('NATIVE_LOCAL_AGENT_RECEIPT '.length));
 const corePassed=!earlyHeaders&&!childReceipt.failure&&childReceipt.core?.runOk&&childReceipt.core?.runStatus==='completed';
 receipt.phases.push({phase:'bundled-node-core-supervisor-auto-run',passed:Boolean(corePassed),proxyMode:childReceipt.proxyMode,core:childReceipt.core,proxyRequests:childReceipt.proxyRequests,failure:childReceipt.failure});
}catch(error){
 receipt.phases.push({phase:'bundled-node-core-supervisor-auto-run',passed:false,failure:error?.killed?'bundled-core-time-limit':'bundled-core-launch-or-receipt-failed'});
}
finally{
 try{await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:100});receipt.profileCleaned=true;}
 catch{receipt.profileCleaned=false;receipt.cleanupFailure='temporary-profile-cleanup-failed';}
}

const evidencePath=join(evidenceDir,'receipt.json');
assert.equal(await candidateDigest(app),candidateSha256,'The tested candidate changed during the local-agent run.');
await writeFile(evidencePath,JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({passed:receipt.phases.some(phase=>phase.passed),model,evidencePath,phase:receipt.phases[0]}));
if(!receipt.phases.some(phase=>phase.passed))process.exitCode=1;
