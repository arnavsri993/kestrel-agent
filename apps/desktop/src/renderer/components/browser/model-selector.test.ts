import { describe, expect, it } from "vitest";
import type {
	ProviderAccountModel,
	ProviderAccountSummary,
} from "@kestrel/shared-types";
import {
	accountForChoice,
	matchesCatalogSearch,
	modelAvailabilityLabel,
	modelForChoice,
	modelSupportsThinking,
	providerGroups,
	selectableModel,
	selectAuto,
	selectCustomModel,
	selectModel,
	selectThinking,
	selectorTriggerLabel,
} from "./model-selector";

const accountCapabilities: ProviderAccountSummary["capabilities"] = {
	streaming: true,
	tools: true,
	images: false,
	audio: false,
	documents: false,
	video: false,
	local: false,
};

const modelCapabilities: ProviderAccountModel["capabilities"] = {
	capabilityProvenance: "confirmed",
	streaming: true,
	tools: true,
	vision: false,
	audio: false,
	documents: false,
	video: false,
	structuredOutput: true,
	reasoningEfforts: [],
};

function model(
	id: string,
	overrides: Partial<ProviderAccountModel> = {},
): ProviderAccountModel {
	return {
		id,
		displayName: id,
		availability: "available",
		discoverySource: "provider_api",
		capabilities: modelCapabilities,
		...overrides,
	};
}

function account(
	id: string,
	displayName: string,
	models: ProviderAccountModel[],
	overrides: Partial<ProviderAccountSummary> = {},
): ProviderAccountSummary {
	return {
		id,
		endpointId: id,
		providerId: "openai",
		displayName,
		authTransport: "api_key",
		enabled: true,
		capabilities: accountCapabilities,
		discovery: { state: "fresh" },
		models,
		...overrides,
	};
}

const accounts: ProviderAccountSummary[] = [
	account("openai-work", "Work OpenAI", [
		model("gpt-work", {
			displayName: "Work GPT",
			capabilities: {
				...modelCapabilities,
				reasoningEfforts: ["low", "medium", "high"],
			},
		}),
	]),
	account("openai-personal", "Personal OpenAI", [
		model("gpt-personal", {
			availability: "stale",
			discoverySource: "metadata",
		}),
	]),
	account(
		"local-ollama",
		"Local Ollama",
		[model("llama", { availability: "unsupported" })],
		{
			providerId: "ollama",
			authTransport: "local",
			enabled: false,
			capabilities: { ...accountCapabilities, local: true },
			discovery: { state: "unsupported" },
		},
	),
];

const choice = {
	executionMode: "manual" as const,
	providerId: "openai-work",
	accountId: "openai-work",
	model: "gpt-work",
	reasoningEffort: "medium" as const,
};

describe("account-aware model selector", () => {
	it("groups only enabled accounts by provider and sorts their labels", () => {
		const groups = providerGroups(accounts);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.accounts.map((item) => item.displayName)).toEqual([
			"Personal OpenAI",
			"Work OpenAI",
		]);
	});

	it("keeps unavailable account models out of explicit selection", () => {
		expect(selectableModel(model("available"))).toBe(true);
		expect(selectableModel(model("unknown", { availability: "unknown" }))).toBe(
			true,
		);
		expect(
			selectableModel(model("blocked", { availability: "permission_denied" })),
		).toBe(false);
		expect(
			modelAvailabilityLabel(
				model("fallback", {
					availability: "unknown",
					discoverySource: "fallback",
				}),
			),
		).toBe("Fallback · capabilities unverified");
	});

	it("never substitutes a removed account with another endpoint", () => {
		expect(accountForChoice(accounts, choice)?.id).toBe("openai-work");
		expect(modelForChoice(accounts, choice)?.displayName).toBe("Work GPT");
		expect(
			accountForChoice(accounts, { providerId: "openai-work", accountId: "missing" }),
		).toBeUndefined();
		expect(accountForChoice(accounts, { providerId: "openai" })).toBeUndefined();
		expect(selectorTriggerLabel({ ...choice, accountId: "missing" }, accounts)).toBe(
			"gpt-work · account unavailable",
		);
	});

	it("uses discovered reasoning capabilities rather than a vendor model name", () => {
		expect(modelSupportsThinking(accounts, choice)).toBe(true);
		expect(selectorTriggerLabel(choice, accounts)).toBe("Work GPT · Med");
		expect(
		modelSupportsThinking(accounts, {
			...choice,
			accountId: "openai-personal",
			providerId: "openai-personal",
			model: "gpt-personal",
		}),
		).toBe(false);
		const unverifiedAccount = account("unverified", "Unverified", [
			model("reported-thinking", {
				capabilities: {
					...modelCapabilities,
					capabilityProvenance: "unknown",
					reasoningEfforts: ["low", "medium"],
				},
			}),
		]);
		const unverifiedChoice = selectModel(
			unverifiedAccount,
			unverifiedAccount.models[0]!,
			{ ...choice, reasoningEffort: "medium" },
		);
		expect(modelSupportsThinking([unverifiedAccount], unverifiedChoice)).toBe(
			false,
		);
		expect(unverifiedChoice.reasoningEffort).toBe("none");
	});

	it("searches provider, account, and discovered model fields", () => {
		const group = providerGroups(accounts)[0]!;
		expect(matchesCatalogSearch(group, "personal")).toBe(true);
		expect(matchesCatalogSearch(group, "gpt-work")).toBe(true);
		expect(matchesCatalogSearch(group, "anthropic")).toBe(false);
	});

	it("keeps account identity through model, thinking, custom, and auto choices", () => {
		const selected = selectModel(
			accounts[0]!,
			accounts[0]!.models[0]!,
			{ ...choice, reasoningEffort: "none" },
		);
		expect(selected).toMatchObject({
			providerId: "openai-work",
			accountId: "openai-work",
			model: "gpt-work",
			reasoningEffort: "medium",
		});
		expect(selectThinking("high", selected).reasoningEffort).toBe("high");
		expect(
			selectCustomModel(accounts[1]!, "  custom-model  ", selected),
		).toMatchObject({
			accountId: "openai-personal",
			model: "custom-model",
			reasoningEffort: "none",
		});
		expect(selectAuto(selected)).toMatchObject({
			executionMode: "automatic",
			reasoningEffort: "none",
		});
	});
});
