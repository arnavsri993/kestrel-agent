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
function bundle(root, identity, identifier = "com.kestrel.desktop.dev", channel = "development") {
  const resources = join(root, "Contents/Resources");
  mkdirSync(join(resources, "agent-core/service"), { recursive: true });
  writeFileSync(join(root, "Contents/Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict>
    <key>CFBundleIdentifier</key><string>${identifier}</string>
    <key>LSEnvironment</key><dict><key>KESTREL_RELEASE_CHANNEL</key><string>${channel}</string></dict>
    </dict></plist>`);
  writeFileSync(join(resources, "app.asar"), "desktop fixture");
  writeFileSync(join(resources, "agent-core/service/index.js"), "core fixture");
  writeFileSync(join(resources, "agent-core/runtime-manifest.json"), JSON.stringify({ build: identity }));
  const digest = value => createHash("sha256").update(value).digest("hex");
  writeFileSync(join(resources, "build-provenance.json"), JSON.stringify({ ...identity,
    artifacts: { appAsar: digest("desktop fixture"), coreEntry: digest("core fixture") } }));
  return root;
}
describe("canonical integrated-source policy", () => {
  it("opts into only an exact clean candidate including live main and records that scope in its owner claim", () => {
    const { root, git } = repository();
    const base = sourceProvenance(root);
    git("checkout", "-b", "candidate");
    writeFileSync(join(root, "scripts/input.mjs"), "candidate");
    git("add", "."); git("commit", "-m", "candidate");
    const identity = sourceProvenance(root);
    const options = { candidateCommit: identity.sourceCommit };
    expect(() => assertIntegratedSource(root, identity)).toThrow(/fetched main tip/);
    expect(assertIntegratedSource(root, identity, options)).toEqual(identity);
    for (const candidateCommit of ["candidate", identity.sourceCommit.slice(0, 8), "HEAD", "", identity.sourceCommit.toUpperCase()])
      expect(() => assertIntegratedSource(root, identity, { candidateCommit })).toThrow(/exact full/);
    expect(() => assertIntegratedSource(root, identity, { candidateCommit: base.sourceCommit })).toThrow(/does not match/);
    const installRoot = mkdtempSync(join(tmpdir(), "kestrel-policy-candidate-"));
    expect(() => claimDeploymentOwner(root, installRoot)).toThrow(/fetched main tip/);
    expect(claimDeploymentOwner(root, installRoot, undefined, options).candidateCommit).toBe(identity.sourceCommit);
    writeFileSync(join(root, "scripts/input.mjs"), "dirty candidate");
    expect(() => assertIntegratedSource(root, identity, options)).toThrow(/clean/);
  });
  it("rejects development candidates when remote main advances or fetched main is omitted", () => {
    const { root, git } = repository();
    git("checkout", "-b", "candidate");
    writeFileSync(join(root, "scripts/input.mjs"), "candidate");
    git("add", "."); git("commit", "-m", "candidate");
    const candidate = sourceProvenance(root);
    git("checkout", "main");
    writeFileSync(join(root, "scripts/input.mjs"), "new remote main");
    git("add", "."); git("commit", "-m", "main advance");
    git("checkout", "candidate");
    const options = { candidateCommit: candidate.sourceCommit };
    expect(() => assertIntegratedSource(root, candidate, options)).toThrow(/Remote main changed/);
    git("fetch", "origin", "main");
    expect(() => assertIntegratedSource(root, candidate, options)).toThrow(/must include/);
  });
  it("rejects an unrelated exact candidate and stale packaged candidate identity", () => {
    const { root, git } = repository();
    const initial = sourceProvenance(root);
    git("checkout", "--orphan", "unrelated");
    git("add", "."); git("commit", "-m", "unrelated history");
    const unrelated = sourceProvenance(root);
    expect(() => assertIntegratedSource(root, unrelated, { candidateCommit: unrelated.sourceCommit })).toThrow(/must include/);
    git("checkout", "-b", "candidate", initial.sourceCommit);
    writeFileSync(join(root, "scripts/input.mjs"), "candidate");
    git("add", "."); git("commit", "-m", "candidate");
    const candidate = sourceProvenance(root);
    expect(() => assertIntegratedSource(root, initial, { candidateCommit: candidate.sourceCommit })).toThrow(/Packaged provenance/);
  });
  it("retains owner handoff and requires a matching candidate claim", () => {
    const first = repository(); const other = repository();
    const installRoot = mkdtempSync(join(tmpdir(), "kestrel-policy-candidate-owner-"));
    const owner = claimDeploymentOwner(first.root, installRoot);
    other.git("checkout", "-b", "candidate");
    writeFileSync(join(other.root, "scripts/input.mjs"), "candidate");
    other.git("add", "."); other.git("commit", "-m", "candidate");
    const candidateCommit = sourceProvenance(other.root).sourceCommit;
    expect(() => claimDeploymentOwner(other.root, installRoot, undefined, { candidateCommit })).toThrow(/Explicit --handoff-from/);
    expect(claimDeploymentOwner(other.root, installRoot, owner.workspace, { candidateCommit }).candidateCommit).toBe(candidateCommit);
    expect(() => assertDeploymentCandidate({ repositoryRoot: other.root, installRoot, candidateCommit: "0".repeat(40),
      source: join(installRoot, "missing.app"), destination: join(installRoot, "Kestrel.app") })).toThrow(/same exact/);
  });
  (process.platform === "darwin" ? it : it.skip)("allows verified development identity only and preserves hashes/core/nondowngrade checks", () => {
    const { root, git } = repository();
    const base = sourceProvenance(root);
    git("checkout", "-b", "candidate");
    writeFileSync(join(root, "scripts/input.mjs"), "candidate");
    git("add", "."); git("commit", "-m", "candidate");
    const identity = sourceProvenance(root);
    const installRoot = mkdtempSync(join(tmpdir(), "kestrel-policy-candidate-bundle-"));
    const candidateCommit = identity.sourceCommit;
    claimDeploymentOwner(root, installRoot, undefined, { candidateCommit });
    const destination = bundle(join(installRoot, "Kestrel.app"), base);
    const source = bundle(join(installRoot, "candidate.app"), identity);
    const candidate = { repositoryRoot: root, installRoot, source, destination, candidateCommit };
    expect(assertDeploymentCandidate(candidate).buildId).toBe(identity.buildId);
    for (const [identifier, channel] of [["com.kestrel.desktop", "stable"], ["com.kestrel.desktop.dev", "stable"], ["com.kestrel.desktop.dev.launcher", "development"]]) {
      bundle(source, identity, identifier, channel);
      expect(() => assertDeploymentCandidate(candidate)).toThrow(/development bundle identity/);
    }
    bundle(source, identity);
    writeFileSync(join(source, "Contents/Resources/app.asar"), "tampered");
    expect(() => assertDeploymentCandidate(candidate)).toThrow(/hashes/);
    bundle(source, identity);
    writeFileSync(join(source, "Contents/Resources/agent-core/runtime-manifest.json"), JSON.stringify({ build: { buildId: "mixed" } }));
    expect(() => assertDeploymentCandidate(candidate)).toThrow(/Core build/);
    bundle(source, identity);
    writeFileSync(join(root, "scripts/input.mjs"), "newer candidate");
    git("add", "."); git("commit", "-m", "newer candidate");
    bundle(destination, sourceProvenance(root));
    git("reset", "--hard", candidateCommit);
    expect(() => assertDeploymentCandidate(candidate)).toThrow(/downgrade/);
  });
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
