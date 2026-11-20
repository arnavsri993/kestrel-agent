#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { candidateDigest, RETIREMENT_GATES, validateNativeExtensionParityEvidence, validateRetirementEvidence } from "./native-retirement-evidence.mjs";

const candidate = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (!candidate || !existsSync(join(candidate, "Contents/MacOS/Kestrel"))) {
  console.error("Retirement requires an explicit built Kestrel.app candidate. No app was installed.");
  process.exit(1);
}
if (process.env.KESTREL_ACCEPT_ELECTRON_RETIREMENT !== "1") {
  console.error("Explicit retirement acceptance is required separately from evidence. No app was installed.");
  process.exit(1);
}
const manifestPath = process.env.KESTREL_NATIVE_RETIREMENT_EVIDENCE;
if (!manifestPath) {
  console.error(`Set KESTREL_NATIVE_RETIREMENT_EVIDENCE to a candidate-bound evidence manifest. Acceptance is not evidence. Missing gates:\n${RETIREMENT_GATES.map(gate => `- ${gate}`).join("\n")}\nNo app was installed.`);
  process.exit(1);
}
const { candidateSha256, problems } = await validateRetirementEvidence(candidate, resolve(manifestPath));
const parity = await validateNativeExtensionParityEvidence(candidate, resolve(manifestPath), candidateSha256);
const allProblems = [...problems, ...parity.problems];
if (allProblems.length) {
  console.error(`Native retirement evidence is incomplete or invalid:\n${allProblems.map(problem => `- ${problem}`).join("\n")}\nNo app was installed.`);
  process.exit(1);
}
if (await candidateDigest(candidate) !== candidateSha256) {
  console.error("Candidate changed during validation. No app was installed.");
  process.exit(1);
}
console.log("Candidate-bound retirement evidence and native Chromium desktop Store parity passed. Review the supporting evidence before cutover.");
