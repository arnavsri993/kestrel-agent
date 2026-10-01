import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { atomicJson, deploymentPaths } from "./macos-deployment-lock.mjs";
import { sourceProvenance } from "./build-provenance.mjs";

export function readBundleProvenance(bundle) {
  return JSON.parse(readFileSync(join(bundle, "Contents", "Resources", "build-provenance.json"), "utf8"));
}

export function assertIntegratedSource(repositoryRoot, manifest) {
  const source = sourceProvenance(repositoryRoot);
  if (source.dirty || manifest.dirty) throw new Error("Canonical installation requires a clean committed source tree.");
  if (source.sourceCommit !== manifest.sourceCommit || source.sourceDigest !== manifest.sourceDigest || source.buildId !== manifest.buildId)
    throw new Error("Packaged provenance does not match current source; rebuild before installing.");
  const git = (...args) => execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8", timeout: 30_000 }).trim();
  const fetchedMain = git("rev-parse", "refs/remotes/origin/main");
  if (source.sourceCommit !== fetchedMain)
    throw new Error("Canonical installation requires the fetched main tip; fetch and check out integrated main first.");
  const remoteMain = git("ls-remote", "--exit-code", "origin", "refs/heads/main").split(/\s+/)[0];
  if (remoteMain !== fetchedMain)
    throw new Error("Remote main changed since the last fetch; fetch and rebuild the current integrated tip.");
  return source;
}

export function claimDeploymentOwner(repositoryRoot, installRoot, handoffFrom) {
  const source = sourceProvenance(repositoryRoot);
  assertIntegratedSource(repositoryRoot, source);
  const path = deploymentPaths(installRoot).owner;
  if (existsSync(path)) {
    const previous = JSON.parse(readFileSync(path, "utf8"));
    if (previous.workspace !== realpathSync(repositoryRoot) && handoffFrom !== previous.workspace)
      throw new Error("Another workspace owns canonical deployment. Explicit --handoff-from <recorded workspace> is required.");
  }
  const owner = { format: 1, workspace: realpathSync(repositoryRoot), sourceCommit: source.sourceCommit,
    claimedAt: new Date().toISOString() };
  atomicJson(path, owner);
  return owner;
}

export function assertDeploymentCandidate({ repositoryRoot, installRoot, source, destination }) {
  const paths = deploymentPaths(installRoot);
  if (!existsSync(paths.owner)) throw new Error("No canonical deployment owner. From clean integrated main run pnpm deployment:claim first.");
  const owner = JSON.parse(readFileSync(paths.owner, "utf8"));
  if (owner.workspace !== realpathSync(repositoryRoot))
    throw new Error("This worktree is not the canonical deployment owner. Request an explicit owner handoff.");
  const manifest = readBundleProvenance(source);
  try { assertIntegratedSource(repositoryRoot, manifest); }
  catch (error) { throw new Error(`Refusing unintegrated, dirty or stale deployment: ${error.message}`); }
  if (existsSync(join(destination, "Contents", "Resources", "build-provenance.json"))) {
    const previous = readBundleProvenance(destination);
    try { execFileSync("git", ["merge-base", "--is-ancestor", previous.sourceCommit, manifest.sourceCommit], { cwd: repositoryRoot, stdio: "ignore" }); }
    catch { throw new Error("Refusing a downgrade or unrelated installed commit; explicit rollback review is required."); }
  }
  const core = JSON.parse(readFileSync(join(source, "Contents", "Resources", "agent-core", "runtime-manifest.json"), "utf8"));
  if (core.build?.buildId !== manifest.buildId) throw new Error("Packaged Agent Core build does not match desktop build.");
  const digest = path => createHash("sha256").update(readFileSync(path)).digest("hex");
  if (manifest.artifacts?.appAsar !== digest(join(source, "Contents/Resources/app.asar")) ||
      manifest.artifacts?.coreEntry !== digest(join(source, "Contents/Resources/agent-core/service/index.js")))
    throw new Error("Packaged artifact hashes do not match build provenance.");
  return manifest;
}
