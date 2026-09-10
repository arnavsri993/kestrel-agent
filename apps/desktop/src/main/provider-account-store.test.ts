import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CredentialBroker,
	PlaintextSecretProtection,
} from "./credential-broker";
import { ProviderAccountStore } from "./provider-account-store";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createStore(now = new Date("2026-09-06T12:00:00.000Z")) {
	const root = mkdtempSync(join(tmpdir(), "kestrel-provider-accounts-"));
	roots.push(root);
	const broker = new CredentialBroker(
		join(root, "secure"),
		new PlaintextSecretProtection(),
	);
	return {
		root,
		broker,
		store: new ProviderAccountStore(
			join(root, "provider-accounts.json"),
			broker,
			join(root, "user-data"),
			() => now,
		),
	};
}

const openAiAccount = (displayName: string, apiKey: string) => ({
	providerId: "openai",
		adapter: "openai-responses" as const,
		displayName,
		authTransport: "api_key" as const,
		enabled: true,
		defaultModel: "gpt-5.6-terra",
		apiKey,
		headers: [],
});

describe("provider account store", () => {
	it("keeps multiple independent accounts under one provider", async () => {
		const { store } = createStore();
		const first = await store.create(openAiAccount("Personal OpenAI", "sk-personal-123456"));
		const second = await store.create(openAiAccount("Team OpenAI", "sk-team-123456"));

		expect(second).toHaveLength(2);
		expect(second.map(({ id }) => id)).toEqual(
			expect.arrayContaining([first[0]!.id]),
		);
		expect(new Set(second.map(({ id }) => id)).size).toBe(2);
		const runtime = await store.runtimeAccounts({});
		expect(runtime.map(({ displayName, apiKey }) => ({ displayName, apiKey }))).toEqual(
			expect.arrayContaining([
				{ displayName: "Personal OpenAI", apiKey: "sk-personal-123456" },
				{ displayName: "Team OpenAI", apiKey: "sk-team-123456" },
			]),
		);
	});

	it("stores API keys in the broker, never in the account JSON", async () => {
		const { root, store, broker } = createStore();
		const secret = "sk-never-in-account-json-123456";
		const [account] = await store.create(openAiAccount("Protected", secret));
		const file = readFileSync(join(root, "provider-accounts.json"), "utf8");

		expect(file).not.toContain(secret);
		expect(file).not.toContain("apiKey");
		expect(await broker.getOpaqueSecret(`provider-account-${account!.id}`)).toContain(secret);
	});

	it("migrates legacy routes as metadata without copying the legacy token", async () => {
		const { root, store } = createStore();
		const legacyToken = "sk-legacy-openai-123456";
		await store.ensureLegacyAccounts({
			OPENAI_API_KEY: legacyToken,
			OPENAI_MODEL: "gpt-5.6-sol",
			OPENAI_ORGANIZATION: "org-team",
			OPENAI_PROJECT: "proj-research",
		});

		const [account] = await store.list();
		expect(account).toMatchObject({
			id: "legacy-openai-primary",
			providerId: "openai",
			displayName: "OpenAI API",
		});
		const file = readFileSync(join(root, "provider-accounts.json"), "utf8");
		expect(file).not.toContain(legacyToken);
		expect(file).toContain("legacyEnvironmentKey");
		const runtime = await store.runtimeAccounts({ OPENAI_API_KEY: legacyToken });
		expect(runtime[0]).toMatchObject({
			id: "legacy-openai-primary",
			apiKey: legacyToken,
			defaultModel: "gpt-5.6-sol",
			organization: "org-team",
			project: "proj-research",
		});
	});

	it("registers an enabled Cursor CLI route as a non-secret legacy account", async () => {
		const { root, store } = createStore();
		await store.ensureLegacyAccounts({
			KESTREL_ENABLE_CURSOR_SUBSCRIPTION: "1",
			KESTREL_CURSOR_PATH: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
		});

		expect(await store.list()).toEqual([
			expect.objectContaining({
				id: "legacy-cursor",
				providerId: "cursor",
				displayName: "Cursor",
				authTransport: "cli_profile",
			}),
		]);
		const runtime = await store.runtimeAccounts({
			KESTREL_ENABLE_CURSOR_SUBSCRIPTION: "1",
			KESTREL_CURSOR_PATH: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
		});
		expect(runtime).toEqual([
			expect.objectContaining({
				id: "legacy-cursor",
				adapter: "cursor-cli",
				executable: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
			}),
		]);
		const file = readFileSync(join(root, "provider-accounts.json"), "utf8");
		expect(file).not.toContain("CURSOR_API_KEY");
	});

	it("keeps a removed legacy account disconnected across later migrations", async () => {
		const { store } = createStore();
		const environment = { OPENAI_API_KEY: "sk-legacy-disconnect-123456" };
		await store.ensureLegacyAccounts(environment);
		await store.remove("legacy-openai-primary");

		await store.ensureLegacyAccounts(environment);

		expect(await store.list()).toEqual([]);
	});

	it("updates metadata, disables runtime use, and removes brokered secrets", async () => {
		const { store, broker } = createStore();
		const [account] = await store.create(openAiAccount("Before", "sk-before-123456"));
		const secretId = `provider-account-${account!.id}`;

		await store.update({ id: account!.id, displayName: "After", enabled: false });
		expect(await store.list()).toEqual([
			expect.objectContaining({ id: account!.id, displayName: "After", enabled: false }),
		]);
		expect(await store.runtimeAccounts({})).toEqual([]);

		await store.remove(account!.id);
		expect(await store.list()).toEqual([]);
		expect(await broker.getOpaqueSecret(secretId)).toBeUndefined();
	});

	it("does not clear protected headers when updating unrelated account metadata", async () => {
		const { store } = createStore();
		const [account] = await store.create({
			providerId: "acme",
			adapter: "openai-compatible",
			displayName: "Before rename",
			authTransport: "api_key",
			enabled: true,
			baseUrl: "https://gateway.example.test/v1",
			apiKey: "acme-secret-123456",
			headers: [{ name: "X-Workspace", value: "research" }],
		});

		await store.update({ id: account!.id, displayName: "After rename" });

		expect((await store.runtimeAccounts({}))[0]).toMatchObject({
			displayName: "After rename",
			headers: { "X-Workspace": "research" },
		});
	});

	it("normalizes an OpenAI-compatible account and preserves safe custom headers", async () => {
		const { store } = createStore();
		const [account] = await store.create({
			providerId: "acme",
			adapter: "openai-compatible",
			displayName: "Acme Gateway",
			authTransport: "api_key",
			enabled: true,
			baseUrl: "https://gateway.example.test/v1/",
			apiKey: "acme-secret-123456",
			headers: [
				{ name: "X-Org", value: "research" },
			],
		});

		expect(account).toMatchObject({
			providerId: "acme",
		});
		const runtime = await store.runtimeAccounts({});
		expect(runtime[0]).toMatchObject({
			adapter: "openai-compatible",
			baseUrl: "https://gateway.example.test/v1",
			headers: { "X-Org": "research" },
		});
	});

	it("rejects an update that would make a compatible endpoint unrunnable", async () => {
		const { store } = createStore();
		const [account] = await store.create({
			providerId: "acme",
			adapter: "openai-compatible",
			displayName: "Acme Gateway",
			authTransport: "api_key",
			enabled: true,
			baseUrl: "https://gateway.example.test/v1",
			apiKey: "acme-secret-123456",
			headers: [],
		});

		await expect(
			store.update({ id: account!.id, baseUrl: "" }),
		).rejects.toThrow("needs a base URL");
		expect((await store.runtimeAccounts({}))[0]?.baseUrl).toBe(
			"https://gateway.example.test/v1",
		);
	});

	it("ignores a malformed persisted compatible endpoint without blocking other account data", async () => {
		const { root, store } = createStore();
		writeFileSync(
			join(root, "provider-accounts.json"),
			JSON.stringify({
				version: 3,
				accounts: [
					{
						id: "bad-compatible",
						providerId: "bad-compatible",
						adapter: "openai-compatible",
						displayName: "Malformed endpoint",
						authTransport: "api_key",
						enabled: true,
						baseUrl: "not-a-url",
						createdAt: "2026-09-06T12:00:00.000Z",
						updatedAt: "2026-09-06T12:00:00.000Z",
					},
				],
			}),
		);

		await expect(store.list()).resolves.toEqual([]);
	});

	it("skips malformed persisted account identities without bricking startup", async () => {
		const { root, store } = createStore();
		writeFileSync(
			join(root, "provider-accounts.json"),
			JSON.stringify({
				version: 3,
				accounts: [
					{
						id: "not an account id",
						providerId: "openai",
						adapter: "openai-responses",
						displayName: "Malformed",
						authTransport: "api_key",
						enabled: true,
						createdAt: "2026-09-06T12:00:00.000Z",
						updatedAt: "2026-09-06T12:00:00.000Z",
					},
				],
			}),
		);

		await expect(store.list()).resolves.toEqual([]);
		await expect(store.runtimeAccounts({})).resolves.toEqual([]);
	});

	it("supports local Ollama accounts without an API key", async () => {
		const { store } = createStore();
		await store.create({
			providerId: "ollama-local",
			adapter: "ollama",
			displayName: "Home Ollama",
			authTransport: "local",
			enabled: true,
			baseUrl: "http://127.0.0.1:11434/",
			defaultModel: "qwen3:8b",
			headers: [],
		});

		expect(await store.runtimeAccounts({})).toMatchObject([
			{
				providerId: "ollama-local",
				adapter: "ollama",
				baseUrl: "http://127.0.0.1:11434",
				defaultModel: "qwen3:8b",
			},
		]);
	});

	it("supports a loopback OpenAI-compatible account without a credential", async () => {
		const { store } = createStore();
		await store.create({
			providerId: "local-gateway",
			adapter: "openai-compatible",
			displayName: "Local Gateway",
			authTransport: "local",
			enabled: true,
			baseUrl: "http://127.0.0.1:1234/v1/",
			headers: [],
		});

		expect(await store.runtimeAccounts({})).toMatchObject([
			{
				providerId: "local-gateway",
				adapter: "openai-compatible",
				authTransport: "local",
				baseUrl: "http://127.0.0.1:1234/v1",
			},
		]);
	});

	it("rejects credential-bearing or non-HTTP local base URLs", async () => {
		const { store } = createStore();
		const account = {
			providerId: "local-gateway",
			adapter: "openai-compatible" as const,
			displayName: "Local Gateway",
			authTransport: "local" as const,
			enabled: true,
			headers: [],
		};

		await expect(
			store.create({ ...account, baseUrl: "http://127.0.0.1:1234/v1?mode=test" }),
		).rejects.toThrow("must not contain credentials, a query, or a fragment");
		await expect(
			store.create({ ...account, baseUrl: "ftp://127.0.0.1:1234/v1" }),
		).rejects.toThrow("must use a loopback local base URL");
	});
});
