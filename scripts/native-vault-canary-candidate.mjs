import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { manifest } from "./prepare-native-vault-cef.mjs";
import { validateChromiumSigningClones } from "./native-code-sign-clone.mjs";
import { assertNoExactExecutableRunning, validateChromiumVaultCandidatePath } from "./native-real-keychain-candidate.mjs";

const sha256 = /^[a-f0-9]{64}$/;
export function validatePackagedVaultMetadata(value) {
 if (value?.apiVersion !== 1 || !sha256.test(value.frameworkSha256 ?? "") || !sha256.test(value.sourceFrameworkSha256 ?? "") ||
     value.sourceProvenance !== "builder-attestation-not-independent-proof" || value.runtimeBehaviorVerified !== false)
  throw Error("Candidate requires a vault-engine build record; metadata does not certify runtime behavior.");
 for (const kind of ["cef", "chromium"])
  if (value.pins?.[kind]?.commit !== manifest.pins[kind].commit) throw Error("Candidate engine source pin differs from the reviewed patch set.");
 if (!Array.isArray(value.patches) || value.patches.length !== manifest.patches.length)
  throw Error("Candidate engine patch set is incomplete.");
 const seen = new Set();
 for (const patch of value.patches) {
  const expected = manifest.patches.find(item => item.file === patch?.file);
  if (!expected || seen.has(patch.file) || patch.sha256 !== expected.sha256) throw Error("Candidate engine patch digest differs from the reviewed patch set.");
  seen.add(patch.file);
 }
 return value;
}

async function privateBundleFile(path, maximum) {
 if (await realpath(path) !== path) throw Error("Candidate metadata or executable is aliased.");
 const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try {
  const info = await file.stat();
  if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || (info.mode & 0o022) !== 0 || info.size > maximum)
   throw Error("Candidate bundle file is unsafe or oversized.");
  const bytes = await file.readFile();
  if (bytes.length > maximum) throw Error("Candidate bundle file grew past its limit.");
  return bytes;
 } finally { await file.close(); }
}

export async function validateVaultCanaryCandidate(supplied, { root } = {}) {
 const selected = await validateChromiumVaultCandidatePath(supplied, { root });
 const { candidate, executable } = selected;
 assertNoExactExecutableRunning(executable);
 const recordPath = join(candidate, "Contents/Resources/native-vault-engine.json");
 let metadata;
 try { metadata = validatePackagedVaultMetadata(JSON.parse((await privateBundleFile(recordPath, 65536)).toString("utf8"))); }
 catch { throw Error("Select a disposable app built with the reviewed vault-enabled engine. No app was launched."); }
 const helper = join(candidate, "Contents/MacOS/Kestrel Vault");
 for (const path of [executable, helper]) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || info.nlink !== (path === executable ? selected.signingClones.aliases.length + 1 : 1) ||
      (info.mode & 0o022) !== 0 || !(info.mode & 0o111) || await realpath(path) !== path)
   throw Error("Candidate native executable is unsafe.");
  const imports = execFileSync("/usr/bin/nm", ["-u", path], { encoding: "utf8", timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
  if (/_SecItem(?:CopyMatching|Add|Update|Delete)\b/.test(imports))
   throw Error("Candidate native vault path still imports Keychain password-item APIs.");
 }
 const framework = await realpath(join(candidate, "Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework"));
 if (!framework.startsWith(`${candidate}/Contents/Frameworks/Chromium Embedded Framework.framework/`))
  throw Error("Candidate engine escapes its framework.");
 const file = await open(framework, constants.O_RDONLY | constants.O_NOFOLLOW);
 let frameworkSha256;
 try {
  const before = await file.stat();
  if (!before.isFile() || before.nlink !== 1 || ![process.getuid(), 0].includes(before.uid) || (before.mode & 0o022) !== 0)
   throw Error("Candidate framework binary is unsafe.");
  const hash = createHash("sha256");
  for await (const bytes of file.createReadStream({ autoClose: false })) hash.update(bytes);
  const after = await file.stat();
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
   throw Error("Candidate framework changed during validation.");
  frameworkSha256 = hash.digest("hex");
 } finally { await file.close(); }
 if (frameworkSha256 !== metadata.frameworkSha256) throw Error("Candidate framework does not match its build record.");
 const symbols = execFileSync("/usr/bin/nm", ["-gU", framework], { encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
 const exports = new Set([...symbols.matchAll(/^\s*[a-fA-F0-9]+\s+T\s+(\S+)\s*$/gm)].map(match => match[1]));
 for (const name of ["_cef_kestrel_vault_api_version", "_cef_kestrel_vault_configure"])
  if (!exports.has(name)) throw Error("Candidate is missing an actual vault-engine API export.");
 execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", candidate], { stdio: "pipe", timeout: 30000 });
 if (JSON.stringify(await validateChromiumSigningClones(candidate)) !== JSON.stringify(selected.signingClones)) throw Error("Candidate executable aliases changed during validation.");
 return { ...selected, metadata, frameworkSha256, noDirectKeychainItemImports: true };
}
