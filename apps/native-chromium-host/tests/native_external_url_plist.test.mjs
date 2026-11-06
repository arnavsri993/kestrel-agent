import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the native app declares only HTTP and HTTPS URL schemes", () => {
  const plist = fileURLToPath(new URL("../build/Info.plist", import.meta.url));
  const types = JSON.parse(execFileSync("/usr/bin/plutil", ["-extract", "CFBundleURLTypes", "json", "-o", "-", plist], { encoding: "utf8" }));
  assert.deepEqual(types.flatMap((entry) => entry.CFBundleURLSchemes).sort(), ["http", "https"]);
  assert.ok(types.every((entry) => entry.CFBundleTypeRole === "Viewer"));
});

test("native URL validation and the bounded queue preserve readiness and never replay a dispatched URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-url-queue-test-"));
  try {
    const binary = join(root, "queue-test");
    execFileSync("/usr/bin/xcrun", ["clang++", "-std=c++17", "-fobjc-arc", "-framework", "Foundation", fileURLToPath(new URL("native_external_url_test.mm", import.meta.url)), "-o", binary], { timeout: 30_000, stdio: "pipe" });
    execFileSync(binary, [], { timeout: 5_000, stdio: "pipe" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native picker paths retain Core's POSIX canonical grant boundary across Foundation aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-dialog-path-test-"));
  try {
    const binary = join(root, "path-test");
    execFileSync("/usr/bin/xcrun", ["clang++", "-std=c++17", "-fobjc-arc", "-framework", "Foundation", fileURLToPath(new URL("foundation_path_resolution_test.mm", import.meta.url)), "-o", binary], { timeout: 30_000, stdio: "pipe" });
    execFileSync(binary, [], { timeout: 5_000, stdio: "pipe" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
