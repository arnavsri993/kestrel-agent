import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe.skipIf(process.platform !== "darwin")("native main run-loop dispatch", () => {
  let temporary, executable;
  beforeAll(() => {
    const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    temporary = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-run-loop-dispatch-")));
    executable = join(temporary, "fixture");
    const sdk = execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8", timeout: 5_000 }).trim();
    const compiler = execFileSync("/usr/bin/xcrun", ["--find", "clang++"], { encoding: "utf8", timeout: 5_000 }).trim();
    execFileSync(compiler, ["-std=c++20", "-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=13.0", "-isysroot", sdk,
      "-I", join(repository, "apps/native-chromium-host/src"),
      join(repository, "apps/native-chromium-host/src/kestrel_native_run_loop_dispatch.mm"),
      join(repository, "apps/native-chromium-host/tests/native_run_loop_dispatch_fixture.mm"),
      "-framework", "Foundation", "-o", executable], { timeout: 30_000, stdio: "pipe" });
  }, 40_000);
  afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });

  it("delivers once on main inside nested default, modal, and event-tracking modes", () => {
    const result = spawnSync(executable, [], { encoding: "utf8", timeout: 20_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("PASS default-mode");
    expect(result.stdout).toContain("PASS modal-mode-nested-dispatch");
    expect(result.stdout).toContain("PASS event-tracking-mode");
  });
});
