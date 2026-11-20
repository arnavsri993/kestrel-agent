import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe.skipIf(process.platform !== "darwin")("native Core key dispatch", () => {
  let temporary, executable;
  beforeAll(() => {
    const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    temporary = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-key-dispatch-fixture-")));
    executable = join(temporary, "key-dispatch-fixture");
    const sdk = execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8", timeout: 5000 }).trim();
    execFileSync("/usr/bin/xcrun", ["clang++", "-std=c++20", "-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=13.0", "-isysroot", sdk,
      join(repository, "apps/native-chromium-host/src/kestrel_native_core_key_dispatch.mm"),
      join(repository, "apps/native-chromium-host/tests/native_core_key_dispatch_test.mm"),
      "-framework", "Foundation", "-o", executable], { timeout: 30000, stdio: "pipe" });
  }, 40000);
  afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });
  it("keeps main responsive, serializes bounded lookups and discards replaced/shutdown owner results", () => {
    const result = spawnSync(executable, [], { encoding: "utf8", timeout: 15000 });
    expect(result.error).toBeUndefined(); expect(result.stderr).toBe(""); expect(result.status).toBe(0);
  });
});
