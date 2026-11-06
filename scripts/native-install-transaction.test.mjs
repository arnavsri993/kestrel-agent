import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { cp, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { candidateDigest } from "./native-retirement-evidence.mjs";
import { installNativeBundleTransaction, rollbackNativeBundleTransaction, withNativeInstallLock } from "./native-install-transaction.mjs";

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-install-transaction-"))); roots.push(root);
  const source = join(root, "source", "Kestrel.app"), target = join(root, "installed", "Kestrel.app");
  for (const [path, content] of [[source, "candidate"], [target, "previous"]]) {
    await mkdir(join(path, "Contents"), { recursive: true });
    await writeFile(join(path, "Contents", "fixture"), content);
  }
  const expectedCandidateSha256 = await candidateDigest(source), previous = await candidateDigest(target);
  const options = { source, target, expectedCandidateSha256, copy: (from, to) => cp(from, to, { recursive: true, verbatimSymlinks: true }), validate: vi.fn(async () => {}), beforeReplace: vi.fn(async () => {}), register: vi.fn(async () => {}) };
  return { root, source, target, previous, options };
}
async function change(path) { await writeFile(join(path, "Contents", "fixture"), "changed"); }
async function journalFor(f) {
  const base = join(dirname(f.target), ".Kestrel-cutover-backups");
  return join(base, (await readdir(base)).find(name => name !== ".metadata_never_index"), "transaction.json");
}
async function recoveryOptions(f, result) { return { transactionPath: result.transactionPath, target: f.target, beforeReplace: vi.fn(async () => {}), register: vi.fn(async () => {}) }; }

it("stages and validates twice, installs the candidate, and retains exact private backup and durable journal", async () => {
  const f = await fixture(), result = await installNativeBundleTransaction(f.options);
  expect(result.destination).toBe(f.target);
  expect(await candidateDigest(f.target)).toBe(f.options.expectedCandidateSha256);
  expect(await candidateDigest(result.backupPath)).toBe(f.previous);
  for (const path of [dirname(result.transactionPath), dirname(dirname(result.transactionPath))]) {
    const marker = await lstat(join(path, ".metadata_never_index"));
    expect(marker.isFile()).toBe(true); expect(marker.mode & 0o777).toBe(0o600);
  }
  expect(f.options.validate).toHaveBeenCalledTimes(2);
  expect(f.options.register).toHaveBeenCalledWith(f.target);
  expect((await lstat(dirname(result.transactionPath))).mode & 0o777).toBe(0o700);
  expect((await lstat(result.transactionPath)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(result.transactionPath, "utf8"))).toMatchObject({ version: 1, source: f.source, target: f.target, candidateSha256: f.options.expectedCandidateSha256, previousSha256: f.previous, state: "committed" });
});
it.each(["copy", "copied-hash", "staged-validation", "source-change", "target-change", "stage-change", "running-check"])("preserves previous target on %s before replacement", async mode => {
  const f = await fixture();
  if (mode === "copy") f.options.copy = async () => { throw new Error("copy failed"); };
  if (mode === "copied-hash") { const copy = f.options.copy; f.options.copy = async (a, b) => { await copy(a, b); await change(b); }; }
  if (mode === "staged-validation") f.options.validate = async () => { throw new Error("validation failed"); };
  if (mode === "source-change") f.options.beforeReplace = () => change(f.source);
  if (mode === "target-change") f.options.beforeReplace = () => change(f.target);
  if (mode === "stage-change") f.options.validate = path => change(path);
  if (mode === "running-check") f.options.beforeReplace = async () => { throw new Error("running"); };
  await expect(installNativeBundleTransaction(f.options)).rejects.toThrow(/recovery journal:/);
  if (mode !== "target-change") expect(await candidateDigest(f.target)).toBe(f.previous);
  if (mode === "target-change") expect(await readFile(join(f.target, "Contents", "fixture"), "utf8")).toBe("changed");
});
it("rejects unapproved candidate hashes and missing trusted callbacks", async () => {
  const f = await fixture();
  await expect(installNativeBundleTransaction({ ...f.options, expectedCandidateSha256: "0".repeat(64) })).rejects.toThrow(/expected SHA/);
  await expect(installNativeBundleTransaction({ ...f.options, validate: undefined })).rejects.toThrow(/Trusted validate/);
  expect(await candidateDigest(f.target)).toBe(f.previous);
});
it.each(["adoption", "installed-validation", "register"])("recovers the exact previous bundle after %s fails, retaining the candidate", async mode => {
  const f = await fixture();
  if (mode === "adoption") f.options.ops = { rename: async (a, b) => { if (a.includes("/stage/Kestrel.app")) throw new Error("adoption failed"); await rename(a, b); } };
  if (mode === "installed-validation") f.options.validate = async path => { if (path === f.target) throw new Error("installed check failed"); };
  if (mode === "register") f.options.register = vi.fn().mockRejectedValueOnce(new Error("register failed")).mockResolvedValue(undefined);
  await expect(installNativeBundleTransaction(f.options)).rejects.toThrow(/failed.*recovery journal:/);
  expect(await candidateDigest(f.target)).toBe(f.previous);
  const transactionPath = await journalFor(f), journal = JSON.parse(await readFile(transactionPath, "utf8"));
  expect(journal.state).toBe("rolled-back");
  const retained = join(dirname(transactionPath), mode === "adoption" ? "stage" : "candidate", "Kestrel.app");
  expect(await candidateDigest(retained)).toBe(f.options.expectedCandidateSha256);
});
it("refuses automatic restore when installed validation changed the candidate and exposes original failure", async () => {
  const f = await fixture();
  f.options.validate = async path => { if (path === f.target) { await change(path); throw new Error("original check failed"); } };
  await expect(installNativeBundleTransaction(f.options)).rejects.toThrow(/original check failed; recovery incomplete.*changed target/);
  const journal = await journalFor(f);
  expect(await candidateDigest(join(dirname(journal), "previous", "Kestrel.app"))).toBe(f.previous);
  expect(await readFile(join(f.target, "Contents", "fixture"), "utf8")).toBe("changed");
});
it("explicitly rolls back a committed install, retains candidate bytes, and is safely repeatable", async () => {
  const f = await fixture(), result = await installNativeBundleTransaction(f.options), options = await recoveryOptions(f, result);
  await rollbackNativeBundleTransaction(options);
  expect(await candidateDigest(f.target)).toBe(f.previous);
  expect(await candidateDigest(join(dirname(result.transactionPath), "candidate", "Kestrel.app"))).toBe(f.options.expectedCandidateSha256);
  await rollbackNativeBundleTransaction(options);
  expect(options.register).toHaveBeenCalledTimes(2);
});
it("recovers a missing-target crash window using the exact old backup", async () => {
  const f = await fixture(), result = await installNativeBundleTransaction(f.options);
  await rename(f.target, join(dirname(result.transactionPath), "crash-retained.app"));
  await rollbackNativeBundleTransaction(await recoveryOptions(f, result));
  expect(await candidateDigest(f.target)).toBe(f.previous);
});
it.each(["changed-target", "changed-backup", "malformed", "oversized", "public-journal", "symlink-journal", "wrong-target", "arbitrary-path"])("rejects unsafe explicit recovery: %s", async mode => {
  const f = await fixture(), result = await installNativeBundleTransaction(f.options), options = await recoveryOptions(f, result);
  if (mode === "changed-target") await change(f.target);
  if (mode === "changed-backup") await change(result.backupPath);
  if (mode === "malformed") await writeFile(result.transactionPath, "{}");
  if (mode === "oversized") await writeFile(result.transactionPath, " ".repeat(20000));
  if (mode === "public-journal") await chmod(result.transactionPath, 0o644);
  if (mode === "symlink-journal") { await rename(result.transactionPath, `${result.transactionPath}.old`); await symlink(`${result.transactionPath}.old`, result.transactionPath); }
  if (mode === "wrong-target") { const value = JSON.parse(await readFile(result.transactionPath, "utf8")); value.target = f.source; await writeFile(result.transactionPath, JSON.stringify(value)); }
  if (mode === "arbitrary-path") options.transactionPath = join(f.root, "transaction.json");
  await expect(rollbackNativeBundleTransaction(options)).rejects.toThrow();
  if (mode !== "changed-target") expect(await candidateDigest(f.target)).toBe(f.options.expectedCandidateSha256);
});
it("conservatively refuses an unrelated local service on the deterministic guard port", async () => {
  const f = await fixture(), server = createServer(socket => socket.destroy());
  const port = 49152 + (createHash("sha256").update(f.target).digest().readUInt16BE(0) % 16384);
  await new Promise((accept, reject) => { server.once("error", reject); server.listen({ port, host: "127.0.0.1", exclusive: true }, accept); });
  try { await expect(installNativeBundleTransaction(f.options)).rejects.toThrow(/guard unavailable.*another installer or local service/); }
  finally { await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept())); }
  expect(await candidateDigest(f.target)).toBe(f.previous);
});
it("rejects symlinked source, target, backup directory and ancestors", async () => {
  for (const kind of ["source", "target", "backup", "ancestor"]) {
    const f = await fixture();
    if (kind === "source" || kind === "target") { const path = f[kind]; await rename(path, `${path}.real`); await symlink(`${path}.real`, path); }
    if (kind === "backup") await symlink(f.root, join(dirname(f.target), ".Kestrel-cutover-backups"));
    if (kind === "ancestor") { await symlink(dirname(f.source), join(f.root, "source-link")); f.options.source = join(f.root, "source-link", "Kestrel.app"); }
    await expect(installNativeBundleTransaction(f.options)).rejects.toThrow(/Unsafe directory/);
  }
});
it("keeps the original error when recovery also fails and releases the guard", async () => {
  const f = await fixture();
  f.options.validate = async path => { if (path === f.target) throw new Error("original validation"); };
  f.options.ops = { rename: async (a, b) => { if (a.includes("/previous/Kestrel.app")) throw new Error("restore error"); await rename(a, b); } };
  await expect(installNativeBundleTransaction(f.options)).rejects.toThrow(/original validation.*restore error/);
  const journal = await journalFor(f);
  expect(await candidateDigest(join(dirname(journal), "previous", "Kestrel.app"))).toBe(f.previous);
  expect(await candidateDigest(join(dirname(journal), "candidate", "Kestrel.app"))).toBe(f.options.expectedCandidateSha256);
  const legacy = vi.fn();
  await expect(withNativeInstallLock(f.target, legacy)).rejects.toThrow(/Pending native cutover/);
  expect(legacy).not.toHaveBeenCalled();
});

it("recovers after its actual installer is SIGKILLed following the previous bundle rename", async () => {
  const f = await fixture();
  const moduleUrl = pathToFileURL(resolve("scripts/native-install-transaction.mjs")).href;
  const script = `
    import { cp, rename } from "node:fs/promises";
    import { installNativeBundleTransaction } from ${JSON.stringify(moduleUrl)};
    const source = ${JSON.stringify(f.source)}, target = ${JSON.stringify(f.target)};
    setInterval(() => {}, 1000);
    await installNativeBundleTransaction({ source, target, expectedCandidateSha256: ${JSON.stringify(f.options.expectedCandidateSha256)},
      copy: (a,b) => cp(a,b,{recursive:true,verbatimSymlinks:true}), validate: async()=>{}, beforeReplace: async()=>{}, register: async()=>{},
      ops: { rename: async(a,b) => { await rename(a,b); if (a === target) { process.send({ moved: true }); await new Promise(() => {}); } } } });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = ""; child.stderr.on("data", value => { errors += value; });
  try {
    const [message] = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(`Child exited before rename: ${errors}`); })]);
    expect(message).toEqual({ moved: true });
    const transactionPath = await journalFor(f);
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    const legacy = vi.fn(async () => {});
    await expect(withNativeInstallLock(f.target, legacy)).rejects.toThrow(/Pending native cutover.*recovery journal:/);
    expect(legacy).not.toHaveBeenCalled();
    await rollbackNativeBundleTransaction(await recoveryOptions(f, { transactionPath }));
    await withNativeInstallLock(f.target, legacy);
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(await candidateDigest(f.target)).toBe(f.previous);
    expect(await candidateDigest(join(dirname(transactionPath), "stage", "Kestrel.app"))).toBe(f.options.expectedCandidateSha256);
    } finally { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; } }
});
it("shares exclusive guarding with the legacy installer, including a missing target", async () => {
  const f = await fixture(), missing = join(f.root, "fresh", "Kestrel.app");
  await mkdir(dirname(missing));
  await withNativeInstallLock(missing, async () => {
    await expect(withNativeInstallLock(missing, async () => {})).rejects.toThrow(/guard unavailable/);
  });
  await withNativeInstallLock(f.target, async () => { await expect(installNativeBundleTransaction(f.options)).rejects.toThrow(/guard unavailable/); });
  expect(await candidateDigest(f.target)).toBe(f.previous);
});
it("checks running apps immediately before every canonical rename and after adoption", async () => {
  const f = await fixture(), events = [];
  f.options.beforeReplace = async () => { events.push("check"); };
  f.options.ops = { rename: async (a, b) => { events.push(a === f.target ? "remove" : "adopt"); await rename(a, b); } };
  await installNativeBundleTransaction(f.options);
  const removed = events.indexOf("remove"), adopted = events.indexOf("adopt");
  expect(events[removed - 1]).toBe("check");
  expect(events[adopted - 1]).toBe("check");
  expect(events[adopted + 1]).toBe("check");
});

it("checks running apps directly around both explicit rollback canonical renames", async () => {
  const f = await fixture(), result = await installNativeBundleTransaction(f.options), options = await recoveryOptions(f, result), events = [];
  options.beforeReplace = async () => { events.push("check"); };
  options.ops = { rename: async (a, b) => { events.push(a === f.target ? "remove" : "restore"); await rename(a, b); } };
  await rollbackNativeBundleTransaction(options);
  const removed = events.indexOf("remove"), restored = events.indexOf("restore");
  expect(events[removed - 1]).toBe("check");
  expect(events[restored - 1]).toBe("check");
  expect(events[restored + 1]).toBe("check");
});

it("releases a guard after SIGKILL before any recovery journal or filesystem mutation", async () => {
  const f = await fixture(), moduleUrl = pathToFileURL(resolve("scripts/native-install-transaction.mjs")).href;
  const script = `import { withNativeInstallLock } from ${JSON.stringify(moduleUrl)};
    await withNativeInstallLock(${JSON.stringify(f.target)}, async () => { process.send({ guarded: true }); await new Promise(() => {}); });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = ""; child.stderr.on("data", value => { errors += value; });
  try {
    const [message] = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(`Child exited before guard: ${errors}`); })]);
    expect(message).toEqual({ guarded: true });
    expect(await candidateDigest(f.target)).toBe(f.previous);
    expect(await readdir(dirname(f.target))).toEqual(["Kestrel.app"]);
    await expect(installNativeBundleTransaction(f.options)).rejects.toThrow(/guard unavailable/);
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    const result = await installNativeBundleTransaction(f.options);
    expect(await candidateDigest(result.backupPath)).toBe(f.previous);
  } finally { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; } }
});
it("releases its guard after an ordinary callback failure", async () => {
  const f = await fixture();
  await expect(withNativeInstallLock(f.target, async () => { throw new Error("ordinary failure"); })).rejects.toThrow("ordinary failure");
  await withNativeInstallLock(f.target, async () => {});
  expect(await candidateDigest(f.target)).toBe(f.previous);
});
it("reports the durable journal through onPrepared before copying any candidate bytes", async () => {
  const f = await fixture(); let reported;
  f.options.onPrepared = async ({ transactionPath }) => {
    reported = transactionPath;
    expect(JSON.parse(await readFile(transactionPath, "utf8"))).toMatchObject({ state: "prepared", target: f.target });
    expect(await candidateDigest(f.target)).toBe(f.previous);
    expect(await readdir(dirname(transactionPath))).toEqual([".metadata_never_index", "transaction.json"]);
  };
  const result = await installNativeBundleTransaction(f.options);
  expect(reported).toBe(result.transactionPath);
});
it("rechecks target absence after the final process scan before restoring", async () => {
  const f = await fixture(), result = await installNativeBundleTransaction(f.options), options = await recoveryOptions(f, result);
  let calls = 0;
  options.beforeReplace = async () => { if (++calls === 3) await mkdir(f.target); };
  await expect(rollbackNativeBundleTransaction(options)).rejects.toThrow(/newly occupied target/);
  expect(await readdir(f.target)).toEqual([]);
  expect(await candidateDigest(result.backupPath)).toBe(f.previous);
  expect(await candidateDigest(join(dirname(result.transactionPath), "candidate", "Kestrel.app"))).toBe(f.options.expectedCandidateSha256);
});
it("can explicitly recover after onPrepared fails before backup directories exist", async () => {
  const f = await fixture(); let transactionPath;
  f.options.onPrepared = async value => { transactionPath = value.transactionPath; throw new Error("prepared output failed"); };
  await expect(installNativeBundleTransaction(f.options)).rejects.toThrow(/prepared output failed/);
  await rollbackNativeBundleTransaction(await recoveryOptions(f, { transactionPath }));
  expect(await candidateDigest(f.target)).toBe(f.previous);
});

it("allows a fresh attempt after a pre-move failure while preserving its journal", async () => {
  const f = await fixture();
  await expect(installNativeBundleTransaction({ ...f.options, copy: async () => { throw new Error("pre-move copy failure"); } })).rejects.toThrow(/pre-move copy failure/);
  const journal = await journalFor(f);
  await withNativeInstallLock(f.target, async () => {});
  const result = await installNativeBundleTransaction(f.options);
  expect(result.transactionPath).not.toBe(journal);
  expect(JSON.parse(await readFile(journal, "utf8"))).toMatchObject({ state: "rolled-back", reconciledFromState: "prepared", reconciliation: "previous-bundle-present-without-backup", source: f.source, target: f.target, previousSha256: f.previous });
  expect(Number.isFinite(Date.parse(JSON.parse(await readFile(journal, "utf8")).reconciledAt))).toBe(true);
  const second = await installNativeBundleTransaction(f.options);
  expect(second.transactionPath).not.toBe(result.transactionPath);
  await withNativeInstallLock(f.target, async () => {});
});
it.each(["malformed", "unknown-entry", "symlink-directory", "unjournaled-data"])("refuses unsafe pending transaction inspection: %s", async mode => {
  const f = await fixture(), base = join(dirname(f.target), ".Kestrel-cutover-backups"), directory = join(base, "12345678-1234-4234-8234-123456789abc");
  await mkdir(base, { mode: 0o700 });
  if (mode === "symlink-directory") await symlink(f.root, directory);
  else {
    await mkdir(directory, { mode: 0o700 });
    if (mode === "malformed") await writeFile(join(directory, "transaction.json"), "{}", { mode: 0o600 });
    if (mode === "unknown-entry") await mkdir(join(base, "unknown"));
    if (mode === "unjournaled-data") await writeFile(join(directory, "unknown"), "preserve me");
  }
  const legacy = vi.fn();
  await expect(withNativeInstallLock(f.target, legacy)).rejects.toThrow(/recovery journal:|Unknown.*recovery entries/);
  expect(legacy).not.toHaveBeenCalled();
  expect(await candidateDigest(f.target)).toBe(f.previous);
});
it("allows empty and marker-only pre-journal setup directories", async () => {
  const f = await fixture(), base = join(dirname(f.target), ".Kestrel-cutover-backups");
  await mkdir(base, { mode: 0o700 });
  for (const [id, marker] of [["12345678-1234-4234-8234-123456789abc", false], ["22345678-1234-4234-8234-123456789abc", true]]) {
    const directory = join(base, id); await mkdir(directory, { mode: 0o700 });
    if (marker) await writeFile(join(directory, ".metadata_never_index"), "", { mode: 0o600 });
  }
  const legacy = vi.fn(); await withNativeInstallLock(f.target, legacy); expect(legacy).toHaveBeenCalledTimes(1);
});
it("refuses more than 256 journal directories without running another installer", async () => {
  const f = await fixture(), base = join(dirname(f.target), ".Kestrel-cutover-backups");
  await mkdir(base, { mode: 0o700 });
  await Promise.all(Array.from({ length: 257 }, (_, index) => mkdir(join(base, `${index.toString(16).padStart(8, "0")}-1234-4234-8234-123456789abc`), { mode: 0o700 })));
  const legacy = vi.fn();
  await expect(withNativeInstallLock(f.target, legacy)).rejects.toThrow(/excessive recovery entries/);
  expect(legacy).not.toHaveBeenCalled();
  expect((await readdir(base)).length).toBe(257);
});
it("blocks both native and legacy installs while an adopted candidate has a nonterminal journal", async () => {
  const f = await fixture(), result = await installNativeBundleTransaction(f.options);
  const journal = JSON.parse(await readFile(result.transactionPath, "utf8"));
  journal.state = "candidate-installed"; await writeFile(result.transactionPath, JSON.stringify(journal));
  const legacy = vi.fn(), copy = vi.fn();
  await expect(withNativeInstallLock(f.target, legacy)).rejects.toThrow(result.transactionPath);
  await expect(installNativeBundleTransaction({ ...f.options, copy })).rejects.toThrow(result.transactionPath);
  expect(legacy).not.toHaveBeenCalled(); expect(copy).not.toHaveBeenCalled();
  await rollbackNativeBundleTransaction(await recoveryOptions(f, result));
  await withNativeInstallLock(f.target, legacy); expect(legacy).toHaveBeenCalledTimes(1);
});

it("preserves an actual SIGKILLed initial journal temporary and allows a fresh installation", async () => {
  const f = await fixture(), moduleUrl = pathToFileURL(resolve("scripts/native-install-transaction.mjs")).href;
  const script = `
    import { cp, open } from "node:fs/promises";
    import { basename } from "node:path";
    import { installNativeBundleTransaction } from ${JSON.stringify(moduleUrl)};
    await installNativeBundleTransaction({ source: ${JSON.stringify(f.source)}, target: ${JSON.stringify(f.target)}, expectedCandidateSha256: ${JSON.stringify(f.options.expectedCandidateSha256)},
      copy: (a,b)=>cp(a,b,{recursive:true}), validate: async()=>{}, beforeReplace: async()=>{}, register: async()=>{},
      ops: { open: async(path,...args) => { const handle = await open(path,...args); if (basename(path).startsWith(".journal-")) { process.send({ temporary: path }); await new Promise(()=>{}); } return handle; } } });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = ""; child.stderr.on("data", value => { errors += value; });
  try {
    const [message] = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(`Child exited before initial journal: ${errors}`); })]);
    expect(message.temporary).toContain("/.journal-");
    expect(await candidateDigest(f.target)).toBe(f.previous);
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    expect((await readdir(dirname(message.temporary))).sort()).toEqual([".metadata_never_index", message.temporary.split("/").at(-1)].sort());
    const legacy = vi.fn(); await withNativeInstallLock(f.target, legacy); expect(legacy).toHaveBeenCalledTimes(1);
    const result = await installNativeBundleTransaction(f.options);
    expect(await candidateDigest(result.backupPath)).toBe(f.previous);
    expect(await readFile(message.temporary, "utf8")).toBe("");
  } finally { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; } }
});
it.each(["public", "symlink", "oversized", "unknown", "excessive"])("refuses unsafe pre-journal temporary files: %s", async mode => {
  const f = await fixture(), base = join(dirname(f.target), ".Kestrel-cutover-backups"), directory = join(base, "12345678-1234-4234-8234-123456789abc");
  await mkdir(base, { mode: 0o700 }); await mkdir(directory, { mode: 0o700 });
  const path = join(directory, mode === "unknown" ? ".journal-unknown" : ".journal-22345678-1234-4234-8234-123456789abc");
  if (mode === "symlink") await symlink(join(f.target, "Contents", "fixture"), path);
  else await writeFile(path, mode === "oversized" ? "x".repeat(16385) : "{incomplete", { mode: mode === "public" ? 0o644 : 0o600 });
  if (mode === "excessive") await Promise.all(Array.from({ length: 8 }, (_, index) => writeFile(join(directory, `.journal-${index.toString(16).padStart(8, "0")}-1234-4234-8234-123456789abc`), "", { mode: 0o600 })));
  const legacy = vi.fn(); await expect(withNativeInstallLock(f.target, legacy)).rejects.toThrow(/recovery journal:/);
  expect(legacy).not.toHaveBeenCalled(); expect(await candidateDigest(f.target)).toBe(f.previous);
});
