#!/usr/bin/env node
// Read-only planning only. This does not authorize, stage, install or roll back.
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { candidateDigest, validateRetirementEvidence } from "./native-retirement-evidence.mjs";

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
  const postPrefix = `${POST_GATE}:`;
  const preCutoverProblems = evidence.problems.filter(problem => !problem.startsWith(postPrefix));
  const postCutoverEvidenceProblems = evidence.problems.filter(problem => problem.startsWith(postPrefix));
  const backup = join(dirname(target), ".Kestrel-cutover-backups", `${previousSha256}-${candidateSha256}`, "Kestrel.app");
  let backupExists = false;
  try { await lstat(backup); backupExists = true; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return {
    version: 1,
    kind: "read-only-native-cutover-plan",
    candidate: { path: candidatePath, sha256: candidateSha256 },
    target: { path: targetPath, sha256: previousSha256 },
    backup: { path: backup, mustNotExist: true, alreadyExists: backupExists },
    preCutover: {
      evidenceComplete: preCutoverProblems.length === 0,
      evidenceProblems: preCutoverProblems,
      required: [
        "Review every pre-cutover receipt and supporting artifact; hashes and status fields are attestations, not proof of behavior.",
        "Pass live signing and notarization checks and exact-candidate extension parity; confirm explicit retirement and cutover acceptance.",
        "Complete an explicitly approved, tested profile transfer and rollback; preserve existing profiles, credentials, and provider logins.",
        "Recheck candidate, installed target, and the absence of the reserved backup immediately before any mutation.",
        "Use an owned, private backup directory on the target volume; never overwrite an existing backup, unrelated app, or profile.",
        "Stage and validate the signed candidate, preserve the exact previous app in that backup, then atomically replace the canonical app with recoverable failure handling.",
      ],
    },
    postCutover: {
      gate: POST_GATE,
      evidenceProblems: postCutoverEvidenceProblems,
      required: [
        "Verify installed bundle identity and signing against the candidate, then open the canonical Dock app and visibly exercise its real Kestrel workflow.",
        "Record candidate-bound on-screen evidence only after the installed app passes; retain the previous app backup until verification and explicit recovery decision.",
        "If install or verification fails, stop and restore the exact prior app from the owned backup; do not overwrite user profiles or credentials.",
        "Verify the restored app and its bundle fingerprint; report any incomplete rollback rather than claiming success.",
      ],
    },
    limitations: [
      "This plan performs no mutation and does not certify evidence, signing, live tests, free space, permissions, or rollback readiness.",
      "The current installer requires post-cutover evidence before replacement and moves the previous app to Trash; it does not implement this staged recovery protocol.",
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
