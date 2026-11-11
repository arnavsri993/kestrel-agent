#!/usr/bin/env node
// Hardware Core-key fixture only. This is not candidate-bound release evidence.
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileNativeLocalVaultCrypto, nativeLocalVaultLinkFlags } from "./build-native-local-vault.mjs";

assert.equal(process.platform, "darwin"); assert.equal(process.arch, "arm64");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "apps/native-chromium-host/src");
const tempRoot = await realpath(join(root, ".tmp"));
assert.equal(tempRoot, join(root, ".tmp"));
const tempStat = await lstat(tempRoot);
assert(tempStat.isDirectory() && !tempStat.isSymbolicLink() && tempStat.uid === process.getuid() && !(tempStat.mode & 0o022));
const evidence = join(tempRoot, `native-local-vault-core-fixture-${Date.now()}-${randomUUID()}`);
await mkdir(evidence, { mode: 0o700 });
const work = join(evidence, "work");
await mkdir(work, { mode: 0o700 });
assert.equal(await realpath(work), work);
const app = join(work, "VaultFixture.app"), macos = join(app, "Contents/MacOS");
const executable = join(macos, "VaultFixture"), helper = join(macos, "Kestrel Vault"), object = join(work, "vault.o");
const receipt = { version: 1, gate: "native-local-vault-core-fixture", result: "failed", notCandidateBound: true, encryptedDatabaseVerified: false, coreKeyRestartVerified: false, noKeychainItemAPIs: "production source path uses no item APIs; system internals not observed", scope: "Standalone Core profile key fixture only; no Kestrel app, Chromium, candidate, database encryption, signing or user data proof." };
let stage = "setup";
function command(args) { execFileSync("/usr/bin/xcrun", args, { stdio: "pipe", timeout: 60000 }); }
function run(mode, profile) {
 const result = spawnSync(executable, [mode, profile], { encoding: "utf8", timeout: 20000, env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "", TMPDIR: tmpdir(), LANG: "en_US.UTF-8" } });
 assert(!result.error && result.status === 0 && result.signal === null, `Fixture failed during ${stage}.`);
 assert.equal(result.stderr, "");
 if (mode === "refuse") { assert.equal(result.stdout, ""); return; }
 assert.match(result.stdout, /^[a-f0-9]{64}\n$/); return result.stdout.trim();
}
try {
 await mkdir(macos, { recursive: true, mode: 0o700 });
 await writeFile(join(app, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>VaultFixture</string><key>CFBundleIdentifier</key><string>com.kestrel.local-vault-fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`, { mode: 0o600 });
 stage = "compile-swift"; compileNativeLocalVaultCrypto(object);
 const flags = ["-std=c++20", "-fobjc-arc", "-mmacosx-version-min=13.0"];
 stage = "compile-helper"; command(["clang++", ...flags, join(src, "kestrel_local_vault_crypto_helper.cc"), object, ...nativeLocalVaultLinkFlags(), "-framework", "Foundation", "-framework", "Security", "-o", helper]);
 stage = "compile-core-fixture"; command(["clang++", ...flags, join(src, "kestrel_native_core_keychain.mm"), join(src, "kestrel_local_vault.mm"), join(src, "kestrel_local_vault_crypto_process.mm"), join(root, "apps/native-chromium-host/tests/native_local_vault_core_fixture.mm"), object, ...nativeLocalVaultLinkFlags(), "-framework", "Foundation", "-framework", "Security", "-o", executable]);
 await chmod(executable, 0o700); await chmod(helper, 0o700);
 const profile = join(work, "profile"); await mkdir(profile, { mode: 0o700 });
 stage = "production-create"; console.log(`STAGE ${stage}`); const first = run("create", profile);
 const vault = join(profile, ".kestrel-local-vault-v1"), stat = await lstat(vault);
 assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600);
 const envelope = await readFile(vault); assert(envelope.length > 0 && envelope.length <= 16384);
 for (const path of [join(profile, ".kestrel-native-test-core-key-v1"), join(profile, "native-core/database.key")])
  await assert.rejects(lstat(path), { code: "ENOENT" });
 await mkdir(join(profile, "native-core"), { mode: 0o700 });
 stage = "production-restart-existing"; console.log(`STAGE ${stage}`); const second = run("existing", profile); assert.equal(first, second);
 receipt.coreKeyRestartVerified = true; receipt.keySha256 = first; receipt.envelopeMode0600 = true;
 const missing = join(work, "existing-without-vault"); await mkdir(missing, { mode: 0o700 }); await mkdir(join(missing, "native-core"), { mode: 0o700 });
 await writeFile(join(missing, "native-core", "sentinel"), "generated fixture data", { mode: 0o600 });
 stage = "existing-profile-no-vault"; console.log(`STAGE ${stage}`); run("refuse", missing);
 await assert.rejects(lstat(join(missing, ".kestrel-local-vault-v1")), { code: "ENOENT" });
 assert.equal(await readFile(join(missing, "native-core", "sentinel"), "utf8"), "generated fixture data");
 const corrupt = join(work, "corrupt-profile"); await mkdir(corrupt, { mode: 0o700 });
 const damaged = Buffer.from(envelope); damaged[damaged.length - 1] ^= 1; const damagedPath = join(corrupt, ".kestrel-local-vault-v1");
 await writeFile(damagedPath, damaged, { mode: 0o600 });
 stage = "corrupt-envelope-contained"; console.log(`STAGE ${stage}`); run("refuse", corrupt);
 assert.deepEqual(await readFile(damagedPath), damaged); assert.deepEqual(await readFile(vault), envelope);
 receipt.existingProfileWithoutVaultRefused = true; receipt.corruptEnvelopeRefused = true;
 receipt.result = "passed";
} catch (error) {
 if (stage.startsWith("compile-")) console.error(String(error.stderr ?? "").slice(0, 8000));
 receipt.failedStage = stage; process.exitCode = 1; console.error(`Native local-vault Core fixture failed at ${stage}.`);
} finally {
 await rm(work, { recursive: true, force: true });
 await writeFile(join(evidence, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}
if (receipt.result === "passed") console.log(`Core fixture passed; receipt: ${join(evidence, "receipt.json")}`);
