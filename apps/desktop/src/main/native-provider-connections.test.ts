import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalSecretConfiguration } from "@kestrel/shared-types";
import { NativeProviderHost } from "./native-provider-host";
import { DEFAULT_EXTERNAL_SECRET_CONFIGURATION } from "./external-secret-manager";
// @ts-expect-error Native runtime modules are executed unchanged by bundled Node.
import { createNativeCoreConfiguration } from "../../../native-chromium-host/resources/native-core-configuration.mjs";

const roots: string[] = [];
const CLIENT_ID = "1234567890-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com";
const GOOGLE_SCOPES = "openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events";
const protection = {
	isEncryptionAvailable: () => true,
	encryptString: async (value: string) => Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`),
	decryptString: async (value: Buffer) => Buffer.from(value.toString().slice("sealed:".length), "base64").toString(),
};

afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "kestrel-native-provider-connections-"));
	roots.push(root);
	let provider!: NativeProviderHost;
	let busy = false;
	let running = false;
	const starts: unknown[] = [];
	let stops = 0;
	const core = {
		get isReady() { return running; },
		get hasProcess() { return running; },
		start: vi.fn(async (configuration: unknown) => { running = true; starts.push(configuration); }),
		stop: vi.fn(async () => { running = false; stops++; }),
	};
	const configuration = async () => provider ? provider.runtimeConfiguration() : {};
	const controller = createNativeCoreConfiguration({ core, configuration, isBusy: () => busy, changed: async () => {} });
	const execution = vi.fn(async (_file: string, _args: string[], _settings: unknown) => ({ stdout: "OPENAI_API_KEY=external-api-key-value\n" }));
	const fetchGoogle: typeof fetch = async (input, init) => {
		const url = String(input);
		if (url.endsWith("/token")) return Response.json({ access_token: "access-token-value-that-is-long-enough", refresh_token: "refresh-token-value-that-is-long-enough", scope: GOOGLE_SCOPES });
		if (url.endsWith("/userinfo")) return Response.json({ email: "person@example.test" });
		if (url.includes("/calendars/primary/events")) return Response.json({ items: [] });
		if (url.endsWith("/revoke")) return new Response("", { status: 200 });
		throw new Error(`Unexpected Google URL: ${url}`);
	};
	let authGate: Promise<void> | undefined;
	const openAuthUrl = vi.fn(async (raw: string, signal: AbortSignal) => {
		expect(core.isReady).toBe(true);
		if (authGate) await Promise.race([authGate, new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
		const auth = new URL(raw);
		const callback = new URL(auth.searchParams.get("redirect_uri")!);
		callback.searchParams.set("state", auth.searchParams.get("state")!);
		callback.searchParams.set("code", "generated-loopback-code");
		await fetch(callback);
	});
	const helper = join(root, "generated-external-helper");
	await writeFile(helper, "unused fake executable", { mode: 0o700 });
	await chmod(helper, 0o700);
	provider = new NativeProviderHost({
		root,
		encryptionKeyBase64: randomBytes(32).toString("base64"),
		homeDirectory: root,
		environment: { KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1", OPENAI_API_KEY: "ambient-provider-secret-must-not-import" },
		reconfigure: (mutation: () => Promise<unknown>, rollback?: () => Promise<void>, validate?: () => void, shouldRestoreCore?: () => boolean) => controller.reconfigure(mutation, rollback, validate, shouldRestoreCore),
		mutateSettings: (mutation: () => Promise<unknown>, rollback?: () => Promise<void>, validate?: () => void) => controller.withIdleMutation(mutation, rollback, validate),
		shouldRestoreCore: () => true,
		isBusy: () => busy,
		openAuthUrl,
		googleOAuthFetch: fetchGoogle,
		googleOAuthTimeoutMs: 30_000,
		externalSecretDependencies: { execute: execution },
	} as never);
	await controller.start();
	return {
		root, provider, controller, core, starts, get stops() { return stops; }, execution, openAuthUrl, helper,
		set busy(value: boolean) { busy = value; },
		set authGate(value: Promise<void> | undefined) { authGate = value; },
	};
}

function externalConfiguration(helper: string): ExternalSecretConfiguration {
	const configuration = structuredClone(DEFAULT_EXTERNAL_SECRET_CONFIGURATION);
	configuration.command = { enabled: true, executablePath: helper, arguments: ["--fixture"], timeoutMs: 1_000, overrideStored: true };
	return configuration;
}

describe("native provider Connections integration", () => {
	it("keeps Core running during Google consent and commits only the profile secret", async () => {
		const f = await fixture();
		const stopsBefore = f.stops;
		let completeConsent!: () => void;
		f.authGate = new Promise<void>(resolve => { completeConsent = resolve; });
		const connect = f.provider.handle({ type: "oauth-google-connect", clientId: CLIENT_ID });
		await vi.waitFor(() => expect(f.openAuthUrl).toHaveBeenCalledOnce());
		expect(f.core.isReady).toBe(true);
		expect(f.stops).toBe(stopsBefore);
		completeConsent();
		const result = await connect;
		expect(result).toMatchObject({ ok: true, googleWorkspaceOAuth: { connected: true, email: "person@example.test" } });
		expect(f.stops).toBe(stopsBefore + 1);
		const environment = (await f.provider.runtimeConfiguration()).secureEnvironment;
		expect(environment.KESTREL_GOOGLE_WORKSPACE_OAUTH).toContain("refresh-token-value-that-is-long-enough");
		expect(JSON.stringify(result)).not.toContain("refresh-token-value");
	});

	it("cancels a renderer-owned sign-in without a late secret write or Core mutation", async () => {
		const f = await fixture();
		let completeConsent!: () => void;
		f.authGate = new Promise<void>(resolve => { completeConsent = resolve; });
		const owner = new AbortController();
		const before = f.stops;
		const connect = f.provider.handle({ type: "oauth-google-connect", clientId: CLIENT_ID }, owner.signal);
		await vi.waitFor(() => expect(f.openAuthUrl).toHaveBeenCalledOnce());
		owner.abort(new Error("UI disconnected"));
		expect(await connect).toMatchObject({ ok: false, error: expect.any(String) });
		expect(f.stops).toBe(before);
		expect((await f.provider.runtimeConfiguration()).secureEnvironment.KESTREL_GOOGLE_WORKSPACE_OAUTH).toBeUndefined();
		completeConsent();
	});

	it("reports communication metadata only, with Messages explicitly unavailable", async () => {
		const f = await fixture();
		const status = await f.provider.handle({ type: "communication-sources" });
		expect(status).toMatchObject({ ok: true, communicationSources: [
			{ id: "mac-messages", state: "unavailable" },
			{ id: "gmail", state: "not_connected" },
		] });
		expect(JSON.stringify(status)).not.toMatch(/token|secret|cookie/i);
	});

	it("saves external-source settings without executing the helper or restarting Core", async () => {
		const f = await fixture();
		const beforeStops = f.stops;
		const result = await f.provider.handle({ type: "external-secret-save", configuration: externalConfiguration(f.helper) });
		expect(result.ok).toBe(true);
		expect(f.execution).not.toHaveBeenCalled();
		expect(f.stops).toBe(beforeStops);
		expect(f.core.isReady).toBe(true);
	});

	it("executes external sync once and applies the API key override only to Core", async () => {
		const f = await fixture();
		await f.provider.handle({ type: "credential-set", credentialId: "openai", value: "stored-api-key-value" });
		const beforeStops = f.stops;
		await f.provider.handle({ type: "external-secret-save", configuration: externalConfiguration(f.helper) });
		f.execution.mockClear();
		const result = await f.provider.handle({ type: "external-secret-sync", providerId: "command" });
		expect(result.ok).toBe(true);
		expect(f.execution).toHaveBeenCalledOnce();
		expect(f.stops).toBe(beforeStops + 1);
		const current = f.starts.at(-1) as { secureEnvironment?: NodeJS.ProcessEnv };
		expect(current.secureEnvironment?.OPENAI_API_KEY).toBe("external-api-key-value");
		expect(JSON.stringify(result)).not.toContain("external-api-key-value");
		expect((await f.provider.runtimeConfiguration()).secureEnvironment.OPENAI_API_KEY).toBe("external-api-key-value");
		const removed = await f.provider.handle({ type: "external-secret-remove", providerId: "command" });
		expect(removed.ok).toBe(true);
		expect(f.starts.at(-1)).toMatchObject({ secureEnvironment: { OPENAI_API_KEY: "stored-api-key-value" } });
		expect((await f.provider.runtimeConfiguration()).secureEnvironment.OPENAI_API_KEY).toBe("stored-api-key-value");
	});

	it("denies active-task Google commits and external sync before executing the source", async () => {
		const f = await fixture();
		const beforeStops = f.stops;
		let completeConsent!: () => void;
		f.authGate = new Promise<void>(resolve => { completeConsent = resolve; });
		const connecting = f.provider.handle({ type: "oauth-google-connect", clientId: CLIENT_ID });
		await vi.waitFor(() => expect(f.openAuthUrl).toHaveBeenCalledOnce());
		f.busy = true;
		completeConsent();
		expect(await connecting).toMatchObject({ ok: false, error: expect.any(String) });
		expect(f.stops).toBe(beforeStops);
		expect((await f.provider.runtimeConfiguration()).secureEnvironment.KESTREL_GOOGLE_WORKSPACE_OAUTH).toBeUndefined();
		f.busy = false;
		const saved = await f.provider.handle({ type: "external-secret-save", configuration: externalConfiguration(f.helper) });
		expect(saved.ok).toBe(true);
		f.busy = true;
		const busySave = await f.provider.handle({ type: "external-secret-save", configuration: externalConfiguration(f.helper) });
		expect(busySave).toMatchObject({ ok: false });
		const synced = await f.provider.handle({ type: "external-secret-sync", providerId: "command" });
		expect(synced).toMatchObject({ ok: false });
		expect(f.execution).not.toHaveBeenCalled();
		expect(f.stops).toBe(beforeStops);
	});

	it("closes child/provider hosts without leaving a pending sign-in owner", async () => {
		const f = await fixture();
		let completeConsent!: () => void;
		f.authGate = new Promise<void>(resolve => { completeConsent = resolve; });
		const connect = f.provider.handle({ type: "oauth-google-connect", clientId: CLIENT_ID });
		await vi.waitFor(() => expect(f.openAuthUrl).toHaveBeenCalledOnce());
		await f.provider.close();
		expect(await connect).toMatchObject({ ok: false, error: expect.any(String) });
		await expect(f.provider.handle({ type: "communication-sources" })).resolves.toMatchObject({ ok: false });
		completeConsent();
	});
});
