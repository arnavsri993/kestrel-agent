import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileNativeLocalVaultCrypto, nativeLocalVaultLinkFlags } from "./build-native-local-vault.mjs";

describe.skipIf(process.platform !== "darwin")("native browser local vault framework and profile guards", () => {
 let temporary, apps, profiles;
 beforeAll(() => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const src = join(root, "apps/native-chromium-host/src");
  temporary = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-browser-vault-test-")));
  profiles = join(temporary, "profiles"); mkdirSync(profiles, { mode: 0o700 });
  const object = compileNativeLocalVaultCrypto(join(temporary, "vault.o"), { target: `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx13.0` });
  const binaries = {};
  for (const mode of ["dev", "release"]) {
   const binary = join(temporary, `fixture-${mode}`); binaries[mode] = binary;
   execFileSync("/usr/bin/xcrun", ["clang++", "-std=c++20", "-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=13.0", `-DKESTREL_NATIVE_RELEASE_BUILD=${mode === "release" ? 1 : 0}`,
    join(src, "kestrel_browser_local_vault.mm"), join(src, "kestrel_local_vault.mm"), join(src, "kestrel_local_vault_crypto_process.mm"),
    join(root, "apps/native-chromium-host/tests/native_browser_local_vault_fixture.mm"), object,
    ...nativeLocalVaultLinkFlags(), "-framework", "Foundation", "-framework", "Security", "-o", binary], { timeout: 60000, stdio: "pipe" });
  }
  apps = {};
  for (const mode of ["dev", "release"]) for (const api of ["stock", "wrong", "current"]) {
   const app = join(temporary, `${mode}-${api}.app`), contents = join(app, "Contents"), macos = join(contents, "MacOS");
   const framework = join(contents, "Frameworks", "Chromium Embedded Framework.framework");
   mkdirSync(macos, { recursive: true }); mkdirSync(framework, { recursive: true });
   writeFileSync(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.kestrel.native-chromium-host.dev</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
   const executable = join(macos, "Fixture"); copyFileSync(binaries[mode], executable); chmodSync(executable, 0o700);
   const source = join(temporary, `${api}.cc`);
   const exports = api === "stock" ? 'extern "C" int fixture_stock_symbol() { return 1; }' :
    `#include <stdlib.h>\n#include <stddef.h>\nextern "C" unsigned int cef_kestrel_vault_api_version() { return ${api === "wrong" ? 999 : 1}; }\nextern "C" int cef_kestrel_vault_configure(unsigned char*, size_t) { _Exit(91); }`;
   writeFileSync(source, exports);
   execFileSync("/usr/bin/xcrun", ["clang++", "-dynamiclib", source, "-o", join(framework, "Chromium Embedded Framework")], { timeout: 30000, stdio: "pipe" });
   apps[`${mode}-${api}`] = executable;
  }
 }, 160000);
 afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });
 function profile(name, { existing = false, marker = false, markerMode = 0o600 } = {}) {
  const path = join(profiles, name); mkdirSync(path, { mode: 0o700 });
  if (existing) mkdirSync(join(path, "Profile 1"), { mode: 0o700 });
  if (marker) { const file = join(path, ".kestrel-native-test-profile-v1"); writeFileSync(file, "native-test-profile-v1\n", { mode: markerMode }); chmodSync(file, markerMode); }
  return realpathSync(path);
 }
 function invoke(app, path, mode, success = false) {
  const before = readdirSync(path).sort();
  const result = spawnSync(apps[app], [path, mode, success ? "ok" : "fail"], { encoding: "utf8", timeout: 15000 });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0); expect(result.stderr).toBe("");
  expect(readdirSync(path).sort()).toEqual(before);
  expect(readdirSync(path)).not.toContain(".kestrel-local-vault-v1");
  return result.stdout.trim();
 }
 it("rejects missing and incompatible framework APIs without changing an existing profile", () => {
  const path = profile("existing-stock", { existing: true });
  expect(invoke("dev-stock", path, "production")).toContain("does not support Kestrel's local vault");
  expect(invoke("dev-wrong", path, "production")).toContain("does not support Kestrel's local vault");
 });
 it("finds the locally loaded API and rejects existing profiles before key creation", () => {
  const path = profile("existing-current", { existing: true });
  expect(invoke("dev-current", path, "production")).toContain("existing profile has no local vault");
 });
 it("rejects mock mode on a vault-enabled engine", () => {
  const path = profile("current-mock", { marker: true });
  expect(invoke("dev-current", path, "mock")).toContain("Mock storage is unsupported");
 });
 it("allows stock mock mode only for a marked private development profile", () => {
  const valid = profile("stock-valid", { marker: true });
  expect(statSync(join(valid, ".kestrel-native-test-profile-v1")).mode & 0o777).toBe(0o600);
  expect(invoke("dev-stock", valid, "mock", true)).toBe("ok");
  expect(invoke("dev-stock", profile("stock-unmarked"), "mock")).toContain("restricted to marked disposable");
  expect(invoke("dev-stock", profile("stock-insecure", { marker: true, markerMode: 0o644 }), "mock")).toContain("restricted to marked disposable");
  const shared = profile("stock-shared-profile", { marker: true });
  chmodSync(shared, 0o755);
  expect(invoke("dev-stock", shared, "mock")).toContain("restricted to marked disposable");
 });
 it("rejects marked mock profiles in a release build", () => {
  expect(invoke("release-stock", profile("release-valid", { marker: true }), "mock")).toContain("restricted to marked disposable");
 });
});
