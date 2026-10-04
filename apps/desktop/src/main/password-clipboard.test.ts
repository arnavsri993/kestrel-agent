import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cryptoState = vi.hoisted(() => ({ keys: [] as Buffer[] }));
vi.mock("node:crypto", async () => {
	const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
	return {
		...actual,
		randomBytes: (size: number) => {
			const key = actual.randomBytes(size);
			cryptoState.keys.push(key);
			return key;
		},
		createHash: vi.fn(actual.createHash),
	};
});

import { createHash } from "node:crypto";
import { copyPasswordWithExpiry } from "./password-clipboard";

function fixtureClipboard() {
	let value = "";
	return {
		writeText: vi.fn((text: string) => { value = text; }),
		readText: vi.fn(() => value),
		clear: vi.fn(() => { value = ""; }),
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	cryptoState.keys.length = 0;
	vi.clearAllMocks();
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe("saved password clipboard expiry", () => {
	it("clears an unchanged copy after one minute and releases its comparison key", () => {
		const clipboard = fixtureClipboard();
		copyPasswordWithExpiry(clipboard, "owned-clipboard-fixture-alpha");
		expect(clipboard.readText()).toBe("owned-clipboard-fixture-alpha");
		expect(cryptoState.keys[0]).toHaveLength(32);
		expect(cryptoState.keys[0]).not.toEqual(Buffer.alloc(32));
		vi.advanceTimersByTime(59_999);
		expect(clipboard.clear).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(clipboard.clear).toHaveBeenCalledTimes(1);
		expect(clipboard.readText()).toBe("");
		expect(cryptoState.keys[0]).toEqual(Buffer.alloc(32));
		expect(createHash).not.toHaveBeenCalled();
	});

	it("preserves something the person copied later", () => {
		const clipboard = fixtureClipboard();
		copyPasswordWithExpiry(clipboard, "owned-clipboard-fixture-alpha");
		clipboard.writeText("A different copied sentence");
		vi.advanceTimersByTime(60_000);
		expect(clipboard.clear).not.toHaveBeenCalled();
		expect(clipboard.readText()).toBe("A different copied sentence");
		expect(cryptoState.keys[0]).toEqual(Buffer.alloc(32));
	});

	it.each(["owned-clipboard-fixture-alpha", "owned-clipboard-fixture-beta"])(
		"starts a new full expiry period for another password copy (%s)",
		(second) => {
			const clipboard = fixtureClipboard();
			copyPasswordWithExpiry(clipboard, "owned-clipboard-fixture-alpha");
			const firstKey = Buffer.from(cryptoState.keys[0]!);
			vi.advanceTimersByTime(30_000);
			copyPasswordWithExpiry(clipboard, second);
			expect(cryptoState.keys[0]).toEqual(Buffer.alloc(32));
			expect(cryptoState.keys[1]).not.toEqual(firstKey);
			expect(vi.getTimerCount()).toBe(1);
			vi.advanceTimersByTime(30_000);
			expect(clipboard.clear).not.toHaveBeenCalled();
			expect(clipboard.readText()).toBe(second);
			vi.advanceTimersByTime(30_000);
			expect(clipboard.clear).toHaveBeenCalledTimes(1);
			expect(cryptoState.keys[1]).toEqual(Buffer.alloc(32));
		},
	);

	it("releases comparison material if clipboard reading is revoked", () => {
		const clipboard = fixtureClipboard();
		copyPasswordWithExpiry(clipboard, "owned-clipboard-fixture-alpha");
		clipboard.readText.mockImplementation(() => { throw new Error("Unavailable"); });
		expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
		expect(clipboard.clear).not.toHaveBeenCalled();
		expect(cryptoState.keys[0]).toEqual(Buffer.alloc(32));
	});

	it("releases comparison material if clearing is revoked", () => {
		const clipboard = fixtureClipboard();
		copyPasswordWithExpiry(clipboard, "owned-clipboard-fixture-alpha");
		clipboard.clear.mockImplementation(() => { throw new Error("Unavailable"); });
		expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
		expect(cryptoState.keys[0]).toEqual(Buffer.alloc(32));
	});

	it("leaves the preceding copy protected when a new write fails", () => {
		const clipboard = fixtureClipboard();
		copyPasswordWithExpiry(clipboard, "owned-clipboard-fixture-alpha");
		clipboard.writeText.mockImplementationOnce(() => { throw new Error("Unavailable"); });
		expect(() => copyPasswordWithExpiry(clipboard, "owned-clipboard-fixture-beta")).toThrow("Unavailable");
		expect(cryptoState.keys[0]).not.toEqual(Buffer.alloc(32));
		expect(cryptoState.keys[1]).toEqual(Buffer.alloc(32));
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(60_000);
		expect(clipboard.clear).toHaveBeenCalledTimes(1);
		expect(cryptoState.keys[0]).toEqual(Buffer.alloc(32));
	});
});
