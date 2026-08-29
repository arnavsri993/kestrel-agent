import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "@kestrel/shared-types";
import { PreResponseContextResolver } from "./context-resolver";
import { fixtureMemories } from "./fixtures";

describe("pre-response context resolver", () => {
	it("keeps confirmed, inferred, and stale buckets mutually exclusive", () => {
		const memories: MemoryRecord[] = [
			{
				...fixtureMemories[0]!,
				id: "memory-stale-confirmed",
				userConfirmed: true,
				inferred: true,
				validUntil: "2020-01-01T00:00:00.000Z",
				structuredData: { category: "schedule" },
			},
			{
				...fixtureMemories[0]!,
				id: "memory-inferred-only",
				userConfirmed: false,
				inferred: true,
				validUntil: undefined,
				structuredData: { category: "schedule" },
			},
		];
		const resolver = new PreResponseContextResolver(() => memories);
		const resolved = resolver.resolve({
			userMessage: "",
			detectedIntent: "",
			detectedEntities: [],
			possibleContextCategories: ["schedule"],
			maximumRetrievedItems: 10,
		});
		expect(resolved.possiblyStale.map((item) => item.id)).toEqual([
			"memory-stale-confirmed",
		]);
		expect(resolved.inferred.map((item) => item.id)).toEqual([
			"memory-inferred-only",
		]);
		expect(resolved.confirmed).toEqual([]);
	});

	it.each([
		[Number.NaN, 0],
		[Number.POSITIVE_INFINITY, 0],
		[-1, 0],
		[1.9, 1],
	])(
		"bounds malformed retrieval limit %s to %s items",
		(maximumRetrievedItems, expected) => {
			const resolver = new PreResponseContextResolver(() => fixtureMemories);
			const resolved = resolver.resolve({
				userMessage: "",
				detectedIntent: "",
				detectedEntities: [],
				possibleContextCategories: [
					"devices",
					"software_versions",
					"prior_errors",
					"prior_attempts",
					"schedule",
					"preferences",
				],
				maximumRetrievedItems,
			});

			expect(resolved.confirmed).toHaveLength(expected);
		},
	);
});
