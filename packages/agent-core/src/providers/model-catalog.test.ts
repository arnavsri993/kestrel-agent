import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { describe, expect, it } from "vitest";
import { ModelCatalog } from "./model-catalog";
import type { DiscoveredModel, ModelProvider } from "./types";

type DiscoveryState =
	| { models: DiscoveredModel[] }
	| { error: Error };

function provider(input: {
	id: string;
	providerId: string;
	accountId: string;
	displayName: string;
	defaultModel?: string;
	discovery?: () => Promise<DiscoveredModel[]>;
	configurationVersion?: string;
}): ModelProvider {
	return {
		id: input.id,
		poolId: input.providerId,
		account: {
			id: input.accountId,
			providerId: input.providerId,
			displayName: input.displayName,
			authTransport: "api_key",
			enabled: true,
			...(input.configurationVersion
				? { configurationVersion: input.configurationVersion }
				: {}),
		},
		...(input.defaultModel ? { defaultModel: input.defaultModel } : {}),
		capabilities: {
			streaming: true,
			tools: true,
			images: false,
			audio: false,
			documents: false,
			local: false,
		},
		...(input.discovery ? { discoverModels: input.discovery } : {}),
		complete: async (request) => ({
			providerId: input.id,
			model: request.model,
			text: "ok",
			toolCalls: [],
			usage: { inputTokens: 0, outputTokens: 0 },
			finishReason: "stop",
		}),
	};
}

function discovered(id: string): DiscoveredModel {
	return {
		id,
		displayName: id.toUpperCase(),
		availability: "available",
		source: "provider_api",
		capabilities: { tools: true, structuredOutput: true },
	};
}

describe("account-aware model catalog", () => {
	it("keeps matching provider model IDs isolated by account", async () => {
		let first: DiscoveryState = { models: [discovered("shared"), discovered("a-only")] };
		let second: DiscoveryState = { models: [discovered("shared"), discovered("b-only")] };
		const providers = [
			provider({
				id: "openai-account-a",
				providerId: "openai",
				accountId: "account-a",
				displayName: "Personal",
				discovery: async () => {
					if ("error" in first) throw first.error;
					return first.models;
				},
			}),
			provider({
				id: "openai-account-b",
				providerId: "openai",
				accountId: "account-b",
				displayName: "Work",
				discovery: async () => {
					if ("error" in second) throw second.error;
					return second.models;
				},
			}),
		];
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const catalog = new ModelCatalog(database, providers);

		await catalog.refresh(providers);

		expect(catalog.modelsForEndpoint("openai-account-a").map((model) => model.id)).toEqual([
			"shared",
			"a-only",
		]);
		expect(catalog.modelsForEndpoint("openai-account-b").map((model) => model.id)).toEqual([
			"shared",
			"b-only",
		]);
		expect(catalog.list().map((account) => [account.id, account.models.length])).toEqual([
			["account-a", 2],
			["account-b", 2],
		]);
		database.close();
	});

	it("replaces models removed upstream instead of restoring a fallback default", async () => {
		let state: DiscoveryState = { models: [discovered("old-model")] };
		const endpoint = provider({
			id: "custom-account",
			providerId: "custom",
			accountId: "custom-account",
			displayName: "Custom endpoint",
			defaultModel: "legacy-default",
			discovery: async () => {
				if ("error" in state) throw state.error;
				return state.models;
			},
		});
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const catalog = new ModelCatalog(database, [endpoint]);

		expect(catalog.modelsForEndpoint(endpoint.id)).toEqual([]);
		await catalog.refresh([endpoint]);
		expect(catalog.modelsForEndpoint(endpoint.id).map((model) => model.id)).toEqual([
			"old-model",
		]);
		state = { models: [discovered("new-model")] };
		await catalog.refresh([endpoint]);
		expect(catalog.modelsForEndpoint(endpoint.id).map((model) => model.id)).toEqual([
			"new-model",
		]);
		state = { models: [] };
		await catalog.refresh([endpoint]);
		expect(catalog.modelsForEndpoint(endpoint.id)).toEqual([]);
		database.close();
	});

	it("retains the last catalog as stale when refresh fails", async () => {
		let state: DiscoveryState = { models: [discovered("still-here")] };
		const endpoint = provider({
			id: "anthropic-account",
			providerId: "anthropic",
			accountId: "anthropic-account",
			displayName: "Anthropic",
			discovery: async () => {
				if ("error" in state) throw state.error;
				return state.models;
			},
		});
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const catalog = new ModelCatalog(database, [endpoint]);
		await catalog.refresh([endpoint]);
		state = {
			error: new Error(
				"temporary upstream outage: Bearer sk-private-discovery-token-123456",
			),
		};
		await catalog.refresh([endpoint]);

	const account = catalog.list()[0]!;
		expect(account.discovery).toMatchObject({
			state: "failed",
			error: "Model discovery failed. Check the account connection and refresh again.",
		});
		expect(account.models).toMatchObject([
			{ id: "still-here", availability: "stale" },
		]);
		database.close();
	});

	it("does not turn adapter-wide defaults into per-model capability claims", async () => {
		const endpoint = provider({
			id: "openai-account",
			providerId: "openai",
			accountId: "account-a",
			displayName: "Personal",
			discovery: async () => [
				{
					id: "advertised-only",
					availability: "available",
					source: "provider_api",
					capabilities: { capabilityProvenance: "unknown" },
				},
			],
		});
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const catalog = new ModelCatalog(database, [endpoint]);

		await catalog.refresh([endpoint]);

		expect(catalog.modelsForEndpoint(endpoint.id)[0]?.capabilities).toMatchObject({
			capabilityProvenance: "unknown",
			tools: false,
			vision: false,
			structuredOutput: false,
		});
		database.close();
	});

	it("marks discovered models stale after the cache interval in a running core", async () => {
		let now = new Date("2026-09-06T12:00:00.000Z");
		const endpoint = provider({
			id: "gemini-account",
			providerId: "gemini",
			accountId: "gemini-account",
			displayName: "Google",
			discovery: async () => [discovered("gemini-live")],
		});
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const catalog = new ModelCatalog(database, [endpoint], () => now);
		await catalog.refresh([endpoint]);
		now = new Date("2026-09-06T12:16:00.000Z");

		expect(catalog.list()[0]!.discovery.state).toBe("stale");
		expect(catalog.list()[0]!.models[0]!.availability).toBe("stale");
		database.close();
	});

	it("refreshes only missing or expired dynamic catalogs during startup", async () => {
		let now = new Date("2026-09-06T12:00:00.000Z");
		let calls = 0;
		const endpoint = provider({
			id: "startup-account",
			providerId: "openai",
			accountId: "startup-account",
			displayName: "Startup account",
			discovery: async () => {
				calls += 1;
				return [discovered("current-model")];
			},
		});
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const catalog = new ModelCatalog(database, [endpoint], () => now);

		await catalog.refreshStale([endpoint]);
		expect(calls).toBe(1);
		await catalog.refreshStale([endpoint]);
		expect(calls).toBe(1);

		now = new Date("2026-09-06T12:16:00.000Z");
		await catalog.refreshStale([endpoint]);
		expect(calls).toBe(2);
		database.close();
	});

	it("invalidates a stored account catalog when its connection revision changes", async () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const first = provider({
			id: "changed-account",
			providerId: "custom",
			accountId: "changed-account",
			displayName: "Custom endpoint",
			configurationVersion: "2026-09-06T12:00:00.000Z",
			discovery: async () => [discovered("old-endpoint-model")],
		});
		const catalog = new ModelCatalog(database, [first]);
		await catalog.refresh([first]);

		const changed = provider({
			id: "changed-account",
			providerId: "custom",
			accountId: "changed-account",
			displayName: "Custom endpoint",
			configurationVersion: "2026-09-06T12:05:00.000Z",
			discovery: async () => [discovered("new-endpoint-model")],
		});
		const reloaded = new ModelCatalog(database, [changed]);

		expect(reloaded.modelsForEndpoint(changed.id)).toEqual([]);
		expect(reloaded.list()[0]!.discovery.state).toBe("idle");
		await reloaded.refreshStale([changed]);
		expect(reloaded.modelsForEndpoint(changed.id).map((model) => model.id)).toEqual([
			"new-endpoint-model",
		]);
		database.close();
	});

	it("uses a labelled fallback only where no discovery interface exists", async () => {
		const endpoint = provider({
			id: "codex-account",
			providerId: "codex",
			accountId: "codex-account",
			displayName: "Codex profile",
			defaultModel: "configured-default",
		});
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const catalog = new ModelCatalog(database, [endpoint]);

		expect(catalog.modelsForEndpoint(endpoint.id)).toMatchObject([
			{
				id: "configured-default",
				discoverySource: "fallback",
				availability: "unknown",
				isFallback: true,
			},
		]);
		await catalog.refresh([endpoint]);
		expect(catalog.list()[0]!.discovery.state).toBe("unsupported");
		database.close();
	});
});
