#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { candidateDigest, validateNativeExtensionParityEvidence, validateNativePreCutoverEvidence } from "./native-retirement-evidence.mjs";

const candidate = process.argv[2] && resolve(process.argv[2]);
if (!candidate || !existsSync(join(candidate, "Contents/MacOS/Kestrel")) ||
    process.env.KESTREL_ACCEPT_ELECTRON_RETIREMENT !== "1" || !process.env.KESTREL_NATIVE_RETIREMENT_EVIDENCE) {
  console.error("A built native candidate, explicit retirement acceptance and candidate-bound evidence are required. No app was installed.");
  process.exit(1);
}
const manifest = resolve(process.env.KESTREL_NATIVE_RETIREMENT_EVIDENCE);
const evidence = await validateNativePreCutoverEvidence(candidate, manifest);
const parity = await validateNativeExtensionParityEvidence(candidate, manifest, evidence.candidateSha256);
const problems = [...evidence.problems, ...parity.problems];
if (problems.length || await candidateDigest(candidate) !== evidence.candidateSha256) {
  console.error(`Native cutover prerequisites are incomplete or changed:\n${problems.map(item => `- ${item}`).join("\n")}\nNo app was installed.`);
  process.exit(1);
}
console.log("Pre-cutover prerequisites passed. Canonical on-screen verification and full retirement acceptance remain required before transaction commit.");
