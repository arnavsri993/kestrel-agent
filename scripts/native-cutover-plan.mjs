#!/usr/bin/env node
// Read-only planning only. This does not authorize, stage, install or roll back.
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { candidateDigest, validateNativeExtensionParityEvidence, validateNativePreCutoverEvidence, validateRetirementEvidence } from "./native-retirement-evidence.mjs";

const POST_GATE = "canonical-dock-app-on-screen";

export async function createNativeCutoverPlan({ candidate, target, manifestPath }) {
  if (![candidate, target, manifestPath].every(value => typeof value === "string" && isAbsolute(value))) {
    throw new Error("Candidate, target, and evidence manifest must be absolute paths.");
  }
  const targetInfo = await lstat(target);
  if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) throw new Error("Target must be an existing non-symlink app directory.");
  const candidatePath = await realpath(candidate);
  const targetPath = await realpath(target);
  if (candidatePath === targetPath) throw new Error("Candidate and installed target must be separate app bundles.");
  const [candidateSha256, previousSha256, evidence] = await Promise.all([
    candidateDigest(candidatePath), candidateDigest(targetPath), validateRetirementEvidence(candidatePath, manifestPath),
  ]);
  if (candidateSha256 !== evidence.candidateSha256) throw new Error("Candidate changed while preparing the plan.");
  const parity = await validateNativeExtensionParityEvidence(candidatePath, manifestPath, candidateSha256);
  const prerequisites = await validateNativePreCutoverEvidence(candidatePath, manifestPath);
  const preCutoverProblems = [...prerequisites.problems, ...parity.problems];
  const postCutoverEvidenceProblems = evidence.problems.filter(problem => problem.startsWith(`${POST_GATE}:`));
  const backup = join(dirname(targetPath), ".Kestrel-cutover-backups");
  let backupExists = false;
  try {
    const info = await lstat(backup); backupExists = true;
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700)
      preCutoverProblems.push("Retained-bundle recovery directory is not an owned private directory.");
  }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (await candidateDigest(candidatePath) !== candidateSha256 || await candidateDigest(targetPath) !== previousSha256)
    throw new Error("Candidate or installed app changed while preparing the plan.");
  return {
    version: 2,
    kind: "read-only-native-cutover-plan",
    candidate: { path: candidatePath, sha256: candidateSha256 },
    target: { path: targetPath, sha256: previousSha256 },
    backup: { root: backup, alreadyExists: backupExists, pathTemplate: join(backup, "<transaction UUID>", "previous", "Kestrel.app"), allocatedExclusivelyDuringApply: true },
    preCutover: {
      evidenceComplete: preCutoverProblems.length === 0,
      evidenceProblems: preCutoverProblems,
      required: [
        "Review every pre-cutover receipt and supporting artifact; hashes and status fields are attestations, not proof of behavior.",
        "Pass live signing and notarization checks and exact-candidate extension parity; confirm explicit retirement and cutover acceptance.",
        "Complete an explicitly approved, tested profile transfer and rollback; preserve existing profiles, credentials, and provider logins.",
        "Pass every pre-cutover gate. Only absent canonical on-screen evidence stays pending until the candidate is installed within the recoverable transaction.",
        "Recheck candidate and installed target, then allocate a new private recovery transaction without overwriting an existing backup.",
        "Use an owned, private backup directory on the target volume; never overwrite an existing backup, unrelated app, or profile.",
        "Stage and validate the signed candidate, preserve the exact previous app in that backup, then atomically replace the canonical app with recoverable failure handling.",
      ],
    },
    postCutover: {
      gate: POST_GATE,
      evidenceProblems: postCutoverEvidenceProblems,
      required: [
        "Verify installed bundle identity and signing against the candidate, then open the canonical Dock app and visibly exercise its real Kestrel workflow.",
        "Record fresh on-screen observations bound to this transaction, close only the test-owned app, and pass the full retirement validator before committing installation.",
        "Record candidate-bound on-screen evidence only after the installed app passes; retain the previous app backup until verification and explicit recovery decision.",
        "If install or verification fails, stop and restore the exact prior app from the owned backup; do not overwrite user profiles or credentials.",
        "Verify the restored app and its bundle fingerprint; report any incomplete rollback rather than claiming success.",
      ],
    },
    limitations: [
      "This plan performs no mutation and does not certify evidence, signing, live tests, free space, permissions, or rollback readiness.",
      "The installer requires all other retirement gates before replacement, then waits for transaction-bound canonical evidence and the complete retirement check before committing. Static validation alone cannot commit.",
      "The installer retains the previous bundle and a recovery journal; explicit rollback requires its private transaction.json path and KESTREL_ROLLBACK_NATIVE_CANONICAL=1.",
      "The shared loopback guard coordinates participating installers only. Process and path checks are snapshots; independent launches or filesystem writers are not atomically excluded.",
      "Bundle fingerprints cover paths, types, modes, file bytes and link targets; they do not attest ACLs, extended attributes, ownership or timestamps.",
    ],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const candidate = process.argv[2];
  const manifestPath = process.argv[3];
  if (!candidate || !manifestPath) {
    console.error("Usage: node scripts/native-cutover-plan.mjs /absolute/path/Kestrel.app /absolute/path/evidence.json");
    process.exitCode = 1;
  } else {
    try {
      const plan = await createNativeCutoverPlan({ candidate, manifestPath, target: "/Applications/Kestrel.app" });
      console.log(JSON.stringify(plan, null, 2));
    } catch (error) { console.error(`Cannot prepare a read-only plan: ${error.message}`); process.exitCode = 1; }
  }
}
