import { describe, expect, it } from "vitest";
import { providerFetch } from "./http";

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
});
