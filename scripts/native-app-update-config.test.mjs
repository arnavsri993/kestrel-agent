import { it, expect } from 'vitest';
import { validateNativeUpdateConfig, assertNativeVersionAdvances } from './native-app-update-config.mjs';
import { verifySparkleArchive, SPARKLE_SHA256 } from './prepare-sparkle-native.mjs';
const valid = { enabled: true, runtime: 'native-chromium', feedUrl: 'https://updates.example.invalid/native-appcast.xml', publicKey: Buffer.alloc(32, 7).toString('base64'), bundleVersion: '42', shortVersion: '1.2.3' };
it('leaves development and missing configuration disabled', () => {
  expect(validateNativeUpdateConfig({})).toEqual({ enabled: false });
  expect(() => validateNativeUpdateConfig({ enabled: true })).toThrow();
});
it('accepts only a configured native stable HTTPS feed and valid identity', () => {
  expect(validateNativeUpdateConfig(valid)).toEqual(valid);
  for (const bad of [
    { runtime: 'electron' }, { feedUrl: 'http://example.invalid/native-appcast.xml' },
    { feedUrl: 'https://example.invalid/latest-mac.yml' }, { feedUrl: 'https://user:pass@example.invalid/native-appcast.xml' },
    { feedUrl: 'https://example.invalid/native-appcast.xml?redirect=x' }, { publicKey: 'missing' },
    { bundleVersion: '0' }, { bundleVersion: '01' }, { shortVersion: '1.2.3-beta' },
  ]) expect(() => validateNativeUpdateConfig({ ...valid, ...bad })).toThrow();
});
it('rejects any archive that does not match the pinned release checksum', () => {
  expect(SPARKLE_SHA256).toMatch(/^[a-f0-9]{64}$/);
  expect(() => verifySparkleArchive(Buffer.from('tampered'))).toThrow(/SHA-256/);
});

it('requires each published native build version to advance', () => {
  expect(() => assertNativeVersionAdvances('41', '42')).not.toThrow();
  for (const next of ['40', '41', '0', '042', '42.0']) expect(() => assertNativeVersionAdvances('41', next)).toThrow();
});
