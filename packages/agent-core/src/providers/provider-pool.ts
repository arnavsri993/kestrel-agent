import {
	ModelProviderError,
	type ModelCallOptions,
	type ModelProvider,
	type ModelRequest,
	type ModelResult,
	type ProviderAvailabilityReason,
} from "./types";

const DEFAULT_HEALTH_BACKOFF_MS = 30_000;
const MAX_HEALTH_BACKOFF_MS = 24 * 60 * 60_000;

export interface ProviderAttempt {
	providerId: string;
	startedAt: string;
	completedAt: string;
	status: "completed" | "failed";
	error?: string;
}

export interface ProviderPoolResult {
	result: ModelResult;
	attempts: ProviderAttempt[];
}

export interface ProviderHealth {
	providerId: string;
	poolId?: string;
	attempts: number;
	successes: number;
	failures: number;
	consecutiveFailures: number;
	averageLatencyMs: number;
	unhealthyUntil?: string;
	unhealthyReason?: ProviderAvailabilityReason;
}

export interface ProviderVerification {
	providerId: string;
	poolId?: string;
	ok: boolean;
	latencyMs: number;
	error?: string;
}

export class ProviderPoolError extends Error {
	constructor(
		message: string,
		readonly attempts: ProviderAttempt[],
		cause?: unknown,
	) {
		super(message, { cause });
		this.name = "ProviderPoolError";
	}
}

const CAPACITY_ERROR_PATTERN =
	/(?:capacity|overloaded|exhausted your capacity|model_capacity)/i;
const RATE_LIMIT_ERROR_PATTERN =
	/(?:rate.?limit|too many requests|quota|retry.?after|retry in)/i;
const RETRY_DELAY_PATTERN =
	/(?:retry(?:\s+after|\s+in)?|try again in)\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)\b/i;

function boundedHealthBackoff(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value))
		return DEFAULT_HEALTH_BACKOFF_MS;
	return Math.max(0, Math.min(MAX_HEALTH_BACKOFF_MS, Math.trunc(value)));
}

function boundedRetryDelay(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.min(MAX_HEALTH_BACKOFF_MS, Math.trunc(value)));
}

function retryDelayFromMessage(message: string): number | undefined {
	const match = message.match(RETRY_DELAY_PATTERN);
	if (!match) return undefined;
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value < 0) return undefined;
	const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[
		match[2]!.toLowerCase() as "ms" | "s" | "m" | "h"
	];
	return boundedRetryDelay(value * multiplier);
}

function availabilityReason(error: unknown): ProviderAvailabilityReason {
	const message = error instanceof Error ? error.message : String(error);
	const status = error instanceof ModelProviderError ? error.status : undefined;
	if (CAPACITY_ERROR_PATTERN.test(message)) return "capacity";
	if (status === 429 || RATE_LIMIT_ERROR_PATTERN.test(message))
		return "rate_limit";
	if (
		(error instanceof ModelProviderError && error.retryable) ||
		(status !== undefined && status >= 500 && status < 600)
	)
		return "transient";
	return "unknown";
}

function availabilityDelay(
	error: unknown,
	baseBackoffMs: number | undefined,
	consecutiveFailures: number,
): number {
	const providerHint = boundedRetryDelay(
		error instanceof ModelProviderError
			? error.retryAfterMs
			: retryDelayFromMessage(error instanceof Error ? error.message : String(error)),
	);
	if (providerHint !== undefined) return providerHint;
	const base = boundedHealthBackoff(baseBackoffMs);
	const multiplier =
		availabilityReason(error) === "unknown"
			? 1
			: 2 ** Math.min(Math.max(consecutiveFailures - 1, 0), 5);
	return Math.min(MAX_HEALTH_BACKOFF_MS, Math.trunc(base * multiplier));
}

export class ProviderPool {
	private readonly providers = new Map<string, ModelProvider>();
	private readonly unhealthyUntil = new Map<string, number>();
	private readonly unhealthyReason = new Map<
		string,
		ProviderAvailabilityReason
	>();
	private readonly measurements = new Map<
		string,
		Omit<
			ProviderHealth,
			"providerId" | "poolId" | "unhealthyUntil" | "unhealthyReason"
		>
	>();

	constructor(
		providers: ModelProvider[],
		private readonly now: () => Date = () => new Date(),
	) {
		for (const provider of providers) {
			if (this.providers.has(provider.id))
				throw new Error(`Duplicate model provider ${provider.id}.`);
			this.providers.set(provider.id, provider);
		}
	}

	list(): ModelProvider[] {
		return [...this.providers.values()];
	}

	async close(): Promise<void> {
		await Promise.all(
			[...this.providers.values()].map((provider) => provider.close?.()),
		);
	}

	health(): ProviderHealth[] {
		return [...this.providers.values()].map((provider) => {
			const measurement = this.measurements.get(provider.id) ?? {
				attempts: 0,
				successes: 0,
				failures: 0,
				consecutiveFailures: 0,
				averageLatencyMs: 0,
			};
			const unhealthyUntil = this.unhealthyUntil.get(provider.id);
			const unhealthyReason = this.unhealthyReason.get(provider.id);
			const isUnhealthy =
				unhealthyUntil !== undefined && unhealthyUntil > this.now().getTime();
			return {
				providerId: provider.id,
				...(provider.poolId ? { poolId: provider.poolId } : {}),
				...measurement,
				...(isUnhealthy && unhealthyUntil !== undefined
					? {
							unhealthyUntil: new Date(unhealthyUntil).toISOString(),
							...(unhealthyReason ? { unhealthyReason } : {}),
						}
					: {}),
			};
		});
	}

	async verify(
		providerId: string,
		signal?: AbortSignal,
	): Promise<ProviderVerification[]> {
		signal?.throwIfAborted();
		const selected =
			providerId === "auto"
				? [...this.providers.values()]
				: this.candidates([providerId], false, undefined, undefined, "auto");
		if (selected.length === 0)
			throw new Error(`Provider ${providerId} is not configured.`);
		const output: ProviderVerification[] = [];
		for (const provider of selected) {
			signal?.throwIfAborted();
			const started = this.now().getTime();
			try {
				if (!provider.probe)
					throw new Error("Provider does not expose a credential probe.");
				await provider.probe(signal);
				signal?.throwIfAborted();
				output.push({
					providerId: provider.id,
					...(provider.poolId ? { poolId: provider.poolId } : {}),
					ok: true,
					latencyMs: Math.max(0, this.now().getTime() - started),
				});
			} catch (error) {
				if (signal?.aborted) throw error;
				output.push({
					providerId: provider.id,
					...(provider.poolId ? { poolId: provider.poolId } : {}),
					ok: false,
					latencyMs: Math.max(0, this.now().getTime() - started),
					error:
						error instanceof Error
							? error.message.slice(0, 500)
							: "Provider verification failed.",
				});
			}
		}
		return output;
	}

	private candidates(
		providerIds: string[],
		automatic: boolean,
		providerModels: Record<string, string> | undefined,
		costScore: ((providerId: string, model: string) => number) | undefined,
		fallbackModel: string,
	): ModelProvider[] {
		const selected: ModelProvider[] = [];
		for (const requested of providerIds) {
			for (const provider of this.providers.values())
				if (
					(provider.id === requested || provider.poolId === requested) &&
					!selected.includes(provider)
				)
					selected.push(provider);
		}
		if (!automatic) return selected;
		return selected.sort((left, right) => {
			const score = (provider: ModelProvider) => {
				const measurement = this.measurements.get(provider.id);
				const failureRate = measurement?.attempts
					? measurement.failures / measurement.attempts
					: 0;
				const latency = measurement?.averageLatencyMs ?? 0;
				const model =
					providerModels?.[provider.id] ??
					(provider.poolId ? providerModels?.[provider.poolId] : undefined) ??
					fallbackModel;
				return (
					failureRate * 10_000 +
					(measurement?.consecutiveFailures ?? 0) * 5_000 +
					latency +
					(costScore?.(provider.id, model) ?? 0) * 1_000
				);
			};
			return score(left) - score(right) || left.id.localeCompare(right.id);
		});
	}

	private measured(
		provider: ModelProvider,
		startedAt: string,
		succeeded: boolean,
	): void {
		const previous = this.measurements.get(provider.id) ?? {
			attempts: 0,
			successes: 0,
			failures: 0,
			consecutiveFailures: 0,
			averageLatencyMs: 0,
		};
		const latency = Math.max(0, this.now().getTime() - Date.parse(startedAt));
		this.measurements.set(provider.id, {
			attempts: previous.attempts + 1,
			successes: previous.successes + (succeeded ? 1 : 0),
			failures: previous.failures + (succeeded ? 0 : 1),
			consecutiveFailures: succeeded ? 0 : previous.consecutiveFailures + 1,
			averageLatencyMs:
				previous.attempts === 0
					? latency
					: Math.round(previous.averageLatencyMs * 0.7 + latency * 0.3),
		});
	}

	private supports(provider: ModelProvider, request: ModelRequest): boolean {
		const parts = request.messages.flatMap((message) => message.content);
		return (
			!parts.some(
				(part) => part.type === "image" && !provider.capabilities.images,
			) &&
			!parts.some(
				(part) => part.type === "audio" && !provider.capabilities.audio,
			) &&
			!parts.some(
				(part) => part.type === "video" && !provider.capabilities.video,
			) &&
			!parts.some(
				(part) => part.type === "document" && !provider.capabilities.documents,
			)
		);
	}

	async complete(
		request: ModelRequest,
		options: ModelCallOptions & {
			providerIds?: string[];
			providerModels?: Record<string, string>;
			healthBackoffMs?: number;
			automaticRouting?: boolean;
			costScore?: (providerId: string, model: string) => number;
			canAttempt?: (
				providerId: string,
				model: string,
				attemptIndex: number,
			) => boolean;
			providerAllowed?: (providerId: string, poolId?: string) => boolean;
		} = {},
	): Promise<ProviderPoolResult> {
		const automatic = options.automaticRouting ?? false;
		const providerIds = options.providerIds ?? [
			...new Set(
				[...this.providers.values()].map(
					(provider) => provider.poolId ?? provider.id,
				),
			),
		];
		if (providerIds.length === 0)
			throw new Error("No model providers are configured.");
		const attempts: ProviderAttempt[] = [];
		let callAttempt = 0;
		const selected = this.candidates(
			providerIds,
			automatic,
			options.providerModels,
			options.costScore,
			request.model,
		);
		const candidates = selected.filter(
			(provider) =>
				this.supports(provider, request) &&
				(options.providerAllowed?.(provider.id, provider.poolId) ?? true),
		);
		for (const provider of selected.filter(
			(candidate) => !this.supports(candidate, request),
		)) {
			const timestamp = this.now().toISOString();
			attempts.push({
				providerId: provider.id,
				startedAt: timestamp,
				completedAt: timestamp,
				status: "failed",
				error: "Provider capabilities do not support this request.",
			});
		}
		for (const provider of selected.filter(
			(candidate) =>
				this.supports(candidate, request) &&
				!(options.providerAllowed?.(candidate.id, candidate.poolId) ?? true),
		)) {
			const timestamp = this.now().toISOString();
			attempts.push({
				providerId: provider.id,
				startedAt: timestamp,
				completedAt: timestamp,
				status: "failed",
				error: "Provider is blocked by managed policy.",
			});
		}
		let lastError: unknown;
		for (let index = 0; index < candidates.length; index += 1) {
			if (options.signal?.aborted) throw options.signal.reason;
			const provider = candidates[index]!;
			const providerId = provider.id;
			if ((this.unhealthyUntil.get(providerId) ?? 0) > this.now().getTime())
				continue;
			const model =
				options.providerModels?.[providerId] ??
				(provider.poolId
					? options.providerModels?.[provider.poolId]
					: undefined) ??
				(request.model === "auto" ? provider.defaultModel : request.model);
			if (!model) {
				const timestamp = this.now().toISOString();
				attempts.push({
					providerId,
					startedAt: timestamp,
					completedAt: timestamp,
					status: "failed",
					error: "Provider has no automatic model mapping.",
				});
				continue;
			}
			if (
				options.canAttempt &&
				!options.canAttempt(providerId, model, callAttempt)
			) {
				const timestamp = this.now().toISOString();
				attempts.push({
					providerId,
					startedAt: timestamp,
					completedAt: timestamp,
					status: "failed",
					error: "Budget policy blocked this provider attempt.",
				});
				continue;
			}
			callAttempt += 1;
			const startedAt = this.now().toISOString();
			try {
				options.onEvent?.({
					type: "provider_progress",
					detail: `Trying provider ${providerId}.`,
				});
				const { tools, ...requestWithoutTools } = request;
				const providerRequest: ModelRequest = provider.capabilities.tools
					? { ...requestWithoutTools, model, ...(tools ? { tools } : {}) }
					: { ...requestWithoutTools, model };
				const result = await provider.complete(providerRequest, options);
				attempts.push({
					providerId,
					startedAt,
					completedAt: this.now().toISOString(),
					status: "completed",
				});
				this.measured(provider, startedAt, true);
				this.unhealthyUntil.delete(providerId);
				this.unhealthyReason.delete(providerId);
				return { result, attempts };
			} catch (error) {
				if (options.signal?.aborted) throw error;
				lastError = error;
				attempts.push({
					providerId,
					startedAt,
					completedAt: this.now().toISOString(),
					status: "failed",
					error:
						error instanceof Error ? error.message : "Provider call failed.",
				});
				this.measured(provider, startedAt, false);
				const consecutiveFailures =
					this.measurements.get(providerId)?.consecutiveFailures ?? 1;
				this.unhealthyUntil.set(
					providerId,
					this.now().getTime() +
						availabilityDelay(
							error,
							options.healthBackoffMs,
							consecutiveFailures,
						),
				);
				this.unhealthyReason.set(providerId, availabilityReason(error));
				const next = candidates[index + 1];
				if (!next) break;
			}
		}
		for (const requested of providerIds)
			if (
				![...this.providers.values()].some(
					(provider) =>
						provider.id === requested || provider.poolId === requested,
				)
			) {
				const timestamp = this.now().toISOString();
				attempts.push({
					providerId: requested,
					startedAt: timestamp,
					completedAt: timestamp,
					status: "failed",
					error: "Provider is not configured.",
				});
			}
		const detail = attempts
			.map(
				(attempt) =>
					`${attempt.providerId}: ${attempt.error ?? attempt.status}`,
			)
			.join("; ");
		throw new ProviderPoolError(
			`All eligible model providers failed${detail ? ` (${detail})` : ""}.`,
			attempts,
			lastError,
		);
	}
}
