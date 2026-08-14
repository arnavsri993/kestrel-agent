import { describe, expect, it } from "vitest";
import { readBoundedResponseBytes } from "./bounded-http";

describe("bounded HTTP response reads", () => {
	it("cancels a chunked body as soon as the streamed byte limit is crossed", async () => {
		let pulls = 0;
		let cancellations = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				controller.enqueue(new Uint8Array([pulls, pulls, pulls]));
				if (pulls === 20) controller.close();
			},
			cancel() {
				cancellations += 1;
			},
		});

		await expect(
			readBoundedResponseBytes(new Response(body), 5, "Response is too large."),
		).rejects.toThrow("Response is too large.");
		expect(cancellations).toBe(1);
		expect(pulls).toBeLessThan(20);
	});

	it("rejects an oversized Content-Length before reading the body", async () => {
		let reads = 0;
		let cancellations = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				reads += 1;
				controller.enqueue(new Uint8Array([1]));
			},
			cancel() {
				cancellations += 1;
			},
		});

		await expect(
			readBoundedResponseBytes(
				new Response(body, { headers: { "content-length": "6" } }),
				5,
				"Response is too large.",
			),
		).rejects.toThrow("Response is too large.");
		expect(cancellations).toBe(1);
		expect(reads).toBeLessThanOrEqual(1);
	});

	it("reconstructs multiple chunks into a single byte array", async () => {
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array([1, 2]));
				controller.enqueue(new Uint8Array([3, 4]));
				controller.close();
			},
		});

		const result = await readBoundedResponseBytes(
			new Response(body),
			5,
			"Response is too large.",
		);
		expect(result).toEqual(new Uint8Array([1, 2, 3, 4]));
	});

	it("rejects invalid maximumBytes", async () => {
		await expect(
			readBoundedResponseBytes(new Response(), -1, "Error"),
		).rejects.toThrow("HTTP response byte limit must be a non-negative safe integer.");
	});
});
