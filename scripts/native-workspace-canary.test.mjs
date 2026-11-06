import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { finishNativeWorkspaceCanary } from "./native-workspace-canary.mjs";
import { createNativeCoreConfiguration, NativeCoreConfigurationBusyError, NATIVE_CORE_CONFIGURATION_BUSY_MESSAGE, nativeHostSettingsErrorMessage } from "../apps/native-chromium-host/resources/native-core-configuration.mjs";

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const content = "Native Kestrel workspace fixture. This disposable folder contains no user data.\n";
const generic = "Kestrel settings could not be applied. Finish or cancel active tasks and check the native profile before retrying.";
async function harness(responses) {
  const path = await mkdtemp(join(tmpdir(), "native-workspace-revoke-")); roots.push(path);
  await writeFile(join(path, "README.md"), content);
  const state = { path, projectId: "synthetic-project", sessionId: "synthetic-session" }, receipt = { phases: [] };
  let revoked = false, calls = 0;
  const revoke = vi.fn(async () => {
    const response = responses[Math.min(calls++, responses.length - 1)];
    if (response instanceof Error) throw response;
    return response;
  });
  const waitFor = vi.fn(async () => {});
  const home = { locator: () => ({ getByRole: () => ({ waitFor }) }), evaluate: vi.fn(async (evaluate, argument) => {
    // Execute the real browser callback against a bounded synthetic bridge.
    const prior = globalThis.window;
    globalThis.window = { kestrel: { request: async request => {
      if (request.type === "get-workspace-grants") return { ok: true, projects: [{ id: state.projectId, path, available: true }] };
      if (request.type === "runtime-call-tool") return { execution: revoked ? { status: "blocked" } : { status: "verified", output: { content } } };
      if (request.type === "remove-workspace-folder") { const response = await revoke(); if (response.ok) revoked = true; return response; }
      throw new Error("Unexpected synthetic request");
    } } };
    try { return await evaluate(argument); } finally { globalThis.window = prior; }
  }) };
  return { home, state, receipt, revoke, waitFor };
}
it("retries only trusted busy admission, then proves revocation and records its reason", async () => {
  const busy = { ok: false, error: nativeHostSettingsErrorMessage(new NativeCoreConfigurationBusyError(), "remove-workspace-folder") };
  const f = await harness([busy, busy, { ok: true, projects: [] }]);
  await finishNativeWorkspaceCanary(f);
  expect(f.revoke).toHaveBeenCalledTimes(3);
  expect(f.receipt.phases).toContainEqual({ phase: "native-workspace-grant-revocation-admission", passed: true, busyRetryCount: 2, busyResponse: NATIVE_CORE_CONFIGURATION_BUSY_MESSAGE });
  expect(f.receipt.phases.at(-1)).toMatchObject({ phase: "native-workspace-full-restart-and-grant-revocation", passed: true, busyRetryCount: 2 });
  expect(await readFile(join(f.state.path, "README.md"), "utf8")).toBe(content);
});
it.each([generic, "Agent Core could not restart.", `${NATIVE_CORE_CONFIGURATION_BUSY_MESSAGE} `])("never retries non-admission settings failures: %s", async error => {
  const f = await harness([{ ok: false, error }, { ok: true, projects: [] }]);
  await expect(finishNativeWorkspaceCanary(f)).rejects.toThrow(error);
  expect(f.revoke).toHaveBeenCalledTimes(1);
  expect(f.receipt.phases).toContainEqual({ phase: "native-workspace-grant-revocation-admission", passed: false, busyRetryCount: 0 });
});
it("does not retry a rejected transport or thrown lifecycle error", async () => {
  const f = await harness([new Error("synthetic lifecycle failure"), { ok: true, projects: [] }]);
  await expect(finishNativeWorkspaceCanary(f)).rejects.toThrow("synthetic lifecycle failure");
  expect(f.revoke).toHaveBeenCalledTimes(1);
});
it("bounds busy contention and still fails the strict revocation assertion", async () => {
  const f = await harness([{ ok: false, error: NATIVE_CORE_CONFIGURATION_BUSY_MESSAGE }]);
  await expect(finishNativeWorkspaceCanary(f)).rejects.toThrow(NATIVE_CORE_CONFIGURATION_BUSY_MESSAGE);
  expect(f.revoke).toHaveBeenCalledTimes(21);
  expect(f.receipt.phases).toContainEqual({ phase: "native-workspace-grant-revocation-admission", passed: false, busyRetryCount: 20, busyResponse: NATIVE_CORE_CONFIGURATION_BUSY_MESSAGE });
});
it("the real configuration guard refuses before mutation, settles, then lets the canary revoke once", async () => {
  const f = await harness([{ ok: true, projects: [] }]);
  let busy = true;
  const core = { hasProcess: false, start: vi.fn(async () => { core.hasProcess = true; }), stop: vi.fn(async () => { core.hasProcess = false; }) };
  const config = createNativeCoreConfiguration({ core, configuration: async () => ({}), isBusy: () => busy });
  await config.start(); const mutation = vi.fn(async () => ({ ok: true, projects: [] }));
  f.revoke.mockImplementation(async () => {
    try { return await config.reconfigure(mutation); }
    catch (error) { busy = false; return { ok: false, error: nativeHostSettingsErrorMessage(error, "remove-workspace-folder") }; }
  });
  await finishNativeWorkspaceCanary(f);
  expect(mutation).toHaveBeenCalledTimes(1); expect(core.stop).toHaveBeenCalledTimes(1);
  expect(f.receipt.phases.at(-1).busyRetryCount).toBe(1);
});
