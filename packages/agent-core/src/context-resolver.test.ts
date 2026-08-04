import { describe, expect, it } from "vitest";
import { fixtureMemories } from "./fixtures";
import { PreResponseContextResolver } from "./context-resolver";

describe("pre-response context resolver", () => {
  it.each([
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    [-1, 0],
    [1.9, 1],
  ])("bounds malformed retrieval limit %s to %s items", (maximumRetrievedItems, expected) => {
    const resolver = new PreResponseContextResolver(() => fixtureMemories);
    const resolved = resolver.resolve({
      userMessage: "",
      detectedIntent: "",
      detectedEntities: [],
      possibleContextCategories: ["devices", "software_versions", "prior_errors", "prior_attempts", "schedule", "preferences"],
      maximumRetrievedItems,
    });

    expect(resolved.confirmed).toHaveLength(expected);
  });
});
