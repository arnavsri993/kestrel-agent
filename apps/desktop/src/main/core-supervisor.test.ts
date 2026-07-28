import { EventEmitter, once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  utilityProcess: { fork: vi.fn() },
}));

import {
  CoreSupervisor,
  type CoreBootstrapConfig,
} from "./core-supervisor";

class FakeCoreProcess extends EventEmitter {
  readonly messages: unknown[] = [];
  exitOnShutdown = false;
  failCancellationPost = false;

  postMessage(message: unknown): void {
    if (
      this.failCancellationPost &&
      message &&
      typeof message === "object" &&
      (message as { request?: { type?: unknown } }).request?.type ===
        "runtime-cancel-stream"
    )
      throw new Error("IPC send failed.");
    this.messages.push(message);
    if (
      this.exitOnShutdown &&
      message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "shutdown"
    )
      this.emit("exit", 0);
  }

  kill(): boolean {
    this.emit("exit", 9);
    return true;
  }

  ready(): void {
    this.emit("message", { type: "ready" });
  }

  crash(code = 9): void {
    this.emit("exit", code);
  }
}

const config: CoreBootstrapConfig = {
  databasePath: "/tmp/kestrel-test.sqlite",
  encryptionKeyBase64: Buffer.alloc(32, 7).toString("base64"),
  workspaceRoots: ["/tmp/workspace"],
  configuredWorkspaceRoots: ["/tmp/workspace", "/Volumes/offline/project"],
  pluginRoots: ["/tmp/plugins"],
  managedPluginRoots: ["/tmp/managed-plugins"],
  learnedSkillRoot: "/tmp/learned-skills",
  secureEnvironment: { OPENAI_API_KEY: "protected-test-key" },
};

afterEach(() => {
  vi.useRealTimers();
});

describe("CoreSupervisor recovery", () => {
  it("keeps agent work alive past the control timeout and requests cancellation at its own deadline", async () => {
    vi.useFakeTimers();
    const child = new FakeCoreProcess();
    const supervisor = new CoreSupervisor(undefined, undefined, {
      processFactory: () => child,
      startupTimeoutMs: 500,
    });
    const started = supervisor.start(config);
    child.ready();
    await started;

    const request = supervisor.request({
      type: "runtime-run-agent",
      sessionId: "session-1",
      message: "Complete the long task",
      model: "auto",
      providerIds: ["auto"],
      streamId: "stream-long",
    });
    let settled = false;
    void request.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejected = expect(request).rejects.toThrow(
      "cancellation was requested",
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false);
    expect(child.messages).not.toContainEqual(
      expect.objectContaining({
        request: {
          type: "runtime-cancel-stream",
          streamId: "stream-long",
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(30 * 60_000 - 30_000);
    await rejected;
    expect(child.messages).toContainEqual({
      type: "request",
      requestId: "core-timeout-cancel-2",
      request: {
        type: "runtime-cancel-stream",
        streamId: "stream-long",
      },
    });

    child.emit("message", {
      requestId: "core-1",
      response: { ok: true },
    });
    child.exitOnShutdown = true;
    await supervisor.stop();
  });

  it("does not claim a timed-out run was cancelled when the cancellation post fails", async () => {
    vi.useFakeTimers();
    const child = new FakeCoreProcess();
    child.failCancellationPost = true;
    const supervisor = new CoreSupervisor(undefined, undefined, {
      processFactory: () => child,
      startupTimeoutMs: 500,
    });
    const started = supervisor.start(config);
    child.ready();
    await started;

    const rejected = expect(
      supervisor.request({
        type: "runtime-run-agent",
        sessionId: "session-1",
        message: "Complete the long task",
        model: "auto",
        providerIds: ["auto"],
        streamId: "stream-long",
      }),
    ).rejects.toThrow("could not request cancellation");
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await rejected;

    child.exitOnShutdown = true;
    await supervisor.stop();
  });

  it("restarts from the last successful bootstrap with bounded backoff", async () => {
    vi.useFakeTimers();
    const processes: FakeCoreProcess[] = [];
    const supervisor = new CoreSupervisor(undefined, undefined, {
      processFactory: () => {
        const child = new FakeCoreProcess();
        processes.push(child);
        return child;
      },
      restartDelaysMs: [10, 20],
      stabilityWindowMs: 1_000,
      startupTimeoutMs: 500,
    });

    const started = supervisor.start(config);
    processes[0]!.ready();
    await started;

    const recoveredOnce = once(supervisor, "recovered");
    processes[0]!.crash(7);
    await expect(supervisor.request({ type: "snapshot" })).rejects.toThrow(
      "restarting",
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(processes).toHaveLength(2);
    await expect(supervisor.request({ type: "snapshot" })).rejects.toThrow(
      "restarting",
    );
    expect(processes[1]!.messages[0]).toMatchObject({
      type: "bootstrap",
      config: {
        databasePath: config.databasePath,
        workspaceRoots: config.workspaceRoots,
        configuredWorkspaceRoots: config.configuredWorkspaceRoots,
        secureEnvironment: config.secureEnvironment,
      },
    });
    processes[1]!.ready();
    await recoveredOnce;

    const recoveredTwice = once(supervisor, "recovered");
    processes[1]!.crash(8);
    await vi.advanceTimersByTimeAsync(20);
    expect(processes).toHaveLength(3);
    processes[2]!.ready();
    await recoveredTwice;

    const failed = once(supervisor, "recovery-failed");
    processes[2]!.crash(9);
    const [error] = await failed;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("after 2 attempts");
    await expect(supervisor.request({ type: "snapshot" })).rejects.toThrow(
      "Restart Kestrel",
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(processes).toHaveLength(3);
  });

  it("cancels a scheduled recovery when the supervisor is stopped", async () => {
    vi.useFakeTimers();
    const processes: FakeCoreProcess[] = [];
    const supervisor = new CoreSupervisor(undefined, undefined, {
      processFactory: () => {
        const child = new FakeCoreProcess();
        processes.push(child);
        return child;
      },
      restartDelaysMs: [50],
      startupTimeoutMs: 500,
    });
    const started = supervisor.start(config);
    processes[0]!.ready();
    await started;
    processes[0]!.crash();
    await supervisor.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(processes).toHaveLength(1);
  });

  it("observes an immediate clean exit without waiting for the kill timeout", async () => {
    vi.useFakeTimers();
    const child = new FakeCoreProcess();
    child.exitOnShutdown = true;
    const supervisor = new CoreSupervisor(undefined, undefined, {
      processFactory: () => child,
      startupTimeoutMs: 500,
    });
    const started = supervisor.start(config);
    child.ready();
    await started;

    await supervisor.stop();

    expect(child.messages).toContainEqual({ type: "shutdown" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not restart after stop while crash cleanup is still pending", async () => {
    vi.useFakeTimers();
    const processes: FakeCoreProcess[] = [];
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const supervisor = new CoreSupervisor(
      undefined,
      () => cleanup,
      {
        processFactory: () => {
          const child = new FakeCoreProcess();
          processes.push(child);
          return child;
        },
        restartDelaysMs: [10],
        startupTimeoutMs: 500,
      },
    );
    const started = supervisor.start(config);
    processes[0]!.ready();
    await started;

    processes[0]!.crash();
    await vi.advanceTimersByTimeAsync(10);
    const stopped = supervisor.stop();
    finishCleanup();
    await stopped;
    await vi.runAllTimersAsync();

    expect(processes).toHaveLength(1);
  });
});
