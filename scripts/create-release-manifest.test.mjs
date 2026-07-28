import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createReleaseManifest,
  resolveReleaseVersion,
} from "./create-release-manifest.mjs";

const temporaryRoots = [];

function fixture(version = "1.2.3") {
  const root = mkdtempSync(join(tmpdir(), "kestrel-release-manifest-"));
  temporaryRoots.push(root);
  const desktopPackagePath = join(root, "desktop-package.json");
  writeFileSync(
    desktopPackagePath,
    `${JSON.stringify({ version }, null, 2)}\n`,
  );
  for (const extension of ["dmg", "zip", "pkg"]) {
    writeFileSync(
      join(root, `Kestrel-Apple-Silicon-${version}.${extension}`),
      `${extension} bytes`,
    );
  }
  return { root, desktopPackagePath };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("release manifest version integrity", () => {
  it("uses the desktop package version for workflow dispatches", () => {
    const { root, desktopPackagePath } = fixture();
    const manifest = createReleaseManifest({
      root,
      desktopPackagePath,
      environment: {
        GITHUB_REF_NAME: "main",
        GITHUB_SHA: "abc123",
      },
    });

    expect(manifest).toMatchObject({
      version: "1.2.3",
      commit: "abc123",
    });
    expect(
      JSON.parse(readFileSync(join(root, "release-manifest.json"), "utf8")),
    ).toEqual(manifest);
    expect(manifest.artifacts).toHaveLength(3);
  });

  it("rejects a release tag that does not match the package", () => {
    expect(() => resolveReleaseVersion("1.2.3", "v1.2.4")).toThrow(
      /does not match desktop package version 1\.2\.3/,
    );
    expect(resolveReleaseVersion("1.2.3", "v1.2.3")).toBe("1.2.3");
  });

  it("rejects stale artifacts from another package version", () => {
    const { root, desktopPackagePath } = fixture("1.2.3");
    writeFileSync(
      join(root, "Kestrel-Apple-Silicon-1.2.2.dmg"),
      "stale bytes",
    );

    expect(() =>
      createReleaseManifest({
        root,
        desktopPackagePath,
        environment: { GITHUB_REF_NAME: "v1.2.3" },
      }),
    ).toThrow(/does not match desktop package version 1\.2\.3/);
  });
});
