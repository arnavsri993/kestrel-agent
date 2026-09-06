import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GoogleSafeBrowsingThreatProvider,
	normalizeThreatLookupUrl,
	UnavailableBrowserThreatProvider,
} from "./browser-threat-provider";

const url = "https://example.com/page";

function response(payload: unknown, ok = true): Response {
	return {
		ok,
		json: async () => payload,
	} as Response;
}

describe("browser threat providers", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("maps Safe Browsing safe and malicious responses", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(response({ threats: [], cacheDuration: "60s" }))
			.mockResolvedValueOnce(
				response({
					threats: [
						{
							threatTypes: [
								"MALWARE",
								"SOCIAL_ENGINEERING",
								"MALWARE",
								"IGNORED",
							],
						},
					],
				}),
			);
		const provider = new GoogleSafeBrowsingThreatProvider({
			apiKey: "test-key",
			fetch,
		});

		expect(await provider.checkUrl({ url, context: "navigation" })).toMatchObject({
			verdict: "safe",
			provider: "google-safe-browsing",
		});
		expect(
			await provider.checkUrl({ url: "https://malware.test", context: "download" }),
		).toMatchObject({
			verdict: "malicious",
			provider: "google-safe-browsing",
			threatTypes: ["malware", "social-engineering"],
		});
	});

	it("caches a response for its cache duration and refreshes after expiry", async () => {
		let now = new Date("2026-01-01T00:00:00.000Z");
		const fetch = vi.fn().mockResolvedValue(response({ cacheDuration: "2s" }));
		const provider = new GoogleSafeBrowsingThreatProvider({
			apiKey: "test-key",
			fetch,
			now: () => now,
		});

		const first = await provider.checkUrl({ url, context: "navigation" });
		now = new Date(now.getTime() + 1_999);
		const cached = await provider.checkUrl({ url, context: "navigation" });
		expect(cached).toBe(first);
		expect(fetch).toHaveBeenCalledTimes(1);

		now = new Date(now.getTime() + 1);
		await provider.checkUrl({ url, context: "navigation" });
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("strips query and fragment data before lookup and cache access", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValue(response({ cacheDuration: "60s" }));
		const provider = new GoogleSafeBrowsingThreatProvider({
			apiKey: "test-key",
			fetch,
		});
		const sensitiveUrl =
			"https://example.com/callback?code=oauth-code&search=private#access_token=fragment-secret";

		expect(normalizeThreatLookupUrl(sensitiveUrl)).toBe(
			"https://example.com/callback",
		);
		await provider.checkUrl({ url: sensitiveUrl, context: "navigation" });
		await provider.checkUrl({
			url: "https://example.com/callback?other=lookup-variant",
			context: "navigation",
		});

		expect(fetch).toHaveBeenCalledOnce();
		const request = new URL(String(fetch.mock.calls[0]?.[0]));
		expect(request.searchParams.get("urls")).toBe(
			"https://example.com/callback",
		);
		expect(String(fetch.mock.calls[0]?.[0])).not.toContain("oauth-code");
		expect(String(fetch.mock.calls[0]?.[0])).not.toContain("fragment-secret");
	});

	it("reports unavailable responses and timeouts truthfully", async () => {
		const unavailable = new GoogleSafeBrowsingThreatProvider({
			apiKey: "test-key",
			fetch: vi.fn().mockResolvedValue(response({}, false)),
		});
		expect(await unavailable.checkUrl({ url, context: "navigation" })).toMatchObject({
			verdict: "unknown",
			reason: "unavailable",
		});

		vi.useFakeTimers();
		const timeout = new GoogleSafeBrowsingThreatProvider({
			apiKey: "test-key",
			timeoutMs: 100,
			fetch: vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
						once: true,
					});
				}),
			) as unknown as typeof fetch,
		});
		const pending = timeout.checkUrl({ url, context: "navigation" });
		await vi.advanceTimersByTimeAsync(100);
		expect(await pending).toMatchObject({
			verdict: "unknown",
			reason: "timeout",
		});
	});

	it("returns not-configured for the unavailable provider", async () => {
		await expect(new UnavailableBrowserThreatProvider().checkUrl()).resolves.toEqual({
			verdict: "unknown",
			provider: "unconfigured",
			reason: "not-configured",
		});
	});
});
