import type {
	ProviderAccountModel,
	ProviderAccountSummary,
	ReasoningEffort,
} from "@kestrel/shared-types";

export type ModelSelectorChoice = {
	executionMode: "automatic" | "manual";
	/** Runtime endpoint ID. It is never a display label or a vendor-wide ID. */
	providerId: string;
	/** Stable account record ID, retained separately from the executable endpoint. */
	accountId?: string;
	model: string;
	reasoningEffort: ReasoningEffort;
};

export type ProviderGroup = {
	id: string;
	label: string;
	accounts: ProviderAccountSummary[];
};

export const THINKING_LEVELS: readonly {
	id: ReasoningEffort;
	label: string;
	description: string;
}[] = [
	{ id: "none", label: "Default", description: "Use the provider default" },
	{ id: "low", label: "Low", description: "Less deliberation" },
	{ id: "medium", label: "Medium", description: "Balanced deliberation" },
	{ id: "high", label: "High", description: "More thorough reasoning" },
	{ id: "xhigh", label: "Extra high", description: "Extended reasoning" },
	{ id: "max", label: "Max", description: "Largest reasoning budget" },
];

export function providerGroups(
	accounts: readonly ProviderAccountSummary[],
): ProviderGroup[] {
	const groups = new Map<string, ProviderGroup>();
	for (const account of accounts.filter((account) => account.enabled)) {
		const group = groups.get(account.providerId) ?? {
			id: account.providerId,
			label: account.providerId,
			accounts: [],
		};
		group.accounts.push(account);
		groups.set(account.providerId, group);
	}
	return [...groups.values()]
		.map((group) => ({
			...group,
			accounts: [...group.accounts].sort((left, right) =>
				left.displayName.localeCompare(right.displayName),
			),
		}))
		.sort((left, right) => left.label.localeCompare(right.label));
}

export function selectableModel(model: ProviderAccountModel): boolean {
	return ["available", "unknown", "stale"].includes(model.availability);
}

export function modelAvailabilityLabel(model: ProviderAccountModel): string {
	const capabilitiesUnverified =
		model.capabilities.capabilityProvenance !== "confirmed";
	switch (model.availability) {
		case "available":
			return capabilitiesUnverified
				? "Available · capabilities unverified"
				: "Available";
		case "unknown":
			return model.discoverySource === "fallback"
				? "Fallback · capabilities unverified"
				: "Check at run · capabilities unverified";
		case "stale":
			return "Stale";
		case "authentication_required":
			return "Sign in required";
		case "permission_denied":
			return "Permission denied";
		case "unsupported":
			return "Unsupported";
		case "unavailable":
			return "Unavailable";
	}
}

export function accountForChoice(
	accounts: readonly ProviderAccountSummary[],
	choice: Pick<ModelSelectorChoice, "providerId" | "accountId">,
): ProviderAccountSummary | undefined {
	const enabledAccounts = accounts.filter((account) => account.enabled);
	// A persisted account ID is an explicit user choice. Never substitute an
	// endpoint or a sibling account when that identity has been removed.
	if (choice.accountId)
		return enabledAccounts.find((account) => account.id === choice.accountId);
	const byEndpoint = enabledAccounts.find(
		(account) => account.endpointId === choice.providerId,
	);
	if (byEndpoint) return byEndpoint;
	// Older provider-level selections can be migrated only when unambiguous.
	// Once a provider has multiple accounts, choosing the first one would route
	// a future run through credentials the person did not select.
	const byProvider = enabledAccounts.filter(
		(account) => account.providerId === choice.providerId,
	);
	return byProvider.length === 1 ? byProvider[0] : undefined;
}

export function modelForChoice(
	accounts: readonly ProviderAccountSummary[],
	choice: ModelSelectorChoice,
): ProviderAccountModel | undefined {
	return accountForChoice(accounts, choice)?.models.find(
		(model) => model.id === choice.model,
	);
}

export function modelSupportsThinking(
	accounts: readonly ProviderAccountSummary[],
	choice: ModelSelectorChoice,
): boolean {
	const model = modelForChoice(accounts, choice);
	return (
		model?.capabilities.capabilityProvenance === "confirmed" &&
		(model.capabilities.reasoningEfforts.length ?? 0) > 1
	);
}

export function selectorTriggerLabel(
	choice: ModelSelectorChoice,
	accounts: readonly ProviderAccountSummary[],
): string {
	if (choice.executionMode === "automatic") return "Auto";
	if (!accountForChoice(accounts, choice))
		return choice.model.trim()
			? `${choice.model} · account unavailable`
			: "Account unavailable";
	if (!choice.model.trim()) return "Choose model";
	const model = modelForChoice(accounts, choice);
	const name = model?.displayName ?? choice.model;
	return modelSupportsThinking(accounts, choice) && choice.reasoningEffort !== "none"
		? `${name} · ${thinkingLabel(choice.reasoningEffort)}`
		: name;
}

export function thinkingLabel(effort: ReasoningEffort): string {
	return THINKING_LEVELS.find((level) => level.id === effort)?.label ?? effort;
}

export function selectModel(
	account: ProviderAccountSummary,
	model: ProviderAccountModel,
	current: ModelSelectorChoice,
): ModelSelectorChoice {
	const efforts = model.capabilities.capabilityProvenance === "confirmed"
		? model.capabilities.reasoningEfforts
		: [];
	const reasoningEffort = efforts.includes(current.reasoningEffort)
		? current.reasoningEffort
		: efforts.includes("medium") ? "medium" : efforts[0] ?? "none";
	return {
		executionMode: "manual",
		providerId: account.endpointId,
		accountId: account.id,
		model: model.id,
		reasoningEffort,
	};
}

export function selectCustomModel(
	account: ProviderAccountSummary,
	model: string,
	current: ModelSelectorChoice,
): ModelSelectorChoice {
	return {
		executionMode: "manual",
		providerId: account.endpointId,
		accountId: account.id,
		model: model.trim(),
		reasoningEffort: "none",
	};
}

export function selectThinking(
	effort: ReasoningEffort,
	current: ModelSelectorChoice,
): ModelSelectorChoice {
	return { ...current, executionMode: "manual", reasoningEffort: effort };
}

export function selectAuto(current: ModelSelectorChoice): ModelSelectorChoice {
	return {
		...current,
		executionMode: "automatic",
		model: current.model.trim() || "auto",
		reasoningEffort: "none",
	};
}

export function matchesCatalogSearch(
	group: ProviderGroup,
	query: string,
): boolean {
	const normalized = query.trim().toLocaleLowerCase();
	if (!normalized) return true;
	return group.accounts.some(
		(account) =>
			account.providerId.toLocaleLowerCase().includes(normalized) ||
			account.displayName.toLocaleLowerCase().includes(normalized) ||
			account.models.some(
				(model) =>
					model.id.toLocaleLowerCase().includes(normalized) ||
					model.displayName.toLocaleLowerCase().includes(normalized),
			),
	);
}

/** Keep search results inside the matching account; provider/account matches show all its models. */
export function searchProviderGroups(accounts: readonly ProviderAccountSummary[], query: string): ProviderGroup[] {
	const normalized = query.trim().toLocaleLowerCase();
	return providerGroups(accounts).map((group) => ({
		...group,
		accounts: group.accounts.map((account) => ({
			...account,
			models: !normalized || [account.providerId, account.displayName].some((value) => value.toLocaleLowerCase().includes(normalized))
				? account.models
				: account.models.filter((model) => [model.id, model.displayName].some((value) => value.toLocaleLowerCase().includes(normalized))),
		})).filter((account) => !normalized || account.models.length > 0 || [account.providerId, account.displayName].some((value) => value.toLocaleLowerCase().includes(normalized))),
	})).filter((group) => group.accounts.length > 0);
}
