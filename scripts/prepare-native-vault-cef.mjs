#!/usr/bin/env node
// Source preparation only. Never downloads Chromium, builds, signs or launches it.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statfsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const patchDirectory = path.join(repositoryRoot, 'apps/native-chromium-host/cef-patches');
export const manifest = JSON.parse(readFileSync(path.join(patchDirectory, 'manifest.json'), 'utf8'));
export const REQUIRED_CEF_SYMBOLS = Object.freeze({
  cef_kestrel_vault_api_version: 1,
  cef_kestrel_vault_configure: 'int(uint8_t*, size_t)',
});
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message || result.stderr.trim() || `exit ${result.status}`}`);
  }
  return result.stdout.trim();
};

export function verifyPatchDigests() {
  for (const entry of manifest.patches) {
    if (digest(readFileSync(path.join(patchDirectory, entry.file))) !== entry.sha256) {
      throw new Error(`Patch digest mismatch: ${entry.file}`);
    }
  }
  return true;
}

export function requireVaultCefCapability({ apiVersion, symbols = [] } = {}) {
  if (apiVersion !== manifest.apiVersion ||
      Object.keys(REQUIRED_CEF_SYMBOLS).some((name) => !symbols.includes(name))) {
    throw new Error('Unsupported stock or incompatible CEF: Kestrel vault API version 1 and both exported symbols are required before profile access. No Keychain or mock-key fallback is allowed.');
  }
  return true;
}

export function validateBuildEnvironment({ platform, architecture, freeBytes,
  fullXcode, macosSdk, tools = [] }) {
  if (platform !== 'darwin' || architecture !== 'arm64') {
    throw new Error('The pinned Kestrel custom CEF target requires a macOS arm64 build machine.');
  }
  if (!Number.isSafeInteger(freeBytes) || freeBytes < manifest.minimumFreeBytes) {
    throw new Error(`Custom CEF preparation requires at least 150 GiB free (${manifest.minimumFreeBytes} bytes); found ${freeBytes}. No source files were changed.`);
  }
  if (!fullXcode || !macosSdk) throw new Error('Full Xcode and a macOS SDK are required; Command Line Tools alone are insufficient.');
  const missing = ['git', 'python3', 'gclient', 'gn', 'autoninja', 'clang'].filter((tool) => !tools.includes(tool));
  if (missing.length) throw new Error(`Missing custom CEF toolchain: ${missing.join(', ')}. No source files were changed.`);
}

function inspectBuildEnvironment(sourceRoot) {
  const disk = statfsSync(sourceRoot, { bigint: true });
  // Check free space before expensive toolchain probes or source changes.
  const freeBytes = Number(disk.bavail * disk.bsize);
  if (freeBytes < manifest.minimumFreeBytes) {
    validateBuildEnvironment({ platform: process.platform, architecture: process.arch,
      freeBytes, tools: [] });
  }
  const toolPaths = {};
  for (const tool of ['git', 'python3', 'gclient', 'gn', 'autoninja']) {
    try { toolPaths[tool] = run('/usr/bin/which', [tool]); } catch { /* collected below */ }
  }
  let fullXcode = false;
  let macosSdk = '';
  try {
    // A build-local override selects an installed Xcode without mutating the
    // machine-wide Command Line Tools preference used by other projects.
    const selected = process.env.DEVELOPER_DIR || run('/usr/bin/xcode-select', ['-p']);
    fullXcode = /\.app\/Contents\/Developer$/.test(selected) &&
      /^Xcode /m.test(run('/usr/bin/xcodebuild', ['-version']));
    macosSdk = run('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path']);
    toolPaths.clang = run('/usr/bin/xcrun', ['--find', 'clang']);
  } catch { /* validation reports an actionable failure */ }
  const environment = { platform: process.platform, architecture: process.arch,
    freeBytes, fullXcode, macosSdk, tools: Object.keys(toolPaths) };
  validateBuildEnvironment(environment);
  return { ...environment, toolPaths };
}

export function verifySourceTrees(sourceRoot, { requireGitPins = true } = {}) {
  verifyPatchDigests();
  const roots = { chromium: sourceRoot, cef: path.join(sourceRoot, 'cef') };
  for (const entry of manifest.patches) {
    const root = roots[entry.repository];
    const gitRoot = realpathSync(run('git', ['rev-parse', '--show-toplevel'], root));
    if (gitRoot !== realpathSync(root)) throw new Error(`Expected a distinct ${entry.repository} Git checkout at ${root}; otherwise git apply may skip the patch.`);
    if (requireGitPins) {
      const head = run('git', ['rev-parse', 'HEAD'], root);
      if (head !== manifest.pins[entry.repository].commit) throw new Error(`${entry.repository} HEAD must be exactly ${manifest.pins[entry.repository].commit}; found ${head}.`);
      const dirty = run('git', ['status', '--porcelain', '--untracked-files=all', '--', ...entry.targets], root);
      if (dirty) throw new Error(`Refusing dirty ${entry.repository} patch targets: ${dirty}`);
    }
    const originals = new Map(entry.upstreamFiles.map((file) => [file.path, file.sha256]));
    for (const target of entry.targets) {
      const filename = path.join(root, target);
      if (originals.has(target)) {
        if (!existsSync(filename) || digest(readFileSync(filename)) !== originals.get(target)) {
          throw new Error(`Pinned upstream source mismatch: ${entry.repository}/${target}. Normal CEF patches or local edits must not be silently overwritten.`);
        }
      } else if (existsSync(filename)) {
        throw new Error(`New patch target already exists: ${entry.repository}/${target}`);
      }
    }
    run('git', ['apply', '--check', path.join(patchDirectory, entry.file)], root);
  }
  return roots;
}

// Downloads only the five manifest-pinned original files (<300 KB total),
// into a disposable fixture. This never clones/checks out a full engine.
export async function verifyUpstreamPatchFixture({ cacheRoot = path.join(repositoryRoot, '.tmp') } = {}) {
  verifyPatchDigests();
  await mkdir(cacheRoot, { recursive: true });
  const fixtureRoot = await mkdtemp(path.join(cacheRoot, 'vault-cef-patch-fixture-'));
  const sourceRoot = path.join(fixtureRoot, 'chromium');
  let downloadedBytes = 0;
  try {
    for (const entry of manifest.patches) {
      const repo = entry.repository;
      const root = repo === 'cef' ? path.join(sourceRoot, 'cef') : sourceRoot;
      for (const file of entry.upstreamFiles) {
        const organization = repo === 'cef' ? 'chromiumembedded/cef' : 'chromium/chromium';
        const url = `https://raw.githubusercontent.com/${organization}/${manifest.pins[repo].commit}/${file.path}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`Pinned primary-source fetch failed (${response.status}): ${url}`);
        // Enforce a bound even if Content-Length is absent/untrusted.
        const chunks = [];
        let bytes = 0;
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > 150_000 || downloadedBytes + bytes > 300_000) {
            await response.body.cancel().catch(() => {});
            throw new Error('Pinned-source fixture exceeded the 300 KB download budget.');
          }
          chunks.push(chunk);
        }
        downloadedBytes += bytes;
        const data = Buffer.concat(chunks);
        if (digest(data) !== file.sha256) throw new Error(`Primary-source SHA256 mismatch: ${repo}/${file.path}`);
        const filename = path.join(root, file.path);
        await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, data);
      }
    }
    // Independent repositories prevent git apply from silently skipping every
    // patch because this fixture lives under the parent project's .tmp.
    run('git', ['init', '--quiet'], sourceRoot);
    run('git', ['init', '--quiet'], path.join(sourceRoot, 'cef'));
    verifySourceTrees(sourceRoot, { requireGitPins: false });
    return { patchAppliesToPinnedUpstream: true, downloadedBytes,
      compiledOrRuntimeVerified: false, pins: manifest.pins,
      patches: manifest.patches.map(({ file, sha256 }) => ({ file, sha256 })) };
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

export async function prepareVaultCef({ sourceRoot, apply = false } = {}) {
  if (!sourceRoot) throw new Error('Pass --chromium-source /absolute/path/to/chromium/src. No engine is downloaded automatically.');
  if (!path.isAbsolute(sourceRoot)) throw new Error('--chromium-source must be absolute.');
  sourceRoot = realpathSync(sourceRoot);
  // Every pin, original-file hash, target cleanliness and apply check must pass
  // before disk/toolchain preflight; every preflight must pass before mutation.
  const roots = verifySourceTrees(sourceRoot);
  const environment = inspectBuildEnvironment(sourceRoot);
  const receiptPath = path.join(roots.cef, '.kestrel-vault-patch.json');
  if (existsSync(receiptPath)) throw new Error(`Refusing to overwrite an existing source receipt: ${receiptPath}`);
  if (apply) {
    // Recheck immediately before applying, including target cleanliness.
    verifySourceTrees(sourceRoot);
    const applied = [];
    try {
      for (const entry of manifest.patches) {
        run('git', ['apply', path.join(patchDirectory, entry.file)], roots[entry.repository]);
        applied.push(entry);
      }
      await writeFile(receiptPath, JSON.stringify({
        schemaVersion: 1, sourceOnly: true, apiVersion: manifest.apiVersion,
        pins: manifest.pins, patches: manifest.patches.map(({ file, sha256 }) => ({ file, sha256 })),
        compiledOrRuntimeVerified: false,
      }, null, 2) + '\n', { flag: 'wx' });
    } catch (error) {
      // Roll back only this script's successfully applied patches. Never reset
      // a checkout or overwrite unrelated tracked/untracked work.
      for (const entry of applied.reverse()) {
        run('git', ['apply', '--reverse', path.join(patchDirectory, entry.file)], roots[entry.repository]);
      }
      throw error;
    }
  }
  return { sourcePreflightPassed: true, applied: apply, buildStarted: false,
    compiledOrRuntimeVerified: false, environment, pins: manifest.pins,
    patches: manifest.patches.map(({ file, sha256 }) => ({ file, sha256 })) };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node scripts/prepare-native-vault-cef.mjs --chromium-source /path/to/src [--apply]\n       node scripts/prepare-native-vault-cef.mjs --verify-upstream-patches\nDefault: read-only pinned-source, clean-target, 150 GiB, full-Xcode/depot_tools preflight. --apply only applies the reviewed patches; no build/sign/launch.');
    return;
  }
  if (args.length === 1 && args[0] === '--verify-upstream-patches') {
    console.log(JSON.stringify(await verifyUpstreamPatchFixture(), null, 2));
    return;
  }
  let sourceRoot;
  let apply = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--chromium-source') sourceRoot = args[++index];
    else if (args[index] === '--apply') apply = true;
    else throw new Error(`Unknown option: ${args[index]}`);
  }
  console.log(JSON.stringify(await prepareVaultCef({ sourceRoot, apply }), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`Kestrel custom CEF preparation stopped: ${error.message}`); process.exitCode = 1; });
}
