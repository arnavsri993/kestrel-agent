#!/usr/bin/env node
// Existing external Ollama model only. No GUI or managed-runtime installation.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { candidateDigest } from "./native-retirement-evidence.mjs";

const supplied = process.env.KESTREL_NATIVE_TEST_APP;
const requested = process.env.KESTREL_TEST_LOCAL_MODEL;
assert(supplied, "Set KESTREL_NATIVE_TEST_APP to an explicit disposable candidate. Nothing was launched.");
assert(requested && /^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9][a-z0-9._-]*)?$/i.test(requested) && requested.length <= 200,
  "Set KESTREL_TEST_LOCAL_MODEL to an exact installed Ollama model name. Nothing was launched.");
const candidate = await realpath(resolve(supplied));
assert(!candidate.startsWith("/Applications/"), "Use a disposable candidate outside /Applications.");

async function externalState() {
  const response = await fetch("http://127.0.0.1:11434/api/tags", { redirect: "error", signal: AbortSignal.timeout(3_000) });
  assert(response.ok, `The existing Ollama service returned ${response.status}.`);
  const text = await response.text();
  assert(Buffer.byteLength(text) <= 1_000_000, "Ollama model metadata exceeded its bound.");
  const parsed = JSON.parse(text);
  assert(Array.isArray(parsed.models), "Ollama did not return a model list.");
  const models = parsed.models.map(item => {
    assert(typeof item?.name === "string" && item.name.length > 0 && typeof item.digest === "string" && /^[a-f0-9]{64}$/i.test(item.digest), "Ollama returned a model without a stable name and digest.");
    return { name: item.name, digest: item.digest.toLowerCase() };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.digest.localeCompare(b.digest));
  assert.equal(new Set(models.map(item => item.name)).size, models.length, "Ollama returned duplicate model names.");
  const pids = execFileSync("/usr/sbin/lsof", ["-nP", "-iTCP:11434", "-sTCP:LISTEN", "-t"], { encoding: "utf8", timeout: 5_000 }).trim().split(/\s+/).filter(Boolean).map(Number).sort((a, b) => a - b);
  assert(pids.length && pids.every(pid => Number.isSafeInteger(pid) && pid > 0), "No stable Ollama listener was found.");
  return { models, pids: [...new Set(pids)] };
}
const initial = await externalState();
const selected = initial.models.find(item => item.name === requested || item.name === `${requested}:latest`);
assert(selected, `The requested model ${requested} is not already installed. Nothing was launched or downloaded.`);
const model = selected.name;
const fingerprint = await candidateDigest(candidate);
await mkdir(resolve(".tmp"), { recursive: true });
const evidence = await mkdtemp(resolve(".tmp/native-local-setup-evidence-"));
await chmod(evidence, 0o700);
const profile = await mkdtemp(join(tmpdir(), "kestrel-native-local-setup-"));
await chmod(profile, 0o700);
const resources = join(candidate, "Contents/Resources");
const receipt = { at: new Date().toISOString(), scope: "existing-external-ollama-model-only", candidate, candidateSha256: fingerprint,
  requestedModel: requested, selectedModel: model, initialExternal: initial, phases: [], progress: [],
  limitations: ["No managed-runtime installation or Ollama runner-descendant cleanup was tested.", "Preflight and stage monitoring cannot atomically prevent a pull if an external actor removes the model between the final check and setup."] };
let child, childExit, stderr = "", sequence = 0, forbidden = false;
const pending = new Map();
const forbiddenStages = new Set(["downloading-runtime", "verifying-runtime", "installing-runtime", "starting-runtime", "downloading-model"]);
function write(value) { assert(child?.stdin.writable, "The disposable native Core is unavailable."); child.stdin.write(JSON.stringify(value) + "\n"); }
function start() {
  let ready = false;
  child = spawn(join(resources, "agent-core/node/bin/node"), [join(resources, "native-desktop-core.mjs"), "--profile-root", profile, "--durable-profile"], {
    env: { ...process.env, KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1" }, stdio: ["pipe", "pipe", "pipe"],
  });
  childExit = new Promise(resolveExit => child.once("exit", (code, signal) => resolveExit({ code, signal })));
  child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-16_000); });
  createInterface({ input: child.stdout }).on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { forbidden = true; child.kill("SIGTERM"); return; }
    if (message.type === "ready") ready = true;
    else if (message.type === "response") {
      const item = pending.get(message.id); if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer); item.resolve(message.response);
    } else if (message.type === "event" && message.channel === "local-runtime-progress") {
      const event = message.event;
      if (event && typeof event.stage === "string") {
        receipt.progress.push({ stage: event.stage, ...(typeof event.percent === "number" ? { percent: event.percent } : {}) });
        if (forbiddenStages.has(event.stage)) {
          forbidden = true;
          // Best effort only: this event does not guarantee cancellation before /api/pull.
          if (child?.stdin.writable) write({ type: "host-request", id: `guard-cancel-${++sequence}`, request: { type: "local-runtime-cancel" } });
        }
      }
    } else if (message.type === "browser-backend-reset") write({ type: "browser-backend-reset-response", requestId: message.requestId, ok: true });
  });
  return async () => {
    for (const end = Date.now() + 30_000; !ready && Date.now() < end;) {
      assert.equal(child.exitCode, null, `Native Core exited during startup: ${stderr}`);
      await delay(25);
    }
    assert(ready, `Native Core did not become ready: ${stderr}`);
  };
}
function request(value, host = false, timeoutMs = 30_000) {
  const id = `canary-${++sequence}`;
  return new Promise((resolveRequest, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native request ${value.type} timed out.`)); }, timeoutMs);
    pending.set(id, { resolve: resolveRequest, timer });
    write({ type: host ? "host-request" : "request", id, request: value });
  });
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) throw new Error("Native Core exited before a clean stop.");
  write({ type: "shutdown" });
  const result = await Promise.race([childExit, delay(15_000, undefined, { ref: false }).then(() => { throw new Error("Disposable native Core did not stop cleanly."); })]);
  assert.deepEqual(result, { code: 0, signal: null }, stderr);
  assert.deepEqual(await externalState(), initial, "The external Ollama listener or model digests changed.");
  child = undefined;
}
async function routeCheck() {
  const routes = await request({ type: "runtime-list-providers" });
  assert(routes.ok && routes.providers?.some(item => item.id === "ollama"), "The configured local Core route was not found.");
  const verification = await request({ type: "runtime-verify-provider", providerId: "ollama" });
  assert(verification.ok && verification.providerVerifications?.some(item => item.ok && (item.poolId === "ollama" || item.providerId === "ollama" || item.providerId === "native-local-ollama")), "The local Core provider did not verify.");
  return verification.providerVerifications.filter(item => item.ok).map(({ providerId, poolId, latencyMs }) => ({ providerId, poolId, latencyMs }));
}
try {
  await start()();
  const preSetup = await request({ type: "local-model-status" }, true);
  assert(preSetup.ok && preSetup.ollamaAvailable && preSetup.localRuntime?.detectedModels?.some(item => item.name === model), "The existing service and model were not discovered by bundled native Core.");
  assert.deepEqual(await externalState(), initial, "External Ollama state changed before setup; refusing to proceed.");
  const setup = await request({ type: "local-runtime-bootstrap", model, consent: true }, true, 180_000);
  assert(!forbidden, "Setup reported an unexpected runtime installation, startup, or model pull.");
  assert(setup.ok && setup.localRuntime?.verifiedModel === model, `The existing local model was not verified: ${setup.error ?? "missing verification"}`);
  assert(receipt.progress.some(item => item.stage === "verifying-model") && receipt.progress.some(item => item.stage === "ready"), "Setup did not report verification and ready stages.");
  receipt.phases.push({ phase: "existing-model-bootstrap-and-live-verification", verifiedAt: setup.localRuntime.verifiedAt, passed: true });
  const providerChecks = await routeCheck();
  const created = await request({ type: "runtime-create-session", title: "Disposable native local setup canary", kind: "conversation" });
  assert(created.ok && created.session?.id, "Core could not create the disposable conversation.");
  const sessionId = created.session.id;
  // Deny all discovered tools in this disposable session before inference;
  // the request schema does not currently expose a no-tools flag.
  const discovered = await request({ type: "runtime-discover-tools", sessionId });
  assert(discovered.ok && Array.isArray(discovered.tools), "Core did not enumerate session tools.");
  for (const tool of discovered.tools) {
    assert(typeof tool.name === "string" && /^[a-z][a-z0-9_.-]+$/.test(tool.name), "Core returned an invalid tool identifier.");
    const denied = await request({ type: "runtime-set-approval-rule", toolName: tool.name, decision: "deny", scope: "session", sessionId });
    assert(denied.ok, "The disposable no-tools session could not be secured.");
  }
  const marker = `LOCAL_CANARY_${Date.now()}`;
  const result = await request({ type: "runtime-run-agent", sessionId, message: `Reply with only ${marker}. Do not call tools.`, model,
    providerIds: ["ollama"], providerModels: { ollama: model }, maximumTurns: 1, reasoningEffort: "none", streamId: "native-local-setup-canary" }, false, 180_000);
  assert(result.ok && result.run?.status === "completed", `The local Core run did not complete: ${result.error ?? result.run?.status ?? "unknown"}`);
  const messages = await request({ type: "runtime-list-messages", sessionId });
  assert(messages.ok && messages.messages?.some(item => item.role === "assistant" && typeof item.content === "string" && item.content.trim()), "The local Core run did not persist a real assistant reply.");
  assert(!messages.messages.some(item => item.role === "tool" || (Array.isArray(item.toolCalls) && item.toolCalls.length)), "The short canary unexpectedly used a tool.");
  const executions = await request({ type: "runtime-list-executions", sessionId });
  assert(executions.ok && Array.isArray(executions.executions) && executions.executions.length === 0, "The short canary attempted a tool execution.");
  receipt.phases.push({ phase: "configured-local-core-verification-and-no-tools-response", passed: true, providerChecks, sessionId, assistantReplyRecorded: true });
  await stop(); receipt.phases.push({ phase: "first-stop-external-pids-and-digests-unchanged", passed: true });
  await start()();
  const restored = await request({ type: "local-model-status" }, true);
  assert(restored.ok && restored.localRuntime?.verifiedModel === model, "The selected local model did not survive the private-profile restart.");
  const restoredChecks = await routeCheck();
  const persisted = await request({ type: "runtime-list-messages", sessionId });
  assert(persisted.ok && persisted.messages?.some(item => item.role === "assistant" && typeof item.content === "string" && item.content.trim()), "The actual local reply did not survive restart.");
  receipt.phases.push({ phase: "same-private-profile-restart-preserves-route-and-response", passed: true, providerChecks: restoredChecks });
  await stop(); receipt.phases.push({ phase: "second-stop-external-pids-and-digests-unchanged", passed: true });
  assert.equal(await candidateDigest(candidate), fingerprint, "The candidate bundle changed during this canary.");
  receipt.phases.push({ phase: "candidate-fingerprint-unchanged", passed: true });
  await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  console.log(`Existing external Ollama native Core setup passed. Evidence: ${evidence}`);
} catch (error) {
  await writeFile(join(evidence, "receipt.json"), JSON.stringify({ ...receipt, failure: String(error) }, null, 2) + "\n", { mode: 0o600 });
  throw error;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      if (child.stdin.writable) write({ type: "shutdown" });
      await Promise.race([childExit, delay(12_000, undefined, { ref: false }).then(() => { throw new Error("shutdown timeout"); })]);
    } catch { child.kill("SIGTERM"); await Promise.race([childExit, delay(3_000, undefined, { ref: false })]); }
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await childExit; }
  }
  for (const item of pending.values()) clearTimeout(item.timer);
  await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
