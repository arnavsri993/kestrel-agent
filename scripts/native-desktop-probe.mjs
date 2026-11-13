import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildNativeChromiumHost } from "./build-native-chromium-host.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function nativeDesktopProbePlan(name, { env = process.env, root = repository } = {}) {
 assert(["browser-backend", "isolated-automation", "download-capture"].includes(name), "Unknown native desktop probe.");
 if (env.KESTREL_TEST_NATIVE_LOCAL_VAULT === "1") assert(env.KESTREL_NATIVE_TEST_APP, "Production-vault probes require an explicit candidate.");
 const evidence = resolve(env.KESTREL_NATIVE_DESKTOP_EVIDENCE || join(root, ".tmp", `native-${name}-${Date.now()}-${randomUUID()}`));
 const childEnv = { ...env };
 // Each command has one bounded scope; optional provider/Store/workspace tests
 // are available through their own supported entry points.
 for (const key of Object.keys(childEnv)) if (key.startsWith("KESTREL_TEST_")) childEnv[key] = "0";
 childEnv.KESTREL_TEST_NATIVE_LOCAL_VAULT = env.KESTREL_TEST_NATIVE_LOCAL_VAULT === "1" ? "1" : "0";
 childEnv.KESTREL_TEST_NATIVE_ISOLATED_AUTOMATION = name === "isolated-automation" ? "1" : "0";
 childEnv.KESTREL_TEST_NATIVE_ISOLATED_DOWNLOADS = name === "download-capture" ? "1" : "0";
 childEnv.KESTREL_NATIVE_DESKTOP_EVIDENCE = evidence;
 return { root, evidence, env: childEnv, script: join(root, "scripts/smoke-chromium-desktop.mjs") };
}
export async function runNativeDesktopProbe(name) {
 assert.equal(process.argv.length, 2, "Native probes accept no profile arguments.");
 const plan = nativeDesktopProbePlan(name);
 plan.env.KESTREL_NATIVE_TEST_APP = process.env.KESTREL_NATIVE_TEST_APP
  ? resolve(process.env.KESTREL_NATIVE_TEST_APP) : await buildNativeChromiumHost();
 await mkdir(plan.evidence, { recursive: true, mode: 0o700 });
 assert.equal((await readdir(plan.evidence)).length, 0, "Use a fresh native probe evidence directory.");
 console.log(`NATIVE_DESKTOP_PROBE_EVIDENCE ${plan.evidence}`);
 const child = spawn(process.execPath, [plan.script], { cwd: plan.root, env: plan.env, stdio: "inherit" });
 const forwardInt = () => { child.kill("SIGINT"); };
 const forwardTerm = () => { child.kill("SIGTERM"); };
 process.once("SIGINT", forwardInt); process.once("SIGTERM", forwardTerm);
 try {
  const outcome = await new Promise((done, reject) => {
   child.once("error", reject); child.once("exit", (code, signal) => done({ code, signal }));
  });
  assert.deepEqual(outcome, { code: 0, signal: null }, `Native desktop probe failed; evidence kept at ${plan.evidence}`);
 } finally { process.removeListener("SIGINT", forwardInt); process.removeListener("SIGTERM", forwardTerm); }
}
