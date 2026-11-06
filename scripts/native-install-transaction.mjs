import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { candidateDigest } from "./native-retirement-evidence.mjs";

const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const STATES = new Set(["prepared", "staged", "moving-previous", "previous-moved", "candidate-installed", "committed", "restoring", "candidate-retained", "rolled-back"]);
const absent = error => error.code === "ENOENT";
function requireCallbacks(options, names) {
  for (const name of names) if (typeof options[name] !== "function") throw new Error(`Trusted ${name} callback is required.`);
}
async function statMaybe(path) {
  try { return await fs.lstat(path); } catch (error) { if (!absent(error)) throw error; return null; }
}
// Check every ancestor: realpath alone can hide a symlink in a parent directory.
async function safeDirectory(path, missing = false) {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`Noncanonical directory: ${path}`);
  let current = sep;
  for (const part of path.split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await statMaybe(current);
    if (!info && missing && current === path) return false;
    if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe directory or ancestor: ${current}`);
  }
  return true;
}
async function privateDirectory(path, create = false, ops = fs) {
  let created = false;
  if (create) {
    try { await ops.mkdir(path, { mode: 0o700 }); created = true; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  await safeDirectory(path);
  const info = await fs.lstat(path);
  if (info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) throw new Error(`Recovery directory must be owned and private (0700): ${path}`);
  if (created) await syncDirectory(dirname(path));
}
async function markUnindexed(path) {
  const marker = join(path, ".metadata_never_index");
  let handle;
  try { handle = await fs.open(marker, "wx", 0o600); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const info = await fs.lstat(marker);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1 || info.size !== 0) throw new Error(`Unsafe recovery indexing marker: ${marker}`);
    return;
  }
  try { await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(path);
}
async function syncDirectory(path) {
  const handle = await fs.open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function move(from, to, ops) {
  await ops.rename(from, to);
  await syncDirectory(dirname(from));
  if (dirname(from) !== dirname(to)) await syncDirectory(dirname(to));
}
async function writeJournal(path, journal, ops = fs) {
  const temporary = join(dirname(path), `.journal-${randomUUID()}`);
  const handle = await ops.open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(journal)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, path);
  await syncDirectory(dirname(path));
}
async function readPrivateJson(path, { metadataOnly = false } = {}) {
  const before = await fs.lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Private metadata must be a regular file: ${path}`);
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (info.ino !== before.ino || info.dev !== before.dev || !info.isFile() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1 || info.size > 16384) throw new Error(`Metadata must be bounded, owned and private: ${path}`);
    if (metadataOnly) return { info }; // Interrupted initial JSON is debris, never authority.
    const buffer = Buffer.alloc(16385);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 16384) throw new Error("Private metadata exceeds size limit.");
    return { value: JSON.parse(buffer.subarray(0, length).toString("utf8")), info };
  } finally { await handle.close(); }
}
// Cooperative exclusion, not a security capability: an unrelated loopback service
// or a hash collision also causes conservative refusal. The kernel releases it
// after any process death, including death before a recovery journal exists.
async function acquireGuard(target) {
  const port = 49152 + (createHash("sha256").update(target).digest().readUInt16BE(0) % 16384);
  const server = createServer({ pauseOnConnect: true }, socket => socket.destroy());
  server.maxConnections = 1;
  await new Promise((accept, reject) => {
    const failed = error => reject(error.code === "EADDRINUSE"
      ? new Error(`Installer guard unavailable at 127.0.0.1:${port}; another installer or local service may be active for ${target}`, { cause: error }) : error);
    server.once("error", failed);
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => { server.removeListener("error", failed); accept(); });
  });
  return () => new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
}
async function withLock(target, action) {
  const release = await acquireGuard(target);
  let result, failure;
  try { result = await action(); } catch (error) { failure = error; }
  try { await release(); }
  catch (error) { failure = failure ? new AggregateError([failure, error], `${failure.message}; installer guard release failed: ${error.message}`) : error; }
  if (failure) throw failure;
  return result;
}
function locations(target, id) {
  const root = join(dirname(target), ".Kestrel-cutover-backups");
  const directory = join(root, id);
  return { root, directory, transactionPath: join(directory, "transaction.json"), backupPath: join(directory, "previous", "Kestrel.app"), staged: join(directory, "stage", "Kestrel.app"), retained: join(directory, "candidate", "Kestrel.app") };
}
async function readTransaction(paths, target, id) {
  const { value: journal } = await readPrivateJson(paths.transactionPath);
  if (journal?.version !== 1 || journal.id !== id || journal.target !== target || !isAbsolute(journal.source ?? "") || resolve(journal.source) !== journal.source || !SHA.test(journal.candidateSha256 ?? "") || !SHA.test(journal.previousSha256 ?? "") || !STATES.has(journal.state)) throw new Error("Invalid or mismatched recovery journal.");
  return journal;
}
async function indexingMarker(path) {
  const info = await fs.lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1 || info.size !== 0) throw new Error(`Unsafe recovery indexing marker: ${path}`);
}
async function assertNoPendingTransaction(target, ops = fs) {
  const root = join(dirname(target), ".Kestrel-cutover-backups");
  if (!await statMaybe(root)) return;
  await privateDirectory(root);
  let count = 0;
  const entries = await fs.opendir(root);
  for await (const entry of entries) {
    if (entry.name === ".metadata_never_index") { await indexingMarker(join(root, entry.name)); continue; }
    if (++count > 256 || !UUID.test(entry.name)) throw new Error(`Unknown or excessive recovery entries; inspect without deleting: ${join(root, entry.name)}`);
    const paths = locations(target, entry.name);
    try {
      await privateDirectory(paths.directory);
      if (!await statMaybe(paths.transactionPath)) {
        // An interrupted first atomic write may leave bounded private temporary
        // files. Preserve their bytes without interpreting incomplete JSON.
        let debris = 0;
        for await (const child of await fs.opendir(paths.directory)) {
          const path = join(paths.directory, child.name);
          if (child.name === ".metadata_never_index") { await indexingMarker(path); continue; }
          if (!child.name.startsWith(".journal-") || !UUID.test(child.name.slice(9)) || ++debris > 8) throw new Error("Unjournaled transaction contains unknown or excessive data");
          await readPrivateJson(path, { metadataOnly: true });
        }
        continue;
      }
      const journal = await readTransaction(paths, target, entry.name);
      if (journal.state === "committed" || journal.state === "rolled-back") continue;
      const backupParent = dirname(paths.backupPath);
      if (await statMaybe(backupParent)) await privateDirectory(backupParent);
      const backup = await statMaybe(paths.backupPath);
      if (await hashAt(target) === journal.previousSha256 && !backup && !await statMaybe(paths.backupPath)) {
        // Reconcile only metadata for a failed pre-move attempt or completed
        // restoration. This does not attest registration or a visible workflow.
        journal.reconciledFromState = journal.state;
        journal.reconciliation = "previous-bundle-present-without-backup";
        journal.reconciledAt = new Date().toISOString();
        journal.state = "rolled-back";
        await writeJournal(paths.transactionPath, journal, ops);
        continue;
      }
      throw new Error("Pending native cutover requires explicit recovery before another installation");
    } catch (error) { throw new Error(`${error.message}; recovery journal: ${paths.transactionPath}`, { cause: error }); }
  }
}
async function hashAt(path) {
  if (!await safeDirectory(path, true)) return null;
  return candidateDigest(path);
}
async function assertHash(path, expected, label) {
  if (await hashAt(path) !== expected) throw new Error(`${label} changed or is missing: ${path}`);
}
async function restore(journal, paths, callbacks, ops) {
  const target = journal.target;
  await callbacks.beforeReplace(target);
  const current = await hashAt(target);
  if (current === journal.previousSha256) {
    // A prior recovery may have restored the bundle before its final journal write.
    await callbacks.register(target);
    journal.state = "rolled-back"; await writeJournal(paths.transactionPath, journal, ops);
    return;
  }
  if (current !== null && current !== journal.candidateSha256) throw new Error(`Refusing to overwrite changed target: ${target}`);
  await privateDirectory(dirname(paths.backupPath));
  await assertHash(paths.backupPath, journal.previousSha256, "Previous backup");
  journal.state = "restoring"; await writeJournal(paths.transactionPath, journal, ops);
  if (current !== null) {
    await privateDirectory(dirname(paths.retained), true, ops);
    if (await statMaybe(paths.retained)) throw new Error(`Retained candidate already exists: ${paths.retained}`);
    await assertHash(target, journal.candidateSha256, "Installed candidate");
    await callbacks.beforeReplace(target);
    await move(target, paths.retained, ops);
  }
  journal.state = "candidate-retained"; await writeJournal(paths.transactionPath, journal, ops);
  // Recheck the empty destination and backup immediately before restoring it.
  if (await statMaybe(target)) throw new Error(`Refusing to replace newly occupied target: ${target}`);
  await assertHash(paths.backupPath, journal.previousSha256, "Previous backup");
  await callbacks.beforeReplace(target);
  // A process scan cannot exclude an independent filesystem writer. Check again
  // after the scan; the cooperative guard only serializes participating installers.
  if (await statMaybe(target)) throw new Error(`Refusing to replace newly occupied target: ${target}`);
  await move(paths.backupPath, target, ops);
  await callbacks.beforeReplace(target);
  await assertHash(target, journal.previousSha256, "Restored previous bundle");
  await callbacks.register(target);
  journal.state = "rolled-back"; await writeJournal(paths.transactionPath, journal, ops);
}

/** Shared process-lifetime exclusion for native and legacy installers. */
export async function withNativeInstallLock(target, action) {
  if (typeof action !== "function" || !isAbsolute(target ?? "") || resolve(target) !== target || basename(target) !== "Kestrel.app") throw new Error("Canonical Kestrel.app target and installer callback are required.");
  await safeDirectory(dirname(target));
  return withLock(target, async () => { await assertNoPendingTransaction(target); return action(); });
}

/** Callers supply static evidence/signature validation and running-app checks. */
export async function installNativeBundleTransaction(options) {
  requireCallbacks(options, ["copy", "validate", "beforeReplace", "register"]);
  const { source, target, expectedCandidateSha256 } = options;
  if (options.onPrepared !== undefined && typeof options.onPrepared !== "function") throw new Error("onPrepared must be a trusted callback.");
  const ops = { ...fs, ...options.ops };
  if (basename(target ?? "") !== "Kestrel.app" || basename(source ?? "") !== "Kestrel.app" || !SHA.test(expectedCandidateSha256 ?? "")) throw new Error("Canonical Kestrel.app paths and candidate SHA-256 are required.");
  await safeDirectory(source); await safeDirectory(target);
  if (source === target || source.startsWith(`${target}${sep}`) || target.startsWith(`${source}${sep}`)) throw new Error("Source and target must be separate bundles.");
  const id = randomUUID(), paths = locations(target, id);
  return withLock(target, async () => {
    await assertNoPendingTransaction(target, ops);
    const candidateSha256 = await candidateDigest(source), previousSha256 = await candidateDigest(target);
    if (candidateSha256 !== expectedCandidateSha256) throw new Error("Source candidate does not match expected SHA-256.");
    await privateDirectory(paths.root, true, ops);
    await markUnindexed(paths.root);
    await ops.mkdir(paths.directory, { mode: 0o700 });
    await privateDirectory(paths.directory);
    await markUnindexed(paths.directory);
    await syncDirectory(paths.root);
    const journal = { version: 1, id, source, target, candidateSha256, previousSha256, state: "prepared" };
    let previousMoved = false;
    try {
      await writeJournal(paths.transactionPath, journal, ops);
      await options.onPrepared?.({ transactionPath: paths.transactionPath });
      await privateDirectory(dirname(paths.staged), true, ops);
      await privateDirectory(dirname(paths.backupPath), true, ops);
      await options.copy(source, paths.staged);
      await assertHash(paths.staged, candidateSha256, "Staged candidate");
      await options.validate(paths.staged);
      journal.state = "staged"; await writeJournal(paths.transactionPath, journal, ops);
      await options.beforeReplace(target);
      await assertHash(source, candidateSha256, "Source candidate");
      await assertHash(paths.staged, candidateSha256, "Staged candidate");
      await assertHash(target, previousSha256, "Previous target");
      journal.state = "moving-previous"; await writeJournal(paths.transactionPath, journal, ops);
      await options.beforeReplace(target);
      await move(target, paths.backupPath, ops); previousMoved = true;
      journal.state = "previous-moved"; await writeJournal(paths.transactionPath, journal, ops);
      await options.beforeReplace(target);
      await move(paths.staged, target, ops);
      await options.beforeReplace(target);
      journal.state = "candidate-installed"; await writeJournal(paths.transactionPath, journal, ops);
      await assertHash(target, candidateSha256, "Installed candidate");
      await options.validate(target);
      await assertHash(target, candidateSha256, "Installed candidate");
      await options.register(target);
      await assertHash(target, candidateSha256, "Registered candidate");
      journal.state = "committed"; await writeJournal(paths.transactionPath, journal, ops);
      return { destination: target, candidateSha256, previousSha256, backupPath: paths.backupPath, transactionPath: paths.transactionPath };
    } catch (error) {
      let recoveryError;
      // rename may have succeeded before a directory sync failed.
      try {
        if (previousMoved || await statMaybe(paths.backupPath)) await restore(journal, paths, options, ops);
      } catch (failure) { recoveryError = failure; }
      const message = `${error.message}; ${recoveryError ? `recovery incomplete (${recoveryError.message})` : "bundles preserved"}; recovery journal: ${paths.transactionPath}`;
      throw recoveryError ? new AggregateError([error, recoveryError], message) : new Error(message, { cause: error });
    }
  });
}

/** Explicit owner recovery only; never trusts destination paths from the journal. */
export async function rollbackNativeBundleTransaction(options) {
  requireCallbacks(options, ["beforeReplace", "register"]);
  const { transactionPath, target } = options, ops = { ...fs, ...options.ops };
  if (basename(target ?? "") !== "Kestrel.app") throw new Error("Known canonical Kestrel.app target is required.");
  await safeDirectory(dirname(target));
  if (resolve(target) !== target) throw new Error("Target must be absolute and canonical.");
  const directory = dirname(transactionPath ?? ""), id = basename(directory), paths = locations(target, id);
  if (!UUID.test(id) || transactionPath !== paths.transactionPath) throw new Error("Recovery journal must use its generated transaction path for this target.");
  await privateDirectory(paths.root); await privateDirectory(paths.directory);
  const loadJournal = () => readTransaction(paths, target, id);
  await loadJournal(); // Validate the generated recovery location before acquiring the guard.
  return withLock(target, async () => {
    const journal = await loadJournal();
    try { await restore(journal, paths, options, ops); }
    catch (error) { throw new Error(`${error.message}; all remaining bundles retained; recovery journal: ${transactionPath}`, { cause: error }); }
    return { destination: target, candidateSha256: journal.candidateSha256, previousSha256: journal.previousSha256, backupPath: paths.backupPath, transactionPath };
  });
}
