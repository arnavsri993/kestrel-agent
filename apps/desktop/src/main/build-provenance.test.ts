import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: { isPackaged: false } }));
import { componentBuildState, desktopBuildProvenance, isCanonicalMacExecutable } from "./build-provenance";
import type { BuildIdentity } from "@kestrel/shared-types";
const identity: BuildIdentity = { format: 1, sourceCommit: "a".repeat(40), sourceDigest: "b".repeat(64), buildId: "c".repeat(64), dirty: false };
describe("observed component provenance", () => {
  it("does not identify temporary release artifacts as the canonical installed app", () => {
    expect(isCanonicalMacExecutable("/Applications/Kestrel.app/Contents/MacOS/Kestrel")).toBe(true);
    expect(isCanonicalMacExecutable("/private/tmp/release/Kestrel.app/Contents/MacOS/Kestrel")).toBe(false);
  });
  it("distinguishes matching, mismatched and missing component identities", () => {
    expect(componentBuildState([identity, identity, identity, identity])).toBe("matching");
    expect(componentBuildState([identity, { ...identity, buildId: "d".repeat(64) }])).toBe("mismatched");
    expect(componentBuildState([identity, null])).toBe("unverified");
  });
  it("does not infer installed or embedded identities in a unit-test process", () => {
    const value = desktopBuildProvenance({ renderer: identity, preload: identity, core: null });
    expect(value.main).toBeNull(); expect(value.installed).toBeNull();
    expect(value.componentState).toBe("unverified"); expect(value.installationState).toBe("development");
  });
});
