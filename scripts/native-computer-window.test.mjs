import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";

it.skipIf(process.platform !== "darwin")("binds native input to the focused window instead of a sharing indicator", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const temporary = mkdtempSync(join(tmpdir(), "kestrel-focused-window-test-"));
  try {
    const executable = join(temporary, "window-fixture");
    const sdk = execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8", timeout: 10_000 }).trim();
    const compiler = execFileSync("/usr/bin/xcrun", ["--find", "clang++"], { encoding: "utf8", timeout: 10_000 }).trim();
    execFileSync(compiler, [
      "-std=c++20", "-Wall", "-Wextra", "-Werror",
      "-isysroot", sdk,
      "-I", join(root, "apps/native-chromium-host/src"),
      join(root, "apps/native-chromium-host/tests/native_computer_window_fixture.cc"),
      "-o", executable,
    ], { timeout: 30_000, stdio: "pipe" });
    execFileSync(executable, [], { timeout: 5_000, stdio: "pipe" });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
