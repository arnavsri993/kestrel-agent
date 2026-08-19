import { EventEmitter, once } from "node:events";
import {
	ProtectedDatabaseError,
	PROTECTED_DATABASE_ERROR_CODE,
} from "@kestrel/database";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	utilityProcess: { fork: vi.fn() },
}));

import { type CoreBootstrapConfig, CoreSupervisor } from "./core-supervisor";

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

	it("surfaces a bootstrap error and does not leave a dead core behind", async () => {
		const child = new FakeCoreProcess();
		const supervisor = new CoreSupervisor(undefined, undefined, {
			processFactory: () => child,
			startupTimeoutMs: 500,
		});

		const started = supervisor.start(config);
		child.emit("message", {
			type: "start-error",
			error: "The active agent configuration is unavailable.",
		});

		await expect(started).rejects.toThrow(
			"The active agent configuration is unavailable.",
		);
		await expect(supervisor.request({ type: "snapshot" })).rejects.toThrow(
			"Agent Core is unavailable.",
		);
	});

	it("preserves protected-profile bootstrap failures across the utility boundary", async () => {
		const child = new FakeCoreProcess();
		const supervisor = new CoreSupervisor(undefined, undefined, {
			processFactory: () => child,
			startupTimeoutMs: 500,
		});

		const started = supervisor.start(config);
		child.emit("message", {
			type: "start-error",
			error: "The encrypted profile could not be decrypted.",
			errorCode: PROTECTED_DATABASE_ERROR_CODE,
		});

		await expect(started).rejects.toBeInstanceOf(ProtectedDatabaseError);
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

	it("does not treat a malformed startup timeout as immediate", async () => {
		vi.useFakeTimers();
		const child = new FakeCoreProcess();
		const supervisor = new CoreSupervisor(undefined, undefined, {
			processFactory: () => child,
			startupTimeoutMs: Number.NaN,
			stabilityWindowMs: Number.POSITIVE_INFINITY,
			restartDelaysMs: [Number.POSITIVE_INFINITY],
		});
		const started = supervisor.start(config);
		let settled = false;
		void started.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toBe(false);
		child.ready();
		await started;
		child.exitOnShutdown = true;
		await supervisor.stop();
	});

	it("does not restart after stop while crash cleanup is still pending", async () => {
		vi.useFakeTimers();
		const processes: FakeCoreProcess[] = [];
		let finishCleanup!: () => void;
		const cleanup = new Promise<void>((resolve) => {
			finishCleanup = resolve;
		});
		const supervisor = new CoreSupervisor(undefined, () => cleanup, {
			processFactory: () => {
				const child = new FakeCoreProcess();
				processes.push(child);
				return child;
			},
			restartDelaysMs: [10],
			startupTimeoutMs: 500,
		});
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

describe("CoreSupervisor browser backend IPC", () => {
	it("forwards a valid snapshot request and rejects hostile desktop-act payloads", async () => {
		const child = new FakeCoreProcess();
		const handler = vi.fn(async () => ({ ok: true }));
		const errors: Error[] = [];
		const supervisor = new CoreSupervisor(handler, undefined, {
			processFactory: () => child,
			startupTimeoutMs: 500,
		});
		supervisor.on("automation-error", (error) => errors.push(error));
		const started = supervisor.start(config);
		child.ready();
		await started;

		child.emit("message", {
			type: "browser-backend-request",
			requestId: "req-snapshot",
			request: { operation: "snapshot", sessionId: "electron-browser-1" },
		});
		await vi.waitFor(() =>
			expect(handler).toHaveBeenCalledWith(
				{ operation: "snapshot", sessionId: "electron-browser-1" },
				expect.any(AbortSignal),
			),
		);

		child.emit("message", {
			type: "browser-backend-request",
			requestId: "req-bad",
			request: { operation: "desktop-act", action: { type: "click", x: "1", y: 2 } },
		});
		child.emit("message", {
			type: "browser-backend-request",
			requestId: "req-act",
			request: { operation: "visible-act" },
		});
		child.emit("message", {
			type: "browser-backend-request",
			request: { operation: "visible-tabs" },
		});
		await vi.waitFor(() => expect(errors.length).toBeGreaterThanOrEqual(3));
		expect(handler).toHaveBeenCalledTimes(1);
		await supervisor.stop();
	});
});
