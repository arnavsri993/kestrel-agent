import { expect, it } from "vitest";
import { observeNativeTabOwnership } from "./native-tab-ownership-observation.mjs";

const url = "http://127.0.0.1:43121/probe";
const tab = { id: 7, windowId: 3, url };
const ready = {
	queryUnfiltered: async () => [tab],
	queryFiltered: async () => [tab],
	delay: async () => {},
};

it("waits for delayed registration in both query forms", async () => {
	let queries = 0;
	const observed = await observeNativeTabOwnership({
		url,
		queryUnfiltered: async () => (++queries >= 3 ? [tab] : []),
		queryFiltered: async () => (queries >= 3 ? [tab] : []),
		delay: async () => {},
		attempts: 5,
	});
	expect(observed).toEqual({ tab, attempts: 3 });
});

it("never accepts filtered-only registration", async () => {
	await expect(
		observeNativeTabOwnership({
			url,
			...ready,
			queryUnfiltered: async () => [],
			attempts: 2,
		}),
	).rejects.toMatchObject({
		code: "NATIVE_TAB_OWNERSHIP_UNCONFIRMED",
		message: "The initial user page must belong to a real Chrome tab in both query forms.",
	});
});

it("never accepts unfiltered-only registration", async () => {
	await expect(
		observeNativeTabOwnership({
			url,
			...ready,
			queryFiltered: async () => [],
			attempts: 2,
		}),
	).rejects.toMatchObject({ code: "NATIVE_TAB_OWNERSHIP_UNCONFIRMED" });
});

it("never accepts disagreeing tab identities or windows", async () => {
	for (const unfiltered of [
		{ ...tab, id: tab.id + 1 },
		{ ...tab, windowId: tab.windowId + 1 },
	]) {
		await expect(
			observeNativeTabOwnership({
				url,
				...ready,
				queryUnfiltered: async () => [unfiltered],
				attempts: 1,
			}),
		).rejects.toMatchObject({ code: "NATIVE_TAB_OWNERSHIP_UNCONFIRMED" });
	}
});

it("exhausted polling fails with a static diagnostic", async () => {
	await expect(
		observeNativeTabOwnership({
			url,
			queryUnfiltered: async () => [],
			queryFiltered: async () => [],
			delay: async () => {},
			attempts: 1,
		}),
	).rejects.toMatchObject({
		message: "The initial user page must belong to a real Chrome tab in both query forms.",
		code: "NATIVE_TAB_OWNERSHIP_UNCONFIRMED",
	});
});
