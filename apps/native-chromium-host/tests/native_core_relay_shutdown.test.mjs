import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Compile the actual relay implementation without CEF, then drive its NSTask
// lifecycle with inert Node children. No application profile or bundle is used.
test("native relay shutdown drains stdout and confirms the separate process group exits", { skip: process.platform !== "darwin", timeout: 30000 }, () => {
  const temporary = mkdtempSync(join(tmpdir(), "kestrel-relay-shutdown-test-"));
  try {
    const source = readFileSync(new URL("../src/kestrel_native_host.mm", import.meta.url), "utf8");
    const relay = source.slice(source.indexOf("@interface KestrelNativeCoreRelay :"), source.indexOf("\nnamespace {"));
    const fixture = join(temporary, "fixture.mm"), executable = join(temporary, "fixture");
    writeFileSync(fixture, `#import <Foundation/Foundation.h>
#include <chrono>
#include <cerrno>
#include <csignal>
#include <unistd.h>
${relay}
int main(int argc, char** argv) {
  @autoreleasepool {
    if (argc != 3) return 10;
    KestrelNativeCoreRelay* relay = [[KestrelNativeCoreRelay alloc] init];
    relay.outputBuffer = [NSMutableData data];
    relay.task = [[NSTask alloc] init];
    relay.task.executableURL = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]]];
    relay.task.arguments = @[@"-e", [NSString stringWithUTF8String:argv[2]]];
    NSPipe* input = [NSPipe pipe]; NSPipe* output = [NSPipe pipe];
    relay.input = input.fileHandleForWriting; relay.output = output.fileHandleForReading;
    relay.task.standardInput = input; relay.task.standardOutput = output;
    // Match start's reader: allow EOF and data reads on its background queue.
    __weak KestrelNativeCoreRelay* weakRelay = relay;
    relay.output.readabilityHandler = ^(NSFileHandle* handle) {
      NSData* data = handle.availableData;
      if (!data.length) { handle.readabilityHandler = nil; return; }
      KestrelNativeCoreRelay* owner = weakRelay;
      if (!owner.stopping) [owner consumeOutput:data];
    };
    NSError* error = nil;
    if (![relay.task launchAndReturnError:&error]) return 11;
    const pid_t pid = relay.task.processIdentifier;
    if (getpgid(pid) != pid || getpgid(pid) == getpgrp()) return 12;
    // Child signals readiness only after registering its TERM handler.
    [NSThread sleepForTimeInterval:0.25];
    const auto start = std::chrono::steady_clock::now();
    if (![relay shutdown]) return 13;
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - start).count();
    if (relay.task.isRunning || kill(-pid, 0) != -1 || errno != ESRCH) return 14;
    printf("%lld %d\\n", (long long)elapsed, relay.task.terminationStatus);
    if (![relay shutdown]) return 15;
  }
}
`);
    execFileSync("/usr/bin/xcrun", ["clang++", "-std=c++20", "-fobjc-arc", "-Wall", "-Wextra", "-Werror", fixture, "-framework", "Foundation", "-o", executable], { timeout: 30000 });
    const run = (program) => {
      const result = spawnSync(executable, [process.execPath, program], { encoding: "utf8", timeout: 17000 });
      assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
      return result.stdout.trim().split(" ").map(Number);
    };
    const [gracefulElapsed, status] = run('process.on("SIGTERM", () => { process.stdout.write(Buffer.alloc(2 * 1024 * 1024, 120), () => setTimeout(() => process.exit(0), 100)); }); setInterval(() => {}, 1000);');
    assert.equal(status, 0, "a blocked stdout flush must not force SIGKILL");
    assert.ok(gracefulElapsed >= 80 && gracefulElapsed < 4000);
    const [forcedElapsed] = run('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);');
    assert.ok(forcedElapsed >= 9900 && forcedElapsed < 13000, "an unresponsive relay must stop within the bounded escalation window");
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});


test("relay waits for actual Core exit before closing its profile, including SIGKILL fallback", { timeout: 12000 }, async () => {
  const source = readFileSync(new URL("../resources/native-core-relay.mjs", import.meta.url), "utf8");
  const shutdown = source.slice(source.indexOf("async function shutdown("), source.indexOf('\ncore.on("message"'));
  for (const stubborn of [false, true]) {
    const program = stubborn
      ? 'process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000);'
      : 'process.on("message", () => setTimeout(() => process.exit(0), 80)); process.send("ready"); setInterval(() => {}, 1000);';
    const core = spawn(process.execPath, ["-e", program], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    try {
      await new Promise((resolve, reject) => { core.once("message", resolve); core.once("error", reject); });
      let closed = false, exitCode;
      const stop = runInNewContext(`(${shutdown})`, {
        stopping: false, failPending() {}, core, setTimeout, clearTimeout, console,
        coreProfile: { async close() {
          assert.ok(core.exitCode !== null || core.signalCode !== null);
          assert.throws(() => process.kill(core.pid, 0), { code: "ESRCH" });
          closed = true;
        } },
        process: { exit(code) { exitCode = code; } },
      });
      await stop();
      assert.equal(closed, true); assert.equal(exitCode, 0);
      assert.equal(stubborn ? core.signalCode : core.exitCode, stubborn ? "SIGKILL" : 0);
    } finally { if (core.exitCode === null && core.signalCode === null) core.kill("SIGKILL"); }
  }
});
