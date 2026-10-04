import { describe, expect, it } from "vitest";
import {
	INJECTION_FIXTURES,
	classifyInjectionAuthority,
	injectionOutcomeForFixture,
} from "./prompt-injection-fixtures";

describe("prompt-injection fixtures", () => {
	it("treats external content as data never authority", () => {
		expect(
			classifyInjectionAuthority({
				origin: "external",
				claimsAuthority: true,
			}),
		).toBe("data");
		for (const fixture of INJECTION_FIXTURES) {
			const outcome = injectionOutcomeForFixture(
				fixture,
				classifyInjectionAuthority({
					origin: "external",
					claimsAuthority: true,
				}),
			);
			expect(["blocked", "ignored_as_data", "requires_approval"]).toContain(
				outcome,
			);
			expect(fixture.payloadMarker).toMatch(/_MARKER$/);
		}
		expect(INJECTION_FIXTURES.length).toBeGreaterThanOrEqual(8);
	});
});
