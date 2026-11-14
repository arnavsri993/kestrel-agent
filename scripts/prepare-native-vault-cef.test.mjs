import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  manifest, requireVaultCefCapability, validateBuildEnvironment, validateCefBuildMetadata,
  verifyPatchDigests, verifySourceTrees, verifyUpstreamPatchFixture,
} from './prepare-native-vault-cef.mjs';

const supported = {
  platform: 'darwin', architecture: 'arm64', freeBytes: 150 * 1024 ** 3,
  fullXcode: true, macosSdk: '/Applications/Xcode.app/Contents/Developer/SDKs/MacOSX.sdk',
  tools: ['git', 'python3', 'gclient', 'gn', 'autoninja', 'clang', 'metal'],
};

test('stock/incomplete/incompatible CEF cannot authorize profile access', () => {
  for (const capability of [undefined, {}, { apiVersion: 1, symbols: [] },
    { apiVersion: 2, symbols: ['cef_kestrel_vault_api_version', 'cef_kestrel_vault_configure'] },
    { apiVersion: 1, symbols: ['cef_kestrel_vault_api_version'] }]) {
    assert.throws(() => requireVaultCefCapability(capability), /Unsupported stock or incompatible CEF/);
  }
  assert.equal(requireVaultCefCapability({ apiVersion: 1,
    symbols: ['cef_kestrel_vault_api_version', 'cef_kestrel_vault_configure'] }), true);
});

test('preflight rejects insufficient disk and incomplete build tools', () => {
  assert.doesNotThrow(() => validateBuildEnvironment(supported));
  assert.throws(() => validateBuildEnvironment({ ...supported, freeBytes: 55 * 1024 ** 3 }), /150 GiB/);
  assert.throws(() => validateBuildEnvironment({ ...supported, freeBytes: supported.freeBytes - 1 }), /150 GiB/);
  assert.throws(() => validateBuildEnvironment({ ...supported, fullXcode: false }), /Full Xcode/);
  assert.throws(() => validateBuildEnvironment({ ...supported, tools: ['git'] }), /Missing custom CEF toolchain/);
  assert.throws(() => validateBuildEnvironment({ ...supported, tools: supported.tools.filter(tool => tool !== 'metal') }), /working Apple Metal toolchain/);
  assert.throws(() => validateBuildEnvironment({ ...supported, architecture: 'x64' }), /macOS arm64/);
});

test('patch digests and exact Chromium/CEF commits are pinned', () => {
  assert.equal(verifyPatchDigests(), true);
  assert.equal(manifest.pins.cef.commit, 'cf671c072925b27823a61181152f4f288e8e4306');
  assert.equal(manifest.pins.chromium.commit, 'fb096c0011f9d50f0a264a9376420cdea9c421e3');
  assert.equal(manifest.compiledOrRuntimeVerified, false);
});

test('source metadata requires the real branch history and matching upstream version, not a pinned HEAD alone', () => {
  const valid = { shallow: false, hasMasterReference: true, version: manifest.pins.cef.version };
  assert.equal(validateCefBuildMetadata(valid), true);
  for (const value of [undefined, {}, { ...valid, shallow: true }, { ...valid, hasMasterReference: false }]) {
    assert.throws(() => validateCefBuildMetadata(value), /full history and the upstream origin\/master reference/);
  }
  assert.throws(() => validateCefBuildMetadata({ ...valid, version: '156.0.0+gcf671c0+chromium-156.0.8078.80' }), /Do not relabel/);
  assert.throws(() => validateCefBuildMetadata({ ...valid, version: undefined }), /version formatter/);
});

test('fixture checks cannot silently skip patches in a parent Git repository', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'vault-cef-guard-test-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: fixture });
    const source = path.join(fixture, 'src');
    await mkdir(path.join(source, 'cef'), { recursive: true });
    assert.throws(() => verifySourceTrees(source, { requireGitPins: false }), /distinct cef Git checkout/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('source revision or file mismatch stops before modifying source', async () => {
  const source = await mkdtemp(path.join(tmpdir(), 'vault-cef-pin-test-'));
  try {
    await mkdir(path.join(source, 'cef'));
    for (const root of [source, path.join(source, 'cef')]) {
      execFileSync('git', ['init', '--quiet'], { cwd: root });
      await writeFile(path.join(root, 'unrelated.txt'), 'preserve\n');
      execFileSync('git', ['add', 'unrelated.txt'], { cwd: root });
      execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '--quiet', '-m', 'fixture'], { cwd: root });
    }
    assert.throws(() => verifySourceTrees(source), /cef HEAD must be exactly/);
    assert.throws(() => verifySourceTrees(source, { requireGitPins: false }), /Pinned upstream source mismatch/);
    assert.equal(execFileSync('git', ['status', '--porcelain', '--', 'unrelated.txt'],
      { cwd: source, encoding: 'utf8' }), '');
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});

test.skipIf(process.env.KESTREL_VERIFY_UPSTREAM_PATCHES !== '1')('patches apply to SHA256-verified small pinned upstream fixture', async () => {
  const result = await verifyUpstreamPatchFixture();
  assert.equal(result.patchAppliesToPinnedUpstream, true);
  assert.ok(result.downloadedBytes > 0 && result.downloadedBytes < 300_000);
  assert.equal(result.compiledOrRuntimeVerified, false);
});
