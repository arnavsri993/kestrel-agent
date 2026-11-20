import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/native-chromium-host/src");

export function compileNativeLocalVaultCrypto(output, { target = "arm64-apple-macosx13.0" } = {}) {
  execFileSync("/usr/bin/xcrun", ["swiftc", "-parse-as-library", "-O", "-target", target,
    "-module-name", "KestrelLocalVault", "-emit-object", join(source, "kestrel_local_vault_crypto.swift"), "-o", output],
    { stdio: "pipe", timeout: 60000 });
  return output;
}

export function nativeLocalVaultLinkFlags() {
  const info = JSON.parse(execFileSync("/usr/bin/xcrun", ["swiftc", "-print-target-info"],
    { encoding: "utf8", timeout: 10000 }));
  return [...info.paths.runtimeLibraryPaths.flatMap(path => ["-L", path]),
    "-framework", "CryptoKit", "-framework", "LocalAuthentication",
    "-Wl,-rpath,/usr/lib/swift"];
}
