import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { SandboxedCommandRunner } from "./command-runner";
import * as child_process from "node:child_process";
import * as fs from "node:fs";

const hostPlatform = process.platform;

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  accessSync: vi.fn(),
  constants: { X_OK: 1 },
}));

describe("SandboxedCommandRunner", () => {
  let originalPlatform: string;
  let originalPath: string | undefined;
  let runner: SandboxedCommandRunner;

  beforeEach(() => {
    originalPlatform = process.platform;
    originalPath = process.env.PATH;
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.resetAllMocks();
    runner = new SandboxedCommandRunner();
    process.env.PATH = "/bin:/usr/bin";
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });

  const defaultInput = {
    command: "ls",
    args: ["-la"],
    cwd: "/tmp",
    workspaceRoot: "/workspace",
    mode: "read_only" as const,
    timeoutMs: 5000,
  };

  it("throws error if platform is not darwin", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(() => runner.start(defaultInput, { onProgress: vi.fn() })).toThrow("implemented only for macOS");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, 1.5])("rejects invalid timeout %s before spawning", (timeoutMs) => {
    vi.mocked(fs.accessSync).mockImplementation(() => {});

    expect(() => runner.start({ ...defaultInput, timeoutMs }, { onProgress: vi.fn() })).toThrow("finite positive integer");
    expect(child_process.spawn).not.toHaveBeenCalled();
  });

  it("throws error if command is not in allowlist", () => {
    const input = { ...defaultInput, command: "rm" };
    expect(() => runner.start(input, { onProgress: vi.fn() })).toThrow("not in the Kestrel executable allowlist");
  });

  it("throws error if allowed command is not found in PATH", () => {
    vi.mocked(fs.accessSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(() => runner.start(defaultInput, { onProgress: vi.fn() })).toThrow("Allowed command ls is not installed");
  });

  function mockSpawn() {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdin = {
      write: vi.fn(),
      destroyed: false,
    };
    const kill = vi.fn();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      stdin,
      kill,
      pid: 12345,
      exitCode: null,
      signalCode: null,
    }) as unknown as child_process.ChildProcess & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: ReturnType<typeof vi.fn>; destroyed: boolean };
      kill: ReturnType<typeof vi.fn>;
    };
    vi.mocked(child_process.spawn).mockReturnValue(child);
    return child;
  }

  it("runs the command successfully", async () => {
    vi.mocked(fs.accessSync).mockImplementation((path) => {
      if (path === "/usr/bin/ls") return; // Found
      throw new Error("ENOENT");
    });

    const child = mockSpawn();
    const onProgress = vi.fn();

    const handle = runner.start(defaultInput, { onProgress });

    // Check spawn args
    expect(child_process.spawn).toHaveBeenCalledWith(
      "/usr/bin/sandbox-exec",
      expect.arrayContaining(["-p", expect.any(String), "/usr/bin/ls", "-la"]),
      expect.objectContaining({ cwd: "/tmp" })
    );

    // Simulate process execution
    child.stdout.emit("data", Buffer.from("hello"));
    child.stderr.emit("data", Buffer.from("world"));
    child.emit("close", 0, null);

    const result = await handle.completion;

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.stderr).toBe("world");
    expect(onProgress).toHaveBeenCalledWith({ stream: "stdout", chunk: "hello" });
    expect(onProgress).toHaveBeenCalledWith({ stream: "stderr", chunk: "world" });
  });

  it("cancels execution if timeoutMs is exceeded", async () => {
    vi.useFakeTimers();
    vi.mocked(fs.accessSync).mockImplementation(() => {});

    const child = mockSpawn();
    const handle = runner.start(defaultInput, { onProgress: vi.fn() });

    vi.advanceTimersByTime(6000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    vi.advanceTimersByTime(1_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("close", null, "SIGKILL");

    await expect(handle.completion).rejects.toThrow("exceeded its 5000 ms timeout");

    vi.useRealTimers();
  });

  it("cancels execution if output exceeds 1MB", async () => {
    vi.useFakeTimers();
    vi.mocked(fs.accessSync).mockImplementation(() => {});

    const child = mockSpawn();
    const handle = runner.start(defaultInput, { onProgress: vi.fn() });

    // Send > 1MB of data
    child.stdout.emit("data", Buffer.alloc(1_000_001));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    vi.advanceTimersByTime(1_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("close", null, "SIGKILL");

    await expect(handle.completion).rejects.toThrow("exceeded the 1 MB safety limit");

    vi.useRealTimers();
  });

  it("handles interactive mode correctly", async () => {
    vi.mocked(fs.accessSync).mockImplementation(() => {});

    const child = mockSpawn();
    const handle = runner.start(defaultInput, { interactive: true, onProgress: vi.fn() });

    expect(child_process.spawn).toHaveBeenCalledWith(
      "/usr/bin/sandbox-exec",
      expect.arrayContaining(["-p", expect.any(String), expect.stringContaining("python3"), "-u", "-c", expect.any(String), expect.any(String), "-la"]),
      expect.any(Object)
    );

    handle.write("input data");
    expect(child.stdin.write).toHaveBeenCalledWith("input data");

    child.emit("close", 0, null);
    await handle.completion;
  });

  it("cancels via AbortSignal", async () => {
    vi.useFakeTimers();
    vi.mocked(fs.accessSync).mockImplementation(() => {});

    const child = mockSpawn();
    const controller = new AbortController();
    const handle = runner.start(defaultInput, { signal: controller.signal, onProgress: vi.fn() });

    controller.abort(new Error("aborted manually"));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    vi.advanceTimersByTime(1_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    child.emit("close", null, "SIGKILL");

    await expect(handle.completion).rejects.toThrow("aborted manually");

    vi.useRealTimers();
  });

  it("escalates stop() to SIGKILL when SIGTERM does not exit the process", async () => {
    vi.useFakeTimers();
    vi.mocked(fs.accessSync).mockImplementation(() => {});

    const child = mockSpawn();
    const handle = runner.start(defaultInput, { onProgress: vi.fn() });

    handle.stop();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    vi.advanceTimersByTime(1_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    vi.useRealTimers();
  });

  it("does not spawn when the command is already cancelled", async () => {
    vi.mocked(fs.accessSync).mockImplementation(() => {});
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));

    const handle = runner.start(defaultInput, { signal: controller.signal, onProgress: vi.fn() });

    expect(child_process.spawn).not.toHaveBeenCalled();
    expect(handle.snapshot()).toMatchObject({ running: false, stdout: "", stderr: "" });
    await expect(handle.completion).rejects.toThrow("already cancelled");
  });

  it("waits for the owned child close before reporting an interrupted shutdown", async () => {
    vi.mocked(fs.accessSync).mockImplementation(() => {});
    const child = mockSpawn();
    const handle = runner.start(defaultInput, { interactive: true, onProgress: vi.fn() });
    const completion = handle.completion.catch(() => undefined);
    let settled = false;
    const closing = runner.close().finally(() => { settled = true; });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(() => runner.start(defaultInput, { onProgress: vi.fn() })).toThrow("shutting down");
    child.emit("close", null, "SIGTERM");
    await expect(closing).rejects.toThrow("descendant shutdown is unconfirmed");
    await completion;
  });

  it("permits a clean shutdown after a child has closed", async () => {
    vi.mocked(fs.accessSync).mockImplementation(() => {});
    const child = mockSpawn();
    const handle = runner.start(defaultInput, { onProgress: vi.fn() });
    child.emit("close", 0, null);
    await handle.completion;
    await expect(runner.close()).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("keeps shutdown clean when stop races an already exited child", async () => {
    vi.mocked(fs.accessSync).mockImplementation(() => {});
    const child = mockSpawn();
    const handle = runner.start(defaultInput, { onProgress: vi.fn() });
    Object.defineProperty(child, "exitCode", { value: 0, configurable: true });
    child.emit("close", 0, null);
    handle.stop();
    await handle.completion;
    await expect(runner.close()).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("remembers an interrupted child after its direct process closes", async () => {
    vi.mocked(fs.accessSync).mockImplementation(() => {});
    const child = mockSpawn();
    const handle = runner.start(defaultInput, { interactive: true, onProgress: vi.fn() });
    handle.stop();
    child.emit("close", null, "SIGTERM");
    await handle.completion;
    await expect(runner.close()).rejects.toThrow("descendant shutdown is unconfirmed");
  });

  it("fails closed if a signalled child never reports close", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fs.accessSync).mockImplementation(() => {});
      const child = mockSpawn();
      const handle = runner.start(defaultInput, { onProgress: vi.fn() });
      void handle.completion.catch(() => undefined);
      const closing = runner.close();
      const assertion = expect(closing).rejects.toThrow("shutdown was not confirmed");
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
      child.emit("close", null, "SIGKILL");
      await handle.completion.catch(() => undefined);
    } finally { vi.useRealTimers(); }
  });

  it.skipIf(hostPlatform !== "darwin")("blocks setsid while preserving process fork and exec", async () => {
    const actualSpawn = (await vi.importActual<typeof import("node:child_process")>("node:child_process")).spawn;
    vi.mocked(child_process.spawn).mockImplementation(actualSpawn);
    process.env.PATH = "/usr/bin";

    let handle: ReturnType<SandboxedCommandRunner["start"]> | undefined;
    const fixture = [
      "import os, sys",
      "try:",
      "    os.setsid()",
      "    print('setsid=allowed')",
      "except OSError as error:",
      "    print(f'setsid=denied:{error.errno}')",
      "pid = os.fork()",
      "if pid == 0:",
      "    os.execv('/usr/bin/true', ['true'])",
      "_, status = os.waitpid(pid, 0)",
      "print(f'fork-exec={os.waitstatus_to_exitcode(status)}')",
      "print(f'pty-stdin={int(sys.stdin.isatty())}', flush=True)",
      "print(f'input={sys.stdin.readline().strip()}', flush=True)",
    ].join("\n");

    try {
      handle = runner.start(
        { ...defaultInput, command: "python3", args: ["-u", "-c", fixture] },
        { interactive: true, onProgress: vi.fn() },
      );
      handle.write("ping\n");
      const result = await handle.completion;
      expect(result.stdout).toContain("setsid=denied:1");
      expect(result.stdout).toContain("fork-exec=0");
      expect(result.stdout).toContain("pty-stdin=1");
      expect(result.stdout).toContain("input=ping");
      await expect(runner.close()).resolves.toBeUndefined();
    } finally {
      if (handle) {
        handle.stop();
        await handle.completion.catch(() => undefined);
      }
    }
  });

  it.skipIf(hostPlatform !== "darwin")("reports unconfirmed shutdown for a stdio-closed setsid-denied descendant and blocks reuse", async () => {
    const actualSpawn = (await vi.importActual<typeof import("node:child_process")>("node:child_process")).spawn;
    vi.mocked(child_process.spawn).mockImplementation(actualSpawn);
    process.env.PATH = "/usr/bin";

    let descendantPid: number | undefined;
    let setsidResult: string | undefined;
    let handle: ReturnType<SandboxedCommandRunner["start"]> | undefined;
    let pidTimer: ReturnType<typeof setTimeout> | undefined;
    let output = "";
    let resolvePid!: (pid: number) => void;
    const pidReported = new Promise<number>((resolve, reject) => {
      resolvePid = resolve;
      pidTimer = setTimeout(() => reject(new Error("Descendant fixture did not report its PID.")), 5_000);
    });
    const fixture = [
      "import errno, os, time",
      "ready_read, ready_write = os.pipe()",
      "pid = os.fork()",
      "if pid == 0:",
      "    os.close(ready_read)",
      "    try:",
      "        os.setsid()",
      "        status = 'allowed'",
      "    except OSError as error:",
      "        status = errno.errorcode.get(error.errno, str(error.errno))",
      "    os.write(ready_write, status.encode())",
      "    os.close(ready_write)",
      "    deadline = time.monotonic() + 8",
      "    for fd in (0, 1, 2):",
      "        try: os.close(fd)",
      "        except OSError: pass",
      "    while time.monotonic() < deadline: time.sleep(0.1)",
      "else:",
      "    os.close(ready_write)",
      "    setsid_result = os.read(ready_read, 32).decode()",
      "    os.close(ready_read)",
      "    print(f'pid={pid} setsid={setsid_result}', flush=True)",
      "    while True: time.sleep(1)",
    ].join("\n");

    try {
      handle = runner.start(
        { ...defaultInput, command: "python3", args: ["-u", "-c", fixture] },
        {
          onProgress: ({ stream, chunk }) => {
            if (stream !== "stdout") return;
            output += chunk;
            const match = output.match(/pid=(\d+) setsid=([A-Z0-9]+)/);
            if (!match) return;
            const pid = Number.parseInt(match[1]!, 10);
            if (!Number.isSafeInteger(pid) || pid <= 0) return;
            setsidResult = match[2];
            resolvePid(pid);
          },
        },
      );
      const completion = handle.completion.catch(() => undefined);
      descendantPid = await pidReported;
      if (pidTimer) clearTimeout(pidTimer);

      expect(setsidResult).toBe("EPERM");
      await expect(runner.close()).rejects.toThrow("descendant shutdown is unconfirmed");
      expect(() => runner.start(defaultInput, { onProgress: vi.fn() })).toThrow("shutting down");
      expect(() => process.kill(descendantPid!, 0)).not.toThrow();
      await completion;
    } finally {
      if (pidTimer) clearTimeout(pidTimer);
      if (handle) {
        handle.stop();
        await handle.completion.catch(() => undefined);
      }
      if (descendantPid !== undefined) {
        try { process.kill(descendantPid, "SIGKILL"); } catch { /* It may already be gone. */ }
        const deadline = Date.now() + 2_000;
        let stillAlive = true;
        while (Date.now() < deadline) {
          try {
            process.kill(descendantPid, 0);
            await new Promise((resolve) => setTimeout(resolve, 10));
          } catch {
            stillAlive = false;
            break;
          }
        }
        expect(stillAlive).toBe(false);
      }
    }
  });
});
