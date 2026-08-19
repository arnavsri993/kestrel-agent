import { describe, expect, it } from "vitest";
import { decodeNodeIpcMessage, encodeNodeIpcMessage } from "./core-ipc-codec";

describe("Node Agent Core IPC codec", () => {
	it("round-trips nested binary data through JSON serialization", () => {
		const original = {
			rgba: Uint8Array.from([0, 1, 2, 255]),
			response: { png: Buffer.from([137, 80, 78, 71]) },
		};

		const decoded = decodeNodeIpcMessage(encodeNodeIpcMessage(original)) as {
			rgba: Uint8Array;
			response: { png: Uint8Array };
		};

		expect(Array.from(decoded.rgba)).toEqual([0, 1, 2, 255]);
		expect(Array.from(decoded.response.png)).toEqual([137, 80, 78, 71]);
	});
});
