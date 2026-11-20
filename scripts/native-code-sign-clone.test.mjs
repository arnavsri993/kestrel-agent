import assert from "node:assert/strict";
import { linkSync } from "node:fs";
import { chmod, cp, link, lstat, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "vitest";
import { validateChromiumSigningClones } from "./native-code-sign-clone.mjs";

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
 const root = await realpath(await mkdtemp(join(tmpdir(), "kestrel-code-clone-test-"))); roots.push(root);
 const candidate = join(root, "Kestrel.app"), executable = join(candidate, "Contents/MacOS/Kestrel");
 await mkdir(join(candidate, "Contents/MacOS"), { recursive: true, mode: 0o700 });
 await writeFile(executable, "generated executable", { mode: 0o700 });
 await writeFile(join(candidate, "Contents/Info.plist"), "generated metadata", { mode: 0o600 });
 const namespace = join(root, "X/com.kestrel.fixture.code_sign_clone"); await mkdir(namespace, { recursive: true, mode: 0o700 });
 const container = join(namespace, "code_sign_clone.abc123"); await mkdir(container, { mode: 0o700 });
 const clone = join(container, "Kestrel.app.bundle");
 await cp(candidate, clone, { recursive: true });
 const alias = join(clone, "Contents/MacOS/Kestrel"); await unlink(alias); await link(executable, alias);
 const run = options => validateChromiumSigningClones(candidate, { namespace, ps: () => "", ...options });
 return { root, candidate, executable, namespace, container, clone, alias, run };
}
it("accounts for the complete byte-identical Chromium clone without changing either bundle", async () => {
 const f = await fixture(), before = await lstat(f.executable), result = await f.run();
 assert.equal(result.aliases.length, 1); assert.equal(result.aliases[0].path, f.clone);
 assert.deepEqual(await lstat(f.executable), before);
});
it("accepts a single-link executable without probing a clone namespace", async () => {
 const f = await fixture(); await unlink(f.alias);
 assert.deepEqual((await f.run({ namespace: "/does-not-exist" })).aliases, []);
});
for (const kind of ["unaccounted", "wrong-location", "changed-bundle", "symlink", "writable-root", "writable-clone", "running-candidate", "running-clone", "too-many"]) {
 it(`rejects ${kind} aliases`, async () => {
  const f = await fixture();
  if (kind === "unaccounted") await link(f.executable, join(f.root, "unknown-alias"));
  if (kind === "wrong-location") { await unlink(f.alias); await link(f.executable, join(f.root, "unknown-alias")); }
  if (kind === "changed-bundle") await writeFile(join(f.clone, "Contents/Info.plist"), "different metadata");
  if (kind === "symlink") { const moved = `${f.clone}.old`; await cp(f.clone, moved, { recursive: true }); await rm(f.clone, { recursive: true }); await symlink(moved, f.clone); await link(f.executable, join(f.root, "unknown-alias")); }
  if (kind === "writable-root") await chmod(f.namespace, 0o777);
  if (kind === "writable-clone") await chmod(f.clone, 0o777);
  if (kind === "too-many") for (let n = 0; n < 129; n++) await mkdir(join(f.namespace, `unused-${n}`));
  const ps = () => kind === "running-candidate" ? `1 ${f.executable}\n` : kind === "running-clone" ? `2 ${f.clone}/Contents/Frameworks/helper\n` : "";
  await assert.rejects(f.run({ ps }));
 });
}
it("detects a link added during validation", async () => {
 const f = await fixture();
 // The injected process inventory is reached after hashing the clone.
 await assert.rejects(f.run({ ps: () => { linkSync(f.executable, join(f.root, "late-alias")); return ""; } }), /changed during/);
});
it("accounts for multiple matching signing clones", async () => {
 const f = await fixture(), container = join(f.namespace, "code_sign_clone.def456"); await mkdir(container);
 const clone = join(container, "Kestrel.app"); await cp(f.candidate, clone, { recursive: true });
 const alias = join(clone, "Contents/MacOS/Kestrel"); await unlink(alias); await link(f.executable, alias);
 assert.equal((await f.run()).aliases.length, 2);
});
