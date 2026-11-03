import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeProviderHost } from "./native-provider-host";
import type { ChatGptOAuthManager, ChatGptOAuthStatus } from "./chatgpt-oauth";
import { CoreRequestSchema, LocalRuntimeStatusSchema, SetupSystemProfileSchema } from "@kestrel/shared-types";
// @ts-expect-error Native runtime modules are executed unchanged by bundled Node.
import { createNativeCoreConfiguration } from "../../../native-chromium-host/resources/native-core-configuration.mjs";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "kestrel-native-provider-host-")); roots.push(root);
	const environment: NodeJS.ProcessEnv = { KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1", OPENAI_API_KEY: "ambient-secret-must-not-import" };
	const reconfigure = vi.fn(async (mutation: () => Promise<unknown>, _rollback?: () => Promise<void>, validate?: () => void, _shouldRestoreCore?: () => boolean) => { const result = await mutation(); validate?.(); return result; });
	const accountStatus = vi.fn(async () => ({ connected: true, accountType: "chatgpt" as const }));
	const manager = { status: vi.fn(async (): Promise<ChatGptOAuthStatus> => ({ connected: false })),
		connect: vi.fn(async (_signal?: AbortSignal): Promise<ChatGptOAuthStatus> => ({ connected: true, accountType: "chatgpt" })), cancel: vi.fn(async () => {}) };
	const createOAuthManager = vi.fn((_options: { executable: string; environment: NodeJS.ProcessEnv; openExternal(url: string): Promise<void>; requestTimeoutMs: number }): Pick<ChatGptOAuthManager, "status" | "connect" | "cancel"> => manager);
	const openAuthUrl = vi.fn(async (_url: string, _signal: AbortSignal) => {});
	const localFetch = vi.fn<typeof fetch>(async () => { throw new Error("Local service unavailable in fixture"); });
	const options = { root, encryptionKeyBase64: randomBytes(32).toString("base64"), homeDirectory: root, environment,
		reconfigure: <T>(mutation: () => Promise<T>, rollback?: () => Promise<void>, validate?: () => void, shouldRestoreCore?: () => boolean): Promise<T> => reconfigure(mutation, rollback, validate, shouldRestoreCore) as Promise<T>, accountStatus, createOAuthManager, openAuthUrl, localFetch };
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
			managedRuntime: false, localModels: [],
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

	it("requires an available service for model-only downloads without changing configuration", async () => {
		const { host, reconfigure, createOAuthManager } = await fixture();
		await expect(host.handle({ type: "local-model-pull", model: "fixture:small" })).rejects.toThrow("Start Ollama or use guided local setup");
		expect(await host.handle({ type: "local-runtime-cancel" })).toEqual({ ok: true });
		expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
		expect(reconfigure).not.toHaveBeenCalled(); expect(createOAuthManager).not.toHaveBeenCalled();
	});

	it("probes existing Ollama without claiming that its detected models are configured or verified", async () => {
		const { host, localFetch, reconfigure } = await fixture();
		localFetch.mockImplementation(async input => String(input).endsWith("/api/tags")
			? Response.json({ models: [{ name: "fixture:small", size: 1024 }] }) : Response.json({}));
		const result = await host.handle({ type: "local-model-status" });
		expect(result).toMatchObject({ ok: true, ollamaAvailable: true, localModels: [], localRuntime: { localModels: [] } });
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
		options.reconfigure = (mutation, rollback, validate, shouldRestoreCore) => configuration.reconfigure(mutation, rollback, validate, shouldRestoreCore);
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

	it("downloads a custom model without stopping Core or selecting a route and reports progress", async () => {
		const { options, localFetch, reconfigure } = await fixture();
		let installed = false;
		const stages: string[] = [];
		localFetch.mockImplementation(async (input, init) => {
			if (String(input).endsWith("/api/tags")) return Response.json({ models: [{ name: "existing:stable", size: 1 }, ...(installed ? [{ name: "fixture:small", size: 1 }] : [])] });
			if (String(input).endsWith("/api/pull")) { expect(JSON.parse(String(init?.body))).toEqual({ model: "fixture:small", stream: true }); installed = true; return new Response('{"status":"success"}\n'); }
			throw new Error("Unexpected operation");
		});
		const host = new NativeProviderHost({ ...options, onLocalRuntimeProgress: event => stages.push(event.stage) });
		expect(CoreRequestSchema.safeParse({ type: "local-model-pull", model: "fixture:small" }).success).toBe(false);
		const result = await host.handle({ type: "local-model-pull", model: "fixture:small" });
		expect(result).toMatchObject({ ok: true, downloadedModel: { name: "fixture:small" } });
		expect(stages).toContain("downloading-model");
		expect(reconfigure).not.toHaveBeenCalled(); expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
		await host.close();
	});

	it("treats an installed custom model as a no-op and does not select it", async () => {
		const { options, localFetch, reconfigure } = await fixture();
		localFetch.mockResolvedValue(Response.json({ models: [{ name: "fixture:small", size: 1 }] }));
		const host = new NativeProviderHost(options);
		expect(await host.handle({ type: "local-model-pull", model: "fixture:small" })).toMatchObject({ ok: true, downloadedModel: { name: "fixture:small" } });
		expect(localFetch.mock.calls.every(([input]) => String(input).endsWith("/api/tags"))).toBe(true);
		expect(reconfigure).not.toHaveBeenCalled(); expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
		await host.close();
	});

	it("cancels a custom model pull without selecting a route or touching existing models", async () => {
		const { options, localFetch } = await fixture();
		localFetch.mockImplementation(async (input, init) => {
			if (String(input).endsWith("/api/tags")) return Response.json({ models: [{ name: "existing:stable", size: 1 }] });
			if (String(input).endsWith("/api/pull")) return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
			throw new Error("Unexpected operation");
		});
		const host = new NativeProviderHost(options);
		const request = host.handle({ type: "local-model-pull", model: "fixture:small" });
		const rejected = expect(request).rejects.toThrow("Partial downloads may remain in Ollama");
		await vi.waitFor(() => expect(localFetch.mock.calls.some(([input]) => String(input).endsWith("/api/pull"))).toBe(true));
		await host.handle({ type: "local-runtime-cancel" }); await rejected;
		expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]); await host.close();
	});

	it("reuses an external installed service without pulling, spawning, or killing it", async () => {
		const { options, localFetch } = await fixture();
		const spawn = vi.fn(() => { throw new Error("Must not spawn"); });
		localFetch.mockImplementation(async input => {
			if (String(input).endsWith("/api/tags")) return Response.json({ models: [{ name: "fixture:small", size: 1 }] });
			if (String(input).endsWith("/api/show")) return Response.json({ capabilities: ["completion", "tools"] });
			if (String(input).endsWith("/api/chat")) return Response.json({ done: true, message: { content: "OK" } });
			throw new Error("Must not download or pull");
		});
		const host = new NativeProviderHost({ ...options, localRuntimeDependencies: { spawn: spawn as unknown as typeof import("node:child_process").spawn } });
		expect((await host.handle({ type: "local-runtime-bootstrap", model: "fixture:small", consent: true })).ok).toBe(true);
		await host.close();
		expect(spawn).not.toHaveBeenCalled();
		expect(localFetch.mock.calls.some(([input]) => String(input).endsWith("/api/pull"))).toBe(false);
	});

	it("pulls only the explicitly selected missing model on an external service without changing existing models", async () => {
		const { options, localFetch } = await fixture();
		let installed = false;
		localFetch.mockImplementation(async (input, init) => {
			if (String(input).endsWith("/api/tags")) return Response.json({ models: [{ name: "existing:stable", size: 1 }, ...(installed ? [{ name: "fixture:small", size: 1 }] : [])] });
			if (String(input).endsWith("/api/pull")) { expect(JSON.parse(String(init?.body))).toEqual({ model: "fixture:small", stream: true }); installed = true; return new Response('{"status":"success"}\n'); }
			if (String(input).endsWith("/api/show")) return Response.json({ capabilities: ["completion", "tools"] });
			if (String(input).endsWith("/api/chat")) return Response.json({ done: true, message: { content: "OK" } });
			throw new Error("Unexpected operation against external service");
		});
		const spawn = vi.fn();
		const host = new NativeProviderHost({ ...options, localRuntimeDependencies: { spawn: spawn as unknown as typeof import("node:child_process").spawn } });
		expect((await host.handle({ type: "local-runtime-bootstrap", model: "fixture:small", consent: true })).ok).toBe(true);
		expect(localFetch.mock.calls.filter(([input]) => String(input).endsWith("/api/pull"))).toHaveLength(1);
		expect(spawn).not.toHaveBeenCalled(); await host.close();
	});

	it("cancels an external pull without killing or deleting the daemon or selecting the model", async () => {
		const { options, localFetch } = await fixture();
		localFetch.mockImplementation(async (input, init) => {
			if (String(input).endsWith("/api/tags")) return Response.json({ models: [{ name: "existing:stable", size: 1 }] });
			if (String(input).endsWith("/api/pull")) return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
			throw new Error("Unexpected operation against external service");
		});
		const spawn = vi.fn();
		const host = new NativeProviderHost({ ...options, localRuntimeDependencies: { spawn: spawn as unknown as typeof import("node:child_process").spawn } });
		const pending = host.handle({ type: "local-runtime-bootstrap", model: "fixture:small", consent: true });
		const rejected = expect(pending).rejects.toThrow("Partial downloads may remain in Ollama");
		await vi.waitFor(() => expect(localFetch.mock.calls.some(([input]) => String(input).endsWith("/api/pull"))).toBe(true));
		await host.handle({ type: "local-runtime-cancel" }); await rejected;
		expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
		expect(spawn).not.toHaveBeenCalled();
		expect(localFetch.mock.calls.every(([input]) => /\/api\/(tags|pull)$/.test(String(input)))).toBe(true);
		await host.close();
	});

	it("does not download or persist an invalid checksum in native setup", async () => {
		const { options, root, localFetch } = await fixture();
		const archive = new TextEncoder().encode("bad archive");
		const manifest = { runtime: "ollama" as const, version: "fixture", platform: "darwin" as const, architectures: ["arm64"] as ["arm64"],
			url: "https://github.com/ollama/ollama/releases/download/test/ollama.tgz", fileName: "ollama.tgz", sha256: "0".repeat(64), bytes: archive.byteLength, binaryPath: "ollama" };
		localFetch.mockImplementation(async input => { if (String(input) === manifest.url) return new Response(archive); throw new Error("offline"); });
		const extract = vi.fn();
		const host = new NativeProviderHost({ ...options, localRuntimeDependencies: { platform: "darwin", architecture: "arm64", manifest, execFile: extract } });
		await expect(host.handle({ type: "local-runtime-bootstrap", model: "fixture:small", consent: true })).rejects.toThrow(/checksum/);
		expect(extract).not.toHaveBeenCalled();
		expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
		expect(await import("node:fs/promises").then(fs => fs.readdir(join(root, "local-runtime", "ollama")))).toEqual([]);
		await host.close();
	});

	it("installs a mocked pinned runtime and model, verifies tools and chat, then publishes and owns only its child", async () => {
		const { options, root, localFetch } = await fixture();
		const archive = new TextEncoder().encode("owned test archive");
		const manifest = { runtime: "ollama" as const, version: "fixture", platform: "darwin" as const, architectures: ["arm64"] as ["arm64"],
			url: "https://github.com/ollama/ollama/releases/download/test/ollama.tgz", fileName: "ollama.tgz",
			sha256: createHash("sha256").update(archive).digest("hex"), bytes: archive.byteLength, binaryPath: "ollama" };
		let service = false, installed = false, verified = false;
		const child = new EventEmitter() as EventEmitter & { exitCode: number | null; kill: ReturnType<typeof vi.fn> };
		child.exitCode = null; child.kill = vi.fn(() => { child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0, null)); return true; });
		const stages: string[] = [];
		const opts = { ...options, onLocalRuntimeProgress: (event: { stage: string }) => { if (event.stage === "ready") expect(verified).toBe(true); stages.push(event.stage); },
			localRuntimeDependencies: { platform: "darwin" as const, architecture: "arm64", manifest,
				execFile: async (_file: string, args: string[]) => { if (args[0] === "-tzf") return { stdout: "ollama\n", stderr: "" };
					await writeFile(join(args[args.indexOf("-C") + 1]!, "ollama"), "fake binary"); return { stdout: "", stderr: "" }; },
				spawn: vi.fn(() => { service = true; return child; }) as unknown as typeof import("node:child_process").spawn } };
		localFetch.mockImplementation(async input => {
			const url = String(input);
			if (url === manifest.url) return new Response(archive);
			if (url.endsWith("/api/tags")) { if (!service) throw new Error("offline"); return Response.json({ models: installed ? [{ name: "fixture:small", size: 1 }] : [] }); }
			if (url.endsWith("/api/pull")) { installed = true; return new Response('{"status":"done"}\n'); }
			if (url.endsWith("/api/show")) return Response.json({ capabilities: ["completion", "tools"] });
			if (url.endsWith("/api/chat")) { verified = true; expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]); return Response.json({ done: true, message: { content: "OK" } }); }
			throw new Error("unexpected URL");
		});
		const host = new NativeProviderHost(opts);
		const result = await host.handle({ type: "local-runtime-bootstrap", model: "fixture:small", consent: true });
		expect(result).toMatchObject({ ok: true, localRuntime: { verifiedModel: "fixture:small", managedRuntime: true } });
		expect(stages).toEqual(expect.arrayContaining(["downloading-runtime", "verifying-runtime", "installing-runtime", "starting-runtime", "downloading-model", "verifying-model", "ready"]));
		expect((await host.runtimeConfiguration()).providerAccounts).toContainEqual(expect.objectContaining({ id: "native-local-ollama", defaultModel: "fixture:small" }));
		expect(await readFile(join(root, "local-runtime", "ollama", "fixture", "ollama"), "utf8")).toBe("fake binary");
		await host.close(); expect(child.kill).toHaveBeenCalledWith("SIGTERM");
	});

	it.each(["cancel", "failure", "close"])("restores prior preferences and verification and reaps the new child on %s before commit", async action => {
		const { options, root, localFetch } = await fixture();
		const archive = new TextEncoder().encode("fixture");
		const manifest = { runtime: "ollama" as const, version: "fixture", platform: "darwin" as const, architectures: ["arm64"] as ["arm64"],
			url: "https://github.com/ollama/ollama/releases/download/test/ollama.tgz", fileName: "ollama.tgz", sha256: createHash("sha256").update(archive).digest("hex"), bytes: archive.byteLength, binaryPath: "ollama" };
		const folder = join(root, "local-runtime", "ollama", "fixture"); await mkdir(folder, { recursive: true });
		await writeFile(join(folder, "ollama"), "fixture", { mode: 0o700 });
		await writeFile(join(folder, "workstrand-install.json"), JSON.stringify({ version: "fixture", sha256: manifest.sha256, binaryPath: "ollama" }));
		const oldVerification = '{"model":"old:model","verifiedAt":"2025-01-01T00:00:00.000Z"}\n';
		const oldPreferences = '{"version":1,"subscriptions":{}}\n';
		await writeFile(join(root, "local-runtime", "last-verification.json"), oldVerification, { mode: 0o600 });
		await writeFile(join(root, "native-runtime-preferences.json"), oldPreferences, { mode: 0o600 });
		let service = false;
		const child = new EventEmitter() as EventEmitter & { exitCode: number | null; kill: ReturnType<typeof vi.fn> };
		child.exitCode = null; child.kill = vi.fn(() => { child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0, null)); return true; });
		localFetch.mockImplementation(async input => {
			if (String(input).endsWith("/api/tags")) { if (!service) throw new Error("offline"); return Response.json({ models: [{ name: "fixture:small", size: 1 }] }); }
			if (String(input).endsWith("/api/show")) return Response.json({ capabilities: ["completion", "tools"] });
			if (String(input).endsWith("/api/chat")) return Response.json({ done: true, message: { content: "OK" } });
			throw new Error("Unexpected fixture call");
		});
		let release!: () => void; let entered!: () => void;
		const held = new Promise<void>(resolve => { release = resolve; }); const reached = new Promise<void>(resolve => { entered = resolve; });
		const core = { start: vi.fn(async (_config: unknown) => {}), stop: vi.fn(async () => {}) };
		const configuration = createNativeCoreConfiguration({ core, isBusy: () => false, configuration: async () => ({ key: options.encryptionKeyBase64 }) });
		await configuration.start();
		const host = new NativeProviderHost({ ...options,
			reconfigure: (mutation, rollback, validate, restore) => configuration.reconfigure(mutation, rollback, validate, restore),
			beforeLocalPreferenceCommit: async () => { entered(); await held; if (action === "failure") throw new Error("fixture write failure"); },
			localRuntimeDependencies: { platform: "darwin", architecture: "arm64", manifest, spawn: (() => { service = true; return child; }) as unknown as typeof import("node:child_process").spawn },
		});
		const pending = host.handle({ type: "local-runtime-bootstrap", model: "fixture:small", consent: true });
		const rejected = expect(pending).rejects.toThrow(); await reached;
		const stopping = action === "close" ? host.close() : action === "cancel" ? host.handle({ type: "local-runtime-cancel" }) : Promise.resolve();
		release(); await stopping; await rejected;
		expect(await readFile(join(root, "native-runtime-preferences.json"), "utf8")).toBe(oldPreferences);
		expect(await readFile(join(root, "local-runtime", "last-verification.json"), "utf8")).toBe(oldVerification);
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		expect(core.start).toHaveBeenCalledTimes(action === "close" ? 1 : 2);
		if (action !== "close") await host.close();
	});

	it("times out a hanging setup, restores Core, and does not persist a model", async () => {
		const { options, localFetch } = await fixture();
		const core = { start: vi.fn(async (_config: unknown) => {}), stop: vi.fn(async () => {}) };
		const configuration = createNativeCoreConfiguration({ core, isBusy: () => false, configuration: async () => ({ key: options.encryptionKeyBase64 }) });
		await configuration.start();
		localFetch.mockImplementation(async (input, init) => {
			if (String(input).endsWith("/api/tags")) return Response.json({ models: [{ name: "fixture:small" }] });
			return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
		});
		const host = new NativeProviderHost({ ...options, reconfigure: (mutation, rollback, validate, shouldRestoreCore) => configuration.reconfigure(mutation, rollback, validate, shouldRestoreCore), localSetupTimeoutMs: 30 });
		await expect(host.handle({ type: "local-runtime-bootstrap", model: "fixture:small", consent: true })).rejects.toThrow();
		expect(core.start).toHaveBeenCalledTimes(2); expect(configuration.changing).toBe(false);
		expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
		await host.close();
	});

	it.each(["tag", "show", "chat", "malformed-show"])("refuses remote or malformed %s metadata and never persists a local route", async stage => {
		const { host, localFetch, root } = await fixture();
		const events: string[] = [];
		localFetch.mockImplementation(async input => {
			const url = String(input); events.push(url);
			if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "plain-alias:latest", size: 1, ...(stage === "tag" ? { remote_host: "https://private.invalid" } : {}) }] });
			if (url.endsWith("/api/show")) return Response.json({ capabilities: ["completion", "tools"], ...(stage === "show" ? { remote_model: "upstream-secret" } : stage === "malformed-show" ? { remote_host: null } : {}) });
			if (url.endsWith("/api/chat")) return Response.json({ done: true, message: { content: "OK" }, ...(stage === "chat" ? { remote_host: "https://private.invalid" } : {}) });
			throw new Error("unexpected endpoint");
		});
		await expect(host.handle({ type: "local-runtime-bootstrap", model: "plain-alias:latest", consent: true })).rejects.toThrow("remote-backed");
		if (stage !== "chat") expect(events.some(url => url.endsWith("/api/chat"))).toBe(false);
		expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
		await expect(readFile(join(root, "local-runtime", "last-verification.json"), "utf8")).rejects.toThrow();
		await host.close();
	});

	it("does not offer cloud-backed tags as installed local model choices", async () => {
		const { host, localFetch } = await fixture();
		localFetch.mockImplementation(async input => String(input).endsWith("/api/tags")
			? Response.json({ models: [{ name: "plain-alias", size: 1, remote_model: "upstream-secret" }, { name: "real-local", size: 1 }] }) : Response.json({}));
		const response = await host.handle({ type: "local-model-status" });
		if (!response.ok || !("localRuntime" in response)) throw new Error("Missing status");
		expect(response.localRuntime.detectedModels?.map(item => item.name)).toEqual(["real-local"]);
		await host.close();
	});

	it("only offers installed choices whose descriptors confirm local backing", async () => {
		const { host, localFetch } = await fixture();
		localFetch.mockImplementation(async (input, init) => {
			if (String(input).endsWith("/api/tags")) return Response.json({ models: ["local", "remote", "malformed", "unavailable"].map(name => ({ name, size: 1 })) });
			if (String(input).endsWith("/api/show")) {
				const { model } = JSON.parse(String(init?.body));
				if (model === "remote") return Response.json({ remote_host: "https://private.invalid" });
				if (model === "malformed") return Response.json({ remote_model: null });
				if (model === "unavailable") return new Response("unavailable", { status: 500 });
				return Response.json({ remote_model: "", remote_host: "" });
			}
			throw new Error("Unexpected endpoint");
		});
		const response = await host.handle({ type: "local-model-status" });
		if (!response.ok || !("localRuntime" in response)) throw new Error("Missing status");
		expect(response.localRuntime.detectedModels?.map(item => item.name)).toEqual(["local"]);
		expect(JSON.stringify(response)).not.toContain("private.invalid");
		expect(localFetch.mock.calls.every(([input]) => !String(input).endsWith("/api/chat") && !String(input).endsWith("/api/pull"))).toBe(true);
		await host.close();
	});

	it("stops reporting a previously verified alias as local when its descriptor becomes remote", async () => {
		const { host, localFetch } = await fixture(); let remote = false;
		localFetch.mockImplementation(async input => {
			if (String(input).endsWith("/api/tags")) return Response.json({ models: [{ name: "plain-alias:latest", size: 1 }] });
			if (String(input).endsWith("/api/show")) return Response.json({ capabilities: ["completion", "tools"], ...(remote ? { remote_model: "upstream" } : {}) });
			return Response.json({ done: true, message: { content: "OK" } });
		});
		expect((await host.handle({ type: "local-runtime-bootstrap", model: "plain-alias:latest", consent: true })).ok).toBe(true);
		remote = true;
		const status = await host.handle({ type: "local-model-status" });
		expect(status).toMatchObject({ localModels: [], localRuntime: { localModels: [] } });
		if (!status.ok || !("localRuntime" in status)) throw new Error("Missing status");
		expect(status.localRuntime.verifiedModel).toBeUndefined();
		await host.close();
	});

	it("rejects a busy local setup before probing or saving provider preferences", async () => {
		const { host, reconfigure, localFetch } = await fixture();
		reconfigure.mockRejectedValueOnce(new Error("Active task"));
		await expect(host.handle({ type: "local-runtime-bootstrap", model: "fixture:small", consent: true })).rejects.toThrow("Active task");
		expect(localFetch).not.toHaveBeenCalled();
		expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
	});

	it.each(["empty-response", "private-error"])("does not configure a local route after %s verification", async failure => {
		const { host, localFetch } = await fixture();
		localFetch.mockImplementation(async input => {
			if (String(input).endsWith("/api/tags")) return Response.json({ models: failure === "not-installed" ? [] : [{ name: "fixture:small" }] });
			if (failure === "private-error") throw new Error("secret path/token/private runtime diagnostics");
			if (String(input).endsWith("/api/show")) return Response.json({ capabilities: ["completion", "tools"] });
			return Response.json({ done: true, message: { content: "" } });
		});
		await expect(host.handle({ type: "local-runtime-bootstrap", model: "fixture:small", consent: true })).rejects.toThrow(/^The installed local model did not complete a real chat response\./);
		expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
	});
	it("does not mark a completion-only model ready for tool-capable Home tasks", async () => {
		const { host, localFetch } = await fixture();
		localFetch.mockImplementation(async input => String(input).endsWith("/api/tags") ? Response.json({ models: [{ name: "fixture:small" }] }) : Response.json({ capabilities: ["completion"] }));
		await expect(host.handle({ type: "local-runtime-bootstrap", model: "fixture:small", consent: true })).rejects.toThrow("confirmed tool support");
		expect(localFetch.mock.calls.some(([url]) => String(url).endsWith("/api/chat"))).toBe(false);
		expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
	});

	it.each(["cancel", "close"])("%s interrupts local verification and restores Core without saving a selected model", async action => {
		const { host, options, localFetch } = await fixture();
		const core = { start: vi.fn(async (_config: unknown) => {}), stop: vi.fn(async () => {}) };
		const configuration = createNativeCoreConfiguration({ core, isBusy: () => false, configuration: async () => ({ key: options.encryptionKeyBase64 }) });
		options.reconfigure = (mutation, rollback, validate, shouldRestoreCore) => configuration.reconfigure(mutation, rollback, validate, shouldRestoreCore);
		await configuration.start();
		localFetch.mockImplementation(async (input, init) => {
			if (String(input).endsWith("/api/tags")) return Response.json({ models: [{ name: "fixture:small" }] });
			return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("private details")), { once: true }));
		});
		const pending = host.handle({ type: "local-runtime-bootstrap", model: "fixture:small", consent: true });
		const rejected = expect(pending).rejects.toThrow("cancelled");
		await vi.waitFor(() => expect(localFetch.mock.calls.some(([url]) => String(url).endsWith("/api/show"))).toBe(true));
		if (action === "close") await host.close();
		else expect(await host.handle({ type: "local-runtime-cancel" })).toEqual({ ok: true });
		await rejected;
		expect(core.start).toHaveBeenCalledTimes(action === "close" ? 1 : 2); expect(configuration.changing).toBe(false);
		if (action === "close") {
			await expect(host.runtimeConfiguration()).rejects.toThrow("shutting down");
			const reopened = new NativeProviderHost(options);
			expect((await reopened.runtimeConfiguration()).providerAccounts).toEqual([]);
			await reopened.close();
		} else expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
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
		expect((await host.handle({ type: "local-runtime-bootstrap", model: "fixture:small", consent: false })).ok).toBe(false);
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
		options.reconfigure = (mutation, rollback, validate, shouldRestoreCore) => configuration.reconfigure(mutation, rollback, validate, shouldRestoreCore);
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
		if (action === "close") {
			await expect(host.runtimeConfiguration()).rejects.toThrow("shutting down");
			const reopened = new NativeProviderHost(options);
			expect((await reopened.runtimeConfiguration()).providerAccounts).toEqual([]);
			await reopened.close();
		} else expect((await host.runtimeConfiguration()).providerAccounts).toEqual([]);
		if (action === "close") expect((await host.handle({ type: "oauth-chatgpt-connect" })).ok).toBe(false);
	});
});
