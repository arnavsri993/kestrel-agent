import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileNativeLocalVaultCrypto, nativeLocalVaultLinkFlags } from "./build-native-local-vault.mjs";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/native-chromium-host/src");
export async function buildNativeVaultTools({ macos, cryptoObject, identity = "-" }) {
 assert(process.platform === "darwin" && process.arch === "arm64", "Native vault tools require Apple Silicon macOS.");
 assert(macos === await realpath(macos) && macos.endsWith(".app/Contents/MacOS") && !macos.includes("/Applications/"), "Build native vault tools only in a canonical staging bundle.");
 const info = await lstat(macos); assert(info.isDirectory() && info.uid === process.getuid() && !(info.mode & 0o022));
 const temporary = cryptoObject ? undefined : await mkdtemp(join(tmpdir(), "kestrel-vault-tools-build-"));
 try {
  const object = cryptoObject ?? compileNativeLocalVaultCrypto(join(temporary, "crypto.o"));
  const sdk = execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8", timeout: 10000 }).trim();
  const common = ["clang++", "-std=c++20", "-O2", "-Wall", "-Wextra", "-Werror", "-arch", "arm64", "-mmacosx-version-min=13.0", "-isysroot", sdk];
  const link = [...nativeLocalVaultLinkFlags(), "-framework", "Foundation", "-framework", "Security"];
  const helper = join(macos, "Kestrel Vault"), provisioner = join(macos, "Kestrel Vault Provisioner");
  execFileSync("/usr/bin/xcrun", [...common, join(source, "kestrel_local_vault_crypto_helper.cc"), object, ...link, "-o", helper], { stdio: "pipe", timeout: 60000 });
  execFileSync("/usr/bin/xcrun", [...common, "-fobjc-arc", join(source, "kestrel_vault_provisioner.mm"), join(source, "kestrel_local_vault.mm"), join(source, "kestrel_local_vault_crypto_process.mm"), object, ...link, "-o", provisioner], { stdio: "pipe", timeout: 60000 });
  for (const tool of [helper, provisioner]) {
   execFileSync("/usr/bin/codesign", ["--force", "--sign", identity, "--options", "runtime", tool], { stdio: "pipe", timeout: 30000 });
   execFileSync("/usr/bin/codesign", ["--verify", "--strict", tool], { stdio: "pipe", timeout: 30000 });
   const imports = execFileSync("/usr/bin/nm", ["-u", tool], { encoding: "utf8", timeout: 10000 });
   assert(!/_SecItem(?:CopyMatching|Add|Update|Delete)\b/.test(imports), "Native vault tools must not import Keychain item APIs.");
  }
  return { helper, provisioner };
 } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
}
