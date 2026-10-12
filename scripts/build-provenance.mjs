import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";

export function sourceProvenance(root = resolve(import.meta.dirname, "..")) {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const sourceCommit = git("rev-parse", "HEAD");
  // electron-vite writes this exact transient module beside its config while
  // importing it, then unlinks it. It is generated code, not a source input.
  // Exclude only untracked instances; a tracked file still remains an input.
  const transientConfig = path => /^apps\/desktop\/electron\.vite\.config\.\d+\.mjs$/.test(path);
  const dirty = git("status", "--porcelain", "-z", "--untracked-files=all").split("\0")
    .some(record => record && !(record.startsWith("?? ") && transientConfig(record.slice(3))));
  // Only source inputs are hashed. Ignored build products and private traces
  // are never read or embedded in an app. Include new untracked source files.
  const tracked = git("ls-files", "-z", "--cached").split("\0");
  const untracked = git("ls-files", "-z", "--others", "--exclude-standard").split("\0").filter(path => !transientConfig(path));
  const files = [...new Set([...tracked, ...untracked]
    .filter(path => /^(apps|packages|scripts)\//.test(path) || /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/.test(path)))].sort();
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(`${Buffer.byteLength(file)}:${file}\0`);
    try { const path = resolve(root, file);
      const bytes = lstatSync(path).isSymbolicLink() ? Buffer.from(`symlink:${readlinkSync(path)}`) : readFileSync(path);
      digest.update(`${bytes.length}:`); digest.update(bytes); }
    catch (error) { if (error.code !== "ENOENT") throw error; digest.update("deleted"); }
  }
  const sourceDigest = digest.digest("hex");
  return { format: 1, sourceCommit, sourceDigest, dirty,
    buildId: createHash("sha256").update(`${sourceCommit}:${sourceDigest}`).digest("hex") };
}

export function buildDefines(root) {
  return { __KESTREL_BUILD_IDENTITY__: JSON.stringify(sourceProvenance(root)) };
}
