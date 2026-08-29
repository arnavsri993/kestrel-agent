import { describe, expect, it, vi } from "vitest";
import { PROVIDER_CONNECT_TIMEOUT_MS, providerFetch } from "./http";

describe("provider HTTP helpers", () => {
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

	it("bounds oversized non-success response bodies before creating provider errors", async () => {
		let pulls = 0;
		let cancellations = 0;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					pulls += 1;
					controller.enqueue(new Uint8Array(40_000));
					if (pulls === 20) controller.close();
				},
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
			).rejects.toThrow("error body exceeded the 64 KB safety limit");
			expect(cancellations).toBe(1);
			expect(pulls).toBeLessThan(20);
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
		const timeoutController = new AbortController();
		const timeoutSpy = vi
			.spyOn(AbortSignal, "timeout")
			.mockReturnValue(timeoutController.signal);
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
			timeoutController.abort(new DOMException("Timed out", "TimeoutError"));
			await expect(pending).rejects.toMatchObject({
				message: `Provider connect timed out after ${PROVIDER_CONNECT_TIMEOUT_MS / 1_000}s.`,
				providerId: "fixture",
				retryable: true,
			});
			expect(timeoutSpy).toHaveBeenCalledWith(PROVIDER_CONNECT_TIMEOUT_MS);
		} finally {
			timeoutSpy.mockRestore();
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
