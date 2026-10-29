import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative as relativePath, resolve } from "node:path";

// Every gate requires its own receipt: an observation for one workflow must not
// be used as evidence that a different workflow passed.
export const RETIREMENT_GATES = Object.freeze([
  "native-chromium-host", "native-chromium-core-relay", "native-core-durability",
  "native-extensions", "native-user-extensions", "native-extension-parity",
  "native-durable-browser-library", "native-download-capture", "native-browser-backend",
  "native-isolated-automation", "native-credential-bootstrap", "packaged-native-arm64",
  "real-keychain-credential-bootstrap", "isolated-automation-session",
  "existing-ui-and-onboarding", "provider-sign-in", "local-models", "agents-and-tools",
  "approvals", "workspace-and-files", "settings", "autofill", "restart-recovery",
  "developer-id-signing-and-notarization", "profile-transfer-and-rollback",
  "canonical-dock-app-on-screen",
]);

const SHA256 = /^[a-f0-9]{64}$/;
const digest = () => createHash("sha256");
async function hashFile(path) {
  const hash = digest();
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

// Include every bundle entry, its type, mode, pathname and contents or link
// target. Signing the main executable alone does not establish that the Node
// sidecar, extension, framework, UI assets and other resources are unchanged.
export async function candidateDigest(candidate) {
  const hash = digest();
  const candidateRoot = await realpath(candidate);
  const add = (value) => { const data = Buffer.from(value); hash.update(`${data.length}:`); hash.update(data); };
  async function visit(path, relative) {
    const before = await lstat(path);
    const type = before.isDirectory() ? "directory" : before.isFile() ? "file" : before.isSymbolicLink() ? "link" : "unsupported";
    if (type === "unsupported") throw new Error(`Unsupported candidate entry: ${relative}`);
    add(relative); add(type); add(String(before.mode & 0o7777));
    if (type === "directory") {
      const names = (await readdir(path)).sort();
      for (const name of names) await visit(join(path, name), relative ? `${relative}/${name}` : name);
    } else if (type === "link") {
      const target = await readlink(path);
      const resolvedTarget = await realpath(path);
      const fromRoot = relativePath(candidateRoot, resolvedTarget);
      if (isAbsolute(target) || fromRoot === ".." || fromRoot.startsWith("../") || isAbsolute(fromRoot)) {
        throw new Error(`Candidate link escapes the app bundle: ${relative}`);
      }
      add(target);
    } else add(await hashFile(path));
    const after = await lstat(path);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.mode !== after.mode) {
      throw new Error(`Candidate changed while hashing: ${relative}`);
    }
  }
  await visit(candidate, "");
  return hash.digest("hex");
}

// Evidence manifest v1: { version: 1, candidateSha256, gates: { gateId:
// { receipt: "relative/path.json", sha256: "..." } } }. Each receipt is a
// separately produced JSON record { version: 1, gate, candidateSha256,
// result: "passed", observedAt, summary, artifacts: [{ path, sha256 }] }.
// Paths are relative to the containing manifest/receipt respectively. Artifact
// hashes prevent accidental substitution; reviewers must still inspect evidence.
export async function validateRetirementEvidence(candidate, manifestPath) {
  const problems = [];
  let candidateSha256;
  try { candidateSha256 = await candidateDigest(candidate); }
  catch (error) { return { problems: [`Cannot fingerprint candidate: ${error.message}`] }; }
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); }
  catch (error) { return { candidateSha256, problems: [`Cannot read evidence manifest: ${error.message}`] }; }
  if (manifest?.version !== 1 || !manifest.gates || typeof manifest.gates !== "object" || Array.isArray(manifest.gates)) {
    return { candidateSha256, problems: ["Evidence manifest has an invalid schema."] };
  }
  if (manifest.candidateSha256 !== candidateSha256) problems.push("Evidence manifest does not match the complete candidate bundle.");
  const seen = new Set();
  for (const gate of RETIREMENT_GATES) {
    const item = manifest.gates[gate];
    if (!item || typeof item.receipt !== "string" || !item.receipt || !SHA256.test(item.sha256 ?? "")) {
      problems.push(`${gate}: missing receipt or receipt digest`); continue;
    }
    const path = resolve(dirname(manifestPath), item.receipt);
    if (seen.has(path)) { problems.push(`${gate}: receipt is reused by another gate`); continue; }
    seen.add(path);
    try {
      const bytes = await readFile(path);
      if (digest().update(bytes).digest("hex") !== item.sha256) throw new Error("receipt digest mismatch");
      const receipt = JSON.parse(bytes.toString("utf8"));
      if (receipt?.version !== 1 || receipt.gate !== gate || receipt.candidateSha256 !== candidateSha256 || receipt.result !== "passed" ||
          typeof receipt.observedAt !== "string" || !Number.isFinite(Date.parse(receipt.observedAt)) ||
          typeof receipt.summary !== "string" || !receipt.summary.trim() || !Array.isArray(receipt.artifacts) || !receipt.artifacts.length) {
        throw new Error("receipt is invalid, unverified, or for a different candidate");
      }
      for (const artifact of receipt.artifacts) {
        if (!artifact || typeof artifact.path !== "string" || !artifact.path || !SHA256.test(artifact.sha256 ?? "")) throw new Error("invalid supporting artifact");
        const artifactPath = isAbsolute(artifact.path) ? artifact.path : resolve(dirname(path), artifact.path);
        const stat = await lstat(artifactPath);
        if (!stat.isFile() || stat.size === 0 || await hashFile(artifactPath) !== artifact.sha256) throw new Error("supporting artifact missing, empty, or changed");
      }
    } catch (error) { problems.push(`${gate}: ${error.message}`); }
  }
  return { candidateSha256, problems };
}
