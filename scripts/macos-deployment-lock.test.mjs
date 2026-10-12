import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const suite = process.platform === "darwin" ? describe : describe.skip;
const helper = new URL("./macos-deployment-lock.mjs", import.meta.url).href;
function launch(script, root, delay = "0") {
  const child = spawn(process.execPath, [script, root, delay], { stdio: ["ignore", "pipe", "pipe"] });
  const finished = new Promise(resolve => child.once("exit", (code) => resolve(code)));
  return { child, finished };
}
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Deployment test did not reach expected state.");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
suite("cross-process canonical deployment lock", () => {
  it("queues competing installers and recovers stale metadata after an owner exits", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-lock-"));
    const script = join(root, "worker.mjs");
    const log = join(root, "events");
    writeFileSync(script, `import { appendFileSync } from 'node:fs';
      import { enterDeploymentLock } from ${JSON.stringify(helper)};
      const assertOwner = enterDeploymentLock(import.meta.filename, process.argv[2]);
      assertOwner(); appendFileSync(${JSON.stringify(log)}, 'enter\\n');
      await new Promise(resolve => setTimeout(resolve, Number(process.argv[3])));
      assertOwner(); appendFileSync(${JSON.stringify(log)}, 'exit\\n');`);
    const first = launch(script, root, "250");
    await until(() => existsSync(log));
    const second = launch(script, root);
    expect(await first.finished).toBe(0); expect(await second.finished).toBe(0);
    expect(readFileSync(log, "utf8")).toBe("enter\nexit\nenter\nexit\n");
    // Metadata from dead PID cannot block a fresh kernel lock acquisition.
    writeFileSync(join(root, ".Kestrel-deployment-active.json"), JSON.stringify({ pid: 999999, token: "stale" }));
    const recovered = launch(script, root);
    expect(await recovered.finished).toBe(0);
  });
  it("refuses replacement after ownership metadata is changed", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-lock-revoked-"));
    const script = join(root, "worker.mjs");
    const marker = join(root, "ready");
    writeFileSync(script, `import { writeFileSync } from 'node:fs';
      import { enterDeploymentLock } from ${JSON.stringify(helper)};
      const check = enterDeploymentLock(import.meta.filename, process.argv[2]);
      writeFileSync(${JSON.stringify(marker)}, 'ready');
      await new Promise(resolve => setTimeout(resolve, 250)); check();
      writeFileSync(${JSON.stringify(join(root, "replaced"))}, 'unsafe');`);
    const worker = launch(script, root);
    await until(() => existsSync(marker));
    writeFileSync(join(root, ".Kestrel-deployment-active.json"), JSON.stringify({ pid: 0, token: "revoked" }));
    expect(await worker.finished).not.toBe(0);
    expect(existsSync(join(root, "replaced"))).toBe(false);
  });
  it("releases kernel ownership after the installer process crashes", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-lock-crash-"));
    const script = join(root, "worker.mjs"); const log = join(root, "events");
    writeFileSync(script, `import { appendFileSync } from 'node:fs';
      import { enterDeploymentLock } from ${JSON.stringify(helper)};
      const check = enterDeploymentLock(import.meta.filename, process.argv[2]);
      check(); appendFileSync(${JSON.stringify(log)}, 'enter\\n');
      await new Promise(resolve => setTimeout(resolve, Number(process.argv[3])));
      check(); appendFileSync(${JSON.stringify(log)}, 'exit\\n');`);
    const crashed = launch(script, root, "10000");
    await until(() => existsSync(log));
    const owner = JSON.parse(readFileSync(join(root, ".Kestrel-deployment-active.json"), "utf8"));
    process.kill(owner.pid, "SIGKILL");
    expect(await crashed.finished).not.toBe(0);
    const next = launch(script, root);
    expect(await next.finished).toBe(0);
    expect(readFileSync(log, "utf8")).toBe("enter\nenter\nexit\n");
  });
});
