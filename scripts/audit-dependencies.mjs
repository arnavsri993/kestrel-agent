#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ADVISORY, BRACE, EXPIRES, PATCHES, SOURCES, assessAudit, parseAuditResult, verifyManifest, verifySourceHashes } from "./audit-minimatch-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
function pnpm(args, options = {}) {
  return spawnSync("corepack", ["pnpm", ...args], { cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...options });
}
function resolveConsumer(path) {
  const [workspace, ...packages] = path.split(">");
  if (workspace !== "apps__desktop" && workspace !== "apps__website") throw new Error(`Unexpected workspace ${workspace}.`);
  let from = createRequire(join(root, workspace.replace("__", "/"), "package.json"));
  for (const name of packages) from = createRequire(from.resolve(`${name}/package.json`));
  return from;
}
function verifyConfiguration() {
  const desktop = createRequire(join(root, "apps/desktop/package.json"));
  const builder = createRequire(desktop.resolve("electron-builder/package.json"));
  const yaml = builder("js-yaml");
  const workspace = yaml.load(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"));
  const lock = yaml.load(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"));
  verifyManifest(workspace, lock, Object.fromEntries(Object.keys(PATCHES).map(version => [version, hash(join(root, "patches", `minimatch@${version}.patch`))])));
}
function verifyInstalled(accepted) {
  const verified = new Set();
  for (const finding of accepted) {
    const consumer = resolveConsumer(finding.path);
    const packagePath = consumer.resolve("./package.json");
    const installedVersion = JSON.parse(readFileSync(packagePath, "utf8")).version;
    if (installedVersion !== finding.version || !packagePath.includes(`minimatch@${finding.version}_patch_hash=${PATCHES[finding.version]}`)) throw new Error(`Resolved package identity does not match: ${finding.path}.`);
    const braceManifest = consumer.resolve("brace-expansion/package.json");
    const braceRoot = dirname(braceManifest);
    const braceVersion = JSON.parse(readFileSync(braceManifest, "utf8")).version;
    const sourceHashes = Object.fromEntries(Object.keys(SOURCES[finding.version]).map(file => [file, hash(join(dirname(packagePath), file))]));
    const braceHashes = Object.fromEntries(Object.keys(BRACE).map(file => [file, hash(join(braceRoot, file))]));
    verifySourceHashes(finding.version, sourceHashes, braceHashes, braceVersion);
    verified.add(finding.version);
  }
  // Exercise every reviewed version even if audit output lists only a subset.
  if (verified.size !== Object.keys(PATCHES).length) throw new Error("Audit did not report all four reviewed minimatch versions; re-review the changed dependency graph.");
  const check = pnpm(["exec", "vitest", "run", "scripts/minimatch-compat.test.mjs"]);
  process.stdout.write(check.stdout || "");
  process.stderr.write(check.stderr || "");
  if (check.error || check.status !== 0) throw new Error(`Installed backport regression tests failed: ${check.error?.message || `exit ${check.status}`}.`);
}
try {
  const audit = pnpm(["audit", "--json"]);
  // Preserve the scanner output even when it is malformed or inconsistent.
  if (audit.stdout) process.stdout.write(audit.stdout.endsWith("\n") ? audit.stdout : `${audit.stdout}\n`);
  if (audit.stderr) process.stderr.write(audit.stderr);
  const report = parseAuditResult(audit);
  const accepted = assessAudit(report, new Date());
  verifyConfiguration();
  if (accepted.length) {
    verifyInstalled(accepted);
    console.log(`${ADVISORY} remains reported by pnpm; the exact reviewed development-only backports and installed behavior were verified for ${accepted.length} paths. Exception expires ${EXPIRES}.`);
  } else console.log("pnpm audit reported no findings.");
} catch (error) {
  console.error(`Dependency audit failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
