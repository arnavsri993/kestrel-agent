// Bundled native provider + Connections lifecycle canary. Uses a fresh throwaway
// profile and generated credentials; Google HTTP is fake and OAuth redirects
// only to the generated localhost PKCE listener.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { candidateDigest } from "./native-retirement-evidence.mjs";

assert(process.env.KESTREL_NATIVE_TEST_APP, "Set KESTREL_NATIVE_TEST_APP to the exact disposable native candidate.");
const candidate = await realpath(resolve(process.env.KESTREL_NATIVE_TEST_APP));
assert(!candidate.startsWith("/Applications/"), "The canary must not use the installed Kestrel app.");
const resources = join(candidate, "Contents/Resources");
const bundledNode = join(resources, "agent-core/node/bin/node");
await realpath(bundledNode);
const candidateSha256 = await candidateDigest(candidate);
const evidence = resolve(process.env.KESTREL_NATIVE_PROVIDER_CONNECTIONS_EVIDENCE || `.tmp/native-provider-connections-${Date.now()}`);
await mkdir(evidence, { recursive: true, mode: 0o700 });
assert.equal((await readdir(evidence)).length, 0, "Use a fresh evidence directory for each provider Connections canary.");

const temporary = await realpath(await mkdtemp(join(tmpdir(), "kestrel-native-provider-connections-")));
const profile = join(temporary, "generated-profile");
const profileKey = randomBytes(32);
const profileKeyBase64 = profileKey.toString("base64");
const expectedPhases = [
	"bundled-node-real-standalone-core-ready",
	"external-source-settings-saved-without-command-or-core-restart",
	"external-sync-executed-once-and-overrode-only-core-runtime-credential",
	"external-source-removal-restarted-core-with-stored-credential-restored",
	"google-consent-kept-core-live-then-profile-secret-commit-restarted-core-with-secret-only-in-runtime-env",
	"google-cancellation-left-existing-secret-and-core-untouched-with-no-late-write",
	"google-disconnect-restarted-core-without-token-before-remote-revocation",
	"active-task-admission-denied-google-secret-commit-and-external-execution",
	"provider-close-and-core-stop-left-no-owned-child-or-open-request-host",
];
const childSource = String.raw`
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [resources, profileRoot] = process.argv.slice(2);
const keyBase64 = process.env.KESTREL_NATIVE_TEST_PROFILE_KEY;
assert.equal(typeof keyBase64, 'string');
const runtime = await import(pathToFileURL(join(resources, 'agent-core/service/native-desktop-runtime.mjs')));
const { openNativeCoreProfile } = await import(pathToFileURL(join(resources, 'native-core-profile.mjs')));
const { createNativeCoreConfiguration } = await import(pathToFileURL(join(resources, 'native-core-configuration.mjs')));
const profile = await openNativeCoreProfile(profileRoot, { durable: true, protectedKeyBase64: keyBase64 });
const entryPath = join(resources, 'agent-core/service/index.js');
const corePids = () => {
  const ps = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 5000 });
  assert.equal(ps.status, 0);
  return ps.stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match && Number(match[2]) === process.pid && match[3].includes('agent-core/service/index.js') ? [Number(match[1])] : [];
  });
};
const waitPid = async previous => {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const values = corePids();
    if (values.length === 1 && (previous === undefined || values[0] !== previous)) return values[0];
    assert(values.length <= 1, 'Multiple standalone Core children were observed.');
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('Core child lifecycle timed out.');
};
const waitGone = async values => {
  const end = Date.now() + 7000;
  while (Date.now() < end) {
    const alive = values.filter(pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } });
    if (!alive.length) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('A canary-owned Core child did not exit.');
};
const phases = [];
const phase = name => { phases.push(name); console.log('PHASE ' + name); };
let host;
let externalHelperRoot;
let busy = false;
let authMode = 'success';
let authGate;
let authEntered;
let executeCount = 0;
let revokeCount = 0;
let core;
let configController;
let openNativeAuth;
const env = { HOME: profile.root, TMPDIR: process.env.TMPDIR || '/tmp', PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C.UTF-8', KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: '1' };
const fakeGoogleFetch = async (input, init = {}) => {
  const url = String(input);
  if (url.endsWith('/token')) return Response.json({ access_token: 'generated-access-token-value-long-enough', refresh_token: 'generated-refresh-token-value-long-enough', scope: 'openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events' });
  if (url.endsWith('/userinfo')) return Response.json({ email: 'generated@example.test' });
  if (url.includes('/calendars/primary/events')) return Response.json({ items: [] });
  if (url.endsWith('/revoke')) {
    revokeCount++;
    const current = await host.runtimeConfiguration();
    assert.equal(current.secureEnvironment.KESTREL_GOOGLE_WORKSPACE_OAUTH, undefined, 'Core must be restarted without the Google secret before revocation.');
    return new Response('', { status: 200 });
  }
  throw new Error('Unexpected fake Google endpoint.');
};
const configuration = async () => ({
  databasePath: profile.databasePath,
  encryptionKeyBase64: profile.encryptionKeyBase64,
  workspaceRoots: [], configuredWorkspaceRoots: [], projects: [], pluginRoots: [], managedPluginRoots: [],
  learnedSkillRoot: join(profile.root, 'learned-skills'),
  ...await host.runtimeConfiguration(),
});
core = new runtime.CoreSupervisor(undefined, undefined, { processFactory: () => runtime.nodeCoreProcess({
  executable: process.execPath, entryPath, stdout: 'ignore',
  env: { ...env, KESTREL_DATA_DIR: profile.root },
}) });
configController = createNativeCoreConfiguration({ core, configuration, isBusy: () => busy, changed: async () => {} });
const reconfigure = (mutation, rollback, validate, shouldRestoreCore) => configController.reconfigure(mutation, rollback, validate, shouldRestoreCore);
const mutateSettings = (mutation, rollback, validate) => configController.withIdleMutation(mutation, rollback, validate);
const clientId = '1234567890-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com';
openNativeAuth = async (raw, signal) => {
  assert.equal(core.isReady, true, 'Core must remain available while a user completes consent.');
  authEntered?.();
  if (authMode === 'cancel') {
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    return;
  }
  if (authGate) await authGate;
  const authorization = new URL(raw);
  assert.equal(authorization.origin, 'https://accounts.google.com');
  const callback = new URL(authorization.searchParams.get('redirect_uri'));
  callback.searchParams.set('state', authorization.searchParams.get('state'));
  callback.searchParams.set('code', 'generated-code-' + randomUUID());
  const response = await fetch(callback);
  assert.equal(response.status, 200);
};
externalHelperRoot = await mkdtemp(join(tmpdir(), 'kestrel-generated-secret-helper-'));
const fakeHelper = join(externalHelperRoot, 'fixture-command');
await writeFile(fakeHelper, 'Generated helper path; injected executor means no process runs.', { mode: 0o700 });
await chmod(fakeHelper, 0o700);
const externalConfig = {
  version: 1,
  onepassword: { enabled: false, account: '', mappings: {}, overrideStored: true },
  bitwarden: { enabled: false, projectId: '', serverUrl: '', autoInstall: false, overrideStored: true },
  command: { enabled: true, executablePath: fakeHelper, arguments: ['--generated-test'], timeoutMs: 1000, overrideStored: true },
};
try {
  assert.equal(process.versions.electron, undefined);
  host = new runtime.NativeProviderHost({
    root: profile.root, encryptionKeyBase64: profile.encryptionKeyBase64, homeDirectory: profile.root,
    environment: env, reconfigure, mutateSettings, isBusy: () => busy, shouldRestoreCore: () => true,
    openAuthUrl: openNativeAuth, googleOAuthFetch: fakeGoogleFetch, googleOAuthTimeoutMs: 30000,
		externalSecretDependencies: { execute: async () => { executeCount++; return { stdout: 'OPENAI_API_KEY=generated-external-api-key-value' + String.fromCharCode(10) }; } },
  });
  await configController.start();
  let pid = await waitPid();
  assert.equal(core.isReady, true);
  phase('bundled-node-real-standalone-core-ready');

  const storedCredential = 'generated-stored-api-key-value';
  const stored = await host.handle({ type: 'credential-set', credentialId: 'openai', value: storedCredential });
  assert.equal(stored.ok, true);
  pid = await waitPid(pid);
  assert(!JSON.stringify(stored).includes(storedCredential));
  const saved = await host.handle({ type: 'external-secret-save', configuration: externalConfig });
  assert.equal(saved.ok, true);
  assert.equal(executeCount, 0, 'Saving configuration must not execute the command helper.');
  assert.deepEqual(corePids(), [pid], 'Saving settings must leave Core process untouched.');
  phase('external-source-settings-saved-without-command-or-core-restart');

  const beforeSync = pid;
  const synced = await host.handle({ type: 'external-secret-sync', providerId: 'command' });
  assert.equal(synced.ok, true);
  assert.equal(executeCount, 1, 'Explicit sync resolves the external command exactly once.');
  pid = await waitPid(beforeSync);
  const applied = await host.runtimeConfiguration();
  assert.equal(applied.secureEnvironment.OPENAI_API_KEY, 'generated-external-api-key-value');
  assert(!JSON.stringify(synced).includes('generated-external-api-key-value'));
  phase('external-sync-executed-once-and-overrode-only-core-runtime-credential');

  const listed = await host.handle({ type: 'external-secret-list' });
  assert.equal(listed.ok, true);
  const removedBefore = pid;
  const removed = await host.handle({ type: 'external-secret-remove', providerId: 'command' });
  assert.equal(removed.ok, true);
  pid = await waitPid(removedBefore);
  const afterRemove = await host.runtimeConfiguration();
  assert.equal(afterRemove.secureEnvironment.OPENAI_API_KEY, storedCredential);
  assert(!JSON.stringify(removed).includes(storedCredential));
  phase('external-source-removal-restarted-core-with-stored-credential-restored');

  const beforeConsent = pid;
  const consentGate = {};
  consentGate.promise = new Promise(resolve => { consentGate.release = resolve; });
  authGate = consentGate.promise;
  let consentResolve;
  const consentStarted = new Promise(resolve => { consentResolve = resolve; });
  authEntered = consentResolve;
  const connecting = host.handle({ type: 'oauth-google-connect', clientId });
  await consentStarted;
  assert.equal(core.isReady, true);
  assert.deepEqual(corePids(), [beforeConsent], 'Consent must not stop/restart Core.');
  consentGate.release(); authGate = undefined; authEntered = undefined;
  const connected = await connecting;
  assert.equal(connected.ok, true, connected.error || 'Google Workspace connect failed.');
  pid = await waitPid(beforeConsent);
  const googleRuntime = await host.runtimeConfiguration();
  assert(googleRuntime.secureEnvironment.KESTREL_GOOGLE_WORKSPACE_OAUTH?.includes('generated-refresh-token-value-long-enough'));
  assert(!JSON.stringify(connected).includes('generated-refresh-token'));
  assert.equal((await host.handle({ type: 'communication-sources' })).communicationSources[0].state, 'unavailable');
  phase('google-consent-kept-core-live-then-profile-secret-commit-restarted-core-with-secret-only-in-runtime-env');

  const beforeCancel = pid;
  authMode = 'cancel';
  let enteredResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  authEntered = enteredResolve;
  const cancelledConnect = host.handle({ type: 'oauth-google-connect', clientId });
  await entered;
  const cancellation = await host.handle({ type: 'oauth-google-cancel' });
  assert.equal(cancellation.ok, true);
  const cancelledResult = await cancelledConnect;
  assert.equal(cancelledResult.ok, false);
  authMode = 'success'; authEntered = undefined;
  assert.deepEqual(corePids(), [beforeCancel]);
  assert((await host.runtimeConfiguration()).secureEnvironment.KESTREL_GOOGLE_WORKSPACE_OAUTH?.includes('generated-refresh-token-value-long-enough'));
  phase('google-cancellation-left-existing-secret-and-core-untouched-with-no-late-write');

  const beforeDisconnect = pid;
  const disconnected = await host.handle({ type: 'oauth-google-disconnect' });
  assert.equal(disconnected.ok, true);
  assert.equal(revokeCount, 1);
  pid = await waitPid(beforeDisconnect);
  assert.equal((await host.runtimeConfiguration()).secureEnvironment.KESTREL_GOOGLE_WORKSPACE_OAUTH, undefined);
  phase('google-disconnect-restarted-core-without-token-before-remote-revocation');

  let releaseBusyConsent;
  const busyConsent = new Promise(resolve => { releaseBusyConsent = resolve; });
  authGate = busyConsent;
  const beforeBusy = pid;
  let busyResolve;
  const busyStarted = new Promise(resolve => { busyResolve = resolve; });
  authEntered = busyResolve;
  const busyConnect = host.handle({ type: 'oauth-google-connect', clientId });
  await busyStarted;
  busy = true;
  releaseBusyConsent(); authGate = undefined; authEntered = undefined;
  const busyResult = await busyConnect;
  assert.equal(busyResult.ok, false);
  assert.deepEqual(corePids(), [beforeBusy]);
  assert.equal((await host.runtimeConfiguration()).secureEnvironment.KESTREL_GOOGLE_WORKSPACE_OAUTH, undefined);
  const executeBeforeBusySave = executeCount;
  const busySave = await host.handle({ type: 'external-secret-save', configuration: externalConfig });
  assert.equal(busySave.ok, false);
  const executeBeforeBusySync = executeCount;
  const deniedSync = await host.handle({ type: 'external-secret-sync', providerId: 'command' });
  assert.equal(deniedSync.ok, false);
  assert.equal(executeCount, executeBeforeBusySync, 'Busy admission must precede external command execution.');
  assert.equal(executeCount, executeBeforeBusySave, 'Busy settings denial must not execute the command helper.');
  assert.deepEqual(corePids(), [beforeBusy]);
  busy = false;
  phase('active-task-admission-denied-google-secret-commit-and-external-execution');

  const ownedPids = corePids();
  await host.close();
  await core.stop();
  await waitGone(ownedPids);
  assert.deepEqual(corePids(), []);
  assert.equal((await host.handle({ type: 'communication-sources' })).ok, false);
  phase('provider-close-and-core-stop-left-no-owned-child-or-open-request-host');
  assert.equal(phases.length, 9);
  console.log('PHASES ' + phases.length);
} catch {
  console.error('NATIVE_PROVIDER_CONNECTIONS_PHASE_FAILED');
  process.exitCode = 1;
} finally {
  try { await host?.close(); } catch {}
  try { await core?.stop(); } catch {}
  const survivors = corePids();
  for (const pid of survivors) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  try { await waitGone(survivors); }
  catch {
    for (const pid of survivors) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    try { await waitGone(survivors); } catch { process.exitCode = 1; }
  }
  if (externalHelperRoot) try { await rm(externalHelperRoot, { recursive: true, force: true }); } catch {}
  try { await profile.close(); } catch {}
}
`;

const phases = [];
let failure = "NATIVE_PROVIDER_CONNECTIONS_PHASE_FAILED";
try {
	await mkdir(profile, { recursive: true, mode: 0o700 });
	const output = execFileSync(bundledNode, ["--input-type=module", "-", resources, profile], {
		input: childSource,
		encoding: "utf8",
		timeout: 180_000,
		maxBuffer: 256 * 1024,
		env: { HOME: temporary, TMPDIR: temporary, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C.UTF-8", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1", KESTREL_NATIVE_TEST_PROFILE_KEY: profileKeyBase64 },
	});
	for (const line of output.split(/\r?\n/)) if (line.startsWith("PHASE ")) phases.push({ phase: line.slice(6), passed: true });
	assert.deepEqual(phases.map(item => item.phase), expectedPhases, "The bundled integration child must report each expected phase in order.");
	failure = undefined;
	} catch (error) {
		const output = typeof error?.stdout === "string" ? error.stdout : Buffer.isBuffer(error?.stdout) ? error.stdout.toString("utf8") : "";
		for (const line of output.split(/\r?\n/)) if (line.startsWith("PHASE ")) phases.push({ phase: line.slice(6), passed: true });
	process.exitCode = 1;
} finally {
	profileKey.fill(0);
	await rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }).catch(() => { failure = "TEMP_PROFILE_CLEANUP_FAILED"; process.exitCode = 1; });
	const candidateSha256After = await candidateDigest(candidate).catch(() => "");
	if (candidateSha256After !== candidateSha256) { failure = "CANDIDATE_CHANGED"; process.exitCode = 1; }
	const receipt = {
		version: 1,
		candidateSha256,
		candidateSha256After,
		result: failure ? "failed" : "passed",
		scope: "Generated disposable profile and key; fake Google endpoints, loopback OAuth, and injected external command only.",
		phases,
		phaseCount: phases.length,
		finishedAt: new Date().toISOString(),
	};
	await writeFile(join(evidence, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

if (failure) console.error(failure);
else console.log(`PASS bundled native provider connections (${phases.length} phases)`);
