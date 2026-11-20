import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileNativeLocalVaultCrypto, nativeLocalVaultLinkFlags } from "./build-native-local-vault.mjs";

describe.skipIf(process.platform !== "darwin")("native local vault file safety with injected crypto", () => {
 let temporary, executable, profileRoot;
 beforeAll(() => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const src = join(root, "apps/native-chromium-host/src");
  temporary = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-local-vault-test-")));
  profileRoot = join(temporary, "profiles"); mkdirSync(profileRoot, { mode: 0o700 });
  executable = join(temporary, "fixture"); const object = join(temporary, "vault-crypto.o");
  const sdk = execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8", timeout: 10000 }).trim();
  const target = `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx13.0`;
  compileNativeLocalVaultCrypto(object, { target });
  execFileSync("/usr/bin/xcrun", ["clang++", "-std=c++20", "-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=13.0", "-isysroot", sdk,
   join(src, "kestrel_local_vault.mm"), join(src, "kestrel_local_vault_crypto_process.mm"), join(root, "apps/native-chromium-host/tests/native_local_vault_test.mm"), object,
   ...nativeLocalVaultLinkFlags(), "-framework", "Foundation", "-framework", "Security", "-o", executable], { timeout: 60000, stdio: "pipe" });
 }, 160000);
 afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });
 it("preserves unsafe inputs and fails closed using only injected mock crypto", () => {
  const result = spawnSync(executable, [profileRoot], { encoding: "utf8", timeout: 15000 });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0); expect(result.stderr).toBe("");
 });
});
