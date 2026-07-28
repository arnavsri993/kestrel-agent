import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = resolve(import.meta.dirname, "..");
const supportedExtensions = new Set([".dmg", ".zip", ".pkg"]);
const packageVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function resolveReleaseVersion(packageVersion, githubRefName) {
  if (
    typeof packageVersion !== "string" ||
    !packageVersionPattern.test(packageVersion)
  ) {
    throw new Error(`Invalid desktop package version: ${String(packageVersion)}`);
  }
  if (
    githubRefName?.startsWith("v") &&
    githubRefName !== `v${packageVersion}`
  ) {
    throw new Error(
      `Release tag ${githubRefName} does not match desktop package version ${packageVersion}.`,
    );
  }
  return packageVersion;
}

export function createReleaseManifest({
  root = resolve("release"),
  desktopPackagePath = resolve(
    repositoryRoot,
    "apps",
    "desktop",
    "package.json",
  ),
  environment = process.env,
} = {}) {
  const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, "utf8"));
  const version = resolveReleaseVersion(
    desktopPackage.version,
    environment.GITHUB_REF_NAME,
  );
  const artifacts = readdirSync(root)
    .map((name) => join(root, name))
    .filter(
      (path) =>
        statSync(path).isFile() &&
        supportedExtensions.has(extname(path).toLowerCase()),
    )
    .sort();
  if (artifacts.length === 0)
    throw new Error("No DMG, ZIP, or PKG release artifacts were found.");

  const records = artifacts.map((path) => {
    const filename = basename(path);
    const extension = extname(filename).toLowerCase();
    const expectedFilename = `Kestrel-Apple-Silicon-${version}${extension}`;
    if (filename !== expectedFilename) {
      throw new Error(
        `Release artifact ${filename} does not match desktop package version ${version}.`,
      );
    }
    return {
      filename,
      bytes: statSync(path).size,
      sha256: createHash("sha256")
        .update(readFileSync(path))
        .digest("hex"),
    };
  });
  const manifest = {
    schemaVersion: 1,
    product: "Kestrel",
    platform: "darwin",
    architecture: "arm64",
    distribution: "internet",
    version,
    commit: environment.GITHUB_SHA ?? "unknown",
    artifacts: records,
  };
  writeFileSync(
    join(root, "release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o644 },
  );
  writeFileSync(
    join(root, "SHA256SUMS"),
    `${records
      .map((record) => `${record.sha256}  ${record.filename}`)
      .join("\n")}\n`,
    { mode: 0o644 },
  );
  return manifest;
}

function isDirectExecution() {
  const entry = process.argv[1];
  return Boolean(
    entry && pathToFileURL(resolve(entry)).href === import.meta.url,
  );
}

if (isDirectExecution()) {
  createReleaseManifest({ root: resolve(process.argv[2] ?? "release") });
}
