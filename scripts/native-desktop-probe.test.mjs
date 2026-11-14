import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { nativeDesktopProbePlan } from "./native-desktop-probe.mjs";

describe("supported native desktop probe routing", () => {
 for (const name of ["browser-backend", "isolated-automation", "download-capture"]) it(`routes ${name} through the actual desktop`, () => {
  const plan = nativeDesktopProbePlan(name, { env: { KESTREL_NATIVE_TEST_APP: "/fixture/Kestrel.app", KESTREL_TEST_NATIVE_LOCAL_VAULT: "1",
   KESTREL_TEST_REAL_CODEX: "1", KESTREL_TEST_REAL_CHROME_WEB_STORE: "1", KESTREL_TEST_NATIVE_WORKSPACE: "1", KESTREL_TEST_FUTURE_EXTERNAL_SCOPE: "1" } });
  assert(plan.script.endsWith("/scripts/smoke-chromium-desktop.mjs"));
  assert.equal(plan.env.KESTREL_NATIVE_TEST_APP, "/fixture/Kestrel.app"); assert.equal(plan.env.KESTREL_TEST_NATIVE_LOCAL_VAULT, "1");
  assert.equal(plan.env.KESTREL_TEST_NATIVE_ISOLATED_AUTOMATION, name === "isolated-automation" ? "1" : "0");
  assert.equal(plan.env.KESTREL_TEST_NATIVE_ISOLATED_DOWNLOADS, name === "download-capture" ? "1" : "0");
  for (const key of ["KESTREL_TEST_REAL_CODEX", "KESTREL_TEST_REAL_CHROME_WEB_STORE", "KESTREL_TEST_REQUIRE_CHROMIUM_EXTENSION_PARITY",
   "KESTREL_TEST_KEEP_STORE_UPDATE_PROFILE", "KESTREL_TEST_NATIVE_PROVIDERS", "KESTREL_TEST_NATIVE_WINDOW_LIFECYCLE",
   "KESTREL_TEST_NATIVE_WORKSPACE", "KESTREL_TEST_NATIVE_WORKSPACE_FIXTURE", "KESTREL_TEST_FUTURE_EXTERNAL_SCOPE"])
   assert.equal(plan.env[key], "0");
 });
 it("requires an exact candidate before production-vault setup", () => {
  assert.throws(() => nativeDesktopProbePlan("browser-backend", { env: { KESTREL_TEST_NATIVE_LOCAL_VAULT: "1" } }), /explicit candidate/);
 });
 it("keeps test-key default and selects distinct evidence for independent runs", () => {
  const first = nativeDesktopProbePlan("browser-backend", { env: {} }), second = nativeDesktopProbePlan("browser-backend", { env: {} });
  assert.equal(first.env.KESTREL_TEST_NATIVE_LOCAL_VAULT, "0"); assert.notEqual(first.evidence, second.evidence);
  const explicit = nativeDesktopProbePlan("download-capture", { env: { KESTREL_NATIVE_DESKTOP_EVIDENCE: "/fixture/evidence" } });
  assert.equal(explicit.evidence, "/fixture/evidence");
 });
});
