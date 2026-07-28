import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyMarketingAssets } from "../../../../scripts/verify-marketing-assets";

const temporaryRoots: string[] = [];

function writeFixtureFile(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function writeFixtureJson(root: string, path: string, value: unknown): void {
  writeFixtureFile(root, path, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(): {
  root: string;
  videoPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "kestrel-marketing-assets-"));
  temporaryRoots.push(root);
  const videoPath = "apps/website/public/media/generated/hero.mp4";
  const video = "test video bytes";
  writeFixtureFile(root, videoPath, video);
  writeFixtureFile(
    root,
    "apps/website/public/media/generated/hero-poster.jpg",
    "test poster bytes",
  );
  writeFixtureFile(
    root,
    "apps/website/public/media/fallback-mobile.svg",
    "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
  );
  writeFixtureJson(root, "website-media/manifests/hero.json", {
    id: "hero",
    status: "published",
    originalOutputPath: "website-media/originals/hero.mp4",
    processedOutputPaths: [
      videoPath,
      "apps/website/public/media/generated/hero-poster.jpg",
    ],
  });
  writeFixtureJson(
    root,
    "apps/website/src/data/media-registry.json",
    [
      {
        id: "hero-field",
        sourceManifestId: "hero",
        status: "published",
        muted: true,
        checksum: createHash("sha256").update(video).digest("hex"),
        posterPath: "/media/generated/hero-poster.jpg",
        mobilePosterPath: "/media/fallback-mobile.svg",
        mp4Path: "/media/generated/hero.mp4",
      },
    ],
  );
  return { root, videoPath };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("marketing asset verifier", () => {
  it("passes a clean-checkout fixture without ignored originals", async () => {
    const { root, videoPath } = fixture();
    const probed: string[] = [];

    await expect(
      verifyMarketingAssets({
        root,
        probeVideo: async (path) => {
          probed.push(path);
        },
      }),
    ).resolves.toEqual({ manifests: 1, registryEntries: 1 });
    expect(probed).toContain(join(root, videoPath));
  });

  it("rejects missing processed outputs and registry paths", async () => {
    const { root } = fixture();
    const manifestPath = "website-media/manifests/hero.json";
    writeFixtureJson(root, manifestPath, {
      id: "hero",
      status: "published",
      originalOutputPath: "website-media/originals/hero.mp4",
      processedOutputPaths: [
        "apps/website/public/media/generated/missing.webm",
      ],
    });
    const registryPath = "apps/website/src/data/media-registry.json";
    writeFixtureJson(root, registryPath, [
      {
        id: "hero-field",
        sourceManifestId: "hero",
        status: "published",
        muted: true,
        posterPath: "/media/generated/missing-poster.jpg",
      },
    ]);

    await expect(
      verifyMarketingAssets({ root, probeVideo: async () => undefined }),
    ).rejects.toThrow(/missing\.webm is missing[\s\S]*missing-poster\.jpg is missing/);
  });

  it("validates draft fallback files and published registry provenance", async () => {
    const { root } = fixture();
    writeFixtureJson(
      root,
      "apps/website/src/data/media-registry.json",
      [
        {
          id: "draft-fallback",
          sourceManifestId: "hero",
          status: "draft",
          muted: true,
          checksum: "development-fallback",
          posterPath: "/media/generated/missing-draft-poster.jpg",
        },
        {
          id: "orphan-published",
          sourceManifestId: "missing-source",
          status: "published",
          muted: true,
          checksum: "development-fallback",
          posterPath: "/media/fallback-mobile.svg",
        },
      ],
    );

    await expect(
      verifyMarketingAssets({ root, probeVideo: async () => undefined }),
    ).rejects.toThrow(
      /missing-draft-poster\.jpg is missing[\s\S]*published without a published source manifest/,
    );
  });
});
