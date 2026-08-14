import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { SandboxedCommandRunner } from "./command-runner";
import * as child_process from "node:child_process";
import * as fs from "node:fs";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  accessSync: vi.fn(),
  constants: { X_OK: 1 },
}));

describe("SandboxedCommandRunner", () => {
  let originalPlatform: string;
  let runner: SandboxedCommandRunner;

  beforeEach(() => {
    originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.resetAllMocks();
    runner = new SandboxedCommandRunner();
    process.env.PATH = "/bin:/usr/bin";
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
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
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write: vi.fn(),
      destroyed: false,
    };
    child.kill = vi.fn();
    child.pid = 12345;
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
    child.emit("close", null, "SIGTERM");

    await expect(handle.completion).rejects.toThrow("exceeded its 5000 ms timeout");

    vi.useRealTimers();
  });

  it("cancels execution if output exceeds 1MB", async () => {
    vi.mocked(fs.accessSync).mockImplementation(() => {});

    const child = mockSpawn();
    const handle = runner.start(defaultInput, { onProgress: vi.fn() });

    // Send > 1MB of data
    child.stdout.emit("data", Buffer.alloc(1_000_001));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null, "SIGTERM");

    await expect(handle.completion).rejects.toThrow("exceeded the 1 MB safety limit");
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
    vi.mocked(fs.accessSync).mockImplementation(() => {});

    const child = mockSpawn();
    const controller = new AbortController();
    const handle = runner.start(defaultInput, { signal: controller.signal, onProgress: vi.fn() });

    controller.abort(new Error("aborted manually"));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("close", null, "SIGTERM");

    await expect(handle.completion).rejects.toThrow("aborted manually");
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
});
