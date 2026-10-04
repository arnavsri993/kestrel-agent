import { describe, expect, it, vi } from "vitest";
import {
	PROVIDER_CONNECT_TIMEOUT_MS,
	LOCAL_GENERATION_CONNECT_TIMEOUT_MS,
	providerFetch,
	quotaFromResponseHeaders,
} from "./http";

describe("provider HTTP helpers", () => {
	it("normalizes only numeric rate-limit headers into bounded quota telemetry", () => {
		const quota = quotaFromResponseHeaders(
			new Headers({
				"x-ratelimit-limit-requests": "100",
				"x-ratelimit-remaining-requests": "20",
				"x-ratelimit-limit-tokens": "1000",
				"x-ratelimit-remaining-tokens": "250",
				"retry-after": "30",
				"x-untrusted-header": "token=secret",
			}),
			Date.parse("2026-09-07T12:00:00.000Z"),
		);

		expect(quota).toEqual({
			confidence: "exact",
			remainingFraction: 0.2,
			resetAt: "2026-09-07T12:00:30.000Z",
		});
		expect(
			quotaFromResponseHeaders(
				new Headers({ "x-ratelimit-remaining-requests": "0" }),
			),
		).toBeUndefined();
	});

	it("fails closed on redirects so provider credentials stay on the configured host", async () => {
		let requestInit: RequestInit | undefined;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (_input, init) => {
			requestInit = init;
			return new Response(null, { status: 204 });
		};
		try {
			await providerFetch("fixture", "https://provider.example.test", {
				redirect: "follow",
			});
			expect(requestInit?.redirect).toBe("error");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("discards non-success response bodies without exposing echoed secrets", async () => {
		let cancellations = 0;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				cancel() {
					cancellations += 1;
				},
			}),
			{ status: 502 },
		);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => response;
		try {
			await expect(
				providerFetch("fixture", "https://provider.example.test", {}),
			).rejects.toThrow("Provider returned HTTP 502.");
			expect(cancellations).toBe(1);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("does not expose raw transport failures", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => {
			throw new Error("request to https://provider.test/?token=sk-secret failed");
		};
		try {
			await expect(
				providerFetch("fixture", "https://provider.example.test", {}),
			).rejects.toMatchObject({
				message: "Provider request failed before a response was received.",
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("bounds provider connect with AbortSignal.any and the caller signal", async () => {
		let requestSignal: AbortSignal | undefined;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (_input, init) => {
			requestSignal = init?.signal ?? undefined;
			return new Response(null, { status: 204 });
		};
		const caller = new AbortController();
		try {
			await providerFetch("fixture", "https://provider.example.test", {
				signal: caller.signal,
			});
			expect(requestSignal).toBeDefined();
			expect(requestSignal!.aborted).toBe(false);
			caller.abort();
			expect(requestSignal!.aborted).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("times out hung provider connects before the agent-level deadline", async () => {
		vi.useFakeTimers();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					reject(
						init.signal?.reason ?? new DOMException("Aborted", "AbortError"),
					);
				});
			});
		try {
			const pending = providerFetch(
				"fixture",
				"https://provider.example.test",
				{},
			);
			const rejection = expect(pending).rejects.toMatchObject({
				message: `Provider connect timed out after ${PROVIDER_CONNECT_TIMEOUT_MS / 1_000}s.`,
				providerId: "fixture",
				retryable: true,
			});
			await vi.advanceTimersByTimeAsync(PROVIDER_CONNECT_TIMEOUT_MS);
			await rejection;
		} finally {
			vi.useRealTimers();
			globalThis.fetch = originalFetch;
		}
	});

	it("keeps a healthy response stream alive after the connect deadline and still honors cancellation", async () => {
		vi.useFakeTimers();
		let requestSignal: AbortSignal | undefined;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (_input, init) => {
			requestSignal = init?.signal ?? undefined;
			return new Response("still generating");
		};
		const caller = new AbortController();
		try {
			const response = await providerFetch("fixture", "https://provider.example.test", { signal: caller.signal });
			await vi.advanceTimersByTimeAsync(PROVIDER_CONNECT_TIMEOUT_MS + 1);
			expect(requestSignal!.aborted).toBe(false);
			expect(await response.text()).toBe("still generating");
			caller.abort();
			expect(requestSignal!.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
			globalThis.fetch = originalFetch;
		}
	});

	it("allows bounded local model prefill while retaining a connect deadline", async () => {
		vi.useFakeTimers();
		let requestSignal: AbortSignal | undefined;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
			requestSignal = init?.signal ?? undefined;
			requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason));
		});
		try {
			const pending = providerFetch("local-fixture", "http://127.0.0.1:11434/api/chat", {}, "local_generation");
			const rejection = expect(pending).rejects.toThrow(`Provider connect timed out after ${LOCAL_GENERATION_CONNECT_TIMEOUT_MS / 1_000}s.`);
			await vi.advanceTimersByTimeAsync(PROVIDER_CONNECT_TIMEOUT_MS);
			expect(requestSignal!.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(LOCAL_GENERATION_CONNECT_TIMEOUT_MS - PROVIDER_CONNECT_TIMEOUT_MS);
			await rejection;
		} finally {
			vi.useRealTimers();
			globalThis.fetch = originalFetch;
		}
	});

	it("rethrows when the caller abort signal fires first", async () => {
		const originalFetch = globalThis.fetch;
		const abortError = new DOMException("Caller aborted", "AbortError");
		globalThis.fetch = async (_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(abortError));
			});
		const caller = new AbortController();
		try {
			const pending = providerFetch("fixture", "https://provider.example.test", {
				signal: caller.signal,
			});
			caller.abort(abortError);
			await expect(pending).rejects.toBe(abortError);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it.each(["ENOTFOUND", "ECONNREFUSED"] as const)(
		"fast-fails on %s with a network unavailable error",
		async (code) => {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = async () => {
				const error = new TypeError("fetch failed");
				(error as { cause?: unknown }).cause = { code };
				throw error;
			};
			try {
				await expect(
					providerFetch("fixture", "https://provider.example.test", {}),
				).rejects.toMatchObject({
					message: "Network unavailable: provider host could not be reached.",
					providerId: "fixture",
					retryable: false,
				});
			} finally {
				globalThis.fetch = originalFetch;
			}
		},
	);
});
