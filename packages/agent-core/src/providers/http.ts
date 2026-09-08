import {
	ModelProviderError,
	type ProviderQuotaSnapshot,
} from "./types";

export const PROVIDER_CONNECT_TIMEOUT_MS = 20_000;

const NETWORK_UNAVAILABLE_CODES = new Set(["ENOTFOUND", "ECONNREFUSED"]);
const MAX_QUOTA_RESET_MS = 7 * 24 * 60 * 60_000;

const QUOTA_HEADER_PAIRS = [
	["ratelimit-limit", "ratelimit-remaining"],
	["x-ratelimit-limit", "x-ratelimit-remaining"],
	["x-ratelimit-limit-requests", "x-ratelimit-remaining-requests"],
	["x-ratelimit-limit-tokens", "x-ratelimit-remaining-tokens"],
	[
		"anthropic-ratelimit-requests-limit",
		"anthropic-ratelimit-requests-remaining",
	],
	[
		"anthropic-ratelimit-tokens-limit",
		"anthropic-ratelimit-tokens-remaining",
	],
] as const;

const QUOTA_RESET_HEADERS = [
	"retry-after",
	"ratelimit-reset",
	"x-ratelimit-reset",
	"x-ratelimit-reset-requests",
	"x-ratelimit-reset-tokens",
	"anthropic-ratelimit-requests-reset",
	"anthropic-ratelimit-tokens-reset",
] as const;

function providerConnectSignal(callerSignal?: AbortSignal | null): {
	signal: AbortSignal;
	connectTimeoutSignal: AbortSignal;
} {
	const connectTimeoutSignal = AbortSignal.timeout(PROVIDER_CONNECT_TIMEOUT_MS);
	if (!callerSignal) return { signal: connectTimeoutSignal, connectTimeoutSignal };
	return {
		signal: AbortSignal.any([callerSignal, connectTimeoutSignal]),
		connectTimeoutSignal,
	};
}

function isNetworkUnavailableError(error: unknown): boolean {
	for (
		let current: unknown = error;
		current && typeof current === "object";
		current = (current as { cause?: unknown }).cause
	) {
		const code = (current as { code?: unknown }).code;
		if (typeof code === "string" && NETWORK_UNAVAILABLE_CODES.has(code))
			return true;
	}
	return false;
}

function providerFetchError(
	error: unknown,
	providerId: string,
	callerSignal: AbortSignal | undefined,
	connectTimeoutSignal: AbortSignal,
): never {
	if (callerSignal?.aborted) throw error;
	if (connectTimeoutSignal.aborted && !callerSignal?.aborted) {
		throw new ModelProviderError(
			`Provider connect timed out after ${PROVIDER_CONNECT_TIMEOUT_MS / 1_000}s.`,
			providerId,
			true,
		);
	}
	if (isNetworkUnavailableError(error)) {
		throw new ModelProviderError(
			"Network unavailable: provider host could not be reached.",
			providerId,
			false,
		);
	}
	throw new ModelProviderError(
		"Provider request failed before a response was received.",
		providerId,
		true,
	);
}

export function parseRetryAfterMs(
	value: string | null,
	nowMs = Date.now(),
): number | undefined {
	if (!value) return undefined;
	const normalized = value.trim();
	if (!normalized) return undefined;
	const seconds = Number(normalized);
	if (Number.isFinite(seconds) && seconds >= 0)
		return Math.trunc(seconds * 1_000);
	const dateMs = Date.parse(normalized);
	if (!Number.isFinite(dateMs)) return undefined;
	return Math.max(0, dateMs - nowMs);
}

function headerNumber(value: string | null): number | undefined {
	if (!value) return undefined;
	const match = value.match(/^\s*(\d+(?:\.\d+)?)/);
	if (!match) return undefined;
	const parsed = Number(match[1]);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function resetDelayMs(value: string | null, nowMs: number): number | undefined {
	if (!value) return undefined;
	const normalized = value.trim();
	if (!normalized) return undefined;
	const numeric = Number(normalized);
	if (Number.isFinite(numeric) && numeric >= 0) {
		// RFC 9333 uses a relative number of seconds, while several upstream
		// APIs use a Unix timestamp. Treat implausibly large values as epoch
		// seconds to avoid turning a reset timestamp into decades of scarcity.
		const targetMs =
			numeric > nowMs / 1_000 ? numeric * 1_000 : nowMs + numeric * 1_000;
		return Math.max(0, targetMs - nowMs);
	}
	const retryAfter = parseRetryAfterMs(normalized, nowMs);
	if (retryAfter !== undefined) return retryAfter;
	const duration = [...normalized.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/gi)]
		.reduce((total, match) => {
			const amount = Number(match[1]);
			const unit = match[2]?.toLowerCase();
			const multiplier =
				unit === "ms"
					? 1
					: unit === "s"
						? 1_000
						: unit === "m"
							? 60_000
							: unit === "h"
								? 3_600_000
								: unit === "d"
									? 86_400_000
									: 0;
			return total + (Number.isFinite(amount) ? amount * multiplier : 0);
		}, 0);
	return duration > 0 ? duration : undefined;
}

/**
 * Extract only explicitly numeric quota metadata. Header names, values, and
 * any provider response body remain private; callers receive a bounded
 * fraction suitable for account-aware routing, or no observation at all.
 */
export function quotaFromResponseHeaders(
	headers: Headers,
	nowMs = Date.now(),
): ProviderQuotaSnapshot | undefined {
	const fractions = QUOTA_HEADER_PAIRS.flatMap(([limitName, remainingName]) => {
		const limit = headerNumber(headers.get(limitName));
		const remaining = headerNumber(headers.get(remainingName));
		if (
			limit === undefined ||
			remaining === undefined ||
			limit <= 0 ||
			remaining > limit
		)
			return [];
		return [remaining / limit];
	});
	if (fractions.length === 0) return undefined;
	const resetDelay = QUOTA_RESET_HEADERS.map((name) =>
		resetDelayMs(headers.get(name), nowMs),
	).find((value) => value !== undefined);
	return {
		confidence: "exact",
		remainingFraction: Math.max(0, Math.min(1, Math.min(...fractions))),
		...(resetDelay !== undefined
			? {
					resetAt: new Date(
						nowMs + Math.min(MAX_QUOTA_RESET_MS, resetDelay),
					).toISOString(),
				}
			: {}),
	};
}

export interface ServerSentEvent {
	event?: string;
	data: string;
}

export async function readServerSentEvents(
	response: Response,
	providerId: string,
	onEvent: (event: ServerSentEvent) => void,
): Promise<void> {
	if (!response.body)
		throw new ModelProviderError(
			"Provider returned an empty streaming response.",
			providerId,
			true,
			response.status,
			false,
			parseRetryAfterMs(response.headers.get("retry-after")),
			quotaFromResponseHeaders(response.headers),
		);
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		buffer += decoder.decode(value, { stream: !done });
		let boundary = buffer.search(/\r?\n\r?\n/);
		while (boundary >= 0) {
			const block = buffer.slice(0, boundary);
			const match = buffer.slice(boundary).match(/^\r?\n\r?\n/);
			buffer = buffer.slice(boundary + (match?.[0].length ?? 2));
			let event: string | undefined;
			const data: string[] = [];
			for (const line of block.split(/\r?\n/)) {
				if (line.startsWith("event:")) event = line.slice(6).trim();
				if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
			}
			if (data.length > 0)
				onEvent({ ...(event ? { event } : {}), data: data.join("\n") });
			boundary = buffer.search(/\r?\n\r?\n/);
		}
		if (done) break;
	}
}

export async function readNdjson(
	response: Response,
	providerId: string,
	onValue: (value: unknown) => void,
): Promise<void> {
	if (!response.body)
		throw new ModelProviderError(
			"Provider returned an empty streaming response.",
			providerId,
			true,
			response.status,
			false,
			parseRetryAfterMs(response.headers.get("retry-after")),
			quotaFromResponseHeaders(response.headers),
		);
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		buffer += decoder.decode(value, { stream: !done });
		const lines = buffer.split(/\r?\n/);
		buffer = lines.pop() ?? "";
		for (const line of lines) if (line.trim()) onValue(JSON.parse(line));
		if (done) break;
	}
	if (buffer.trim()) onValue(JSON.parse(buffer));
}

export async function providerFetch(
	providerId: string,
	url: string,
	init: RequestInit,
): Promise<Response> {
	const { signal, connectTimeoutSignal } = providerConnectSignal(init.signal);
	let response: Response;
	try {
		// Provider requests carry protected credentials. A redirect could move
		// those credentials to a different host, so fail closed instead of
		// following it. Custom provider endpoints still work; their first hop is
		// the explicit endpoint the user configured.
		response = await fetch(url, { ...init, redirect: "error", signal });
	} catch (error) {
		providerFetchError(
			error,
			providerId,
			init.signal ?? undefined,
			connectTimeoutSignal,
		);
	}
	if (!response.ok) {
		// Upstream responses frequently echo authorization, custom request headers,
		// or a signed request URL. Do not read or include that body in an error that
		// can cross into verification UI, run history, or diagnostic state.
		await response.body?.cancel();
		const retryable =
			response.status === 408 ||
			response.status === 409 ||
			response.status === 429 ||
			response.status >= 500;
		throw new ModelProviderError(
			`Provider returned HTTP ${response.status}.`,
			providerId,
			retryable,
			response.status,
			false,
			parseRetryAfterMs(response.headers.get("retry-after")),
			quotaFromResponseHeaders(response.headers),
		);
	}
	return response;
}
