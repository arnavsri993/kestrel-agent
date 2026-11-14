import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { candidateDigest } from "./native-retirement-evidence.mjs";

const identity = s => ({ dev: s.dev, ino: s.ino, nlink: s.nlink, mode: s.mode, uid: s.uid, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs });
async function directory(path, uid) {
 const s = await lstat(path);
 assert(s.isDirectory() && !s.isSymbolicLink() && s.uid === uid && !(s.mode & 0o022) && await realpath(path) === path, "Unsafe Chromium signing-clone directory.");
 return { dev: s.dev, ino: s.ino, mode: s.mode, uid: s.uid };
}
export async function chromiumSigningCloneNamespace(candidate) {
 const id = execFileSync("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", join(candidate, "Contents/Info.plist")], { encoding: "utf8", timeout: 5000 }).trim();
 assert(/^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/.test(id), "Invalid native bundle identifier.");
 const cache = await realpath(execFileSync("/usr/bin/getconf", ["DARWIN_USER_CACHE_DIR"], { encoding: "utf8", timeout: 5000 }).trim());
 assert(basename(cache) === "C", "Unexpected macOS user cache directory.");
 return join(dirname(cache), "X", `${id}.code_sign_clone`);
}

// Chromium hard-links only its main executable into its complete signing clone
// for update safety. A killed browser cannot run its destructor's cleanup.
// Account for every link; arbitrary aliases and all profile/key aliases remain
// forbidden. This reads metadata and bundle bytes; it never removes a clone.
export async function validateChromiumSigningClones(candidate, { namespace, uid = process.getuid(), ps = execFileSync } = {}) {
 const executable = join(candidate, "Contents/MacOS/Kestrel"), before = await lstat(executable);
 assert(before.isFile() && !before.isSymbolicLink() && before.uid === uid && !(before.mode & 0o022) && (before.mode & 0o111), "Unsafe native executable.");
 if (before.nlink === 1) return { executableIdentity: identity(before), aliases: [] };
 assert(before.nlink > 1 && before.nlink <= 33, "Too many executable aliases.");
 const root = namespace ?? await chromiumSigningCloneNamespace(candidate);
 const parentWitness = await directory(dirname(root), uid), rootWitness = await directory(root, uid);
 const entries = await readdir(root);
 assert(entries.length <= 128, "Chromium signing-clone inventory exceeds its bound.");
 const sha256 = await candidateDigest(candidate), aliases = [];
 for (const entry of entries.sort()) {
  if (!/^code_sign_clone\.[A-Za-z0-9_.-]{6}$/.test(entry)) continue;
  const container = join(root, entry); await directory(container, uid);
  for (const name of [basename(candidate), `${basename(candidate)}.bundle`]) {
   const clone = join(container, name), file = join(clone, "Contents/MacOS/Kestrel");
   let s; try { s = await lstat(file); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
   if (s.dev !== before.dev || s.ino !== before.ino) continue;
   for (const component of [clone, join(clone, "Contents"), join(clone, "Contents/MacOS")]) await directory(component, uid);
   assert.deepEqual(identity(s), identity(before), "Chromium signing-clone executable changed.");
   assert.equal(await realpath(file), file, "Aliased Chromium signing-clone executable.");
   assert.equal(await candidateDigest(clone), sha256, "Chromium signing clone differs from the complete candidate.");
   aliases.push({ path: clone, executable: file, candidateSha256: sha256 });
  }
 }
 assert.equal(aliases.length + 1, before.nlink, "Unaccounted native executable hard link.");
 const processes = ps("/bin/ps", ["-axo", "pid=,comm="], { encoding: "utf8", timeout: 5000 });
 for (const row of processes.split(/\r?\n/)) {
  const command = row.trim().match(/^\d+\s+(.+)$/)?.[1];
  assert(!command || ![candidate, ...aliases.map(item => item.path)].some(path => command.startsWith(`${path}/`)), "Candidate or signing-clone process is still running.");
 }
 assert.deepEqual(await directory(dirname(root), uid), parentWitness);
 assert.deepEqual(await directory(root, uid), rootWitness);
 assert.deepEqual(identity(await lstat(executable)), identity(before), "Native executable changed during signing-clone review.");
 for (const alias of aliases) assert.deepEqual(identity(await lstat(alias.executable)), identity(before));
 return { executableIdentity: identity(before), aliases };
}
