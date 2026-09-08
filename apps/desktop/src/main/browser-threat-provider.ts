import type { UserBrowserThreatType } from "@kestrel/shared-types";

/**
 * The browser only needs a small reputation boundary. Keeping provider API
 * details here makes it possible to substitute a commercial service without
 * changing browser navigation, download policy, or renderer state.
 */
export type BrowserThreatCheckContext = "navigation" | "download";

export type BrowserThreatVerdict =
	| {
			verdict: "safe";
			provider: string;
			expiresAt?: Date;
		}
	| {
			verdict: "malicious";
			provider: string;
			threatTypes: UserBrowserThreatType[];
			expiresAt?: Date;
		}
	| {
			verdict: "unknown";
			provider: string;
			reason: "not-configured" | "unavailable" | "timeout" | "invalid-response";
		};

export interface BrowserThreatProvider {
	/** A stable provider name suitable for local, renderer-safe status. */
	readonly id: string;
	/** Whether the provider can perform a real-time check in this process. */
	readonly available: boolean;
	checkUrl(input: {
		url: string;
		context: BrowserThreatCheckContext;
		signal?: AbortSignal;
	}): Promise<BrowserThreatVerdict>;
}

/**
 * Reserved for a future, explicit Kestrel AI integration. It runs after a
 * download finishes and receives metadata only; it is deliberately separate
 * from the URL-reputation provider and does not replace macOS protections.
 */
export interface SuspiciousDownloadAnalyzer {
	analyze(input: {
		downloadId: string;
		filePath: string;
		filename: string;
		sourceUrl: string;
		reputation: Extract<BrowserThreatVerdict, { verdict: "unknown" }>;
	}): Promise<void>;
}

export const SAFE_BROWSING_API_KEY_ENV = "KESTREL_SAFE_BROWSING_API_KEY";
const SAFE_BROWSING_URL_SEARCH_ENDPOINT =
	"https://safebrowsing.googleapis.com/v5/urls:search";
const DEFAULT_TIMEOUT_MS = 3_500;
const MAX_CACHE_MS = 24 * 60 * 60 * 1_000;

interface CacheEntry {
	verdict: BrowserThreatVerdict;
	expiresAt: number;
}

interface GoogleSafeBrowsingResponse {
	threats?: Array<{
		url?: unknown;
		threatTypes?: unknown;
	}>;
	cacheDuration?: unknown;
}

type FetchImplementation = typeof fetch;

/**
 * Reputation lookups do not need user-specific query parameters or fragments:
 * Safe Browsing checks host/path expressions. Stripping them keeps OAuth codes,
 * signed URLs, search terms, and fragments inside the local browser process.
 */
export function normalizeThreatLookupUrl(value: string): string | undefined {
	try {
		const url = new URL(value);
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password
		)
			return undefined;
		url.search = "";
		url.hash = "";
		return url.toString();
	} catch {
		return undefined;
	}
}

function parseThreatType(value: unknown): UserBrowserThreatType | undefined {
	switch (value) {
		case "MALWARE":
			return "malware";
		case "SOCIAL_ENGINEERING":
			return "social-engineering";
		case "UNWANTED_SOFTWARE":
			return "unwanted-software";
		case "POTENTIALLY_HARMFUL_APPLICATION":
			return "potentially-harmful-application";
		default:
			return undefined;
	}
}

function parseCacheDurationMs(value: unknown): number {
	if (typeof value !== "string") return 0;
	const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
	if (!match) return 0;
	const seconds = Number(match[1]);
	if (!Number.isFinite(seconds) || seconds <= 0) return 0;
	return Math.min(Math.floor(seconds * 1_000), MAX_CACHE_MS);
}

function withTimeoutSignal(
	signal: AbortSignal | undefined,
	timeoutMs: number,
): { signal: AbortSignal; didTimeout(): boolean; cleanup(): void } {
	const controller = new AbortController();
	let timedOut = false;
	const abort = () => controller.abort(signal?.reason);
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort(new Error("Threat check timed out."));
	}, timeoutMs);
	return {
		signal: controller.signal,
		didTimeout: () => timedOut,
		cleanup() {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
		},
	};
}

/** A truthful fallback when the host has not configured a threat provider. */
export class UnavailableBrowserThreatProvider implements BrowserThreatProvider {
	readonly id = "unconfigured";
	readonly available = false;

	async checkUrl(): Promise<BrowserThreatVerdict> {
		return {
			verdict: "unknown",
			provider: this.id,
			reason: "not-configured",
		};
	}
}

/**
 * Small Google Safe Browsing v5 adapter. This is intentionally a URL-only
 * provider: downloaded file analysis belongs to a separate future hook.
 *
 * Google documents this API as non-commercial. Production/commercial builds
 * can replace this adapter with a provider implementing BrowserThreatProvider.
 */
export class GoogleSafeBrowsingThreatProvider implements BrowserThreatProvider {
	readonly id = "google-safe-browsing";
	readonly available = true;
	private readonly cache = new Map<string, CacheEntry>();

	constructor(
		private readonly options: {
			apiKey: string;
			fetch?: FetchImplementation;
			now?: () => Date;
			timeoutMs?: number;
			endpoint?: string;
		},
	) {}

	async checkUrl(input: {
		url: string;
		context: BrowserThreatCheckContext;
		signal?: AbortSignal;
	}): Promise<BrowserThreatVerdict> {
		const lookupUrl = normalizeThreatLookupUrl(input.url);
		if (!lookupUrl) {
			return {
				verdict: "unknown",
				provider: this.id,
				reason: "invalid-response",
			};
		}
		const now = (this.options.now ?? (() => new Date()))().getTime();
		const cached = this.cache.get(lookupUrl);
		if (cached && cached.expiresAt > now) return cached.verdict;
		if (cached) this.cache.delete(lookupUrl);

		const requestUrl = new URL(
			this.options.endpoint ?? SAFE_BROWSING_URL_SEARCH_ENDPOINT,
		);
		requestUrl.searchParams.set("key", this.options.apiKey);
		requestUrl.searchParams.append("urls", lookupUrl);
		const timeout = withTimeoutSignal(
			input.signal,
			this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		);
		try {
			const response = await (this.options.fetch ?? fetch)(requestUrl, {
				method: "GET",
				signal: timeout.signal,
			});
			if (!response.ok)
				return {
					verdict: "unknown",
					provider: this.id,
					reason: "unavailable",
				};
			const payload = (await response.json()) as GoogleSafeBrowsingResponse;
			if (!payload || typeof payload !== "object")
				return {
					verdict: "unknown",
					provider: this.id,
					reason: "invalid-response",
				};
			const matchedThreatTypes = (Array.isArray(payload.threats)
				? payload.threats.flatMap((threat) =>
						Array.isArray(threat?.threatTypes)
							? threat.threatTypes
									.map(parseThreatType)
									.filter(
										(type): type is UserBrowserThreatType => Boolean(type),
									)
							: [],
					)
				: []);
			const threatTypes = [...new Set(matchedThreatTypes)];
			const cacheDurationMs = parseCacheDurationMs(payload.cacheDuration);
			const expiresAt =
				cacheDurationMs > 0 ? new Date(now + cacheDurationMs) : undefined;
			const verdict: BrowserThreatVerdict = threatTypes.length
				? {
						verdict: "malicious",
						provider: this.id,
						threatTypes,
						...(expiresAt ? { expiresAt } : {}),
					}
				: {
						verdict: "safe",
						provider: this.id,
						...(expiresAt ? { expiresAt } : {}),
					};
			if (cacheDurationMs > 0)
				this.cache.set(lookupUrl, {
					verdict,
					expiresAt: now + cacheDurationMs,
				});
			return verdict;
		} catch (cause) {
			return {
				verdict: "unknown",
				provider: this.id,
				reason: timeout.didTimeout() ? "timeout" : "unavailable",
			};
		} finally {
			timeout.cleanup();
		}
	}
}

export function createDefaultBrowserThreatProvider(
	environment: NodeJS.ProcessEnv = process.env,
): BrowserThreatProvider {
	const apiKey = environment[SAFE_BROWSING_API_KEY_ENV]?.trim();
	return apiKey
		? new GoogleSafeBrowsingThreatProvider({ apiKey })
		: new UnavailableBrowserThreatProvider();
}
