import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:child_process", async importOriginal => ({
 ...(await importOriginal()),
 execFileSync: vi.fn(() => " 1 /sbin/launchd\n"),
}));
vi.mock("./native-vault-canary-candidate.mjs", () => ({
 validateVaultCanaryCandidate: vi.fn(async candidate => ({ candidate })),
}));
import { validateVaultCanaryCandidate } from "./native-vault-canary-candidate.mjs";
import { execFileSync } from "node:child_process";
import { selectNativeBrowserFixtureStorage, prepareNativeBrowserFixtureProfile, nativeBrowserFixtureStorageArgs,
 nativeBrowserFixtureStorageEnv, captureNativeBrowserFixtureStorage, validateRetainedNativeBrowserFixtureStorage,
 assertNativeBrowserFixtureStopped } from "./native-browser-fixture-storage.mjs";

const magic = Buffer.from([0x4b,0x53,0x54,0x56,0x4c,0x54,1,0,1,2,3]);
let candidate, profile, cleanup = [], previous;
beforeEach(async () => {
 previous = process.env.KESTREL_TEST_NATIVE_LOCAL_VAULT;
 process.env.KESTREL_TEST_NATIVE_LOCAL_VAULT = "1";
 candidate = await realpath(await mkdtemp(join(tmpdir(), "fixture-candidate-")));
 profile = await realpath(await mkdtemp(join(tmpdir(), "kestrel-chromium-desktop-canary-")));
 cleanup.push(candidate, profile);
 await writeFile(join(candidate, "binary"), "candidate");
 vi.mocked(validateVaultCanaryCandidate).mockClear();
 vi.mocked(execFileSync).mockReset().mockReturnValue(" 1 /sbin/launchd\n");
});
afterEach(async () => {
 if (previous === undefined) delete process.env.KESTREL_TEST_NATIVE_LOCAL_VAULT;
 else process.env.KESTREL_TEST_NATIVE_LOCAL_VAULT = previous;
 await Promise.all(cleanup.map(path => rm(path, { recursive: true, force: true })));
 cleanup = [];
});
async function fixture() {
 const storage = await selectNativeBrowserFixtureStorage({candidate, root: candidate});
 await prepareNativeBrowserFixtureProfile({profile, storage});
 expect(await readdir(profile)).toEqual([]);
 await writeFile(join(profile, ".kestrel-local-vault-v1"), magic, {mode: 0o600});
 const evidence = await captureNativeBrowserFixtureStorage({profile, storage});
 return { storage, evidence, candidate, candidateSha256: storage.candidateSha256, root: candidate, profile };
}
describe("generated native browser fixture storage", () => {
 it("captures and revalidates production vault evidence without creating a test key", async () => {
  const f = await fixture();
  expect(nativeBrowserFixtureStorageArgs(f.storage)).toEqual([]);
  expect(nativeBrowserFixtureStorageEnv(f.storage)).toMatchObject({ KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1", KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1" });
  expect(await validateRetainedNativeBrowserFixtureStorage(f)).toBe(profile);
  delete process.env.KESTREL_TEST_NATIVE_LOCAL_VAULT;
  expect(await validateRetainedNativeBrowserFixtureStorage(f)).toBe(profile);
  expect(vi.mocked(validateVaultCanaryCandidate)).toHaveBeenCalled();
 });
 it("rejects a replacement directory at the same profile path", async () => {
  const f = await fixture(), moved = `${profile}-original`;
  cleanup.push(moved);
  await rename(profile, moved);
  await mkdir(profile, { mode: 0o700 });
  await writeFile(join(profile, ".kestrel-local-vault-v1"), magic, { mode: 0o600 });
  await expect(validateRetainedNativeBrowserFixtureStorage(f)).rejects.toThrow();
 });
 it("preflights before touching the profile", async () => {
  vi.mocked(validateVaultCanaryCandidate).mockRejectedValueOnce(Error("bad candidate"));
  await expect(selectNativeBrowserFixtureStorage({candidate,root:candidate})).rejects.toThrow("bad candidate");
  expect(await readdir(profile)).toEqual([]);
 });
 it("refuses running main or helper processes before capture and resume", async () => {
  const f = await fixture();
  for (const suffix of ["Contents/MacOS/Kestrel", "Contents/Frameworks/Kestrel Helper.app/Contents/MacOS/Kestrel Helper"]) {
   vi.mocked(execFileSync).mockReturnValue(` 123 ${candidate}/${suffix}\n`);
   expect(() => assertNativeBrowserFixtureStopped(f.storage)).toThrow("process is still running");
   await expect(captureNativeBrowserFixtureStorage(f)).rejects.toThrow("process is still running");
   await expect(validateRetainedNativeBrowserFixtureStorage(f)).rejects.toThrow("process is still running");
  }
  vi.mocked(execFileSync).mockReturnValue(` 123 ${candidate}-other/Contents/MacOS/Kestrel\n`);
  expect(() => assertNativeBrowserFixtureStopped(f.storage)).not.toThrow();
  vi.mocked(execFileSync).mockImplementation(() => { throw Error("process inventory unavailable"); });
  expect(() => assertNativeBrowserFixtureStopped(f.storage)).toThrow("process inventory unavailable");
 });
 it("rejects changed candidate and vault", async () => {
  const f = await fixture();
  await writeFile(join(profile, ".kestrel-local-vault-v1"), Buffer.concat([magic, Buffer.from([4])]));
  await expect(validateRetainedNativeBrowserFixtureStorage(f)).rejects.toThrow("vault changed");
  await writeFile(join(profile, ".kestrel-local-vault-v1"), magic);
  await writeFile(join(candidate, "binary"), "replacement");
  await expect(validateRetainedNativeBrowserFixtureStorage(f)).rejects.toThrow("candidate changed");
 });
 it("rejects raw keys, broad permissions, hard links and symlinked vaults", async () => {
  const f = await fixture(), vault = join(profile, ".kestrel-local-vault-v1");
  const substitute = { ...f.evidence, mode: "test-key" }; delete substitute.vaultSha256;
  await expect(validateRetainedNativeBrowserFixtureStorage({ ...f, evidence: substitute })).rejects.toThrow();
  await writeFile(join(profile, ".kestrel-native-test-core-key-v1"), "raw");
  await expect(validateRetainedNativeBrowserFixtureStorage(f)).rejects.toThrow("raw test key");
  await rm(join(profile, ".kestrel-native-test-core-key-v1"));
  await chmod(vault, 0o644);
  await expect(validateRetainedNativeBrowserFixtureStorage(f)).rejects.toThrow("private regular file");
  await chmod(vault, 0o600);
  const hard = join(profile, "hardlink"); await link(vault, hard);
  await expect(validateRetainedNativeBrowserFixtureStorage(f)).rejects.toThrow("private regular file");
  await rm(hard); const moved = join(profile, "other"); await rm(vault); await writeFile(moved, magic, {mode:0o600}); await symlink(moved, vault);
  await expect(validateRetainedNativeBrowserFixtureStorage(f)).rejects.toThrow("aliased");
 });
 it("rejects nonempty, aliased and insecure profiles", async () => {
  const storage = await selectNativeBrowserFixtureStorage({candidate, root:candidate});
  await writeFile(join(profile, "existing"), "x");
  await expect(prepareNativeBrowserFixtureProfile({profile,storage})).rejects.toThrow("start empty");
  await rm(join(profile, "existing")); await chmod(profile,0o755);
  await expect(prepareNativeBrowserFixtureProfile({profile,storage})).rejects.toThrow("private directory");
  await chmod(profile,0o700);
  const alias = join(tmpdir(), `fixture-alias-${process.pid}`); cleanup.push(alias); await symlink(profile,alias);
  await expect(prepareNativeBrowserFixtureProfile({profile:alias,storage})).rejects.toThrow();
 });
 it("keeps the existing test-key marker behavior by default", async () => {
  delete process.env.KESTREL_TEST_NATIVE_LOCAL_VAULT;
  const storage = await selectNativeBrowserFixtureStorage({candidate,root:candidate});
  await prepareNativeBrowserFixtureProfile({profile,storage});
  expect(nativeBrowserFixtureStorageArgs(storage)).toEqual(["--kestrel-test-profile-key"]);
  expect(await readFile(join(profile,".kestrel-native-test-profile-v1"),"utf8")).toBe("native-test-profile-v1\n");
  const evidence = await captureNativeBrowserFixtureStorage({profile,storage});
  expect(await validateRetainedNativeBrowserFixtureStorage({profile,candidate,candidateSha256:storage.candidateSha256,evidence,root:candidate})).toBe(profile);
  const substitute = { ...evidence, mode: "production-vault", vaultSha256: "a".repeat(64) };
  await expect(validateRetainedNativeBrowserFixtureStorage({profile,candidate,candidateSha256:storage.candidateSha256,evidence:substitute,root:candidate})).rejects.toThrow("raw test key");
 });
});
