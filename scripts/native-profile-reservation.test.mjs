import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

describe.skipIf(process.platform !== "darwin")("native external profile reservation", () => {
 let temporary, executable;
 beforeAll(() => {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  temporary = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-profile-reservation-")));
  const sdk = execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8", timeout: 5_000 }).trim();
  const compiler = execFileSync("/usr/bin/xcrun", ["--find", "clang++"], { encoding: "utf8", timeout: 5_000 }).trim();
  executable = join(temporary, "fixture");
  execFileSync(compiler, ["-std=c++20", "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=13.0", "-isysroot", sdk,
   "-I", join(repository, "apps/native-chromium-host/src"), join(repository, "apps/native-chromium-host/src/kestrel_profile_reservation.cc"),
   join(repository, "apps/native-chromium-host/tests/native_profile_reservation_fixture.cc"), "-o", executable], { timeout: 30_000, stdio: "pipe" });
 }, 45_000);
 afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });
 function run(scenario) {
  const root = join(temporary, randomUUID()); mkdirSync(root, { mode: 0o700 }); chmodSync(root, 0o700);
  const result = spawnSync(executable, [root, scenario], { encoding: "utf8", timeout: 5_000 });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stderr).toBe(""); expect(result.stdout).toBe("ok\n");
 }
 it("excludes a separate process, survives a profile swap, permits another profile and releases", () => run("process"));
 it("detects replacement of the held external lock or parent", () => { run("replace"); run("parent-replace"); });
 it.skipIf(process.getuid?.() !== 0).each(["root-owner", "parent-owner"])("rejects a different owner for %s", run);
 it.each(["root-mode", "parent-mode", "root-symlink", "parent-symlink", "lock-symlink", "lock-hardlink", "lock-mode", "lock-directory", "lock-content"])("rejects unsafe %s without altering existing content", run);
});
