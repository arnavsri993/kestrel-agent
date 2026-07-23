import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const manifestDir = join(root, "website-media", "manifests");
const registry = JSON.parse(await readFile(join(root, "apps", "website", "src", "data", "media-registry.json"), "utf8")) as Array<Record<string, unknown>>;
const problems: string[] = [];

for (const file of await readdir(manifestDir)) {
  if (!file.endsWith(".json")) continue;
  const manifest = JSON.parse(await readFile(join(manifestDir, file), "utf8")) as { id: string; status: string; originalOutputPath: string; processedOutputPaths: string[] };
  if (["generated", "approved", "processed", "published"].includes(manifest.status)) {
    if (!manifest.originalOutputPath) problems.push(`${manifest.id}: generated state has no original path`);
    else if ((await stat(join(root, manifest.originalOutputPath))).size === 0) problems.push(`${manifest.id}: original is empty`);
  }
  if (manifest.status === "published") {
    const asset = registry.find((item) => item.sourceManifestId === manifest.id);
    if (!asset) problems.push(`${manifest.id}: published without registry entry`);
    if (!asset?.posterPath) problems.push(`${manifest.id}: published video has no poster`);
    if (asset?.muted !== true) problems.push(`${manifest.id}: background video is not muted`);
    for (const path of manifest.processedOutputPaths) if (path.endsWith(".mp4")) await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1", join(root, path)]);
  }
}
if (problems.length) throw new Error(`Marketing asset verification failed:\n${problems.join("\n")}`);
console.log(`Marketing asset verification passed for ${registry.length} registry entries.`);
