import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { sourceProvenance } from "./build-provenance.mjs";
import { assertIntegratedSource, claimDeploymentOwner, assertDeploymentCandidate } from "./macos-deployment-policy.mjs";

function repository() {
  const root = mkdtempSync(join(tmpdir(), "kestrel-deploy-policy-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-b", "main"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
  mkdirSync(join(root, "scripts")); writeFileSync(join(root, "scripts/input.mjs"), "original");
  git("add", "."); git("commit", "-m", "initial"); git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("remote", "add", "origin", root);
  return { root, git };
}
function bundle(root, identity) {
  const resources = join(root, "Contents/Resources");
  mkdirSync(join(resources, "agent-core/service"), { recursive: true });
  writeFileSync(join(resources, "app.asar"), "desktop fixture");
  writeFileSync(join(resources, "agent-core/service/index.js"), "core fixture");
  writeFileSync(join(resources, "agent-core/runtime-manifest.json"), JSON.stringify({ build: identity }));
  const digest = value => createHash("sha256").update(value).digest("hex");
  writeFileSync(join(resources, "build-provenance.json"), JSON.stringify({ ...identity,
    artifacts: { appAsar: digest("desktop fixture"), coreEntry: digest("core fixture") } }));
  return root;
}
describe("canonical integrated-source policy", () => {
  it("rejects uncommitted changes and unintegrated commits", () => {
    const { root, git } = repository();
    const identity = sourceProvenance(root);
    expect(assertIntegratedSource(root, identity)).toEqual(identity);
    writeFileSync(join(root, "scripts/input.mjs"), "changed");
    expect(() => assertIntegratedSource(root, identity)).toThrow(/clean/);
    git("add", "."); git("commit", "-m", "unintegrated");
    expect(() => assertIntegratedSource(root, sourceProvenance(root))).toThrow();
  });
  it("rejects non-owner workspaces before inspecting or replacing a bundle", () => {
    const first = repository(); const other = repository();
    const installRoot = mkdtempSync(join(tmpdir(), "kestrel-policy-install-"));
    claimDeploymentOwner(first.root, installRoot);
    expect(() => assertDeploymentCandidate({ repositoryRoot: other.root, installRoot,
      source: join(installRoot, "missing.app"), destination: join(installRoot, "Kestrel.app") })).toThrow(/not the canonical deployment owner/);
  });
  it("rejects stale artifact identity when clean source changes", () => {
    const { root, git } = repository(); const previous = sourceProvenance(root);
    writeFileSync(join(root, "scripts/input.mjs"), "new source");
    git("add", "."); git("commit", "-m", "integrated improvement"); git("update-ref", "refs/remotes/origin/main", "HEAD");
    expect(() => assertIntegratedSource(root, previous)).toThrow(/does not match/);
  });
  it("refuses an old fetched main tip when the remote has advanced", () => {
    const { root, git } = repository(); const previous = sourceProvenance(root);
    writeFileSync(join(root, "scripts/input.mjs"), "newer remote");
    git("add", "."); git("commit", "-m", "remote advance");
    git("checkout", "--detach", previous.sourceCommit);
    expect(() => assertIntegratedSource(root, previous)).toThrow(/Remote main changed/);
  });
  it("requires an explicit recorded-owner handoff before another workspace can claim deployment", () => {
    const first = repository(); const other = repository();
    const installRoot = mkdtempSync(join(tmpdir(), "kestrel-policy-handoff-"));
    const owner = claimDeploymentOwner(first.root, installRoot);
    expect(() => claimDeploymentOwner(other.root, installRoot)).toThrow(/Explicit --handoff-from/);
    expect(claimDeploymentOwner(other.root, installRoot, owner.workspace).workspace).toBe(realpathSync(other.root));
  });
  it("rejects a downgrade even when the older candidate is integrated and clean", () => {
    const { root, git } = repository();
    const older = sourceProvenance(root);
    writeFileSync(join(root, "scripts/input.mjs"), "newer");
    git("add", "."); git("commit", "-m", "newer integrated source"); git("update-ref", "refs/remotes/origin/main", "HEAD");
    const newer = sourceProvenance(root);
    const installRoot = mkdtempSync(join(tmpdir(), "kestrel-policy-downgrade-"));
    const destination = bundle(join(installRoot, "Kestrel.app"), newer);
    git("reset", "--hard", older.sourceCommit); git("update-ref", "refs/remotes/origin/main", "HEAD");
    claimDeploymentOwner(root, installRoot);
    const source = bundle(join(installRoot, "candidate.app"), older);
    expect(() => assertDeploymentCandidate({ repositoryRoot: root, installRoot, source, destination })).toThrow(/downgrade/);
  });
  it("rejects changed desktop/core bytes and a mixed sidecar before replacement", () => {
    const { root } = repository(); const identity = sourceProvenance(root);
    const installRoot = mkdtempSync(join(tmpdir(), "kestrel-policy-hashes-"));
    claimDeploymentOwner(root, installRoot);
    const source = bundle(join(installRoot, "candidate.app"), identity);
    const candidate = { repositoryRoot: root, installRoot, source, destination: join(installRoot, "Kestrel.app") };
    expect(assertDeploymentCandidate(candidate).buildId).toBe(identity.buildId);
    writeFileSync(join(source, "Contents/Resources/app.asar"), "tampered");
    expect(() => assertDeploymentCandidate(candidate)).toThrow(/hashes/);
    bundle(source, identity);
    writeFileSync(join(source, "Contents/Resources/agent-core/service/index.js"), "tampered");
    expect(() => assertDeploymentCandidate(candidate)).toThrow(/hashes/);
    bundle(source, identity);
    writeFileSync(join(source, "Contents/Resources/agent-core/runtime-manifest.json"), JSON.stringify({ build: { buildId: "different" } }));
    expect(() => assertDeploymentCandidate(candidate)).toThrow(/Core build/);
  });
});
