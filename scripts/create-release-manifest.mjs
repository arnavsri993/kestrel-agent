import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "release");
const artifacts = readdirSync(root).map((name) => join(root, name)).filter((path) => statSync(path).isFile() && /\.(?:dmg|zip|pkg)$/.test(path)).sort();
if (artifacts.length === 0) throw new Error("No DMG, ZIP, or PKG release artifacts were found.");
const records = artifacts.map((path) => {
  const filename = basename(path);
  if (!/^Kestrel-Apple-Silicon-[0-9A-Za-z.-]+\.(?:dmg|zip|pkg)$/.test(filename)) {
    throw new Error(`Unsupported release artifact: ${filename}`);
  }
  return { filename, bytes: statSync(path).size, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
});
const manifest = {
  schemaVersion: 1,
  product: "Kestrel",
  platform: "darwin",
  architecture: "arm64",
  distribution: "internet",
  version: process.env.GITHUB_REF_NAME?.replace(/^v/, "") ?? "development",
  commit: process.env.GITHUB_SHA ?? "unknown",
  artifacts: records,
};
writeFileSync(join(root, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
writeFileSync(join(root, "SHA256SUMS"), `${records.map((record) => `${record.sha256}  ${record.filename}`).join("\n")}\n`, { mode: 0o644 });
