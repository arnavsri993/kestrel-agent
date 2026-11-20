import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalSecretConfiguration } from "@kestrel/shared-types";
import { CredentialBroker } from "./credential-broker";
import { DEFAULT_EXTERNAL_SECRET_CONFIGURATION } from "./external-secret-manager";
import {
	NativeExternalSecretHost,
	NATIVE_EXTERNAL_SECRET_REQUEST_TYPES,
} from "./native-external-secret-host";

const roots: string[] = [];
const helperPids: number[] = [];
const protection = {
	isEncryptionAvailable: () => true,
	encryptString: async (value: string) =>
		Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`),
	decryptString: async (value: Buffer) =>
		Buffer.from(value.toString().slice("sealed:".length), "base64").toString(),
};

afterEach(async () => {
	for (const pid of helperPids.splice(0)) {
		try { process.kill(pid, "SIGKILL"); } catch { /* The child already exited. */ }
	}
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

type SettingsMutation = (mutation: () => Promise<unknown>, rollback?: () => Promise<void>, validate?: () => void) => Promise<unknown>;
async function fixture(options: {
	mutateSettings?: SettingsMutation;
	execute?: (file: string, args: string[], settings: { env: NodeJS.ProcessEnv; timeoutMs: number; maxBuffer: number }) => Promise<{ stdout: string }>;
	fetch?: typeof fetch;
	reconfigure?: (
		mutation: () => Promise<unknown>,
		rollback?: () => Promise<void>,
		validate?: () => void,
		shouldRestoreCore?: () => boolean,
	) => Promise<unknown>;
} = {}) {
	const root = await mkdtemp(join(tmpdir(), "kestrel-native-external-secrets-"));
	roots.push(root);
	const helper = join(root, "fake-helper");
	await writeFile(helper, "fixture executable; never invoked", { mode: 0o700 });
	await chmod(helper, 0o700);
	const broker = new CredentialBroker(root, protection);
	let host!: NativeExternalSecretHost;
	const reconfigure = vi.fn(async (
		mutation: () => Promise<unknown>,
		rollback?: () => Promise<void>,
		validate?: () => void,
		shouldRestoreCore?: () => boolean,
	) => {
		if (options.reconfigure) return options.reconfigure(mutation, rollback, validate, shouldRestoreCore);
		return mutation();
	});
	const mutateSettings = vi.fn(async (mutation: () => Promise<unknown>, rollback?: () => Promise<void>, validate?: () => void) => {
		if (options.mutateSettings) return options.mutateSettings(mutation, rollback, validate);
		try { validate?.(); const result = await mutation(); validate?.(); return result; }
		catch (error) { await rollback?.(); throw error; }
	});
	host = new NativeExternalSecretHost({
		root,
		broker,
		mutateSettings: mutateSettings as <T>(mutation: () => Promise<T>, rollback?: () => Promise<void>, validate?: () => void) => Promise<T>,
		reconfigure: reconfigure as <T>(mutation: () => Promise<T>, rollback?: () => Promise<void>, validate?: () => void, shouldRestoreCore?: () => boolean) => Promise<T>,
		dependencies: {
			...(options.execute ? { execute: options.execute } : {}),
			...(options.fetch ? { fetch: options.fetch } : {}),
		},
		shouldRestoreCore: () => true,
	});
	return { root, helper, broker, host, reconfigure, mutateSettings };
}

function commandConfig(helper: string): ExternalSecretConfiguration {
	const configuration = structuredClone(DEFAULT_EXTERNAL_SECRET_CONFIGURATION);
	configuration.command = {
		enabled: true,
		executablePath: helper,
		arguments: ["--fixture"],
		timeoutMs: 1_000,
		overrideStored: false,
	};
	return configuration;
}

describe("native external-secret host", () => {
	it.each(["save", "sync", "remove"] as const)("reports committed %s when cancellation arrives after transaction completion", async kind => {
		const controller = new AbortController();
		let host!: NativeExternalSecretHost;
		const completeThenCancel: SettingsMutation = async (mutation, _rollback, validate) => {
			const result = await mutation(); validate?.();
			if (kind === "sync") await host.runtimeCredentials();
			controller.abort();
			return result;
		};
		const item = await fixture({
			execute: async () => ({ stdout: "GITHUB_TOKEN=fixture-committed-source-token" }),
			mutateSettings: completeThenCancel,
			reconfigure: completeThenCancel,
		});
		host = item.host;
		await item.broker.setOpaqueSecret("external-secret-configuration", JSON.stringify(commandConfig(item.helper)));
		const request = kind === "save"
			? { type: "external-secret-save", configuration: commandConfig(item.helper) }
			: { type: `external-secret-${kind}`, providerId: "command" };
		const result = await host.handle(request, controller.signal);
		expect(controller.signal.aborted).toBe(true);
		expect(result).toMatchObject({ ok: true, externalSecretConfiguration: { command: { enabled: kind !== "remove" } } });
		expect(JSON.stringify(result)).not.toContain("fixture-committed-source-token");
		await host.close();
	});
	it("exposes only the five validated operations and stores bootstrap tokens encrypted", async () => {
		const { root, host } = await fixture();
		expect([...NATIVE_EXTERNAL_SECRET_REQUEST_TYPES].sort()).toEqual([
			"external-secret-install-bitwarden",
			"external-secret-list",
			"external-secret-remove",
			"external-secret-save",
			"external-secret-sync",
		]);
		for (const raw of [null, {}, { type: "runtime-run-agent" }, { type: "external-secret-sync", providerId: "other" }])
			expect((await host.handle(raw)).ok).toBe(false);

		const onePasswordToken = "fixture-onepassword-bootstrap-secret";
		const bitwardenToken = "fixture-bitwarden-bootstrap-secret";
		const saved = await host.handle({
			type: "external-secret-save",
			configuration: structuredClone(DEFAULT_EXTERNAL_SECRET_CONFIGURATION),
			onePasswordToken,
			bitwardenToken,
		});
		expect(saved).toMatchObject({ ok: true, externalSecretSources: expect.any(Array) });
		expect(JSON.stringify(saved)).not.toContain(onePasswordToken);
		expect(JSON.stringify(saved)).not.toContain(bitwardenToken);
		const files = await readdir(join(root, "secure", "credentials"));
		expect(files).toEqual(expect.arrayContaining([
			"opaque-external-secret-configuration.bin",
			"opaque-external-secret-onepassword-token.bin",
			"opaque-external-secret-bitwarden-token.bin",
		]));
		for (const file of files) {
			const bytes = await readFile(join(root, "secure", "credentials", file), "utf8");
			expect(bytes).not.toContain(onePasswordToken);
			expect(bytes).not.toContain(bitwardenToken);
		}
		await host.close();
	});

	it("saves an enabled source without executing it or restarting Core", async () => {
		const execute = vi.fn(async () => ({ stdout: "GITHUB_TOKEN=fixture-saved-source-token" }));
		const item = await fixture({ execute });
		expect((await item.host.handle({ type: "external-secret-save", configuration: commandConfig(item.helper) })).ok).toBe(true);
		expect(item.mutateSettings).toHaveBeenCalledOnce();
		expect(item.reconfigure).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
		await item.host.close();
	});

	it("resolves an explicitly selected source once and consumes its staged values once", async () => {
		let host!: NativeExternalSecretHost;
		let runtime: unknown;
		const calls: string[] = [];
		const item = await fixture({
			execute: async (file) => { calls.push(file); return { stdout: "GITHUB_TOKEN=fixture-provider-secret\n" }; },
			reconfigure: async (mutation) => {
				const result = await mutation();
				runtime = await host.runtimeCredentials();
				return result;
			},
		});
		host = item.host;
		await item.host.handle({ type: "external-secret-save", configuration: commandConfig(item.helper) });
		calls.length = 0;
		const result = await item.host.handle({ type: "external-secret-sync", providerId: "command" });
		expect(result).toMatchObject({ ok: true, externalSecretSources: expect.arrayContaining([expect.objectContaining({ id: "command", state: "verified" })]) });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatch(/fake-helper$/);
		expect(runtime).toEqual({ values: { github: "fixture-provider-secret" }, overrideStoredIds: [] });
		expect(JSON.stringify(result)).not.toContain("fixture-provider-secret");
		expect(await item.host.runtimeCredentials()).toEqual({ values: { github: "fixture-provider-secret" }, overrideStoredIds: [] });
		expect(calls).toHaveLength(2);
		await item.host.close();
	});

	it.each(["", "UNRELATED_PRIVATE_VALUE=fixture-unknown-secret\n"])(
		"rejects a verified source with no supported credentials (%j)",
		async (stdout) => {
			const item = await fixture({ execute: async () => ({ stdout }) });
			await item.host.handle({ type: "external-secret-save", configuration: commandConfig(item.helper) });
			const result = await item.host.handle({ type: "external-secret-sync", providerId: "command" });
			expect(result).toEqual({ ok: false, error: "The selected secret source could not be verified." });
			expect(JSON.stringify(result)).not.toContain("fixture-unknown-secret");
			await item.host.close();
		},
	);

	it("does not execute or persist when the Core reconfiguration admission check denies the mutation", async () => {
		const execute = vi.fn(async () => ({ stdout: "GITHUB_TOKEN=fixture-secret-value" }));
		const item = await fixture({
			execute,
			mutateSettings: async () => { throw new Error("task busy; private diagnostics"); },
		});
		const response = await item.host.handle({
			type: "external-secret-save",
			configuration: commandConfig(item.helper),
			onePasswordToken: "fixture-never-persisted-token",
		});
		expect(response).toEqual({ ok: false, error: "External secret settings could not be saved." });
		expect(execute).not.toHaveBeenCalled();
		await expect(readdir(join(item.root, "secure", "credentials"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(JSON.stringify(response)).not.toMatch(/private diagnostics|fixture-never-persisted-token/);
		await item.host.close();
	});

	it("checks cancellation at Core reconfiguration validation and before starting a mutation", async () => {
		const before = new AbortController();
		before.abort();
		const rejected = await fixture();
		expect(await rejected.host.handle({
			type: "external-secret-save",
			configuration: structuredClone(DEFAULT_EXTERNAL_SECRET_CONFIGURATION),
		}, before.signal)).toEqual({ ok: false, error: "The native external-secret request was cancelled." });
		expect(rejected.reconfigure).not.toHaveBeenCalled();
		await rejected.host.close();

		const controller = new AbortController();
		let validationReached = false;
		const item = await fixture({
			mutateSettings: async (mutation, _rollback, validate) => {
				await mutation();
				controller.abort();
				validationReached = true;
				validate?.();
				return undefined;
			},
		});
		const result = await item.host.handle({
			type: "external-secret-save",
			configuration: structuredClone(DEFAULT_EXTERNAL_SECRET_CONFIGURATION),
		}, controller.signal);
		expect(validationReached).toBe(true);
		expect(result).toEqual({ ok: false, error: "External secret settings could not be saved." });
		await item.host.close();
	});

	it.each(["save", "remove"] as const)(
		"restores opaque configuration and bootstrap tokens after cancelled %s mutation",
		async (kind) => {
			const controller = new AbortController();
			const cancelledMutation: SettingsMutation = async (mutation, rollback, validate) => {
				try {
					const result = await mutation(); controller.abort(); validate?.(); return result;
				} catch (error) { await rollback?.(); throw error; }
			};
			const item = await fixture(kind === "save" ? { mutateSettings: cancelledMutation } : { reconfigure: cancelledMutation });
			const previous = structuredClone(DEFAULT_EXTERNAL_SECRET_CONFIGURATION);
			previous.bitwarden = {
				enabled: true,
				projectId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
				serverUrl: "https://vault.example.test",
				autoInstall: false,
				overrideStored: true,
			};
		const oldConfiguration = JSON.stringify(previous);
		const oldOnePassword = "fixture-old-onepassword-token";
		const oldBitwarden = "fixture-old-bitwarden-token";
		await item.broker.setOpaqueSecret("external-secret-configuration", oldConfiguration);
		await item.broker.setOpaqueSecret("external-secret-onepassword-token", oldOnePassword);
		await item.broker.setOpaqueSecret("external-secret-bitwarden-token", oldBitwarden);

		const request = kind === "save"
			? {
				type: "external-secret-save",
				configuration: structuredClone(DEFAULT_EXTERNAL_SECRET_CONFIGURATION),
				onePasswordToken: "fixture-new-onepassword-token",
				bitwardenToken: "fixture-new-bitwarden-token",
			}
			: { type: "external-secret-remove", providerId: "bitwarden" };
		const response = await item.host.handle(request, controller.signal);
		expect(response.ok).toBe(false);
		expect(await item.broker.getOpaqueSecret("external-secret-configuration")).toBe(oldConfiguration);
		expect(await item.broker.getOpaqueSecret("external-secret-onepassword-token")).toBe(oldOnePassword);
		expect(await item.broker.getOpaqueSecret("external-secret-bitwarden-token")).toBe(oldBitwarden);
		expect(JSON.stringify(response)).not.toMatch(/fixture-(?:old|new)-(?:onepassword|bitwarden)-token/);
		await item.host.close();
		},
	);

	it("drops staged credentials when an injected provider operation ignores cancellation", async () => {
		let announceStarted!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => { announceStarted = resolve; });
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let calls = 0;
		const item = await fixture({
			execute: async () => {
				calls += 1;
				announceStarted();
				await gate;
				return { stdout: "GITHUB_TOKEN=fixture-provider-secret" };
			},
		});
		await item.host.handle({ type: "external-secret-save", configuration: commandConfig(item.helper) });
		const controller = new AbortController();
		const sync = item.host.handle({ type: "external-secret-sync", providerId: "command" }, controller.signal);
		await started;
		await expect(item.host.runtimeCredentials()).rejects.toThrow(
			"External secret settings are already being changed.",
		);
		expect(calls).toBe(1);
		controller.abort();
		release();
		expect(await sync).toEqual({ ok: false, error: "The selected secret source could not be verified." });
		expect(calls).toBe(1);
		await item.host.runtimeCredentials();
		expect(calls).toBe(2);
		await item.host.close();
	});

	it("clears resolved credentials when the Core sync reconfiguration fails before consumption", async () => {
		let host!: NativeExternalSecretHost;
		let calls = 0;
		const item = await fixture({
			execute: async () => {
				calls += 1;
				return { stdout: "GITHUB_TOKEN=fixture-provider-secret" };
			},
			reconfigure: async (mutation) => {
				await mutation();
				throw new Error("restart failed");
			},
		});
		host = item.host;
		await item.host.handle({ type: "external-secret-save", configuration: commandConfig(item.helper) });
		const result = await host.handle({ type: "external-secret-sync", providerId: "command" });
		expect(result).toEqual({ ok: false, error: "The selected secret source could not be verified." });
		expect(calls).toBe(1);
		await host.runtimeCredentials();
		expect(calls).toBe(2);
		await host.close();
	});

	it("aborts and awaits an initial runtime credential process when closing", async () => {
		const item = await fixture();
		const pidPath = join(item.root, "provider-child.pid");
		const helperSource = [
			`#!${process.execPath}`,
			`require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
			"process.on('SIGTERM', () => {});",
			"setInterval(() => {}, 1000);",
		].join("\n");
		await writeFile(item.helper, helperSource, { mode: 0o700 });
		await chmod(item.helper, 0o700);
		const configuration = commandConfig(item.helper);
		configuration.command.timeoutMs = 10_000;
		await item.host.handle({ type: "external-secret-save", configuration });

		let pid: number | undefined;
		const resolution = item.host.runtimeCredentials();
		for (let attempt = 0; attempt < 100 && pid === undefined; attempt += 1) {
			try {
				pid = Number(await readFile(pidPath, "utf8"));
				if (pid > 0) helperPids.push(pid);
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		}
		expect(pid).toBeGreaterThan(0);
		const closing = item.host.close();
		await expect(resolution).rejects.toThrow();
		await closing;
		if (pid) {
			let state = "";
			try {
				state = execFileSync("/bin/ps", ["-p", String(pid), "-o", "stat=,command="], { encoding: "utf8" }).trim();
			} catch { /* ps exits nonzero when the generated child no longer exists. */ }
			expect(state === "" || state.startsWith("Z"), `remaining generated provider process: ${state}`).toBe(true);
			helperPids.splice(helperPids.indexOf(pid), 1);
		}
	});

	it("returns state-derived details instead of provider error text", async () => {
		const item = await fixture({ execute: async () => { throw new Error("fixture-private-source-value"); } });
		await item.host.handle({ type: "external-secret-save", configuration: commandConfig(item.helper) });
		expect(await item.host.handle({ type: "external-secret-sync", providerId: "command" })).toEqual({
			ok: false,
			error: "The selected secret source could not be verified.",
		});
		const listed = await item.host.handle({ type: "external-secret-list" });
		expect(JSON.stringify(listed)).not.toContain("fixture-private-source-value");
		if (listed.ok && "externalSecretSources" in listed) {
			expect(listed.externalSecretSources).toContainEqual(expect.objectContaining({
				id: "command",
				state: "error",
				detail: "Verification failed. Check the source settings and retry.",
			}));
		}
		await item.host.close();
	});

	it("never auto-downloads Bitwarden during sync; installation requires its explicit request", async () => {
		const fetcher = vi.fn<typeof fetch>(async () => { throw new Error("test fetch must remain unused"); });
		const item = await fixture({ fetch: fetcher });
		const configuration = structuredClone(DEFAULT_EXTERNAL_SECRET_CONFIGURATION);
		configuration.bitwarden = {
			enabled: true,
			projectId: "11111111-2222-4333-8444-555555555555",
			serverUrl: "",
			autoInstall: true,
			overrideStored: true,
		};
		await item.host.handle({
			type: "external-secret-save",
			configuration,
			bitwardenToken: "fixture-machine-account-token",
		});
		const result = await item.host.handle({ type: "external-secret-sync", providerId: "bitwarden" });
		expect(result).toEqual({ ok: false, error: "The selected secret source could not be verified." });
		expect(fetcher).not.toHaveBeenCalled();
		expect(JSON.stringify(result)).not.toContain("fixture-machine-account-token");
		await item.host.close();
	});

	it("sanitizes provider failures and close waits for the active mutation", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const item = await fixture({
			execute: async () => { await gate; throw new Error("raw fixture provider secret and stderr"); },
		});
		await item.host.handle({ type: "external-secret-save", configuration: commandConfig(item.helper) });
		const sync = item.host.handle({ type: "external-secret-sync", providerId: "command" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		let closed = false;
		const closing = item.host.close().then(() => { closed = true; });
		expect((await item.host.handle({ type: "external-secret-list" })).ok).toBe(false);
		expect(closed).toBe(false);
		release();
		const result = await sync;
		expect(result).toEqual({ ok: false, error: "The selected secret source could not be verified." });
		await closing;
		expect(closed).toBe(true);
		expect(JSON.stringify(result)).not.toMatch(/fixture provider secret|stderr/);
		expect((await item.host.handle({ type: "external-secret-list" })).ok).toBe(false);
	});
});
