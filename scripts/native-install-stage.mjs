#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateNativePreCutoverEvidence, validateNativeExtensionParityEvidence } from "./native-retirement-evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stagedBundle = process.argv[2] ? resolve(process.argv[2]) : undefined;
const manifestPath = process.env.KESTREL_NATIVE_RETIREMENT_EVIDENCE;

if (!stagedBundle || !manifestPath) {
  console.error("Staged native validation requires a bundle and candidate-bound evidence manifest.");
  process.exit(1);
}

const evidence = await validateNativePreCutoverEvidence(stagedBundle, resolve(manifestPath));
const parity = await validateNativeExtensionParityEvidence(stagedBundle, resolve(manifestPath), evidence.candidateSha256);
const problems = [...evidence.problems, ...parity.problems];
if (problems.length) {
  console.error(`Staged native bundle does not match the cutover prerequisites:\n${problems.map(problem => `- ${problem}`).join("\n")}`);
  process.exit(1);
}

// Keep the release signing check fixed and run it against the staged copy whose
// fingerprint was just verified. Do not accept a caller-selected checker.
const signing = spawnSync(process.execPath, [
  join(root, "scripts", "check-native-signing.mjs"), stagedBundle,
], { stdio: "inherit" });
if (signing.status !== 0) process.exit(signing.status ?? 1);

console.log(`Staged native bundle matches pre-cutover evidence: ${evidence.candidateSha256}. This is not canonical on-screen acceptance.`);
