import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeProviderHost } from "./native-provider-host";
import type { ChatGptOAuthManager, ChatGptOAuthStatus } from "./chatgpt-oauth";
import { LocalRuntimeStatusSchema, SetupSystemProfileSchema } from "@kestrel/shared-types";
// @ts-expect-error Native runtime modules are executed unchanged by bundled Node.
import { createNativeCoreConfiguration } from "../../../native-chromium-host/resources/native-core-configuration.mjs";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "kestrel-native-provider-host-")); roots.push(root);
	const environment: NodeJS.ProcessEnv = { KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1", OPENAI_API_KEY: "ambient-secret-must-not-import" };
	const reconfigure = vi.fn(async (mutation: () => Promise<unknown>) => mutation());
	const accountStatus = vi.fn(async () => ({ connected: true, accountType: "chatgpt" as const }));
	const manager = { status: vi.fn(async (): Promise<ChatGptOAuthStatus> => ({ connected: false })),
		connect: vi.fn(async (_signal?: AbortSignal): Promise<ChatGptOAuthStatus> => ({ connected: true, accountType: "chatgpt" })), cancel: vi.fn(async () => {}) };
	const createOAuthManager = vi.fn((_options: { executable: string; environment: NodeJS.ProcessEnv; openExternal(url: string): Promise<void>; requestTimeoutMs: number }): Pick<ChatGptOAuthManager, "status" | "connect" | "cancel"> => manager);
	const openAuthUrl = vi.fn(async (_url: string, _signal: AbortSignal) => {});
	const localFetch = vi.fn<typeof fetch>(async () => { throw new Error("Local service unavailable in fixture"); });
	const options = { root, encryptionKeyBase64: randomBytes(32).toString("base64"), homeDirectory: root, environment,
		reconfigure: <T>(mutation: () => Promise<T>): Promise<T> => reconfigure(mutation) as Promise<T>, accountStatus, createOAuthManager, openAuthUrl, localFetch };
	return { root, options, host: new NativeProviderHost(options), reconfigure, manager, createOAuthManager, openAuthUrl, localFetch };
}

async function oauthFixture() {
	const result = await fixture();
	const executable = join(result.root, "official-codex-fixture");
	await writeFile(executable, "fixture\n", { mode: 0o700 });
	result.options.environment.KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY = "0";
	result.options.environment.KESTREL_CODEX_PATH = executable;
	return result;
}

describe("native provider host", () => {
	it("loads fresh onboarding status and saves a protected API route without claiming local verification", async () => {
		const { host, createOAuthManager, reconfigure } = await fixture();
		const credentials = await host.handle({ type: "credential-list" });
		expect(credentials.ok && "credentials" in credentials && credentials.credentials.every(item => !item.configured)).toBe(true);
		expect((await host.handle({ type: "subscription-cli-status" })).ok).toBe(true);
		const status = await host.handle({ type: "local-model-status" });
		if (!status.ok || !("systemProfile" in status)) throw new Error("Missing setup status");
		expect(SetupSystemProfileSchema.safeParse(status.systemProfile).success).toBe(true);
		expect(LocalRuntimeStatusSchema.safeParse(status.localRuntime).success).toBe(true);
		expect(status).toMatchObject({ ollamaAvailable: false, localModels: [], localRuntime: {
			automaticSupported: false, managedRuntime: false, localModels: [], unavailableReason: expect.stringContaining("Automatic runtime installation and model downloads are unavailable"),
		} });
		expect(status.localRuntime.verifiedModel).toBeUndefined();
		expect(reconfigure).not.toHaveBeenCalled(); expect(createOAuthManager).not.toHaveBeenCalled();
		const secret = "fixture-onboarding-api-key";
		const saved = await host.handle({ type: "credential-set", credentialId: "openai", value: secret });
		expect(saved.ok && "credentials" in saved && saved.credentials.find(item => item.id === "openai")?.configured).toBe(true);
		expect(JSON.stringify(saved)).not.toContain(secret);
		expect((await host.runtimeConfiguration()).providerAccounts).toContainEqual(expect.objectContaining({
			id: "legacy-openai-primary", enabled: true, adapter: "openai-responses", apiKey: secret,
		}));
	});

	it("explicitly defers model downloads without running or mutating anything", async () => {
		const { host, reconfigure, createOAuthManager } = await fixture();
		expect(await host.handle({ type: "local-model-pull", model: "fixture:small" })).toEqual({ ok: false, error: expect.stringContaining("Automatic runtime installation and model downloads are unavailable") });
		expect(await host.handle({ type: "local-runtime-cancel" })).toEqual({ ok: true });
		expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
		expect(reconfigure).not.toHaveBeenCalled(); expect(createOAuthManager).not.toHaveBeenCalled();
	});

	it("probes existing Ollama without claiming that its detected models are configured or verified", async () => {
		const { host, localFetch, reconfigure } = await fixture();
		localFetch.mockResolvedValue(Response.json({ models: [{ name: "fixture:small", size: 1024 }] }));
		const result = await host.handle({ type: "local-model-status" });
		expect(result).toMatchObject({ ok: true, ollamaAvailable: true, localModels: [], localRuntime: { automaticSupported: false, localModels: [] } });
		if (!result.ok || !("localRuntime" in result)) throw new Error("Missing status");
		expect(result.localRuntime.verifiedModel).toBeUndefined();
		expect(result.localRuntime.detectedModels).toEqual([expect.objectContaining({ name: "fixture:small" })]);
		expect(localFetch).toHaveBeenCalledWith("http://127.0.0.1:11434/api/tags", expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }));
		expect(reconfigure).not.toHaveBeenCalled();
		expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
	});

	it("verifies an installed model while Core is idle and persists the selected native Ollama route", async () => {
		const { host, options, localFetch, root } = await oauthFixture();
		const core = { start: vi.fn(async (_config: unknown) => {}), stop: vi.fn(async () => {}) };
		const configuration = createNativeCoreConfiguration({ core, isBusy: () => false, configuration: async () => ({
			databasePath: "same-database", encryptionKeyBase64: options.encryptionKeyBase64, ...await host.runtimeConfiguration(),
		}) });
		options.reconfigure = mutation => configuration.reconfigure(mutation);
		await configuration.start();
		localFetch.mockImplementation(async (input, init) => {
			if (String(input).endsWith("/api/tags")) return Response.json({ models: [{ name: "fixture:small", size: 1024 }] });
			if (String(input).endsWith("/api/show")) return Response.json({ capabilities: ["completion", "tools"] });
			expect(configuration.changing).toBe(true); expect(core.stop).toHaveBeenCalledOnce();
			expect(input).toBe("http://127.0.0.1:11434/api/chat");
			expect(init).toMatchObject({ method: "POST", redirect: "error" });
			expect(JSON.parse(String(init?.body))).toMatchObject({ model: "fixture:small", stream: false, keep_alive: 0 });
			return Response.json({ done: true, message: { content: "fixture-private-response" } });
		});
		let releaseRestart!: () => void;
		const restarting = new Promise<void>(resolve => { releaseRestart = resolve; });
		core.start.mockImplementationOnce(async () => restarting);
		const pending = host.handle({ type: "local-runtime-bootstrap", model: "fixture:small", consent: true });
		await vi.waitFor(() => expect(core.start).toHaveBeenCalledTimes(2));
		const duringRestart = await host.handle({ type: "local-model-status" });
		expect(duringRestart).toMatchObject({ localModels: [], localRuntime: { localModels: [] } });
		if (!duringRestart.ok || !("localRuntime" in duringRestart)) throw new Error("Missing local status");
		expect(duringRestart.localRuntime.verifiedModel).toBeUndefined();
		releaseRestart();
		const result = await pending;
		expect(result).toMatchObject({ ok: true, localRuntime: { verifiedModel: "fixture:small", localModels: [{ name: "fixture:small" }] } });
		expect(JSON.stringify(result)).not.toContain("fixture-private-response");
		const route = { id: "native-local-ollama", adapter: "ollama", authTransport: "local", baseUrl: "http://127.0.0.1:11434", defaultModel: "fixture:small", enabled: true };
		expect(core.start).toHaveBeenLastCalledWith(expect.objectContaining({ providerAccounts: [expect.objectContaining(route)] }));
		expect((await new NativeProviderHost(options).runtimeConfiguration()).providerAccounts).toContainEqual(expect.objectContaining(route));
		await host.handle({ type: "subscription-cli-set", id: "codex", enabled: true });
		expect((await host.runtimeConfiguration()).providerAccounts).toContainEqual(expect.objectContaining(route));
		const status = await host.handle({ type: "local-model-status" });
		expect(status).toMatchObject({ localModels: [{ name: "fixture:small" }], localRuntime: { verifiedModel: "fixture:small" } });
		expect(await readFile(join(root, "native-runtime-preferences.json"), "utf8")).not.toContain("fixture-private-response");
	});

	it("rejects a busy local setup before probing or saving provider preferences", async () => {
		const { host, reconfigure, localFetch } = await fixture();
		reconfigure.mockRejectedValueOnce(new Error("Active task"));
		await expect(host.handle({ type: "local-runtime-bootstrap", model: "fixture:small", consent: true })).rejects.toThrow("Active task");
		expect(localFetch).not.toHaveBeenCalled();
		expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
	});

	it.each(["not-installed", "empty-response", "private-error"])("does not configure a local route after %s verification", async failure => {
		const { host, localFetch } = await fixture();
		localFetch.mockImplementation(async input => {
			if (String(input).endsWith("/api/tags")) return Response.json({ models: failure === "not-installed" ? [] : [{ name: "fixture:small" }] });
			if (failure === "private-error") throw new Error("secret path/token/private runtime diagnostics");
			if (String(input).endsWith("/api/show")) return Response.json({ capabilities: ["completion", "tools"] });
			return Response.json({ done: true, message: { content: "" } });
		});
		await expect(host.handle({ type: "local-runtime-bootstrap", model: "fixture:small", consent: true })).rejects.toThrow(/^The installed local model did not complete a real chat response\./);
		expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
		if (failure === "not-installed") expect(localFetch).toHaveBeenCalledOnce();
	});
	it("does not mark a completion-only model ready for tool-capable Home tasks", async () => {
		const { host, localFetch } = await fixture();
		localFetch.mockImplementation(async input => String(input).endsWith("/api/tags") ? Response.json({ models: [{ name: "fixture:small" }] }) : Response.json({ capabilities: ["completion"] }));
		await expect(host.handle({ type: "local-runtime-bootstrap", model: "fixture:small", consent: true })).rejects.toThrow("confirmed tool support");
		expect(localFetch).toHaveBeenCalledTimes(2);
		expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
	});

	it.each(["cancel", "close"])("%s interrupts local verification and restores Core without saving a selected model", async action => {
		const { host, options, localFetch } = await fixture();
		const core = { start: vi.fn(async (_config: unknown) => {}), stop: vi.fn(async () => {}) };
		const configuration = createNativeCoreConfiguration({ core, isBusy: () => false, configuration: async () => ({ key: options.encryptionKeyBase64 }) });
		options.reconfigure = mutation => configuration.reconfigure(mutation);
		await configuration.start();
		localFetch.mockImplementation(async (input, init) => {
			if (String(input).endsWith("/api/tags")) return Response.json({ models: [{ name: "fixture:small" }] });
			return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("private details")), { once: true }));
		});
		const pending = host.handle({ type: "local-runtime-bootstrap", model: "fixture:small", consent: true });
		const rejected = expect(pending).rejects.toThrow("cancelled");
		await vi.waitFor(() => expect(localFetch).toHaveBeenCalledTimes(2));
		if (action === "close") await host.close();
		else expect(await host.handle({ type: "local-runtime-cancel" })).toEqual({ ok: true });
		await rejected;
		expect(core.start).toHaveBeenCalledTimes(2); expect(configuration.changing).toBe(false);
		expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
	});

	it("saves protected API accounts and reloads routes without exposing or inheriting credentials", async () => {
		const { root, options, host } = await fixture();
		expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
		const secret = "native-host-encrypted-provider-secret";
		const result = await host.handle({ type: "provider-account-create", account: {
			providerId: "openai", adapter: "openai-responses", displayName: "Test API", authTransport: "api_key", enabled: true, apiKey: secret, headers: [],
		} });
		expect(result.ok).toBe(true); expect(JSON.stringify(result)).not.toContain(secret);
		expect(await readFile(join(root, "provider-accounts.json"), "utf8")).not.toContain(secret);
		const config = await new NativeProviderHost(options).runtimeConfiguration();
		expect(config.providerAccounts[0]?.apiKey).toBe(secret);
		expect(JSON.stringify(config)).not.toContain("ambient-secret-must-not-import");
		if (!result.ok || !("providerAccounts" in result) || !result.providerAccounts) throw new Error("Missing account summary");
		await host.handle({ type: "provider-account-remove", accountId: result.providerAccounts[0]!.id });
		expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
	});

	it("does not persist credentials when Core refuses a provider change", async () => {
		const { host, reconfigure } = await fixture();
		reconfigure.mockImplementation(async () => { throw new Error("Active task"); });
		await expect(host.handle({ type: "credential-set", credentialId: "openai", value: "sk-must-not-be-saved" })).rejects.toThrow("Active task");
		const result = await host.handle({ type: "credential-list" });
		expect(result.ok && "credentials" in result && result.credentials.find(item => item.id === "openai")?.configured).toBe(false);
	});

	it("enables, disables and re-enables the vendor route without copying its login or creating a legacy account", async () => {
		const { root, options, host } = await fixture();
		const executable = join(root, "official-codex-fixture"); await writeFile(executable, "fixture\n", { mode: 0o700 });
		options.environment.KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY = "0";
		options.environment.KESTREL_CODEX_PATH = executable;
		await host.handle({ type: "subscription-cli-set", id: "codex", enabled: true });
		const [account] = (await new NativeProviderHost(options).runtimeConfiguration()).providerAccounts;
		expect(account).toMatchObject({ id: "native-cli-codex", executable: await realpath(executable), homeDirectory: root, profilePath: join(root, ".codex") });
		const preferences = await readFile(join(root, "native-runtime-preferences.json"), "utf8");
		expect(JSON.parse(preferences)).toEqual({ version: 1, subscriptions: { codex: { enabled: true, path: await realpath(executable) } } });
		expect((await host.subscriptionStatuses()).find(item => item.id === "codex")).toMatchObject({ enabled: true, authenticated: true });
		await host.handle({ type: "subscription-cli-set", id: "codex", enabled: false });
		expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
		await host.handle({ type: "subscription-cli-set", id: "codex", enabled: true });
		expect((await host.runtimeConfiguration()).providerAccounts).toHaveLength(1);
		options.environment.KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY = "1";
		expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
	});

	it("rejects symlinked or public preferences and does not silently reset them", async () => {
		const { root, host } = await fixture();
		const destination = join(root, "preserved.json"); await writeFile(destination, '{"subscriptions":{}}', { mode: 0o600 });
		const preferences = join(root, "native-runtime-preferences.json"); await symlink(destination, preferences);
		await expect(host.runtimeConfiguration()).rejects.toThrow("Existing data was preserved");
		expect(await readFile(destination, "utf8")).toBe('{"subscriptions":{}}');
		await rm(preferences); await writeFile(preferences, '{"subscriptions":{}}', { mode: 0o600 }); await chmod(preferences, 0o644);
		await expect(host.runtimeConfiguration()).rejects.toThrow("Existing data was preserved");
	});

	it("rejects invalid and unrelated host requests before any mutation", async () => {
		const { host, reconfigure } = await fixture();
		expect((await host.handle({ type: "credential-set", credentialId: "arbitrary", value: "secret" })).ok).toBe(false);
		expect((await host.handle({ type: "runtime-run-agent" })).ok).toBe(false);
		expect(reconfigure).not.toHaveBeenCalled();
	});

	it("enables an existing ChatGPT login without initiating a new sign-in or copying metadata", async () => {
		const { host, manager, root, openAuthUrl, createOAuthManager } = await oauthFixture();
		manager.status.mockResolvedValue({ connected: true, accountType: "chatgpt", email: "private@example.com", planType: "private-plan" });
		const result = await host.handle({ type: "oauth-chatgpt-connect" });
		expect(result.ok).toBe(true);
		expect(manager.connect).not.toHaveBeenCalled(); expect(openAuthUrl).not.toHaveBeenCalled();
		expect(manager.cancel).toHaveBeenCalled();
		expect(createOAuthManager.mock.calls[0]?.[0].environment.HOME).toBe(root);
		expect((await host.runtimeConfiguration()).providerAccounts).toMatchObject([{ id: "native-cli-codex", authTransport: "oauth" }]);
		const preferences = await readFile(join(root, "native-runtime-preferences.json"), "utf8");
		for (const privateValue of ["private@example.com", "private-plan"]) {
			expect(JSON.stringify(result)).not.toContain(privateValue); expect(preferences).not.toContain(privateValue);
		}
	});

	it("opens a validated provider-owned login in Kestrel and only returns public route metadata", async () => {
		const { host, manager, createOAuthManager, openAuthUrl } = await oauthFixture();
		const url = "https://auth.openai.com/authorize?state=fixture-private-state";
		manager.connect.mockImplementation(async () => {
			await createOAuthManager.mock.calls[0]![0].openExternal(url);
			return { connected: true, accountType: "chatgpt", email: "private@example.com" };
		});
		const result = await host.handle({ type: "oauth-chatgpt-connect" });
		expect(result.ok).toBe(true); expect(manager.connect).toHaveBeenCalledOnce();
		expect(openAuthUrl).toHaveBeenCalledWith(url, expect.any(AbortSignal));
		expect(JSON.stringify(result)).not.toMatch(/fixture-private-state|private@example.com/);
	});

	it.each(["http://auth.openai.com/authorize", "https://openai.com.evil.test/token", "file:///tmp/login", "https://secret@auth.openai.com/authorize", "https://auth.openai.com:8443/authorize", "not a URL"])("rejects an unsafe auth URL without opening a browser: %s", async url => {
		const { host, manager, createOAuthManager, openAuthUrl } = await oauthFixture();
		manager.connect.mockImplementation(async () => {
			await createOAuthManager.mock.calls[0]![0].openExternal(url);
			return { connected: true, accountType: "chatgpt" };
		});
		await expect(host.handle({ type: "oauth-chatgpt-connect" })).rejects.toThrow("ChatGPT sign-in could not be completed");
		expect(openAuthUrl).not.toHaveBeenCalled(); expect(manager.cancel).toHaveBeenCalled();
		expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
	});

	it("does not start a login or persist enablement after a busy Core rejection", async () => {
		const { host, reconfigure, createOAuthManager } = await oauthFixture();
		reconfigure.mockRejectedValueOnce(new Error("Active task"));
		await expect(host.handle({ type: "oauth-chatgpt-connect" })).rejects.toThrow("Active task");
		expect(createOAuthManager).not.toHaveBeenCalled();
		expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
		// A rejected guard must also release connection ownership.
		expect((await host.handle({ type: "oauth-chatgpt-connect" })).ok).toBe(true);
	});

	it("connects a managed Codex account using only its isolated provider-owned profile", async () => {
		const { host, root, manager, createOAuthManager } = await oauthFixture();
		const created = await host.handle({ type: "provider-account-create", account: {
			providerId: "codex", adapter: "codex-app-server", displayName: "Managed ChatGPT", authTransport: "oauth", enabled: true, headers: [],
		} });
		if (!created.ok || !("providerAccounts" in created) || !created.providerAccounts?.[0]) throw new Error("Missing account");
		const id = created.providerAccounts[0].id;
		const result = await host.handle({ type: "provider-account-connect", accountId: id });
		expect(result.ok).toBe(true); expect(manager.connect).toHaveBeenCalledOnce();
		expect(createOAuthManager.mock.calls[0]![0].environment.CODEX_HOME).toBe(join(root, "provider-profiles", id, "codex"));
		expect((await host.subscriptionStatuses()).find(item => item.id === "codex")?.enabled).toBe(false);
	});

	it("rejects unsupported account types and missing accounts before starting login", async () => {
		const { host, createOAuthManager } = await oauthFixture();
		const created = await host.handle({ type: "provider-account-create", account: {
			providerId: "openai", adapter: "openai-responses", displayName: "API", authTransport: "api_key", enabled: true, apiKey: "fixture-secret", headers: [],
		} });
		if (!created.ok || !("providerAccounts" in created) || !created.providerAccounts?.[0]) throw new Error("Missing account");
		await expect(host.handle({ type: "provider-account-connect", accountId: created.providerAccounts[0].id })).rejects.toThrow("protected API-key flow");
		await expect(host.handle({ type: "provider-account-connect", accountId: "missing-account" })).rejects.toThrow("no longer exists");
		expect(createOAuthManager).not.toHaveBeenCalled();
	});

	it("rejects API-key account results without enabling the ChatGPT plan or revealing provider diagnostics", async () => {
		const { host, manager } = await oauthFixture();
		manager.status.mockResolvedValue({ connected: false, accountType: "apiKey" });
		manager.connect.mockResolvedValue({ connected: true, accountType: "apiKey" });
		await expect(host.handle({ type: "oauth-chatgpt-connect" })).rejects.toThrow("could not be completed");
		expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
		manager.connect.mockRejectedValue(new Error("private token=fixture-secret https://auth.openai.com/callback?code=private"));
		await expect(host.handle({ type: "oauth-chatgpt-connect" })).rejects.toThrow(/^ChatGPT sign-in could not be completed\. Check the provider page and try again\.$/);
	});

	it("cancels login even before a manager exists without starting a provider child", async () => {
		const { host, createOAuthManager } = await oauthFixture();
		const pending = host.handle({ type: "oauth-chatgpt-connect" });
		const rejected = expect(pending).rejects.toThrow("cancelled");
		expect((await host.handle({ type: "oauth-chatgpt-cancel" })).ok).toBe(true);
		await rejected;
		expect(createOAuthManager).not.toHaveBeenCalled();
		expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
	});

	it("reaps a concurrent account-status child during shutdown without starting sign-in", async () => {
		const { options, manager, openAuthUrl } = await oauthFixture();
		const { accountStatus: _accountStatus, ...withoutStatusFixture } = options;
		const host = new NativeProviderHost(withoutStatusFixture);
		let failStatus!: (error: Error) => void;
		manager.status.mockImplementation(async () => new Promise((_resolve, reject) => { failStatus = reject; }));
		manager.cancel.mockImplementation(async () => { failStatus(new Error("private account details")); });
		const pending = host.subscriptionStatuses();
		await vi.waitFor(() => expect(manager.status).toHaveBeenCalledOnce());
		await host.close();
		expect((await pending).find(item => item.id === "codex")?.authenticated).toBe(false);
		expect(manager.cancel).toHaveBeenCalled(); expect(manager.connect).not.toHaveBeenCalled(); expect(openAuthUrl).not.toHaveBeenCalled();
	});

	it.each(["cancel", "close"])("%s aborts login, reaps the manager, restores idle Core and preserves route preferences", async action => {
		const { host, manager, options, openAuthUrl } = await oauthFixture();
		const core = { start: vi.fn(async (_config: unknown) => {}), stop: vi.fn(async () => {}) };
		const config = { databasePath: "same-database", encryptionKeyBase64: options.encryptionKeyBase64 };
		const configuration = createNativeCoreConfiguration({ core, configuration: async () => config, isBusy: () => false });
		options.reconfigure = mutation => configuration.reconfigure(mutation);
		await configuration.start();
		manager.connect.mockImplementation(async signal => new Promise((_resolve, reject) => {
			signal!.addEventListener("abort", () => reject(new Error("private auth diagnostic")), { once: true });
		}));
		const pending = host.handle({ type: "oauth-chatgpt-connect" });
		const rejected = expect(pending).rejects.toThrow("sign-in was cancelled");
		await vi.waitFor(() => expect(manager.connect).toHaveBeenCalledOnce());
		await expect(host.handle({ type: "oauth-chatgpt-connect" })).rejects.toThrow("already in progress");
		expect((await host.handle({ type: "subscription-cli-status" })).ok).toBe(true);
		if (action === "close") await host.close();
		else expect((await host.handle({ type: "oauth-chatgpt-cancel" })).ok).toBe(true);
		await rejected;
		expect(manager.cancel).toHaveBeenCalled(); expect(openAuthUrl).not.toHaveBeenCalled();
		expect(core.start).toHaveBeenLastCalledWith(config); expect(core.start).toHaveBeenCalledTimes(2);
		expect(configuration.changing).toBe(false);
		expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
		if (action === "close") expect((await host.handle({ type: "oauth-chatgpt-connect" })).ok).toBe(false);
	});
});
