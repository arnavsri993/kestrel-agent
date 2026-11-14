import { generateKeyPairSync, sign } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCore, PluginInstaller, PluginRegistry } from "@kestrel/agent-core";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { NativePluginHost } from "./native-plugin-host";
// @ts-expect-error Native runtime modules run unchanged under bundled Node.
import { createNativeCoreConfiguration } from "../../../native-chromium-host/resources/native-core-configuration.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
 const root = mkdtempSync(join(tmpdir(), "native-plugin-host-test-")); roots.push(root);
 const { publicKey, privateKey } = generateKeyPairSync("ed25519");
 const key = join(root, "publisher.json");
 writeFileSync(key, JSON.stringify({keyId: "test.publisher", publicKey: publicKey.export({type:"spki",format:"pem"})}));
 const signer = new PluginInstaller({ managedRoot: join(root,"profile/plugins"), trustKeys: [{keyId:"test.publisher",publicKey}] });
 function bundle(version: string) {
  const path=join(root,`bundle-${version}`); mkdirSync(join(path,".codex-plugin"),{recursive:true});
  mkdirSync(join(path,"mcp")); mkdirSync(join(path,"skills","example"),{recursive:true});
  writeFileSync(join(path,".codex-plugin/plugin.json"),JSON.stringify({ name:"example",version,description:"An owned plugin fixture.", mcpServers:"./.mcp.json", skills:"./skills" }));
  writeFileSync(join(path,"skills/example/reference.md"),"trusted reference");
  writeFileSync(join(path,"skills/example/SKILL.md"),"---\nname: example\ndescription: Owned test skill.\n---\n\nExample.\n");
  writeFileSync(join(path,".mcp.json"),JSON.stringify({mcpServers:{example:{command:"node",args:["./mcp/server.mjs"]}}}));
  writeFileSync(join(path,"mcp/server.mjs"), `import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);let result;if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};else if(m.method==='tools/list')result={tools:[{name:'echo',description:'Echo text',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]};else if(m.method==='tools/call')result={content:[{type:'text',text:String(m.params.arguments.text)}],structuredContent:{text:String(m.params.arguments.text)}};if(result)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
  const digest=signer.digestForSigning(path).digest;
  writeFileSync(join(path,".codex-plugin/signature.json"),JSON.stringify({algorithm:"ed25519",keyId:"test.publisher",digest,signature:sign(null,Buffer.from(digest,"hex"),privateKey).toString("base64")}));
  return path;
 }
 let selected: string | null = null;
 const host = new NativePluginHost({ root:join(root,"profile"), selectBundle:async () => selected, selectPublisher:async () => selected,
  reconfigure: async work => work(), listPlugins:async () => [] });
 return {root,host,key,bundle,select:(value:string|null)=>{selected=value;}};
}
describe("native signed plugin host", () => {
 it("trusts, installs, updates, removes, and restores an owned bundle", async () => {
  const f=fixture(); f.select(f.key); expect((await f.host.handle({type:"plugin-import-publisher"})).ok).toBe(true);
  f.select(f.bundle("1.0.0")); expect(await f.host.handle({type:"plugin-install-bundle"})).toMatchObject({ok:true,pluginMutation:{action:"install",name:"example"}});
  await expect(f.host.handle({type:"plugin-remove-publisher",keyId:"test.publisher"})).rejects.toThrow(/Remove/);
  f.select(f.bundle("2.0.0")); expect(await f.host.handle({type:"plugin-update-bundle"})).toMatchObject({ok:true,pluginMutation:{action:"update",replacedVersion:"1.0.0"}});
  const removed=await f.host.handle({type:"plugin-remove-installed",name:"example"});
  if (!removed.ok || !("pluginMutation" in removed) || !removed.pluginMutation?.recoveryPath) throw new Error("missing recovery id");
  expect(removed.pluginMutation.recoveryPath).not.toContain("/");
  await expect(f.host.handle({type:"plugin-restore-removed",recoveryPath:"/tmp/hostile"})).rejects.toThrow();
  expect(await f.host.handle({type:"plugin-restore-removed",recoveryPath:removed.pluginMutation.recoveryPath})).toMatchObject({ok:true,pluginMutation:{action:"restore",name:"example"}});
 });
 it("honors cancelled pickers and rejects untrusted, tampered, or linked bundles", async () => {
  const f=fixture(); expect(await f.host.handle({type:"plugin-import-publisher", path:f.key})).toMatchObject({ok:true,cancelled:true});
  f.select(f.bundle("1.0.0")); await expect(f.host.handle({type:"plugin-install-bundle"})).rejects.toThrow();
  f.select(f.key); await f.host.handle({type:"plugin-import-publisher"});
  const bad=f.bundle("2.0.0"); writeFileSync(join(bad,"payload"),"tampered"); f.select(bad); await expect(f.host.handle({type:"plugin-install-bundle"})).rejects.toThrow();
  const linked=f.bundle("3.0.0"); symlinkSync(f.key,join(linked,"link")); f.select(linked); await expect(f.host.handle({type:"plugin-install-bundle"})).rejects.toThrow(/symbolic/);
 });
 it("uses the real Core registry and requires explicit enable, connect and tool approval", async () => {
  const f=fixture(); f.select(f.key); await f.host.handle({type:"plugin-import-publisher"});
  f.select(f.bundle("1.0.0")); await f.host.handle({type:"plugin-install-bundle"});
  const config=await f.host.runtimeConfiguration();
  const db=new KestrelDatabase(":memory:",createEncryptionKey());
  const core=new AgentCore({ database:db, ...config, learnedSkillRoot:join(f.root,"profile/learned-skills") });
  try {
   expect(await core.handle({type:"plugin-list"})).toMatchObject({ok:true,plugins:[{name:"example",enabled:false}]});
   expect(core.skillRegistry?.list()).toEqual([]);
   expect(await core.handle({type:"plugin-set-enabled",name:"example",enabled:true})).toMatchObject({ok:true,plugins:[{enabled:true}]});
   expect(core.skillRegistry?.list()).toMatchObject([{name:"example"}]);
   expect(await core.handle({type:"plugin-connect-mcp",name:"example"})).toMatchObject({ok:true,plugins:[{mcpConnected:true}]});
   const session=core.runtime.ensureMainSession();
   expect((await core.runtime.callTool(session.id,"mcp.example.example.echo",{text:"hello"},{idempotencyKey:"one"})).status).toBe("blocked");
   expect(await core.runtime.callTool(session.id,"mcp.example.example.echo",{text:"hello"},{approvalStatus:"approved",idempotencyKey:"two"})).toMatchObject({status:"verified",output:{structuredContent:{text:"hello"}}});
   expect(await core.handle({type:"plugin-disconnect-mcp",name:"example"})).toMatchObject({ok:true,plugins:[{mcpConnected:false}]});
   expect(core.runtime.discoverTools(session.id).some(t=>t.name==="mcp.example.example.echo")).toBe(false);
   const message=core.runtime.appendMessage({sessionId:session.id,role:"user",content:"Remember a safe release check."});
   const proposed=await core.handle({type:"skill-learning-propose",name:"release-check",description:"Check a release.",instructions:"Check the release.",sourceSessionId:session.id,sourceMessageIds:[message.id]});
   if (!proposed.ok || !proposed.skillProposals?.[0]) throw new Error("missing proposal");
   expect(core.skillRegistry?.list().some(skill=>skill.name==="release-check")).toBe(false);
   expect(await core.handle({type:"skill-learning-review",id:proposed.skillProposals[0].id,decision:"install"})).toMatchObject({ok:true,skillProposals:[{status:"installed"}]});
   expect(core.skillRegistry?.list().some(skill=>skill.name==="release-check")).toBe(true);
   writeFileSync(join(config.managedPluginRoots[0]!,"example/skills/example/reference.md"),"tampered");
   expect(() => core.skillRegistry?.readResource("example", "reference.md")).toThrow();
   expect(() => core.skillRegistry?.activate("example")).toThrow();
   writeFileSync(join(config.managedPluginRoots[0]!,"example/skills/example/reference.md"),"trusted reference");
   writeFileSync(join(config.managedPluginRoots[0]!,"example/mcp/server.mjs"),"tampered");
   expect(await core.handle({type:"plugin-connect-mcp",name:"example"})).toMatchObject({ok:false});
  } finally { await core.close(); }
 });

 it("does not reactivate a removed and restored previously enabled plugin", async () => {
  const f=fixture(); f.select(f.key); await f.host.handle({type:"plugin-import-publisher"});
  f.select(f.bundle("1.0.0")); await f.host.handle({type:"plugin-install-bundle"});
  const first=await f.host.runtimeConfiguration(), db=new KestrelDatabase(":memory:",createEncryptionKey());
  try {
   const signed=new PluginInstaller({managedRoot:first.managedPluginRoots[0]!,trustKeys:first.pluginTrustKeys}).inspect(join(first.managedPluginRoots[0]!,"example"));
   const identity={example:`${signed.keyId}:${signed.digest}`};
   const registry=new PluginRegistry(first.pluginRoots, db, first.managedPluginRoots, first.pluginActivationIds, identity);
   expect(registry.discover()[0]?.enabled).toBe(false); registry.setEnabled("example",true);
   expect(new PluginRegistry(first.pluginRoots, db, first.managedPluginRoots, first.pluginActivationIds, identity).discover()[0]?.enabled).toBe(true);
   const removed=await f.host.handle({type:"plugin-remove-installed",name:"example"});
   if (!removed.ok || !("pluginMutation" in removed) || !removed.pluginMutation?.recoveryPath) throw new Error("missing recovery");
   await f.host.handle({type:"plugin-restore-removed",recoveryPath:removed.pluginMutation.recoveryPath});
   const next=await f.host.runtimeConfiguration();
   expect(new PluginRegistry(next.pluginRoots, db, next.managedPluginRoots, next.pluginActivationIds, identity).discover()[0]?.enabled).toBe(false);
  } finally { db.close(); }
 });

 it("refuses a tampered or untrusted managed bundle at Core startup", async () => {
  const f=fixture(); f.select(f.key); await f.host.handle({type:"plugin-import-publisher"});
  f.select(f.bundle("1.0.0")); await f.host.handle({type:"plugin-install-bundle"});
  const config=await f.host.runtimeConfiguration(), db=new KestrelDatabase(":memory:",createEncryptionKey());
  try {
   expect(() => new AgentCore({database:db,...config,pluginTrustKeys:[]})).toThrow();
   writeFileSync(join(config.managedPluginRoots[0]!,"example/mcp/server.mjs"),"tampered");
   expect(() => new AgentCore({database:db,...config})).toThrow();
  } finally { db.close(); }
 });

 it("requires fresh activation after a different signed bundle replaces an enabled plugin", async () => {
  const f=fixture(); f.select(f.key); await f.host.handle({type:"plugin-import-publisher"});
  f.select(f.bundle("1.0.0")); await f.host.handle({type:"plugin-install-bundle"});
  const config=await f.host.runtimeConfiguration(), databasePath=join(f.root,"restart.sqlite"), key=createEncryptionKey();
  let core=new AgentCore({database:new KestrelDatabase(databasePath,key),...config});
  try {
   expect(await core.handle({type:"plugin-set-enabled",name:"example",enabled:true})).toMatchObject({ok:true,plugins:[{enabled:true}]});
   const installed=join(config.managedPluginRoots[0]!,"example");
   rmSync(installed,{recursive:true}); cpSync(f.bundle("2.0.0"),installed,{recursive:true});
   expect(await core.handle({type:"plugin-connect-mcp",name:"example"})).toMatchObject({ok:false});
   expect(() => core.skillRegistry?.activate("example")).toThrow(/identity changed/);
   await core.close();
   core=new AgentCore({database:new KestrelDatabase(databasePath,key),...config});
   expect(await core.handle({type:"plugin-list"})).toMatchObject({ok:true,plugins:[{version:"2.0.0",enabled:false}]});
   expect(core.skillRegistry?.list()).toEqual([]);
   expect(await core.handle({type:"plugin-set-enabled",name:"example",enabled:true})).toMatchObject({ok:true,plugins:[{enabled:true}]});
  } finally { await core.close(); }
 });

 it("makes no mutation if the idle-Core guard refuses the operation", async () => {
  const f=fixture();
  const host=new NativePluginHost({ root:join(f.root,"guarded"), selectBundle:async()=>f.bundle("4.0.0"), selectPublisher:async()=>f.key,
    reconfigure:async()=>{throw new Error("active task");}, listPlugins:async()=>[] });
  await expect(host.handle({type:"plugin-import-publisher"})).rejects.toThrow("active task");
  expect((await host.handle({type:"plugin-get-publishers"}))).toEqual({ok:true,pluginPublishers:[]});
 });

 it("rolls back trust and signed bundle changes when Core restart fails", async () => {
  const f=fixture(); let selected=f.key, fail=false;
  const host=new NativePluginHost({root:join(f.root,"transaction"),selectBundle:async()=>selected,selectPublisher:async()=>selected,listPlugins:async()=>[],
   reconfigure:async (work,rollback)=>{try{const value=await work(); if(fail) throw new Error("restart failed"); return value;}catch(error){await rollback?.(); throw error;}}});
  fail=true; await expect(host.handle({type:"plugin-import-publisher"})).rejects.toThrow("restart failed");
  expect(await host.handle({type:"plugin-get-publishers"})).toEqual({ok:true,pluginPublishers:[]});
  fail=false; await host.handle({type:"plugin-import-publisher"});
  selected=f.bundle("1.0.0"); fail=true; await expect(host.handle({type:"plugin-install-bundle"})).rejects.toThrow("restart failed");
  const installed=join(f.root,"transaction/plugins/example"); expect(existsSync(installed)).toBe(false);
  fail=false; await host.handle({type:"plugin-install-bundle"});
  const original=readFileSync(join(installed,".codex-plugin/plugin.json"),"utf8");
  selected=f.bundle("2.0.0"); fail=true; await expect(host.handle({type:"plugin-update-bundle"})).rejects.toThrow("restart failed");
  expect(readFileSync(join(installed,".codex-plugin/plugin.json"),"utf8")).toBe(original);
  await expect(host.handle({type:"plugin-remove-installed",name:"example"})).rejects.toThrow("restart failed");
  expect(readFileSync(join(installed,".codex-plugin/plugin.json"),"utf8")).toBe(original);
  fail=false; const removed=await host.handle({type:"plugin-remove-installed",name:"example"});
  if (!removed.ok || !("pluginMutation" in removed) || !removed.pluginMutation?.recoveryPath) throw new Error("missing recovery");
  fail=true; await expect(host.handle({type:"plugin-restore-removed",recoveryPath:removed.pluginMutation.recoveryPath})).rejects.toThrow("restart failed");
  expect(existsSync(installed)).toBe(false);
  expect(existsSync(join(f.root,"transaction/plugins/.trash",removed.pluginMutation.recoveryPath))).toBe(true);
 });

 it("never removes or restores through a symlinked recovery directory", async () => {
  const f=fixture(); f.select(f.key); await f.host.handle({type:"plugin-import-publisher"});
  f.select(f.bundle("1.0.0")); await f.host.handle({type:"plugin-install-bundle"});
  const outside=join(f.root,"outside"); mkdirSync(outside);
  symlinkSync(outside,join(f.root,"profile/plugins/.trash"));
  await expect(f.host.handle({type:"plugin-remove-installed",name:"example"})).rejects.toThrow(/recovery directory/);
  expect(existsSync(join(f.root,"profile/plugins/example"))).toBe(true);
 });

 it("rejects a document containing an Ed25519 private key", async () => {
  const f=fixture(), pair=generateKeyPairSync("ed25519"), key=join(f.root,"private.json");
  writeFileSync(key,JSON.stringify({keyId:"private",publicKey:pair.privateKey.export({type:"pkcs8",format:"pem"})}));
  f.select(key); await expect(f.host.handle({type:"plugin-import-publisher"})).rejects.toThrow(/public/i);
 });

 it("rejects a symlink as the selected bundle root", async () => {
  const f=fixture(); f.select(f.key); await f.host.handle({type:"plugin-import-publisher"});
  const source=f.bundle("1.0.0"), link=join(f.root,"linked-bundle"); symlinkSync(source,link);
  f.select(link); await expect(f.host.handle({type:"plugin-install-bundle"})).rejects.toThrow(/regular plugin/);
 });

 it("rejects extra fields including a private key in a public publisher document", async () => {
  const f=fixture(), pair=generateKeyPairSync("ed25519"), path=join(f.root,"extra.json");
  writeFileSync(path,JSON.stringify({keyId:"test",publicKey:pair.publicKey.export({type:"spki",format:"pem"}),privateKey:pair.privateKey.export({type:"pkcs8",format:"pem"})}));
  f.select(path); await expect(f.host.handle({type:"plugin-import-publisher"})).rejects.toThrow(/only a key ID/);
  expect(await f.host.handle({type:"plugin-get-publishers"})).toEqual({ok:true,pluginPublishers:[]});
 });
 it("rejects a root manifest that would bypass signed immediate-child verification", async () => {
  const f=fixture(), config=await f.host.runtimeConfiguration(), root=config.managedPluginRoots[0]!;
  mkdirSync(join(root,".codex-plugin"),{recursive:true});
  writeFileSync(join(root,".codex-plugin/plugin.json"),JSON.stringify({name:"evil",version:"1.0.0",description:"Unsigned"}));
  const db=new KestrelDatabase(":memory:",createEncryptionKey());
  try { expect(()=>new AgentCore({database:db,...config})).toThrow(/hidden managed/); } finally { db.close(); }
 });
 it("preserves explicit external plugin enablement when managed activation IDs are configured", () => {
  const f=fixture(), external=join(f.root,"external"), manifest=join(external,"example/.codex-plugin");
  mkdirSync(manifest,{recursive:true}); writeFileSync(join(manifest,"plugin.json"),JSON.stringify({name:"example",version:"1.0.0",description:"External fixture"}));
  const db=new KestrelDatabase(":memory:",createEncryptionKey());
  try { const registry=new PluginRegistry([external],db,[],{}); registry.discover(); registry.setEnabled("example",true);
    expect(new PluginRegistry([external],db,[],{}).discover()[0]?.enabled).toBe(true);
  } finally {db.close();}
 });
 it("cannot mutate after a cancelled late picker or elapsed whole-operation deadline", async () => {
  const f=fixture(); let release!: (value:string|null)=>void; let now=1000;
  const old=Date.now; Date.now=()=>now;
  try {
   const host=new NativePluginHost({root:join(f.root,"late"),selectBundle:()=>new Promise(resolve=>{release=resolve;}),selectPublisher:()=>new Promise(resolve=>{release=resolve;}),
    reconfigure:async work=>work(),listPlugins:async()=>[]});
   const controller=new AbortController(), pending=host.handle({type:"plugin-import-publisher"},controller.signal);
   controller.abort(); release(f.key); await expect(pending).rejects.toThrow();
   expect(existsSync(join(f.root,"late/trusted-plugin-publishers.json"))).toBe(false);
   const later=host.handle({type:"plugin-import-publisher"}); now += 10*60_000; release(f.key); await expect(later).rejects.toThrow(/timed out/);
   expect(existsSync(join(f.root,"late/trusted-plugin-publishers.json"))).toBe(false);
  } finally { Date.now=old; }
 });
 it("rolls back a mutation if disconnect occurs during Core restart or list validation fails", async () => {
  const f=fixture(); let release!:()=>void, started!:()=>void; const restarting=new Promise<void>(r=>{started=r;});
  let block=false, failList=false; const bundle=f.bundle("1.0.0");
  const host=new NativePluginHost({root:join(f.root,"restart"),selectBundle:async()=>bundle,selectPublisher:async()=>f.key,
   listPlugins:async()=>{if(failList) throw new Error("list failed"); return [];},
   reconfigure:async(work,rollback,validate)=>{try{const result=await work();if(block){started();await new Promise<void>(r=>{release=r;});}await validate?.();return result;}catch(error){await rollback?.();throw error;}}});
  await host.handle({type:"plugin-import-publisher"});
  block=true; const signal=new AbortController(), pending=host.handle({type:"plugin-install-bundle"},signal.signal);
  await restarting; signal.abort(); release(); await expect(pending).rejects.toThrow();
  expect(existsSync(join(f.root,"restart/plugins/example"))).toBe(false);
  block=false; failList=true; await expect(host.handle({type:"plugin-install-bundle"})).rejects.toThrow("list failed");
  expect(existsSync(join(f.root,"restart/plugins/example"))).toBe(false);
 });

 it("rolls back and restores prior Core when disconnect wins during a deferred restart", async () => {
  const f=fixture(); const bundle=f.bundle("1.0.0"); let starts=0, release!:()=>void, notify!:()=>void;
  const waiting=new Promise<void>(r=>{notify=r;});
  const core={stop:async()=>{},start:async()=>{if(++starts===2){notify();await new Promise<void>(r=>{release=r;});}}};
  let host!: NativePluginHost;
  const guard=createNativeCoreConfiguration({core,isBusy:()=>false,configuration:()=>host.runtimeConfiguration(),changed:async()=>{}});
  host=new NativePluginHost({root:join(f.root,"real-guard"),selectBundle:async()=>bundle,selectPublisher:async()=>f.key,listPlugins:async()=>[],
   reconfigure:(work,rollback,validate,restore)=>guard.reconfigure(work,rollback,validate,restore)});
  // Import the publisher before starting the guarded Core so the deferred restart is the install.
  const trustOnly=new NativePluginHost({root:join(f.root,"real-guard"),selectBundle:async()=>bundle,selectPublisher:async()=>f.key,listPlugins:async()=>[],reconfigure:async work=>work()});
  await trustOnly.handle({type:"plugin-import-publisher"}); await guard.start();
  const abort=new AbortController(), pending=host.handle({type:"plugin-install-bundle"},abort.signal);
  await waiting; abort.abort(); release(); await expect(pending).rejects.toThrow();
  expect(starts).toBe(3); expect(existsSync(join(f.root,"real-guard/plugins/example"))).toBe(false);
 });

});
