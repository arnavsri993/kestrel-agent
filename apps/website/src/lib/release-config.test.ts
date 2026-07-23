import { describe, expect, it } from "vitest";
import { resolvePublicRelease } from "./release-config";

describe("public Apple Silicon release configuration", () => {
  it("requires a versioned HTTPS DMG plus manifest and checksums", () => {
    expect(resolvePublicRelease({
      NEXT_PUBLIC_RELEASE_VERSION: "1.2.3",
      NEXT_PUBLIC_RELEASE_STATUS: "verified",
      NEXT_PUBLIC_DOWNLOAD_URL: "https://downloads.example.test/Kestrel-Apple-Silicon-1.2.3.dmg",
      NEXT_PUBLIC_RELEASE_MANIFEST_URL: "https://downloads.example.test/release-manifest.json",
      NEXT_PUBLIC_RELEASE_CHECKSUMS_URL: "https://downloads.example.test/SHA256SUMS",
    })).toMatchObject({
      available: true,
      version: "1.2.3",
      downloadUrl: "https://downloads.example.test/Kestrel-Apple-Silicon-1.2.3.dmg",
    });
  });

  it("fails closed for incomplete, insecure, or non-DMG release input", () => {
    expect(resolvePublicRelease({ NEXT_PUBLIC_RELEASE_VERSION: "1.2.3" }).available).toBe(false);
    expect(resolvePublicRelease({
      NEXT_PUBLIC_RELEASE_VERSION: "1.2.3",
      NEXT_PUBLIC_RELEASE_STATUS: "verified",
      NEXT_PUBLIC_DOWNLOAD_URL: "http://downloads.example.test/Kestrel.zip",
      NEXT_PUBLIC_RELEASE_MANIFEST_URL: "https://downloads.example.test/release-manifest.json",
      NEXT_PUBLIC_RELEASE_CHECKSUMS_URL: "https://downloads.example.test/SHA256SUMS",
    }).available).toBe(false);
  });
});
