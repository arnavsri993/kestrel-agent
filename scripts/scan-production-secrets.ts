import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const targets = [join(root, "apps", "website", "out"), join(root, "apps", "desktop", "out", "renderer")];
const patterns = ["FAL_KEY", "fal.ai credentials", /fal-[A-Za-z0-9_-]{20,}/, /sk-[A-Za-z0-9_-]{20,}/];
const hits: string[] = [];

async function walk(path: string): Promise<void> {
  let info;
  try { info = await stat(path); } catch { return; }
  if (info.isDirectory()) { for (const name of await readdir(path)) await walk(join(path, name)); return; }
  if (!/\.(?:js|mjs|cjs|map|html|json|css)$/.test(path)) return;
  const content = await readFile(path, "utf8");
  for (const pattern of patterns) if (typeof pattern === "string" ? content.includes(pattern) : pattern.test(content)) hits.push(`${path.slice(root.length + 1)} matched ${String(pattern)}`);
}
for (const target of targets) await walk(target);
if (hits.length) throw new Error(`Production secret scan failed:\n${hits.join("\n")}`);
console.log("Production browser secret scan passed: no credential names or known secret prefixes found.");
