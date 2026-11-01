import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("native system integration requires the production native identity and reports verified settings", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-system-integration-test-"));
  try {
    const binary = join(root, "system-integration-test");
    execFileSync("/usr/bin/xcrun", ["clang++", "-std=c++17", "-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=13.0", "-framework", "Foundation", "-framework", "AppKit", "-framework", "ServiceManagement", fileURLToPath(new URL("native_system_integration_test.mm", import.meta.url)), "-o", binary], { timeout: 30_000, stdio: "pipe" });
    execFileSync(binary, [], { timeout: 5_000, stdio: "pipe" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
