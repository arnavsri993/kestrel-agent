import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative as relativePath, resolve, sep } from "node:path";

// Every gate requires its own receipt: an observation for one workflow must not
// be used as evidence that a different workflow passed.
export const RETIREMENT_GATES = Object.freeze([
  "native-chromium-host", "native-chromium-core-relay", "native-core-durability",
  "native-extensions", "native-user-extensions", "native-extension-parity",
  "native-durable-browser-library", "native-download-capture", "native-browser-backend",
  "native-isolated-automation", "native-credential-bootstrap", "packaged-native-arm64",
  "native-local-vault", "native-browser-local-vault", "isolated-automation-session",
  "existing-ui-and-onboarding", "provider-sign-in", "local-models", "agents-and-tools",
  "approvals", "workspace-and-files", "settings", "autofill", "restart-recovery",
  "developer-id-signing-and-notarization", "profile-transfer-and-rollback",
  "canonical-dock-app-on-screen",
]);

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_NATIVE_DESKTOP_RECEIPT_BYTES = 16 * 1024 * 1024;
const JSON_FORMATTER_STORE_ID = "bcjindcccaagfpapjjmafapmmgkkhgoa";
const UBLOCK_ORIGIN_LITE_STORE_ID = "ddkjiahejlhfcafbddmgiahcphecmpfh";
const digest = () => createHash("sha256");
function isContainedPath(parent, child) {
  const rel = relativePath(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
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

// A generic passed wrapper cannot substitute for a production-mode vault
// canary. This verifies the recorded observations, not their independent truth;
// release reviewers must inspect the supporting run and its provenance.
async function validateLocalVaultArtifact(gate, wrapper, wrapperPath, candidateSha256) {
  const kind = gate === "native-local-vault" ? "native-local-vault-canary" : "native-browser-local-vault-canary";
  const artifacts = wrapper.artifacts.filter(artifact => artifact?.kind === kind);
  if (artifacts.length !== 1) throw new Error(`expected exactly one ${kind} artifact`);
  const artifact = artifacts[0];
  if (typeof artifact.path !== "string" || !artifact.path || isAbsolute(artifact.path) || !SHA256.test(artifact.sha256 ?? ""))
    throw new Error("invalid vault canary artifact reference");
  const base = await realpath(dirname(wrapperPath));
  const path = resolve(dirname(wrapperPath), artifact.path);
  if (!isContainedPath(resolve(dirname(wrapperPath)), path)) throw new Error("vault canary artifact escapes receipt directory");
  const canonical = await realpath(path);
  if (!isContainedPath(base, canonical)) throw new Error("vault canary artifact escapes through a symlink");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_RECEIPT_BYTES) throw new Error("vault canary artifact is invalid");
  const bytes = await readFile(path);
  if (digest().update(bytes).digest("hex") !== artifact.sha256) throw new Error("vault canary artifact digest mismatch");
  const proof = JSON.parse(bytes.toString("utf8"));
  const required = ["freshGeneratedProfile", "productionProvider", "cleanRestart", "sameProfileRestartReadback", "encryptedDataVerified", "plaintextAbsent", "noMockProvider", "noTestKey", "noKeychainItemAPIs"];
  const provider = gate === "native-local-vault" ? "secure-enclave-local-vault" : "chromium-local-vault";
  if (!SHA256.test(candidateSha256 ?? "") || proof?.version !== 1 || proof.kind !== kind || proof.gate !== gate ||
      proof.result !== "passed" || proof.provider !== provider || proof.candidateSha256 !== candidateSha256 ||
      proof.candidateSha256After !== candidateSha256 || required.some(key => proof.checks?.[key] !== true))
    throw new Error("vault canary lacks candidate-bound production restart, encryption, or no-Keychain evidence");
  if (gate === "native-browser-local-vault" && (proof.checks?.persistentCookieReadback !== true || proof.checks?.encryptedCookieRow !== true))
    throw new Error("browser vault canary lacks persistent encrypted cookie evidence");
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
  try {
    const stat = await lstat(manifestPath);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) throw new Error("manifest is not a regular file or exceeds the size limit");
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  }
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
      const receiptStat = await lstat(path);
      if (!receiptStat.isFile() || receiptStat.size > MAX_RECEIPT_BYTES) throw new Error("receipt is not a regular file or exceeds the size limit");
      const bytes = await readFile(path);
      if (digest().update(bytes).digest("hex") !== item.sha256) throw new Error("receipt digest mismatch");
      const receipt = JSON.parse(bytes.toString("utf8"));
      if (receipt?.version !== 1 || receipt.gate !== gate || receipt.candidateSha256 !== candidateSha256 || receipt.result !== "passed" ||
          typeof receipt.observedAt !== "string" || !Number.isFinite(Date.parse(receipt.observedAt)) ||
          typeof receipt.summary !== "string" || !receipt.summary.trim() || !Array.isArray(receipt.artifacts) || !receipt.artifacts.length) {
        throw new Error("receipt is invalid, unverified, or for a different candidate");
      }
      if (gate === "native-local-vault" || gate === "native-browser-local-vault") {
        await validateLocalVaultArtifact(gate, receipt, path, candidateSha256);
      }
      for (const artifact of receipt.artifacts) {
        if (!artifact || typeof artifact.path !== "string" || !artifact.path || !SHA256.test(artifact.sha256 ?? "")) throw new Error("invalid supporting artifact");
        const artifactPath = isAbsolute(artifact.path) ? artifact.path : resolve(dirname(path), artifact.path);
        const stat = await lstat(artifactPath);
        if (!stat.isFile() || stat.size === 0 || stat.size > MAX_ARTIFACT_BYTES || await hashFile(artifactPath) !== artifact.sha256) throw new Error("supporting artifact missing, empty, oversized, or changed");
      }
    } catch (error) { problems.push(`${gate}: ${error.message}`); }
  }
  return { candidateSha256, problems };
}

// The native desktop Store canary writes its own receipt. The retirement gate
// wrapper must explicitly identify that receipt as an artifact so a generic
// "passed" attestation cannot stand in for real Chromium-owned observations.
export async function validateNativeExtensionParityEvidence(candidate, manifestPath, candidateSha256) {
  const problems = [];
  const fail = (message) => ({ problems: [message] });
  try {
    if (await candidateDigest(candidate) !== candidateSha256) return fail("native-extension-parity: candidate changed before semantic receipt validation");
  } catch (error) { return fail(`native-extension-parity: cannot fingerprint candidate: ${error.message}`); }
  let manifest;
  try {
    const stat = await lstat(manifestPath);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) throw new Error("manifest is not a regular file or exceeds the size limit");
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) { return fail(`Cannot read native desktop evidence manifest: ${error.message}`); }
  const item = manifest?.gates?.["native-extension-parity"];
  if (!item || typeof item.receipt !== "string" || !SHA256.test(item.sha256 ?? "")) return fail("native-extension-parity: missing receipt or receipt digest");
  const manifestDir = resolve(dirname(manifestPath));
  let canonicalManifestDir;
  try { canonicalManifestDir = await realpath(manifestDir); }
  catch (error) { return fail(`Cannot resolve native desktop evidence directory: ${error.message}`); }
  const wrapperPath = resolve(manifestDir, item.receipt);
  const wrapperRelative = relativePath(manifestDir, wrapperPath);
  if (!wrapperRelative || wrapperRelative === ".." || wrapperRelative.startsWith(`..${sep}`) || isAbsolute(wrapperRelative)) {
    return fail("native-extension-parity: receipt path escapes the evidence directory");
  }
  let wrapper;
  try {
    const stat = await lstat(wrapperPath);
    if (!stat.isFile() || stat.size > MAX_RECEIPT_BYTES) throw new Error("receipt is not a regular file or exceeds the size limit");
    const canonicalWrapperPath = await realpath(wrapperPath);
    if (!isContainedPath(canonicalManifestDir, canonicalWrapperPath)) throw new Error("receipt parent path escapes the evidence directory through a symlink");
    const bytes = await readFile(canonicalWrapperPath);
    if (digest().update(bytes).digest("hex") !== item.sha256) throw new Error("receipt digest mismatch");
    wrapper = JSON.parse(bytes.toString("utf8"));
  } catch (error) { return fail(`native-extension-parity: ${error.message}`); }
  if (wrapper?.version !== 1 || wrapper.gate !== "native-extension-parity" || wrapper.candidateSha256 !== candidateSha256 ||
      wrapper.result !== "passed" || !Array.isArray(wrapper.artifacts)) {
    return fail("native-extension-parity: wrapper receipt is invalid or for a different candidate");
  }
  const desktopArtifacts = wrapper.artifacts.filter(artifact => artifact?.kind === "native-chromium-desktop-receipt");
  if (desktopArtifacts.length !== 1) return fail("native-extension-parity: expected exactly one native Chromium desktop receipt artifact");
  const artifact = desktopArtifacts[0];
  if (typeof artifact.path !== "string" || !artifact.path || isAbsolute(artifact.path) || !SHA256.test(artifact.sha256 ?? "")) {
    return fail("native-extension-parity: invalid native desktop receipt artifact path or digest");
  }
  const desktopPath = resolve(dirname(wrapperPath), artifact.path);
  const desktopRelative = relativePath(dirname(wrapperPath), desktopPath);
  if (!desktopRelative || desktopRelative === ".." || desktopRelative.startsWith(`..${sep}`) || isAbsolute(desktopRelative)) {
    return fail("native-extension-parity: desktop receipt artifact path escapes its receipt directory");
  }
  let desktop;
  try {
    const stat = await lstat(desktopPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_NATIVE_DESKTOP_RECEIPT_BYTES) throw new Error("desktop receipt artifact is not a regular file or exceeds the size limit");
    const canonicalWrapperDir = await realpath(dirname(wrapperPath));
    const canonicalDesktopPath = await realpath(desktopPath);
    if (!isContainedPath(canonicalWrapperDir, canonicalDesktopPath)) throw new Error("desktop receipt artifact parent path escapes its receipt directory through a symlink");
    const bytes = await readFile(canonicalDesktopPath);
    if (digest().update(bytes).digest("hex") !== artifact.sha256) throw new Error("desktop receipt artifact digest mismatch");
    desktop = JSON.parse(bytes.toString("utf8"));
  } catch (error) { return fail(`native-extension-parity: ${error.message}`); }
  if (desktop?.kind !== "native-chromium-desktop-receipt" || desktop?.candidateSha256 !== candidateSha256 || desktop?.storeRequested !== true || desktop?.extensionParityRequired !== true ||
      desktop.failed !== undefined || desktop.awaitingNativeInstall === true || desktop.awaitingExtensionId !== undefined) {
    return fail("native-extension-parity: desktop receipt is not a Store parity run for this exact candidate");
  }
  const parity = desktop.extensionParity;
  const requiredChecks = ["storeInstall", "extensionCreatedTabs", "toolbarActionPopup", "chromeManagerDisableReenable", "storePersistence", "storeVersionUpgrade"];
  if (!parity || requiredChecks.some(check => parity.checks?.[check] !== true)) {
    const missing = requiredChecks.filter(check => parity?.checks?.[check] !== true);
    problems.push(`native-extension-parity: required Chromium Store checks are incomplete (${missing.join(", ") || "invalid checks"})`);
  }
  if (parity?.passed !== true || !Array.isArray(parity.missing) || parity.missing.length !== 0) {
    problems.push("native-extension-parity: desktop parity receipt is not a clean passed result");
  }
  const contentExtension = parity?.extensions?.content;
  const actionExtension = parity?.extensions?.action;
  if (contentExtension?.id !== JSON_FORMATTER_STORE_ID || contentExtension.storeInstalled !== true ||
      actionExtension?.id !== UBLOCK_ORIGIN_LITE_STORE_ID || actionExtension.storeInstalled !== true) {
    problems.push("native-extension-parity: both expected official Store extensions must be installed and identified");
  }
  const tabEvidence = parity?.extensionCreatedTabEvidence;
  if (tabEvidence?.extensionId !== UBLOCK_ORIGIN_LITE_STORE_ID || !tabEvidence || tabEvidence.created !== true || tabEvidence.adoptedByKestrel !== true || tabEvidence.sameWindow !== true ||
      tabEvidence.updated !== true || tabEvidence.updateAdopted !== true || tabEvidence.removedFromKestrel !== true ||
      !Number.isSafeInteger(tabEvidence.chromeWindowId)) {
    problems.push("native-extension-parity: action-extension tab ownership evidence is incomplete");
  }
  const popup = parity?.toolbarActionPopupEvidence?.popup;
  if (parity?.toolbarActionPopupEvidence?.actionResult?.ok !== true || popup?.observed !== true || popup.isolated !== true ||
      typeof popup.url !== "string" || !popup.url.startsWith(`chrome-extension://${UBLOCK_ORIGIN_LITE_STORE_ID}/`)) {
    problems.push("native-extension-parity: isolated action popup evidence is incomplete or belongs to another extension");
  }
  const manager = parity?.chromeManagerEvidence;
  if (manager?.extensionId !== JSON_FORMATTER_STORE_ID || !manager || manager.disabledVisibleInKestrel !== true ||
      manager.disabledRuntimeInactive !== true || manager.reenabledVisibleInKestrel !== true || manager.runtimeRestored !== true) {
    problems.push("native-extension-parity: extension manager disable and re-enable evidence is incomplete");
  }
  const restart = parity?.restartEvidence;
  if (!restart || restart.extensionId !== JSON_FORMATTER_STORE_ID || restart.installed !== true || restart.enabled !== true || restart.functionalAfterRestart !== true ||
      typeof restart.version !== "string" || !restart.version || restart.version !== contentExtension?.version) {
    problems.push("native-extension-parity: JSON Formatter persistence and functional restart evidence is incomplete");
  }
  const actionRestart = restart?.actionExtension;
  if (!actionRestart || actionRestart.id !== UBLOCK_ORIGIN_LITE_STORE_ID || actionRestart.enabled !== true ||
      typeof actionRestart.version !== "string" || !actionRestart.version) {
    problems.push("native-extension-parity: uBlock Origin Lite persistence and enabled restart evidence is incomplete");
  }
  const actionRestartPhase = (desktop.phases ?? []).find(phase => phase?.phase === "native-extension-restart");
  if (actionRestartPhase?.passed !== true || actionRestartPhase.actionExtension?.id !== UBLOCK_ORIGIN_LITE_STORE_ID ||
      actionRestartPhase.actionExtension.enabled !== true || actionRestartPhase.actionExtension.version !== actionRestart?.version) {
    problems.push("native-extension-parity: uBlock Origin Lite restart phase evidence is missing or inconsistent");
  }
  const durableRestart = (desktop.phases ?? []).find(phase => phase?.phase === "durable-core-and-clean-restart");
  if (durableRestart?.passed !== true) problems.push("native-extension-parity: durable Core and clean restart phase is missing or failed");
  const requiredFunctionalPhases = ["native-extension-functional", "native-extension-functional-after-chrome-manager-toggle", "native-extension-functional-after-restart"];
  for (const phaseName of requiredFunctionalPhases) {
    if (!(desktop.phases ?? []).some(phase => phase?.phase === phaseName && phase.passed === true)) {
      problems.push(`native-extension-parity: missing successful ${phaseName} phase`);
    }
  }
  const finalPhase = [...(desktop.phases ?? [])].reverse().find(phase => phase?.phase === "native-chromium-extension-parity-final");
  if (!finalPhase || finalPhase.passed !== true || requiredChecks.some(check => finalPhase.checks?.[check] !== true)) {
    problems.push("native-extension-parity: final post-restart parity phase is missing or incomplete");
  }
  const update = parity?.updateCheck;
  if (update?.status === "no_update") {
    if (update.extensionId !== UBLOCK_ORIGIN_LITE_STORE_ID || typeof update.installedVersionBefore !== "string" || update.installedVersionAfter !== update.installedVersionBefore ||
        (update.reportedVersion != null && update.reportedVersion !== update.installedVersionBefore) ||
        actionExtension?.version !== update.installedVersionBefore || actionRestart?.version !== update.installedVersionAfter) {
      problems.push("native-extension-parity: malformed no_update result; installed version must remain unchanged");
    } else {
      problems.push("native-extension-parity: no_update confirms the installed version but does not prove a published version upgrade");
    }
  } else if (update?.status === "update_available") {
    if (update.extensionId !== UBLOCK_ORIGIN_LITE_STORE_ID || typeof update.installedVersionBefore !== "string" || typeof update.reportedVersion !== "string" ||
        !update.reportedVersion || update.reportedVersion === update.installedVersionBefore || actionExtension?.version !== update.installedVersionBefore ||
        update.installedVersionAfter !== update.reportedVersion || update.observedVersionUpgrade !== true || parity?.checks?.storeVersionUpgrade !== true ||
        actionRestart?.version !== update.installedVersionAfter || actionRestart?.enabled !== true) {
      problems.push("native-extension-parity: update_available did not produce an observed installed version transition to the reported version");
    }
  } else {
    problems.push(`native-extension-parity: update check is inconclusive or failed (status=${String(update?.status ?? "missing")})`);
  }
  return { candidateSha256, problems };
}
