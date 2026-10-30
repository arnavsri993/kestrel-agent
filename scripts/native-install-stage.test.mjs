import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { candidateDigest } from "./native-retirement-evidence.mjs";

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it("rejects a staged bundle whose fingerprint differs from the evidence manifest before signing", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-native-stage-test-"));
  roots.push(root);
  const staged = join(root, "Kestrel.app");
  await mkdir(join(staged, "Contents", "MacOS"), { recursive: true });
  await writeFile(join(staged, "Contents", "MacOS", "Kestrel"), "staged executable");
  const manifestPath = join(root, "evidence.json");
  await writeFile(manifestPath, JSON.stringify({
    version: 1,
    candidateSha256: "0".repeat(64),
    gates: {},
  }));

  const result = spawnSync(process.execPath, [
    resolve("scripts/native-install-stage.mjs"), staged,
  ], {
    encoding: "utf8",
    env: { ...process.env, KESTREL_NATIVE_RETIREMENT_EVIDENCE: manifestPath },
  });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("does not match the complete candidate bundle");
  expect(result.stderr).toContain("missing receipt or receipt digest");
  expect(result.stdout).not.toContain("Native Chromium signing");
  expect(await candidateDigest(staged)).not.toBe("0".repeat(64));
});
