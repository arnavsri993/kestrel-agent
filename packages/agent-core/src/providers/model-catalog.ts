import type { KestrelDatabase } from "@kestrel/database";
import {
	ProviderAccountSummarySchema,
	type ProviderAccountModel,
	type ProviderAccountSummary,
} from "@kestrel/shared-types";
import {
	ModelProviderError,
	type DiscoveredModel,
	type ModelProvider,
	type ProviderModelAvailability,
} from "./types";

const CATALOG_KEY = "providers.model-catalog.v2";
const CATALOG_VERSION = 2;
const STALE_AFTER_MS = 15 * 60_000;
const MAX_DISCOVERED_MODELS = 2_000;
const MAX_CONCURRENT_DISCOVERIES = 3;

interface CatalogDiscoveryState {
	state: "idle" | "fresh" | "stale" | "failed" | "unsupported";
	lastAttemptAt?: string;
	lastSuccessAt?: string;
	error?: string;
}

export interface CatalogModelRecord extends ProviderAccountModel {
	/** Internal marker used to keep automatic routing honest about fallbacks. */
	isFallback: boolean;
}

interface CatalogEndpoint {
	endpointId: string;
	providerId: string;
	accountId: string;
	displayName: string;
	authTransport: "api_key" | "oauth" | "cli_profile" | "local";
	enabled: boolean;
	configurationVersion?: string;
	capabilities: ProviderAccountSummary["capabilities"];
	discovery: CatalogDiscoveryState;
	models: CatalogModelRecord[];
}

interface PersistedCatalog {
	version: number;
	endpoints: CatalogEndpoint[];
}

function safeTimestamp(value: string | undefined): string | undefined {
	return value && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function boundedPositive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: undefined;
}

function isStale(value: string | undefined, now: Date): boolean {
	const timestamp = value ? Date.parse(value) : Number.NaN;
	return !Number.isFinite(timestamp) || now.getTime() - timestamp > STALE_AFTER_MS;
}

function endpointIdentity(provider: ModelProvider): Omit<
	CatalogEndpoint,
	"discovery" | "models"
> {
	const account = provider.account;
	return {
		endpointId: provider.id,
		providerId: account?.providerId ?? provider.poolId ?? provider.id,
		accountId: account?.id ?? provider.id,
		displayName: account?.displayName ?? provider.poolId ?? provider.id,
		authTransport: account?.authTransport ?? (provider.capabilities.local ? "local" : "api_key"),
		enabled: account?.enabled ?? true,
		...(account?.configurationVersion
			? { configurationVersion: account.configurationVersion }
			: {}),
		capabilities: {
			streaming: provider.capabilities.streaming,
			tools: provider.capabilities.tools,
			images: provider.capabilities.images,
			audio: provider.capabilities.audio,
			documents: provider.capabilities.documents,
			...(provider.capabilities.video !== undefined
				? { video: provider.capabilities.video }
				: {}),
			local: provider.capabilities.local,
		},
	};
}

function fallbackModel(provider: ModelProvider): CatalogModelRecord[] {
	if (!provider.defaultModel?.trim()) return [];
	const reasoningEfforts = provider.profileHints?.features?.reasoningLevels
		? (["none", "low", "medium", "high", "xhigh", "max"] as const)
		: [];
	return [
		{
			id: provider.defaultModel,
			displayName: provider.profileHints?.displayName ?? provider.defaultModel,
			availability: "unknown",
			discoverySource: "fallback",
			capabilities: {
				capabilityProvenance: "transport",
				streaming: provider.capabilities.streaming,
				tools: provider.capabilities.tools,
				vision: provider.capabilities.images,
				audio: provider.capabilities.audio,
				documents: provider.capabilities.documents,
				video: provider.capabilities.video ?? false,
				structuredOutput:
					provider.profileHints?.features?.structuredOutput ??
					provider.capabilities.tools,
				reasoningEfforts: [...reasoningEfforts],
				...(boundedPositive(provider.profileHints?.limits?.contextWindow)
					? {
						contextWindow: boundedPositive(
							provider.profileHints?.limits?.contextWindow,
						)!,
					}
					: {}),
				...(boundedPositive(provider.profileHints?.limits?.maxOutputTokens)
					? {
						maxOutputTokens: boundedPositive(
							provider.profileHints?.limits?.maxOutputTokens,
						)!,
					}
					: {}),
			},
			isFallback: true,
		},
	];
}

function recordFromDiscovery(
	provider: ModelProvider,
	model: DiscoveredModel,
	now: string,
): CatalogModelRecord | undefined {
	const id = model.id.trim();
	if (!id || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) return undefined;
	const capabilities = model.capabilities;
	const capabilityProvenance =
		capabilities?.capabilityProvenance ?? "unknown";
	const useTransportDefaults = capabilityProvenance === "transport";
	return {
		id,
		displayName:
			model.displayName?.trim().slice(0, 300) || id,
		availability: model.availability ?? "unknown",
		discoverySource: model.source,
		discoveredAt: now,
		capabilities: {
			capabilityProvenance,
			streaming:
				capabilities?.streaming ??
				(useTransportDefaults ? provider.capabilities.streaming : false),
			tools:
				capabilities?.tools ??
				(useTransportDefaults ? provider.capabilities.tools : false),
			vision:
				capabilities?.images ??
				(useTransportDefaults ? provider.capabilities.images : false),
			audio:
				capabilities?.audio ??
				(useTransportDefaults ? provider.capabilities.audio : false),
			documents:
				capabilities?.documents ??
				(useTransportDefaults ? provider.capabilities.documents : false),
			video:
				capabilities?.video ??
				(useTransportDefaults ? (provider.capabilities.video ?? false) : false),
			structuredOutput:
				capabilities?.structuredOutput ??
				(useTransportDefaults ? provider.capabilities.tools : false),
			reasoningEfforts: [...(capabilities?.reasoningEfforts ?? [])],
			...(boundedPositive(capabilities?.contextWindow)
				? { contextWindow: boundedPositive(capabilities?.contextWindow)! }
				: {}),
			...(boundedPositive(capabilities?.maxOutputTokens)
				? { maxOutputTokens: boundedPositive(capabilities?.maxOutputTokens)! }
				: {}),
		},
		isFallback: false,
	};
}

function sanitizeStoredEndpoint(
	value: unknown,
	now: Date,
): CatalogEndpoint | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Partial<CatalogEndpoint>;
	if (
		typeof raw.endpointId !== "string" ||
		typeof raw.providerId !== "string" ||
		typeof raw.accountId !== "string" ||
		typeof raw.displayName !== "string" ||
		typeof raw.authTransport !== "string" ||
		typeof raw.enabled !== "boolean" ||
		!raw.capabilities ||
		!raw.discovery
	)
		return undefined;
	const models = (Array.isArray(raw.models) ? raw.models : []).flatMap((model) => {
		const rawModel =
			model && typeof model === "object" && !Array.isArray(model)
				? (model as unknown as Record<string, unknown>)
				: undefined;
		const rawCapabilities =
			rawModel?.capabilities &&
			typeof rawModel.capabilities === "object" &&
			!Array.isArray(rawModel.capabilities)
				? (rawModel.capabilities as Record<string, unknown>)
				: {};
		// V2 catalogs predate explicit capability provenance. Their fallback
		// records were transport-derived; every dynamic record stays conservative
		// until refreshed rather than inheriting a provider-wide feature matrix.
		const parsed = ProviderAccountSummarySchema.shape.models.element.safeParse({
			...rawModel,
			capabilities: {
				...rawCapabilities,
				capabilityProvenance:
					rawCapabilities.capabilityProvenance ??
					(rawModel?.discoverySource === "fallback" ? "transport" : "unknown"),
			},
		});
		if (!parsed.success) return [];
		return [
			{
				...parsed.data,
				availability:
					parsed.data.availability === "available" &&
					isStale(parsed.data.discoveredAt, now)
						? ("stale" as const)
						: parsed.data.availability,
				isFallback: parsed.data.discoverySource === "fallback",
			},
		];
	});
	const discovery = raw.discovery as CatalogDiscoveryState;
	if (
		discovery.state !== "idle" &&
		discovery.state !== "fresh" &&
		discovery.state !== "stale" &&
		discovery.state !== "failed" &&
		discovery.state !== "unsupported"
	)
		return undefined;
	const parsed = ProviderAccountSummarySchema.safeParse({
		id: raw.accountId,
		endpointId: raw.endpointId,
		providerId: raw.providerId,
		displayName: raw.displayName,
		authTransport: raw.authTransport,
		enabled: raw.enabled,
		capabilities: raw.capabilities,
		discovery: {
			state: isStale(safeTimestamp(discovery.lastSuccessAt), now)
				? discovery.state === "fresh"
					? "stale"
					: discovery.state
				: discovery.state,
			...(safeTimestamp(discovery.lastAttemptAt)
				? { lastAttemptAt: discovery.lastAttemptAt }
				: {}),
			...(safeTimestamp(discovery.lastSuccessAt)
				? { lastSuccessAt: discovery.lastSuccessAt }
				: {}),
			...(typeof discovery.error === "string" && discovery.error
				? { error: discovery.error.slice(0, 500) }
				: {}),
		},
		models,
	});
	if (!parsed.success) return undefined;
	const configurationVersion =
		typeof raw.configurationVersion === "string" &&
		raw.configurationVersion.length > 0 &&
		raw.configurationVersion.length <= 200
			? raw.configurationVersion
			: undefined;
	return {
		endpointId: parsed.data.endpointId,
		providerId: parsed.data.providerId,
		accountId: parsed.data.id,
		displayName: parsed.data.displayName,
		authTransport: parsed.data.authTransport,
		enabled: parsed.data.enabled,
		...(configurationVersion ? { configurationVersion } : {}),
		capabilities: parsed.data.capabilities,
		discovery: {
			state: parsed.data.discovery.state,
			...(parsed.data.discovery.lastAttemptAt
				? { lastAttemptAt: parsed.data.discovery.lastAttemptAt }
				: {}),
			...(parsed.data.discovery.lastSuccessAt
				? { lastSuccessAt: parsed.data.discovery.lastSuccessAt }
				: {}),
			...(parsed.data.discovery.error
				? { error: parsed.data.discovery.error }
				: {}),
		},
		models,
	};
}

function availabilityForError(error: unknown): ProviderModelAvailability {
	if (error instanceof ModelProviderError) {
		if (error.status === 401) return "authentication_required";
		if (error.status === 403) return "permission_denied";
	}
	return "stale";
}

function errorDetail(error: unknown): string {
	// Provider and CLI errors can echo request headers, a URL query, or a whole
	// upstream response. Persist only a stable diagnostic category; full details
	// stay in the provider process and never become renderer-visible state.
	if (error instanceof ModelProviderError && error.status)
		return `Model discovery failed (HTTP ${error.status}).`;
	return "Model discovery failed. Check the account connection and refresh again.";
}

export class ModelCatalog {
	private readonly endpoints = new Map<string, CatalogEndpoint>();

	constructor(
		private readonly database: KestrelDatabase,
		providers: readonly ModelProvider[],
		private readonly now: () => Date = () => new Date(),
	) {
		const stored = database.getPrivateState<PersistedCatalog>(CATALOG_KEY);
		const storedByEndpoint = new Map(
			(stored?.version === CATALOG_VERSION && Array.isArray(stored.endpoints)
				? stored.endpoints
				: [])
				.flatMap((endpoint) => {
					const parsed = sanitizeStoredEndpoint(endpoint, this.now());
					return parsed ? [[parsed.endpointId, parsed] as const] : [];
				}),
		);
		for (const provider of providers) {
			const identity = endpointIdentity(provider);
			const storedEndpoint = storedByEndpoint.get(provider.id);
			// An endpoint can keep its stable account ID while its base URL, headers,
			// credential, or enablement changes. Reusing that account's old catalog
			// would turn a previous endpoint's entitlement into a false fresh result.
			const reusableEndpoint =
				storedEndpoint?.configurationVersion === identity.configurationVersion
					? storedEndpoint
					: undefined;
			// A fallback is only authoritative when the adapter has no supported
			// discovery surface. If discovery exists, an empty result is meaningful:
			// this account has no advertised models and we must not resurrect a
			// static default from a different account or an earlier release.
			const fallback = provider.discoverModels ? [] : fallbackModel(provider);
			this.endpoints.set(provider.id, {
				...identity,
				discovery: reusableEndpoint?.discovery ?? { state: "idle" },
				models:
					reusableEndpoint?.models.length
						? reusableEndpoint.models
						: fallback,
			});
		}
		this.persist();
	}

	list(): ProviderAccountSummary[] {
		this.refreshStaleness();
		return [...this.endpoints.values()]
			.map((endpoint) =>
				ProviderAccountSummarySchema.parse({
					id: endpoint.accountId,
					endpointId: endpoint.endpointId,
					providerId: endpoint.providerId,
					displayName: endpoint.displayName,
					authTransport: endpoint.authTransport,
					enabled: endpoint.enabled,
					capabilities: endpoint.capabilities,
					discovery: endpoint.discovery,
					models: endpoint.models.map(({ isFallback: _isFallback, ...model }) =>
						model,
					),
				}),
			)
			.sort(
				(left, right) =>
					left.providerId.localeCompare(right.providerId) ||
					left.displayName.localeCompare(right.displayName),
			);
	}

	modelsForEndpoint(endpointId: string): CatalogModelRecord[] {
		this.refreshStaleness();
		return this.endpoints.get(endpointId)?.models.map((model) => ({ ...model })) ?? [];
	}

	/**
	 * Refreshes only supported interfaces. Existing cache entries survive a
	 * failure and become stale instead of disappearing or being silently
	 * replaced by a hard-coded vendor list.
	 */
	async refresh(
		providers: readonly ModelProvider[],
		providerId?: string,
		signal?: AbortSignal,
	): Promise<ProviderAccountSummary[]> {
		this.refreshStaleness();
		const targets = providers.filter((provider) => {
			const endpoint = this.endpoints.get(provider.id);
			if (
				providerId &&
				provider.id !== providerId &&
				provider.poolId !== providerId &&
				provider.account?.id !== providerId &&
				endpoint?.providerId !== providerId
			)
				return false;
			return true;
		});
		const iterator = targets.values();
		const worker = async () => {
			for (;;) {
				signal?.throwIfAborted();
				const next = iterator.next();
				if (next.done) return;
				await this.refreshEndpoint(next.value, signal);
			}
		};
		try {
			await Promise.all(
				Array.from(
					{ length: Math.min(MAX_CONCURRENT_DISCOVERIES, targets.length) },
					() => worker(),
				),
			);
		} finally {
			// Persist every completed endpoint even if a startup deadline aborts one
			// slower discovery request. The next bounded refresh can resume safely.
			this.persist();
		}
		return this.list();
	}

	/** Refresh only missing or expired dynamic catalogs during bounded startup. */
	async refreshStale(
		providers: readonly ModelProvider[],
		signal?: AbortSignal,
	): Promise<ProviderAccountSummary[]> {
		this.refreshStaleness();
		const now = this.now();
		const due = providers.filter((provider) => {
			const endpoint = this.endpoints.get(provider.id);
			if (!endpoint || !provider.discoverModels) return false;
			switch (endpoint.discovery.state) {
				case "idle":
				case "stale":
					return true;
				case "failed":
					return isStale(endpoint.discovery.lastAttemptAt, now);
				case "fresh":
				case "unsupported":
					return false;
			}
		});
		if (due.length === 0) return this.list();
		return this.refresh(due, undefined, signal);
	}

	private async refreshEndpoint(
		provider: ModelProvider,
		signal?: AbortSignal,
	): Promise<void> {
		signal?.throwIfAborted();
		const current = this.endpoints.get(provider.id);
		if (!current) return;
		const attemptAt = this.now().toISOString();
		if (!provider.discoverModels) {
			current.discovery = {
				state: "unsupported",
				lastAttemptAt: attemptAt,
				...(current.discovery.lastSuccessAt
					? { lastSuccessAt: current.discovery.lastSuccessAt }
					: {}),
			};
			return;
		}
		try {
			const discovered = await provider.discoverModels(signal);
			signal?.throwIfAborted();
			const successfulAt = this.now().toISOString();
			const models = [...new Map(
				discovered
					.slice(0, MAX_DISCOVERED_MODELS)
					.flatMap((model) => {
						const record = recordFromDiscovery(provider, model, successfulAt);
						return record ? [[record.id, record] as const] : [];
					}),
			).values()];
			// A successful empty enumeration means the account currently exposes
			// no models. Preserve that result instead of turning a maintained
			// default into a fake entitlement.
			current.models = models;
			current.discovery = {
				state: "fresh",
				lastAttemptAt: attemptAt,
				lastSuccessAt: successfulAt,
			};
		} catch (error) {
			if (signal?.aborted) throw error;
			const status = availabilityForError(error);
			current.models = current.models.map((model) => ({
				...model,
				availability:
					status === "authentication_required" || status === "permission_denied"
						? status
						: model.availability === "available"
							? "stale"
							: model.availability,
			}));
			current.discovery = {
				state: "failed",
				lastAttemptAt: attemptAt,
				...(current.discovery.lastSuccessAt
					? { lastSuccessAt: current.discovery.lastSuccessAt }
					: {}),
				error: errorDetail(error),
			};
		}
	}

	private persist(): void {
		this.database.setPrivateState(CATALOG_KEY, {
			version: CATALOG_VERSION,
			endpoints: [...this.endpoints.values()],
		} satisfies PersistedCatalog);
	}

	/**
	 * A long-lived core must not continue to route from a catalog merely because
	 * it was fresh at startup. Mark entries stale lazily at each read, then let
	 * the caller refresh them before automatic routing uses them again.
	 */
	private refreshStaleness(): void {
		const now = this.now();
		let changed = false;
		for (const endpoint of this.endpoints.values()) {
			if (
				endpoint.discovery.state === "fresh" &&
				isStale(endpoint.discovery.lastSuccessAt, now)
			) {
				endpoint.discovery = { ...endpoint.discovery, state: "stale" };
				changed = true;
			}
			for (const model of endpoint.models) {
				if (
					model.availability === "available" &&
					isStale(model.discoveredAt, now)
				) {
					model.availability = "stale";
					changed = true;
				}
			}
		}
		if (changed) this.persist();
	}
}
