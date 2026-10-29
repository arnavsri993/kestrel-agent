import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

assert(process.env.KESTREL_NATIVE_TEST_APP,'Set KESTREL_NATIVE_TEST_APP to the just-built native candidate.');
const resources=join(resolve(process.env.KESTREL_NATIVE_TEST_APP),'Contents/Resources');
const profile=await mkdtemp(join(tmpdir(),'kestrel-native-provider-store-'));
// Run the bundled implementation under its exact bundled Node/SQLite ABI.
// The fixture never enables an API route in Core or contacts a provider.
const source=String.raw`
import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const [resources,profileRoot]=process.argv.slice(2);
const {openNativeCoreProfile}=await import(pathToFileURL(join(resources,'native-core-profile.mjs')));
const {CredentialBroker,PlaintextSecretProtection,ProviderAccountStore,CoreSupervisor,nodeCoreProcess}=await import(pathToFileURL(join(resources,'agent-core/service/native-desktop-runtime.mjs')));
assert.equal(process.versions.electron,undefined);
const profile=await openNativeCoreProfile(profileRoot,{durable:true});
const core=new CoreSupervisor(undefined,undefined,{processFactory:()=>nodeCoreProcess({executable:process.execPath,entryPath:join(resources,'agent-core/service/index.js'),stdout:'ignore',env:{HOME:profile.root,PATH:process.env.PATH||'',TMPDIR:process.env.TMPDIR||'',KESTREL_DATA_DIR:profile.root}})});
const config={databasePath:profile.databasePath,encryptionKeyBase64:profile.encryptionKeyBase64,workspaceRoots:[],configuredWorkspaceRoots:[],projects:[],pluginRoots:[],managedPluginRoots:[],learnedSkillRoot:join(profile.root,'learned-skills'),secureEnvironment:{},providerAccounts:[]};
try {
 await core.start(config);
 const created=await core.request({type:'runtime-create-session',title:'Native credential preservation canary',kind:'conversation'});
 assert(created.ok&&created.session?.id);const sessionId=created.session.id;await core.stop();
 const keyBefore=await readFile(join(profile.root,'database.key'));
 const createStore=()=>new ProviderAccountStore(join(profile.root,'provider-accounts.json'),new CredentialBroker(profile.root,new PlaintextSecretProtection(),{keyProvider:async()=>Buffer.from(profile.encryptionKeyBase64,'base64')}),profile.root);
 const store=createStore();const secret='native-provider-store-fixture-secret';
 const accounts=await store.create({providerId:'openai',adapter:'openai-responses',displayName:'Native storage canary',authTransport:'api_key',enabled:true,apiKey:secret,headers:[]});
 assert.equal(accounts.length,1);assert(!JSON.stringify(accounts).includes(secret));
 assert(!(await readFile(join(profile.root,'provider-accounts.json'),'utf8')).includes(secret));
 const runtime=await createStore().runtimeAccounts({});assert.equal(runtime.length,1);assert.equal(runtime[0].apiKey,secret);
 await assert.rejects(stat(join(profile.root,'secure/database-key.bin')),{code:'ENOENT'});
 assert.deepEqual(await readFile(join(profile.root,'database.key')),keyBefore);
 await core.start(config);const sessions=await core.request({type:'runtime-list-sessions'});
 assert(sessions.ok&&sessions.sessions.some(session=>session.id===sessionId));await core.stop();
 await store.remove(accounts[0].id);assert.deepEqual(await createStore().runtimeAccounts({}),[]);
 assert.deepEqual(await readFile(join(profile.root,'database.key')),keyBefore);
 console.log('Native provider storage passed: no Electron, bundled Node ABI, encrypted credential round-trip, secret-free summaries, unchanged profile key, preserved real Core conversation, and revocation.');
} finally { await core.stop();await profile.close(); }
`;
try {
 execFileSync(join(resources,'agent-core/node/bin/node'),['--input-type=module','-',resources,profile],{input:source,stdio:['pipe','inherit','inherit'],timeout:30_000});
} finally {await rm(profile,{recursive:true,force:true});}
