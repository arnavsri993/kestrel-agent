import { describe, expect, it } from "vitest";
import { manifest } from "./prepare-native-vault-cef.mjs";
import { validatePackagedVaultMetadata } from "./native-vault-canary-candidate.mjs";

const valid = () => ({ apiVersion: 1, frameworkSha256: "a".repeat(64), sourceFrameworkSha256: "b".repeat(64),
 sourceProvenance: "builder-attestation-not-independent-proof", runtimeBehaviorVerified: false,
 pins: structuredClone(manifest.pins), patches: manifest.patches.map(({ file, sha256 }) => ({ file, sha256 })) });
describe("packaged vault canary provenance", () => {
 it("accepts a hash-bound build attestation without promoting it to runtime proof", () => {
  expect(validatePackagedVaultMetadata(valid()).runtimeBehaviorVerified).toBe(false);
 });
 it.each([undefined, {}, { ...valid(), apiVersion: 0 }, { ...valid(), frameworkSha256: "not-a-hash" },
  { ...valid(), sourceFrameworkSha256: undefined }, { ...valid(), sourceFrameworkSha256: "not-a-hash" },
  { ...valid(), runtimeBehaviorVerified: true }, { ...valid(), sourceProvenance: "verified" }])("rejects missing, incompatible or overclaimed metadata", value => {
  expect(() => validatePackagedVaultMetadata(value)).toThrow();
 });
 it("rejects another source revision or missing, duplicate and modified patches", () => {
  const a = valid(); a.pins.chromium.commit = "0".repeat(40);
  const b = valid(); b.patches.pop();
  const c = valid(); c.patches[1] = c.patches[0];
  const d = valid(); d.patches[0].sha256 = "0".repeat(64);
  for (const value of [a, b, c, d]) expect(() => validatePackagedVaultMetadata(value)).toThrow();
 });
});
