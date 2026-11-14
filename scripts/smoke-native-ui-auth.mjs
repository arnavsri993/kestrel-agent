import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createHmac} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {connect} from 'node:net';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';

const app=process.env.KESTREL_NATIVE_TEST_APP;
assert(app,'Set KESTREL_NATIVE_TEST_APP to the just-built native candidate.');
const resources=join(resolve(app),'Contents/Resources');
const shim=join(resolve(app),'Contents/MacOS/Kestrel Native Bridge');
const profile=await mkdtemp(join(tmpdir(),'kestrel-native-ui-auth-'));
const children=new Set();
let broker;
let diagnostics='';
const exitOf=(child)=>new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
const bounded=async(promise,label)=>Promise.race([promise,delay(10_000,undefined,{ref:false}).then(()=>{throw Error(label+' timed out');})]);
function nativeHost(origin){
 const child=spawn(shim,[origin],{stdio:['pipe','pipe','pipe']});children.add(child);
 const exited=exitOf(child);exited.finally(()=>children.delete(child));
 let buffer=Buffer.alloc(0),ended=false;const queue=[],waiters=[];
 child.stdout.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=4){const n=buffer.readUInt32LE();assert(n>0&&n<=1024*1024);if(buffer.length<n+4)break;const value=JSON.parse(buffer.subarray(4,n+4));buffer=buffer.subarray(n+4);const next=waiters.shift();if(next)next.resolve(value);else queue.push(value);}});
 child.stdout.on('end',()=>{ended=true;for(const waiter of waiters.splice(0))waiter.reject(Error('Native host ended'));});
 child.stdin.on('error',()=>{});
 return {child,exited,next(){if(queue.length)return Promise.resolve(queue.shift());if(ended)return Promise.reject(Error('Native host ended'));return bounded(new Promise((resolve,reject)=>waiters.push({resolve,reject})),'Native message');},send(value,fragmented=false){const bytes=Buffer.from(JSON.stringify(value)),head=Buffer.alloc(4);head.writeUInt32LE(bytes.length);const frame=Buffer.concat([head,bytes]);if(fragmented)for(const byte of frame)child.stdin.write(Buffer.of(byte));else child.stdin.write(frame);},async close(){child.stdin.end();return bounded(exited,'Host shutdown');}};
}
try{
 broker=spawn(join(resources,'agent-core/node/bin/node'),[join(resources,'native-ui-broker.mjs'),'--profile-root',profile,'--browser-pid',String(process.pid)],{stdio:['pipe','pipe','pipe']});
 const brokerExited=exitOf(broker);broker.stderr.on('data',b=>diagnostics+=b);
 const lines=createInterface({input:broker.stdout});
 const setup=await bounded(new Promise((resolve,reject)=>{lines.once('line',line=>resolve(JSON.parse(line)));broker.once('exit',()=>reject(Error('Broker stopped: '+diagnostics)));}),'Broker startup');
 assert.match(setup.extensionId,/^[a-p]{32}$/);
 const origin=`chrome-extension://${setup.extensionId}/`;
 const configName='launch-config.json';
 const config=JSON.parse(await readFile(join(setup.extensionRoot,configName),'utf8'));
 const key=Buffer.from(config.key,'base64');
 const socket=join(execFileSync('/usr/bin/getconf',['DARWIN_USER_TEMP_DIR'],{encoding:'utf8'}).trim(),`kestrel-native-${process.pid}/bridge.sock`);
 const impostor=connect(socket);let leaked=0;impostor.on('data',b=>leaked+=b.length);impostor.on('error',()=>{});
 await bounded(new Promise(resolve=>impostor.once('close',resolve)),'Peer rejection');assert.equal(leaked,0,'A process other than the browser-launched bundled shim must receive no challenge or Core data.');
 const forged=nativeHost(origin);const challenge=await forged.next();assert.equal(challenge.kind,'challenge');
 forged.send({kind:'authenticate',mac:'0'.repeat(64)},true);await assert.rejects(forged.next(),/ended/);await bounded(forged.exited,'Forged host rejection');
 const host=nativeHost(origin);const nonce=await host.next();assert.equal(nonce.kind,'challenge');assert.notEqual(nonce.nonce,challenge.nonce);
 const authenticate=(value)=>({kind:'authenticate',mac:createHmac('sha256',key).update(value.nonce).digest('hex')});
 host.send(authenticate(nonce),true);assert.equal((await host.next()).kind,'ready');
 host.send({kind:'request',id:'snapshot',request:{type:'snapshot'}},true);
 const response=await host.next();assert.equal(response.kind,'response');assert.equal(response.id,'snapshot');assert.equal(response.response.ok,true);assert(response.response.snapshot,'Authenticated connection must reach the actual encrypted Core.');
 host.send({kind:'request',id:'invalid',request:{type:'not-a-kestrel-command'}});
 assert.equal((await host.next()).response.ok,false);
 const duplicate=nativeHost(origin);duplicate.send(authenticate(await duplicate.next()));await assert.rejects(duplicate.next(),/ended/);await bounded(duplicate.exited,'Duplicate owner rejection');
 host.send({kind:'request',id:'still-live',request:{type:'runtime-list-sessions'}});const stillLive=await host.next();assert.equal(stillLive.id,'still-live');assert.equal(stillLive.response.ok,true);
 await host.close();key.fill(0);
 broker.stdin.end();const stopped=await bounded(brokerExited,'Broker shutdown');assert.deepEqual(stopped,{code:0,signal:null},diagnostics);
 await assert.rejects(readFile(join(setup.extensionRoot,configName)),error=>error.code==='ENOENT');
 console.log('Native UI authentication passed: kernel peer rejection, forged signature rejection, fresh challenges, fragmented framing, actual Core response, invalid request rejection, single owner, and clean secret/child shutdown.');
}finally{
 for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exitOf(child);}
 if(broker&&broker.exitCode===null&&broker.signalCode===null){broker.kill('SIGTERM');await bounded(exitOf(broker),'Cleanup');}
 await rm(profile,{recursive:true,force:true});
}
