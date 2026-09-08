import { describe, expect, it } from "vitest";
import { BrowserTabTransferAccess } from "./browser-tab-transfer-access";

describe("BrowserTabTransferAccess", () => {
	it("binds a single-use token to its detached owner and tab", () => {
		const owner = {};
		const access = new BrowserTabTransferAccess<object>({
			createToken: () => "transfer-token",
		});

		const token = access.issue(owner, "tab-one", 1_000);

		expect(access.consume(token, "tab-two", 1_001)).toBeNull();
		expect(access.consume(token, "tab-one", 1_002)).toBeNull();
	});

	it("returns the owner once for a matching unexpired transfer", () => {
		const owner = {};
		const access = new BrowserTabTransferAccess<object>({
			createToken: () => "transfer-token",
		});
		const token = access.issue(owner, "tab-one", 1_000);

		expect(access.consume(token, "tab-one", 1_001)).toBe(owner);
		expect(access.consume(token, "tab-one", 1_002)).toBeNull();
	});

	it("rejects expired and revoked transfers", () => {
		const owner = {};
		let nextToken = 0;
		const access = new BrowserTabTransferAccess<object>({
			ttlMs: 10,
			createToken: () => `transfer-${nextToken++}`,
		});

		const expired = access.issue(owner, "tab-one", 1_000);
		expect(access.consume(expired, "tab-one", 1_010)).toBeNull();

		const revoked = access.issue(owner, "tab-one", 2_000);
		access.revokeOwner(owner);
		expect(access.consume(revoked, "tab-one", 2_001)).toBeNull();
	});
});
