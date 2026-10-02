import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TASK_SECRET_CLEANUP_LIMITS, TaskSecretVault } from "./task-secrets";

const fixtureSecret = "fixture-sensitive-Alpha123456789";

function reference(text: string): string {
	const match = text.match(/\[TASK_SECRET:([^\]]+)\]/);
	if (!match) throw new Error("Expected an opaque temporary credential reference.");
	return match[1]!;
}

function prepare(vault: TaskSecretVault, sessionId = "session-a", runId = "run-a") {
	const result = vault.prepare(sessionId, `API_KEY=${fixtureSecret}`);
	expect(result.scopeId).toBeDefined();
	vault.bind(result.scopeId!, sessionId, runId);
	return { ...result, ref: reference(result.text) };
}

describe("temporary task credential vault", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
	});
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it("keeps model-facing text opaque and resolves only for the bound session and task", () => {
		const vault = new TaskSecretVault();
		const prepared = prepare(vault);
		expect(prepared.text).not.toContain(fixtureSecret);
		expect(vault.resolve("session-a", "run-a", { SERVICE_API_KEY: prepared.ref })).toEqual({ SERVICE_API_KEY: fixtureSecret });
		expect(() => vault.resolve("session-b", "run-a", { SERVICE_API_KEY: prepared.ref })).toThrow();
		expect(() => vault.resolve("session-a", "run-b", { SERVICE_API_KEY: prepared.ref })).toThrow();
		expect(() => vault.bind(prepared.scopeId!, "session-b", "run-a")).toThrow();
		expect(() => vault.bind(prepared.scopeId!, "session-a", "run-b")).toThrow();
	});

	it("gives identical secrets distinct task references and clears only the selected task", () => {
		const vault = new TaskSecretVault();
		const first = prepare(vault);
		const second = prepare(vault, "session-a", "run-b");
		expect(first.ref).not.toBe(second.ref);
		expect(vault.clearRun("run-a")).toMatchObject({ removed: 1, remaining: 0, verified: true });
		expect(() => vault.resolve("session-a", "run-a", { API_KEY: first.ref })).toThrow();
		expect(vault.resolve("session-a", "run-b", { API_KEY: second.ref })).toEqual({ API_KEY: fixtureSecret });
	});

	it("replaces every occurrence of a detected credential, including an unlabelled repetition", () => {
		const vault = new TaskSecretVault();
		const prepared = vault.prepare("session-a", `API_KEY=${fixtureSecret}; repeat ${fixtureSecret} for the same setup.`);
		expect(prepared.text).not.toContain(fixtureSecret);
		const refs = [...prepared.text.matchAll(/\[TASK_SECRET:([^\]]+)\]/g)].map((match) => match[1]);
		expect(refs).toHaveLength(2);
		expect(new Set(refs).size).toBe(1);
		vault.bind(prepared.scopeId!, "session-a", "run-a");
		expect(vault.resolve("session-a", "run-a", { API_KEY: refs[0]! })).toEqual({ API_KEY: fixtureSecret });
		expect(vault.clearRun("run-a")).toMatchObject({ removed: 1, verified: true });
	});

	it("zeroes retained buffers before removing the scope and reports the exact cleanup boundary", () => {
		const vault = new TaskSecretVault();
		const prepared = prepare(vault);
		// Retain the actual allocation to distinguish zeroing from deleting a Map entry.
		const scopes = (vault as unknown as { scopes: Map<string, { values: Map<string, Buffer> }> }).scopes;
		const bytes = scopes.get(prepared.scopeId!)!.values.get(prepared.ref)!;
		expect(bytes.toString("utf8")).toBe(fixtureSecret);
		expect(vault.clearRun("run-a")).toEqual({
			method: "temporary-secret-store-readback", removed: 1, remaining: 0,
			verified: true, limits: TASK_SECRET_CLEANUP_LIMITS,
		});
		expect(bytes.every((byte) => byte === 0)).toBe(true);
		expect(scopes.has(prepared.scopeId!)).toBe(false);
		expect(() => vault.resolve("session-a", "run-a", { API_KEY: prepared.ref })).toThrow();
		expect(vault.clearRun("run-a")).toBeUndefined();
		expect(TASK_SECRET_CLEANUP_LIMITS).toMatch(/CLI files.*provider retention.*backups.*process memory/);
	});

	it("does not allocate storage for normal text or already opaque placeholders", () => {
		const vault = new TaskSecretVault();
		expect(vault.prepare("session-a", "Set up the CLI.")).toEqual({ text: "Set up the CLI." });
		expect(vault.prepare("session-a", "API_KEY=[TASK_SECRET:unknown]")).toEqual({ text: "API_KEY=[TASK_SECRET:unknown]" });
		expect(() => vault.resolve("session-a", "run-a", { API_KEY: "unknown" })).toThrow();
	});

	it("rejects expired references and zeroes their allocations while retaining honest cleanup counts", () => {
		const vault = new TaskSecretVault(100);
		const prepared = prepare(vault);
		const scopes = (vault as unknown as { scopes: Map<string, { values: Map<string, Buffer> }> }).scopes;
		const bytes = scopes.get(prepared.scopeId!)!.values.get(prepared.ref)!;
		vi.advanceTimersByTime(101);
		expect(() => vault.resolve("session-a", "run-a", { API_KEY: prepared.ref })).toThrow();
		expect(bytes.every((byte) => byte === 0)).toBe(true);
		expect(vault.clearRun("run-a")).toMatchObject({ removed: 1, remaining: 0, verified: true });
	});

	it("checks expiration even when the timer has not fired", () => {
		const vault = new TaskSecretVault(100);
		const prepared = prepare(vault);
		vi.setSystemTime(new Date("2026-10-01T12:00:01Z"));
		expect(() => vault.resolve("session-a", "run-a", { API_KEY: prepared.ref })).toThrow();
	});

	it.each(["PATH", "NODE_OPTIONS", "PYTHONPATH", "DYLD_INSERT_LIBRARIES", "HOME", "BASH_ENV", "npm_config_userconfig"])(
		"rejects environment control variable %s without mutating the parent environment", (name) => {
			const vault = new TaskSecretVault();
			const prepared = prepare(vault);
			const previous = process.env[name];
			expect(() => vault.resolve("session-a", "run-a", { API_KEY: prepared.ref, [name]: prepared.ref })).toThrow(/credential environment/);
			expect(process.env[name]).toBe(previous);
			expect(vault.resolve("session-a", "run-a", { API_KEY: prepared.ref })).toEqual({ API_KEY: fixtureSecret });
		},
	);

	it("fails extraction atomically when capacity is exceeded and permits a fresh task afterward", () => {
		const vault = new TaskSecretVault();
		const input = Array.from({ length: 17 }, (_value, index) => `SERVICE_${index}_API_KEY=fixture-sensitive-${index}-Alpha123456789`).join("\n");
		const allocations: Buffer[] = [];
		const originalFrom = Buffer.from;
		const allocationSpy = vi.spyOn(Buffer, "from").mockImplementation(((value: unknown, ...arguments_: unknown[]) => {
			const allocated = Reflect.apply(originalFrom, Buffer, [value, ...arguments_]) as Buffer;
			if (typeof value === "string" && value.startsWith("fixture-sensitive-")) allocations.push(allocated);
			return allocated;
		}) as typeof Buffer.from);
		try {
			expect(() => vault.prepare("session-a", input)).toThrow(/capacity/);
		} finally {
			allocationSpy.mockRestore();
		}
		expect(allocations).toHaveLength(16);
		expect(allocations.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
		expect(vault.redact("session-a", fixtureSecret)).toBe(fixtureSecret);
		expect((vault as unknown as { scopes: Map<string, unknown> }).scopes.size).toBe(0);
		const fresh = prepare(vault);
		expect(vault.clearRun("run-a")).toMatchObject({ removed: 1, verified: true });
		expect(() => vault.resolve("session-a", "run-a", { API_KEY: fresh.ref })).toThrow();
	});

	it("rejects excess concurrent scopes without damaging existing tasks and recovers capacity after cleanup", () => {
		const vault = new TaskSecretVault();
		const tasks = Array.from({ length: 64 }, (_value, index) => prepare(vault, "session-a", `run-${index}`));
		expect(() => vault.prepare("session-b", `API_KEY=${fixtureSecret}`)).toThrow(/capacity/);
		expect(vault.resolve("session-a", "run-0", { API_KEY: tasks[0]!.ref })).toEqual({ API_KEY: fixtureSecret });
		vault.clearSession("session-a");
		const recovered = prepare(vault, "session-b", "recovered-run");
		expect(vault.resolve("session-b", "recovered-run", { API_KEY: recovered.ref })).toEqual({ API_KEY: fixtureSecret });
	});

	it("clears all tasks for one session while leaving another session usable", () => {
		const vault = new TaskSecretVault();
		const first = prepare(vault);
		const other = prepare(vault, "session-b", "run-b");
		vault.clearSession("session-a");
		expect(() => vault.resolve("session-a", "run-a", { API_KEY: first.ref })).toThrow();
		expect(vault.resolve("session-b", "run-b", { API_KEY: other.ref })).toEqual({ API_KEY: fixtureSecret });
	});

	it("redacts known values only within their session and also masks recognizable new credentials", () => {
		const vault = new TaskSecretVault();
		prepare(vault);
		expect(vault.redact("session-a", `command echoed ${fixtureSecret}`)).toBe("command echoed [REDACTED]");
		expect(vault.redact("session-b", `command echoed ${fixtureSecret}`)).toBe(`command echoed ${fixtureSecret}`);
		expect(vault.redact("session-b", `api_key=${fixtureSecret}`)).toBe("api_key=[REDACTED]");
	});
});
