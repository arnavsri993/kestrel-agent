#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { candidateDigest, RETIREMENT_GATES, validateRetirementEvidence } from "./native-retirement-evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
if (problems.length) {
  console.error(`Native retirement evidence is incomplete or invalid:\n${problems.map(problem => `- ${problem}`).join("\n")}\nNo app was installed.`);
  process.exit(1);
}
// Evidence supplements, never replaces, the exact-candidate parity check.
const parity = spawnSync(process.execPath, [
  join(root, "scripts/smoke-native-user-extensions.mjs"), "--require-extension-parity",
], { cwd: root, stdio: "inherit", timeout: 120_000, env: { ...process.env, KESTREL_NATIVE_TEST_APP: candidate } });
if (parity.status !== 0) {
  console.error("Native Chrome extension parity has not passed. No app was installed.");
  process.exit(parity.status ?? 1);
}
if (await candidateDigest(candidate) !== candidateSha256) {
  console.error("Candidate changed during validation. No app was installed.");
  process.exit(1);
}
console.log("Candidate-bound retirement evidence and live extension parity passed. Review the supporting evidence before cutover.");
