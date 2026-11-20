import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import { manifest } from './prepare-native-vault-cef.mjs';
import {
  VAULT_CEF_BUILD_RECEIPT_NAME, VAULT_CEF_FRAMEWORK_RELATIVE_PATH,
  validateNativeVaultCefRuntime,
} from './native-vault-cef-runtime.mjs';

const fixtures = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const frameworkRelative = 'Release/Chromium Embedded Framework.framework';
const fakeEngine = Buffer.from('not an executable: injected read-only probe fixture\n');
const engineHash = createHash('sha256').update(fakeEngine).digest('hex');
const dylibMetadata = `fixture:\nLoad command 0
          cmd LC_ID_DYLIB
      cmdsize 112
         name @executable_path/../Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework (offset 24)
   time stamp 0 Thu Jan  1 00:00:00 1970
      current version 1560.0.15
compatibility version 1560.0.15
`;
const versionHeader = `#define CEF_VERSION "${manifest.pins.cef.version}"
#define CEF_COMMIT_HASH "${manifest.pins.cef.commit}"
#define CHROME_VERSION_MAJOR 156
#define CHROME_VERSION_MINOR 0
#define CHROME_VERSION_BUILD 8078
#define CHROME_VERSION_PATCH 80
`;

async function fixture({ versioned = false } = {}) {
  const runtime = await realpath(await mkdtemp(path.join(tmpdir(), 'kestrel-custom-cef-fixture-')));
  fixtures.push(runtime);
  const files = {
    'include/cef_version.h': versionHeader,
    'include/cef_app.h': '// fixture\n',
    'include/cef_kestrel_vault.h': '#define CEF_KESTREL_VAULT_API_VERSION 1u\n',
    'libcef_dll/CMakeLists.txt': '# fixture\n',
    'cmake/cef_macros.cmake': '# fixture\n',
    'LICENSE.txt': 'Fixture only.\n',
  };
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(runtime, relative)), { recursive: true });
    await writeFile(path.join(runtime, relative), content, { mode: 0o644 });
  }
  let binary = path.join(runtime, VAULT_CEF_FRAMEWORK_RELATIVE_PATH);
  if (versioned) binary = path.join(runtime, frameworkRelative, 'Versions/A/Chromium Embedded Framework');
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(binary, fakeEngine, { mode: 0o755 });
  const resources = path.join(path.dirname(binary), 'Resources');
  await mkdir(resources);
  await writeFile(path.join(resources, 'Info.plist'), '<plist><dict/></plist>', { mode: 0o644 });
  if (versioned) {
    await symlink('A', path.join(runtime, frameworkRelative, 'Versions/Current'));
    await symlink('Versions/Current/Chromium Embedded Framework', path.join(runtime, VAULT_CEF_FRAMEWORK_RELATIVE_PATH));
    await symlink('Versions/Current/Resources', path.join(runtime, frameworkRelative, 'Resources'));
  }
  const receipt = {
    schemaVersion: 1, kind: 'kestrel-vault-cef-build', apiVersion: 1,
    sourceBuild: true, reviewed: true,
    cefVersion: manifest.pins.cef.version, chromiumVersion: manifest.pins.chromium.tag,
    pins: structuredClone(manifest.pins),
    patches: manifest.patches.map(({ file, sha256 }) => ({ file, sha256 })),
    framework: { relativePath: VAULT_CEF_FRAMEWORK_RELATIVE_PATH, sha256: engineHash },
  };
  const receiptPath = path.join(runtime, VAULT_CEF_BUILD_RECEIPT_NAME);
  await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o644 });
  const calls = [];
  const probe = async (command, args) => {
    calls.push({ command, args });
    if (command === '/usr/bin/lipo') return 'arm64\n';
    if (command === '/usr/bin/nm') return '0000000000001000 T _cef_kestrel_vault_api_version\n0000000000002000 T _cef_kestrel_vault_configure\n';
    if (command === '/usr/libexec/PlistBuddy') return args[1] === 'Print :CFBundleShortVersionString' ? '156.0.15.0\n' : '15.0\n';
    if (command === '/usr/bin/otool') return dylibMetadata;
    if (command === '/usr/bin/codesign') return '';
    throw new Error(`Unexpected probe ${command}`);
  };
  const validate = (extra = {}) => validateNativeVaultCefRuntime({ runtime, probe,
    platform: 'darwin', architecture: 'arm64', ...extra });
  return { runtime, binary, receipt, receiptPath, calls, probe, validate };
}

test('validates a pinned fixture without treating builder attestation as runtime proof', async () => {
  const item = await fixture();
  const result = await item.validate();
  assert.equal(result.frameworkSha256, engineHash);
  assert.equal(result.sourceProvenance, 'builder-attestation-not-independent-proof');
  assert.equal(result.runtimeBehaviorVerified, false);
  assert.equal(result.releaseSigningVerified, false);
  assert.equal(result.frameworkVersionMetadataVerified, true);
  assert.deepEqual(item.calls.map(({ command }) => command), ['/usr/bin/lipo', '/usr/bin/nm', '/usr/libexec/PlistBuddy', '/usr/libexec/PlistBuddy', '/usr/bin/otool', '/usr/bin/codesign']);
  assert.deepEqual(item.calls.at(-1).args.slice(0, 3), ['--verify', '--deep', '--strict']);
});

test('rejects stale framework metadata even when the header and receipt match the pin', async () => {
  const item = await fixture();
  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
    await assert.rejects(item.validate({ probe: (command, args) => command.endsWith('/PlistBuddy') && args[1] === `Print :${key}`
      ? '0.0.0\n' : item.probe(command, args) }), new RegExp(`${key} mismatch`));
  }
  for (const field of ['current version', 'compatibility version']) {
    await assert.rejects(item.validate({ probe: (command, args) => command.endsWith('/otool')
      ? dylibMetadata.replace(`${field} 1560.0.15`, `${field} 1560.0.0`) : item.probe(command, args) }), new RegExp(`Mach-O ${field} mismatch`));
  }
  assert(!item.calls.some(({ command }) => command.endsWith('/codesign')), 'Stale metadata reached final signature acceptance.');
});

test('refuses missing, duplicate or ambiguous Mach-O dylib identities', async () => {
  const item = await fixture();
  for (const output of ['', `${dylibMetadata}\n${dylibMetadata}`, dylibMetadata.replace('current version 1560.0.15', 'current version 1560.0.15\ncurrent version 1560.0.15')]) {
    await assert.rejects(item.validate({ probe: (command, args) => command.endsWith('/otool') ? output : item.probe(command, args) }), /dylib identity|version mismatch/);
  }
});

test('accepts normal contained relative versioned framework symlinks', async () => {
  const item = await fixture({ versioned: true });
  const result = await item.validate();
  assert.equal(result.frameworkBinary, item.binary);
});

test.skipIf(process.platform !== 'darwin')('checks actual signed Mach-O/plist metadata without loading the generated fixture', async () => {
  const item = await fixture({ versioned: true });
  // This deliberately inert library is not CEF and cannot initialize Kestrel.
  // It tests the real macOS probe formats only; no runtime/release proof.
  const source = path.join(item.runtime, 'inert-fixture.c');
  await writeFile(source, 'unsigned int cef_kestrel_vault_api_version(void) { return 0; }\nint cef_kestrel_vault_configure(unsigned char *key, unsigned long length) { return 0; }\n');
  const plist = path.join(path.dirname(item.binary), 'Resources/Info.plist');
  await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.kestrel.inert-metadata-fixture</string>
<key>CFBundleExecutable</key><string>Chromium Embedded Framework</string>
<key>CFBundlePackageType</key><string>FMWK</string>
<key>CFBundleShortVersionString</key><string>156.0.15.0</string>
<key>CFBundleVersion</key><string>15.0</string>
</dict></plist>`);
  const run = (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
  };
  const compile = async version => {
    run('/usr/bin/xcrun', ['clang', '-arch', 'arm64', '-dynamiclib', '-mmacosx-version-min=13.0',
      '-current_version', version, '-compatibility_version', version,
      '-Wl,-install_name,@rpath/Chromium Embedded Framework.framework/Chromium Embedded Framework', source, '-o', item.binary]);
    run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', path.join(item.runtime, frameworkRelative)]);
    item.receipt.framework.sha256 = createHash('sha256').update(await readFile(item.binary)).digest('hex');
    await writeFile(item.receiptPath, JSON.stringify(item.receipt));
  };
  await compile('1560.0.15');
  const result = await item.validate({ probe: undefined });
  assert.equal(result.frameworkVersionMetadataVerified, true);
  assert.equal(result.runtimeBehaviorVerified, false);
  await compile('1560.0.0');
  await assert.rejects(item.validate({ probe: undefined }), /Mach-O current version mismatch/);
}, 60000);

test('requires an explicit canonical absolute root', async () => {
  const item = await fixture();
  await assert.rejects(item.validate({ runtime: 'relative/cef' }), /absolute canonical/);
  await assert.rejects(item.validate({ runtime: `${item.runtime}/../${path.basename(item.runtime)}` }), /absolute canonical/);
  const alias = `${item.runtime}-alias`;
  fixtures.push(alias);
  await symlink(item.runtime, alias);
  await assert.rejects(item.validate({ runtime: alias }), /root must be canonical/);
  assert.equal(item.calls.length, 0);
});

test('rejects exported data, missing exports, incompatible architecture and signature failure', async () => {
  const item = await fixture();
  await assert.rejects(item.validate({ probe: async (command, args) => command.endsWith('/nm')
    ? '0000000000001000 D _cef_kestrel_vault_api_version\n0000000000002000 T _cef_kestrel_vault_configure\n'
    : item.probe(command, args) }), /missing actual exported functions _cef_kestrel_vault_api_version/);
  await assert.rejects(item.validate({ probe: async (command, args) => command.endsWith('/lipo')
    ? 'x86_64\n' : item.probe(command, args) }), /pinned arm64/);
  await assert.rejects(item.validate({ probe: async (command, args) => {
    if (command.endsWith('/codesign')) throw new Error('invalid signature');
    return item.probe(command, args);
  } }), /invalid signature/);
});

test('rejects version, source pins, patch digests and framework hash mismatches', async () => {
  const item = await fixture();
  const header = path.join(item.runtime, 'include/cef_version.h');
  await writeFile(header, versionHeader.replace('CHROME_VERSION_PATCH 80', 'CHROME_VERSION_PATCH 81'));
  await assert.rejects(item.validate(), /version\/commit mismatch/);
  await writeFile(header, versionHeader);
  const writeReceipt = async (mutate) => {
    const changed = structuredClone(item.receipt); mutate(changed);
    await writeFile(item.receiptPath, JSON.stringify(changed));
  };
  await writeReceipt((receipt) => { receipt.pins.cef.commit = '0'.repeat(40); });
  await assert.rejects(item.validate(), /cef source pin mismatch/);
  await writeReceipt((receipt) => { receipt.patches[0].sha256 = '0'.repeat(64); });
  await assert.rejects(item.validate(), /patch digest mismatch/);
  await writeReceipt((receipt) => { receipt.framework.sha256 = '0'.repeat(64); });
  await assert.rejects(item.validate(), /framework SHA256 differs/);
});

test('requires a reviewed bounded build receipt and checks optional source receipt', async () => {
  const item = await fixture();
  const unreviewed = { ...item.receipt, reviewed: false };
  await writeFile(item.receiptPath, JSON.stringify(unreviewed));
  await assert.rejects(item.validate(), /reviewed source-build receipt/);
  await writeFile(item.receiptPath, ' '.repeat(65537));
  await assert.rejects(item.validate(), /65536-byte limit/);
  await writeFile(item.receiptPath, JSON.stringify(item.receipt));
  const sourceReceipt = { ...item.receipt, patches: [] };
  await writeFile(path.join(item.runtime, '.kestrel-vault-patch.json'), JSON.stringify(sourceReceipt));
  await assert.rejects(item.validate(), /exactly both reviewed patches/);
  await rm(path.join(item.runtime, '.kestrel-vault-patch.json'));
  await rm(item.receiptPath);
  await assert.rejects(item.validate(), /requires its reviewed \.kestrel-vault-build.json/);
});

test('rejects writable or hard-linked engine binaries', async () => {
  const item = await fixture();
  await chmod(item.binary, 0o777);
  await assert.rejects(item.validate(), /not group\/world writable/);
  await chmod(item.binary, 0o755);
  await link(item.binary, path.join(item.runtime, 'engine-alias'));
  await assert.rejects(item.validate(), /one hard link/);
});

test('rejects absolute and escaping framework links before tool execution', async () => {
  const item = await fixture();
  const linkPath = path.join(item.runtime, frameworkRelative, 'absolute-alias');
  await symlink(item.binary, linkPath);
  await assert.rejects(item.validate(), /framework symlink must resolve inside/);
  await rm(linkPath);
  await symlink('../../include/cef_version.h', linkPath);
  await assert.rejects(item.validate(), /framework symlink must resolve inside/);
  assert.equal(item.calls.length, 0);
});

test('detects engine mutation after reviewed hash and before signature verification completes', async () => {
  const item = await fixture();
  await assert.rejects(item.validate({ probe: async (command, args) => {
    if (command.endsWith('/codesign')) await writeFile(item.binary, Buffer.concat([fakeEngine, Buffer.from('changed')]));
    return item.probe(command, args);
  } }), /changed during validation/);
});
