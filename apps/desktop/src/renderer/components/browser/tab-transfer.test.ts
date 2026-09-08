import { describe, expect, it } from "vitest";
import {
	parseBrowserTabTransfer,
	serializeBrowserTabTransfer,
} from "./tab-transfer";

const payload = {
	tabId: "tab-12345678-1234-4123-8123-123456789abc",
	transferToken: "87654321-4321-4321-8321-cba987654321",
};

describe("browser tab drag payload", () => {
	it("round trips a bounded authenticated payload", () => {
		expect(parseBrowserTabTransfer(serializeBrowserTabTransfer(payload))).toEqual(
			payload,
		);
	});

	it.each([
		"",
		"tab-12345678-1234-4123-8123-123456789abc",
		JSON.stringify({ tabId: payload.tabId }),
		JSON.stringify({ ...payload, tabId: "../tab" }),
		JSON.stringify({ ...payload, transferToken: "forged" }),
	])("rejects malformed data-transfer content", (value) => {
		expect(parseBrowserTabTransfer(value)).toBeNull();
	});
});
