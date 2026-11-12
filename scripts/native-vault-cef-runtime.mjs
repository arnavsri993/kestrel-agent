// Validate an explicitly supplied local custom CEF distribution. Read-only:
// no download, build, dlopen, engine execution, signing or profile access.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifest, verifyPatchDigests } from './prepare-native-vault-cef.mjs';

export const VAULT_CEF_BUILD_RECEIPT_NAME = '.kestrel-vault-build.json';
export const VAULT_CEF_FRAMEWORK_RELATIVE_PATH = 'Release/Chromium Embedded Framework.framework/Chromium Embedded Framework';
export const VAULT_CEF_REQUIRED_EXPORTS = Object.freeze([
  '_cef_kestrel_vault_api_version', '_cef_kestrel_vault_configure',
]);
const frameworkDirectoryName = 'Chromium Embedded Framework.framework';
const receiptLimit = 64 * 1024;
const trustedOwner = (info) => info.uid === process.getuid?.() || info.uid === 0;
const inside = (root, filename) => {
  const relative = path.relative(root, filename);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

function assertOwnedEntry(info, description, { file = false } = {}) {
  if ((file && !info.isFile()) || (!file && !info.isDirectory())) {
    throw new Error(`Custom CEF ${description} must be a ${file ? 'regular file' : 'directory'}.`);
  }
  // Owner writes are normal for a locally built/signed framework (mode 0755).
  // Reject group/world write authority and aliases through hard links.
  if (!trustedOwner(info) || (info.mode & 0o022) !== 0 || (file && info.nlink !== 1)) {
    throw new Error(`Custom CEF ${description} must be owned by the current user/root, not group/world writable, and regular files must have one hard link.`);
  }
}

async function checkedPath(root, relative, { file = false } = {}) {
  const filename = path.join(root, relative);
  const canonical = await realpath(filename).catch(() => { throw new Error(`Custom CEF distribution is missing ${relative}.`); });
  if (!inside(root, canonical)) throw new Error(`Custom CEF path escapes its distribution: ${relative}`);
  // Validate each lexical component too: realpath containment alone would allow
  // an absolute symlink into the tree, which is not a portable framework layout.
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) {
      if (!trustedOwner(entry)) throw new Error(`Custom CEF symlink has an untrusted owner: ${current}`);
      const target = await readlink(current);
      if (path.isAbsolute(target)) throw new Error(`Custom CEF symlinks must be relative: ${current}`);
      if (!inside(root, await realpath(current))) throw new Error(`Custom CEF symlink escapes its distribution: ${current}`);
    } else if (current !== filename) {
      assertOwnedEntry(entry, path.relative(root, current));
    }
  }
  assertOwnedEntry(await stat(canonical), relative, { file });
  return canonical;
}

async function boundedText(root, relative, maximum = receiptLimit) {
  const filename = await checkedPath(root, relative, { file: true });
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    assertOwnedEntry(info, relative, { file: true });
    if (info.size > maximum) throw new Error(`Custom CEF ${relative} exceeds the ${maximum}-byte limit.`);
    // Never allocate/read beyond the cap, even if the file grows after stat.
    const data = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < data.length) {
      const { bytesRead } = await handle.read(data, length, data.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximum) throw new Error(`Custom CEF ${relative} changed beyond its size limit.`);
    const after = await handle.stat();
    if (info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) {
      throw new Error(`Custom CEF ${relative} changed during its bounded read.`);
    }
    return data.subarray(0, length).toString('utf8');
  } finally { await handle.close(); }
}

function uniqueDefine(source, name, { quoted = false } = {}) {
  const expression = new RegExp(`^\\s*#define\\s+${name}\\s+${quoted ? '"([^"\\r\\n]+)"' : '(\\d+)'}\\s*$`, 'gm');
  const matches = [...source.matchAll(expression)];
  if (matches.length !== 1) throw new Error(`Custom CEF version header must define ${name} exactly once.`);
  return matches[0][1];
}

function validateVersionHeader(source) {
  const version = uniqueDefine(source, 'CEF_VERSION', { quoted: true });
  const commit = uniqueDefine(source, 'CEF_COMMIT_HASH', { quoted: true });
  const chromiumVersion = ['MAJOR', 'MINOR', 'BUILD', 'PATCH']
    .map((part) => uniqueDefine(source, `CHROME_VERSION_${part}`)).join('.');
  if (version !== manifest.pins.cef.version || commit !== manifest.pins.cef.commit ||
      chromiumVersion !== manifest.pins.chromium.tag) {
    throw new Error(`Custom CEF version/commit mismatch: require ${manifest.pins.cef.version} and ${manifest.pins.cef.commit}.`);
  }
  return { cefVersion: version, chromiumVersion };
}

async function validateFrameworkVersionMetadata(runtime, frameworkBinary, probe) {
  // These values come from CEF's get_plist_version_string and
  // get_dylib_version_string, not Chromium's four-part product version.
  const match = manifest.pins.cef.version.match(/^(\d+)\.(\d+)\.(\d+)\+/);
  if (!match) throw new Error('Invalid pinned CEF version for macOS metadata.');
  const [, major, minor, patchText] = match;
  const patch = Number(patchText);
  const expectedDylib = `${major}${minor}.${Math.floor(patch / 255)}.${patch % 255}`;
  const expectedPlist = `${major}.${minor}.${patch}.0`;
  const relative = `Release/${frameworkDirectoryName}/Resources/Info.plist`;
  await boundedText(runtime, relative);
  const plist = await checkedPath(runtime, relative, { file: true });
  for (const [key, expected] of [['CFBundleShortVersionString', expectedPlist], ['CFBundleVersion', `${patch}.0`]]) {
    const actual = (await probe('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist])).trim();
    if (actual !== expected) throw new Error(`Custom CEF framework ${key} mismatch: require ${expected}. Regenerate GN metadata; a matching header alone is insufficient.`);
  }
  const output = await probe('/usr/bin/otool', ['-l', frameworkBinary]);
  const identifiers = output.split(/^Load command \d+\s*$/m)
    .filter((block) => /^\s*cmd LC_ID_DYLIB\s*$/m.test(block));
  if (identifiers.length !== 1) throw new Error('Custom CEF framework requires exactly one Mach-O dylib identity.');
  for (const field of ['current version', 'compatibility version']) {
    const values = [...identifiers[0].matchAll(new RegExp(`^\\s*${field} (\\d+\\.\\d+\\.\\d+)\\s*$`, 'gm'))];
    if (values.length !== 1 || values[0][1] !== expectedDylib) {
      throw new Error(`Custom CEF framework Mach-O ${field} mismatch: require ${expectedDylib}. Regenerate GN metadata before linking.`);
    }
  }
}

function validateProvenance(receipt, description) {
  if (!receipt || receipt.schemaVersion !== 1 || receipt.apiVersion !== manifest.apiVersion) {
    throw new Error(`Invalid custom CEF ${description} schema/API version.`);
  }
  for (const repository of ['cef', 'chromium']) {
    if (receipt.pins?.[repository]?.commit !== manifest.pins[repository].commit) {
      throw new Error(`Custom CEF ${description} ${repository} source pin mismatch.`);
    }
  }
  if (!Array.isArray(receipt.patches) || receipt.patches.length !== manifest.patches.length) {
    throw new Error(`Custom CEF ${description} must attest exactly both reviewed patches.`);
  }
  const seen = new Set();
  for (const patch of receipt.patches) {
    const expected = manifest.patches.find((candidate) => candidate.file === patch.file);
    if (!expected || seen.has(patch.file) || patch.sha256 !== expected.sha256) {
      throw new Error(`Custom CEF ${description} patch digest mismatch.`);
    }
    seen.add(patch.file);
  }
}

export function validateVaultCefBuildReceipt(receipt) {
  validateProvenance(receipt, 'build receipt');
  if (receipt.kind !== 'kestrel-vault-cef-build' || receipt.reviewed !== true ||
      receipt.sourceBuild !== true || receipt.cefVersion !== manifest.pins.cef.version ||
      receipt.chromiumVersion !== manifest.pins.chromium.tag ||
      receipt.framework?.relativePath !== VAULT_CEF_FRAMEWORK_RELATIVE_PATH ||
      !/^[a-f0-9]{64}$/.test(receipt.framework?.sha256 ?? '')) {
    throw new Error('Custom CEF requires a reviewed source-build receipt bound to the actual framework SHA256; a source patch receipt alone is insufficient.');
  }
  return receipt;
}

function defaultProbe(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`Custom CEF read-only probe failed: ${command} (${result.error?.message || result.stderr.trim() || result.status}).`);
  }
  return result.stdout;
}

async function validateFrameworkSymlinks(root, framework) {
  const pending = [framework];
  let count = 0;
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++count > 50_000) throw new Error('Custom CEF framework exceeds the 50,000-entry validation limit.');
      const filename = path.join(directory, entry.name);
      const info = await lstat(filename);
      if (info.isSymbolicLink()) {
        if (!trustedOwner(info)) throw new Error(`Custom CEF framework symlink has an untrusted owner: ${filename}`);
        if (path.isAbsolute(await readlink(filename)) || !inside(framework, await realpath(filename))) {
          throw new Error(`Custom CEF framework symlink must resolve inside its framework: ${path.relative(root, filename)}`);
        }
      } else if (info.isDirectory()) {
        assertOwnedEntry(info, path.relative(root, filename));
        pending.push(filename);
      } else {
        assertOwnedEntry(info, path.relative(root, filename), { file: true });
      }
    }
  }
}

async function frameworkDigest(filename) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    assertOwnedEntry(before, 'framework main binary', { file: true });
    const hash = createHash('sha256');
    for await (const data of handle.createReadStream({ autoClose: false })) hash.update(data);
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('Custom CEF framework main binary changed while hashing.');
    }
    return { sha256: hash.digest('hex'), size: before.size,
      identity: { dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs } };
  } finally { await handle.close(); }
}

export async function validateNativeVaultCefRuntime({ runtime, probe = defaultProbe,
  platform = process.platform, architecture = process.arch } = {}) {
  if (platform !== 'darwin' || architecture !== 'arm64') {
    throw new Error('Custom vault CEF requires Apple Silicon macOS.');
  }
  if (typeof runtime !== 'string' || !path.isAbsolute(runtime) || path.normalize(runtime) !== runtime) {
    throw new Error('Explicit --vault-cef-runtime must name an absolute canonical local binary-distribution path.');
  }
  const canonicalRoot = await realpath(runtime).catch(() => { throw new Error('Custom CEF distribution path does not exist.'); });
  if (canonicalRoot !== runtime) throw new Error('Custom CEF distribution root must be canonical; pass its real path rather than a symlink.');
  assertOwnedEntry(await lstat(runtime), 'distribution root');
  verifyPatchDigests();
  const version = validateVersionHeader(await boundedText(runtime, 'include/cef_version.h'));
  for (const filename of ['include/cef_app.h', 'libcef_dll/CMakeLists.txt', 'cmake/cef_macros.cmake', 'LICENSE.txt']) {
    await checkedPath(runtime, filename, { file: true });
  }
  const framework = await checkedPath(runtime, `Release/${frameworkDirectoryName}`);
  const frameworkBinary = await checkedPath(runtime, VAULT_CEF_FRAMEWORK_RELATIVE_PATH, { file: true });
  if (!inside(framework, frameworkBinary)) throw new Error('Custom CEF main binary must be contained inside its framework.');
  await validateFrameworkSymlinks(runtime, framework);
  const architectures = (await probe('/usr/bin/lipo', ['-archs', frameworkBinary])).trim().split(/\s+/);
  if (architectures.length !== 1 || architectures[0] !== 'arm64') throw new Error('Custom CEF main binary must be the pinned arm64 distribution.');
  const symbols = await probe('/usr/bin/nm', ['-gU', frameworkBinary]);
  const exportedFunctions = new Set([...symbols.matchAll(/^\s*[a-fA-F0-9]+\s+T\s+(\S+)\s*$/gm)].map((match) => match[1]));
  const missing = VAULT_CEF_REQUIRED_EXPORTS.filter((symbol) => !exportedFunctions.has(symbol));
  if (missing.length) throw new Error(`Unsupported stock/incompatible CEF framework: missing actual exported functions ${missing.join(', ')}. No engine was loaded or executed.`);
  await validateFrameworkVersionMetadata(runtime, frameworkBinary, probe);
  const extensionHeader = await boundedText(runtime, 'include/cef_kestrel_vault.h');
  const apiDefines = [...extensionHeader.matchAll(/^\s*#define\s+CEF_KESTREL_VAULT_API_VERSION\s+(\S+)\s*$/gm)];
  if (apiDefines.length !== 1 || !/^1u?$/.test(apiDefines[0][1])) {
    throw new Error('Custom CEF extension header API version must be 1.');
  }
  let receipt;
  try { receipt = JSON.parse(await boundedText(runtime, VAULT_CEF_BUILD_RECEIPT_NAME)); }
  catch (error) { throw new Error(`Custom CEF requires its reviewed ${VAULT_CEF_BUILD_RECEIPT_NAME}: ${error.message}`); }
  validateVaultCefBuildReceipt(receipt);
  const optionalSourceReceipt = path.join(runtime, '.kestrel-vault-patch.json');
  try {
    await lstat(optionalSourceReceipt);
    validateProvenance(JSON.parse(await boundedText(runtime, '.kestrel-vault-patch.json')), 'source receipt');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const fingerprint = await frameworkDigest(frameworkBinary);
  if (fingerprint.sha256 !== receipt.framework.sha256) throw new Error('Custom CEF framework SHA256 differs from its reviewed build receipt.');
  await probe('/usr/bin/codesign', ['--verify', '--deep', '--strict', framework]);
  // Check the pathname still denotes the same regular inode after all probes.
  const finalInfo = await stat(frameworkBinary);
  assertOwnedEntry(finalInfo, 'framework main binary', { file: true });
  if (finalInfo.dev !== fingerprint.identity.dev || finalInfo.ino !== fingerprint.identity.ino ||
      finalInfo.size !== fingerprint.identity.size || finalInfo.mtimeMs !== fingerprint.identity.mtimeMs ||
      finalInfo.ctimeMs !== fingerprint.identity.ctimeMs) {
    throw new Error('Custom CEF framework main binary changed during validation.');
  }
  return { runtime, framework, frameworkBinary, frameworkSha256: fingerprint.sha256,
    ...version, apiVersion: manifest.apiVersion, architecture: 'arm64',
    requiredExportsVerified: true, frameworkVersionMetadataVerified: true, localCodeSignatureVerified: true,
    releaseSigningVerified: false, sourceProvenance: 'builder-attestation-not-independent-proof',
    runtimeBehaviorVerified: false, buildReceipt: VAULT_CEF_BUILD_RECEIPT_NAME,
    pins: manifest.pins, patches: manifest.patches.map(({ file, sha256 }) => ({ file, sha256 })) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--vault-cef-runtime') {
    console.error('Usage: node scripts/native-vault-cef-runtime.mjs --vault-cef-runtime /canonical/local/cef-distribution');
    process.exitCode = 1;
  } else {
    validateNativeVaultCefRuntime({ runtime: args[1] }).then((result) => console.log(JSON.stringify(result, null, 2)))
      .catch((error) => { console.error(`Custom vault CEF runtime rejected: ${error.message}`); process.exitCode = 1; });
  }
}
