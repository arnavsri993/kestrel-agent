import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { loadStoreUpdateContinuation } from "./native-store-update-continuation.mjs";

const formatter = "bcjindcccaagfpapjjmafapmmgkkhgoa", action = "ddkjiahejlhfcafbddmgiahcphecmpfh";
const candidateHash = "a".repeat(64), fixtureHash = "b".repeat(64);

describe("Store continuation accepts only private evidence for the exact pending official update", () => {
  let directory, options;
  beforeAll(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "kestrel-store-continuation-test-")));
    options = { candidate: join(directory, "Candidate.app"), candidateSha256: candidateHash,
      checkpoint: join(directory, "checkpoint.json"), fixtureReceiptSha256: fixtureHash, actionExtensionId: action };
  });
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
  function valid() {
    return { kind: "native-store-update-resume", version: 1, mode: "update-acceptance",
      candidate: options.candidate, candidateSha256: candidateHash, candidateSha256After: candidateHash,
      fixture: { checkpoint: options.checkpoint, receiptSha256: fixtureHash, originalCandidateSha256: "c".repeat(64) },
      result: "failed", failedStage: "official-update-check", updateQueryRequested: true, profileRetained: true,
      updateCheck: { status: "update_available", checkSucceeded: true, reportedVersion: "1.10.0" },
      diskVersionsBefore: { [formatter]: "1.7", [action]: "1.9.9" },
      initial: { [formatter]: { id: formatter, version: "1.7", enabled: true, installType: "normal" },
        [action]: { id: action, version: "1.9.9", enabled: true, installType: "normal" } },
      initialSessionCount: 3, phases: [], actionDocumentUsed: true };
  }
  let sequence = 0;
  async function save(value = valid()) {
    const path = join(directory, `receipt-${sequence++}.json`);
    const bytes = JSON.stringify(value);
    await writeFile(path, bytes, { mode: 0o600 });
    return { path, bytes };
  }
  it("valid receipt returns only bounded evidence references and original baselines", async () => {
    const { path, bytes } = await save();
    const result = await loadStoreUpdateContinuation(path, options);
    assert.deepEqual(result, { path, sha256: createHash("sha256").update(bytes).digest("hex"),
      baselineVersions: valid().diskVersionsBefore, updateCheck: valid().updateCheck, initialSessionCount: 3 });
  });
  it("binds a production continuation to its explicit storage mode", async () => {
    const fixtureStorage = { mode: "production-vault", vaultSha256: "e".repeat(64) };
    const value = { ...valid(), fixtureStorageMode: "production-vault", fixtureStorage,
      stops: [{ exitCode: 0, signal: null, forced: false, candidateProcessesStopped: true }] };
    const { path } = await save(value);
    await assert.rejects(loadStoreUpdateContinuation(path, options));
    await loadStoreUpdateContinuation(path, { ...options, fixtureStorageMode: "production-vault", fixtureStorage });
    for (const mutate of [v => { v.fixtureStorage.vaultSha256 = "f".repeat(64); }, v => { v.stops = []; },
      v => { v.stops[0].forced = true; }, v => { v.stops[0].candidateProcessesStopped = false; }]) {
      const changed = JSON.parse(JSON.stringify(value)); mutate(changed);
      await assert.rejects(loadStoreUpdateContinuation((await save(changed)).path, { ...options, fixtureStorageMode: "production-vault", fixtureStorage }));
    }
    await assert.rejects(loadStoreUpdateContinuation((await save()).path, { ...options, fixtureStorageMode: "production-vault" }));
  });
  const mutations = {
    "wrong kind": value => { value.kind = "native-store-update-fixture"; },
    "wrong version": value => { value.version = "1"; },
    "unknown storage mode": value => { value.fixtureStorageMode = "unknown"; },
    "changed fixture storage": value => { value.fixtureStorageChanged = true; },
    "failed shutdown": value => { value.shutdownFailed = true; },
    "compatibility-only": value => { value.mode = "compatibility-only"; },
    "different candidate path": value => { value.candidate += "-different"; },
    "different candidate hash": value => { value.candidateSha256 = "d".repeat(64); },
    "changed final candidate hash": value => { value.candidateSha256After = "d".repeat(64); },
    "missing final candidate hash": value => { delete value.candidateSha256After; },
    "candidate change marker": value => { value.candidateChanged = true; },
    "false candidate change marker": value => { value.candidateChanged = false; },
    "different checkpoint": value => { value.fixture.checkpoint += ".other"; },
    "different fixture receipt hash": value => { value.fixture.receiptSha256 = "d".repeat(64); },
    "missing fixture": value => { delete value.fixture; },
    "successful receipt": value => { value.result = "passed"; },
    "different failure stage": value => { value.failedStage = "official-update-check-result"; },
    "query never requested": value => { value.updateQueryRequested = false; },
    "profile not retained": value => { value.profileRetained = false; },
    "no update": value => { value.updateCheck.status = "no_update"; },
    "query timed out": value => { value.updateCheck.status = "timeout"; },
    "query failed": value => { value.updateCheck.checkSucceeded = false; },
    "missing update version": value => { delete value.updateCheck.reportedVersion; },
    "same update version": value => { value.updateCheck.reportedVersion = "1.9.9"; },
    "older update version": value => { value.updateCheck.reportedVersion = "1.9.8"; },
    "lexically newer but numerically older": value => { value.updateCheck.reportedVersion = "1.9.10"; value.diskVersionsBefore[action] = value.initial[action].version = "1.10"; },
    "equivalent trailing-zero version": value => { value.updateCheck.reportedVersion = "1.9.9.0"; },
    "nonnormalized update version": value => { value.updateCheck.reportedVersion = "01.10"; },
    "out-of-range update version": value => { value.updateCheck.reportedVersion = "65536"; },
    "too many update components": value => { value.updateCheck.reportedVersion = "2.0.0.0.0"; },
    "nonnormalized disk version": value => { value.diskVersionsBefore[formatter] = value.initial[formatter].version = "01.7"; },
    "zero disk version": value => { value.diskVersionsBefore[formatter] = value.initial[formatter].version = "0.0"; },
    "missing baseline extension": value => { delete value.diskVersionsBefore[formatter]; },
    "unknown baseline extension": value => { value.diskVersionsBefore.unknown = "1"; },
    "missing initial provenance": value => { delete value.initial; },
    "missing initial extension": value => { delete value.initial[formatter]; },
    "wrong provenance identity": value => { value.initial[action].id = formatter; },
    "disabled extension": value => { value.initial[action].enabled = false; },
    "unpacked action extension": value => { value.initial[action].installType = "development"; },
    "unpacked formatter extension": value => { value.initial[formatter].installType = "development"; },
    "initial version differs from disk": value => { value.initial[action].version = "1.9.8"; },
    "missing session count": value => { delete value.initialSessionCount; },
    "negative session count": value => { value.initialSessionCount = -1; },
    "fractional session count": value => { value.initialSessionCount = 0.5; },
    "recursive continuation": value => { value.continuation = { path: "prior.json" }; },
    "nested continuation": value => { value.fixture.continuationReceipt = "prior.json"; },
  };
  it.each(Object.entries(mutations))("rejects %s", async (_name, mutate) => {
    const value = valid(); mutate(value);
    await assert.rejects(loadStoreUpdateContinuation((await save(value)).path, options));
  });
  it("invalid caller identities cannot authorize a receipt", async () => {
    const { path } = await save();
    for (const replacement of [{ actionExtensionId: formatter }, { candidateSha256: "A".repeat(64) },
      { fixtureReceiptSha256: "bad" }, { candidate: "relative.app" }, { checkpoint: "checkpoint.json" },
      { checkpoint: path }]) await assert.rejects(loadStoreUpdateContinuation(path, { ...options, ...replacement }));
  });
  it("malformed and non-object JSON fail closed", async () => {
    for (const value of [null, [], "receipt", 1]) await assert.rejects(loadStoreUpdateContinuation((await save(value)).path, options));
    const { path } = await save(); await writeFile(path, "{");
    await assert.rejects(loadStoreUpdateContinuation(path, options));
    await writeFile(path, Buffer.from([0xff]));
    await assert.rejects(loadStoreUpdateContinuation(path, options));
  });
  it("public files, symbolic links, ancestor symbolic links, hard links, and directories are rejected", async () => {
    const publicFile = await save(); await chmod(publicFile.path, 0o640);
    await assert.rejects(loadStoreUpdateContinuation(publicFile.path, options));
    const source = await save(), symbolic = join(directory, "symlink.json"), hard = join(directory, "hardlink.json");
    await symlink(source.path, symbolic);
    await assert.rejects(loadStoreUpdateContinuation(symbolic, options));
    const ancestor = join(directory, "alias"); await symlink(directory, ancestor);
    await assert.rejects(loadStoreUpdateContinuation(join(ancestor, source.path.split("/").at(-1)), options));
    await link(source.path, hard);
    await assert.rejects(loadStoreUpdateContinuation(hard, options));
    await assert.rejects(loadStoreUpdateContinuation(source.path, options));
    await assert.rejects(loadStoreUpdateContinuation(directory, options));
  });
  it("empty, oversized, and absent receipts are rejected", async () => {
    const { path } = await save();
    await writeFile(path, ""); await assert.rejects(loadStoreUpdateContinuation(path, options));
    await writeFile(path, Buffer.alloc(128 * 1024 + 1, " ")); await assert.rejects(loadStoreUpdateContinuation(path, options));
    await assert.rejects(loadStoreUpdateContinuation(join(directory, "absent.json"), options));
  });
});
