import { describe, beforeAll, afterAll, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

describe.skipIf(process.platform !== "darwin")("native prepared profile inventory", () => {
 let temporary, executable;
 beforeAll(() => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  temporary = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-prepared-inventory-"))); executable = join(temporary, "fixture");
  const sdk = execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8", timeout: 5000 }).trim();
  execFileSync("/usr/bin/xcrun", ["clang++", "-std=c++20", "-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=13.0", "-isysroot", sdk, "-I", join(repo, "apps/native-chromium-host/src"), join(repo, "apps/native-chromium-host/src/kestrel_native_prepared_profiles.mm"), join(repo, "apps/native-chromium-host/tests/prepared_profiles_fixture.mm"), "-framework", "Foundation", "-o", executable], { timeout: 30000, stdio: "pipe" });
 }, 40000);
 afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });
 function fixture() {
  const root = join(temporary, randomUUID()); mkdirSync(root, { mode: 0o700 });
  const parent = join(root, "native-core-profiles");
  const add = () => { if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 }); const relative = `native-core-profiles/${randomUUID()}`, path = join(root, relative); mkdirSync(path, { mode: 0o700 }); return { relative, path }; };
  const inspect = (active = "", previous = "", row) => { const result = spawnSync(executable, [root, active, previous, ...(row ? [JSON.stringify(row)] : [])], { encoding: "utf8", timeout: 5000 }); expect(result.status, result.stderr).toBe(0); return JSON.parse(result.stdout); };
  return { root, parent, add, inspect };
 }
 function journal(path) { mkdirSync(join(path, "native-core", "database"), { recursive: true, mode: 0o700 }); const file = join(path, "native-core/database/kestrel.sqlite.kestrel-transfer-journal"); writeFileSync(file, "generated", { mode: 0o600 }); return file; }
 it("returns empty without creating a missing parent", () => { const f = fixture(); expect(f.inspect()).toEqual({ ok: true, error: false, rows: [] }); expect(existsSync(f.parent)).toBe(false); });
 it("lists private UUID children deterministically across restarts and excludes current selections", () => {
  const f = fixture(), a = f.add(), b = f.add(), c = f.add(); journal(a.path); mkdirSync(join(f.parent, "unrelated"));
  const first = f.inspect(b.relative, c.relative); expect(first).toMatchObject({ ok: true, rows: [{ relative: a.relative, path: a.path, hasJournal: true }] });
  expect(f.inspect(b.relative, c.relative)).toEqual(first); expect(f.inspect().rows.find(row => row.relative === b.relative).hasJournal).toBe(false);
  expect(f.inspect(b.relative, c.relative, first.rows[0]).current).toBe(true);
  expect(f.inspect(a.relative, c.relative, first.rows[0]).current).toBe(false);
 });
 it("treats unsafe nested paths and journals as unknown without traversing links", () => {
  const f = fixture(), a = f.add(), b = f.add(), c = f.add(), other = f.add(); symlinkSync(other.path, join(a.path, "native-core"));
  mkdirSync(join(b.path, "native-core"), { mode: 0o700 }); symlinkSync(other.path, join(b.path, "native-core/database"));
  const file = journal(c.path); chmodSync(file, 0o644);
  for (const candidate of [a, b, c]) expect(f.inspect().rows.find(row => row.relative === candidate.relative).hasJournal).toBe(false);
 });
 it("refuses unsafe root, parent, and UUID children", () => {
  const f = fixture(); chmodSync(f.root, 0o755); expect(f.inspect().ok).toBe(false); chmodSync(f.root, 0o700);
  const a = f.add(); chmodSync(f.parent, 0o755); expect(f.inspect().ok).toBe(false); chmodSync(f.parent, 0o700);
  const other = f.add(); symlinkSync(other.path, join(f.parent, randomUUID())); expect(f.inspect().ok).toBe(false);
  expect(existsSync(a.path)).toBe(true);
  const g = fixture(), h = fixture(); symlinkSync(h.root, g.parent); expect(g.inspect().ok).toBe(false);
 });
 it("rejects a replaced profile inode and invalid selection input", () => {
  const f = fixture(), child = f.add(), row = f.inspect().rows[0]; renameSync(child.path, `${child.path}.saved`); mkdirSync(child.path, { mode: 0o700 });
  expect(f.inspect("", "", row).current).toBe(false); expect(f.inspect("../bad").ok).toBe(false);
 });
 it("revalidates root and parent directory identities and rejects tampered rows", () => {
  const f = fixture(), child = f.add(), row = f.inspect().rows[0];
  const savedRoot = `${f.root}.saved`;
  renameSync(f.root, savedRoot); mkdirSync(f.root, { mode: 0o700 });
  renameSync(join(savedRoot, "native-core-profiles"), f.parent); rmSync(savedRoot, { recursive: true });
  expect(f.inspect("", "", row).current).toBe(false);

  const g = fixture(), profile = g.add(), original = g.inspect().rows[0];
  const savedParent = `${g.parent}.saved`;
  renameSync(g.parent, savedParent); mkdirSync(g.parent, { mode: 0o700 });
  renameSync(join(savedParent, profile.relative.split("/")[1]), profile.path); rmSync(savedParent, { recursive: true });
  expect(g.inspect("", "", original).current).toBe(false);
  for (const key of ["rootDevice", "rootInode", "parentDevice", "parentInode", "device", "inode"]) {
   const tampered = { ...original, [key]: Number(original[key]) + 1 };
   expect(g.inspect("", "", tampered).current).toBe(false);
  }
  expect(g.inspect("", "", { ...original, relative: "native-core-profiles/00000000-0000-0000-0000-000000000000\u0000suffix" }).current).toBe(false);
  expect(g.inspect("\u0001").ok).toBe(false);
 });
 it("rejects noncanonical or control-character roots without inspecting them", () => {
  const f = fixture();
  const noncanonical = spawnSync(executable, [`${f.root}/.`, "", ""], { encoding: "utf8", timeout: 5000 });
  expect(noncanonical.status).toBe(0); expect(JSON.parse(noncanonical.stdout).ok).toBe(false);
  const controlRoot = `${f.root}\u0001`;
  const result = spawnSync(executable, [controlRoot, "", ""], { encoding: "utf8", timeout: 5000 });
  expect(result.status).toBe(0); expect(JSON.parse(result.stdout).ok).toBe(false);
 });
 it("fails closed beyond 128 entries, including unrelated entries", () => {
  const f = fixture(); f.add(); for (let i = 0; i < 128; i++) mkdirSync(join(f.parent, `ignored-${i}`));
  expect(f.inspect()).toEqual({ ok: false, error: true, rows: [] });
 });
});
