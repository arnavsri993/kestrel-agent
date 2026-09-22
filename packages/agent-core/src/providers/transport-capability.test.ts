import { describe, expect, it } from "vitest";
import {
	assertToolCapableOrThrow,
	contractFromProviderCapabilities,
	evaluateCapabilityRequirements,
} from "./transport-capability";

describe("transport capability contract", () => {
	it("marks text-only transports as tool-incapable without faking support", () => {
		const contract = contractFromProviderCapabilities({
			streaming: true,
			tools: false,
			images: false,
			audio: false,
			documents: false,
			local: false,
			subscriptionVersusApi: "subscription",
		});
		expect(contract.toolSupport).toBe(false);
		expect(contract.structuredToolCalls).toBe("unsupported");
		expect(contract.toolAuthority).toBe("none");
		const failure = evaluateCapabilityRequirements(contract, {
			requireTools: true,
		});
		expect(failure?.code).toBe("capability_unsatisfied");
		expect(failure?.missing).toContain("structured_tool_calls");
		expect(failure?.recoveryOptions.some((option) => option.includes("text-only"))).toBe(
			true,
		);
	});

	it("accepts bridged Kestrel tool authority for Codex-style transports", () => {
		const contract = contractFromProviderCapabilities({
			streaming: true,
			tools: true,
			images: true,
			audio: false,
			documents: false,
			structuredToolCalls: "bridged",
			subscriptionVersusApi: "subscription",
			sessionPersistence: true,
			usageAccounting: true,
			reasoningEffort: true,
			toolAuthority: "kestrel",
		});
		expect(contract.toolSupport).toBe(true);
		expect(contract.structuredToolCalls).toBe("bridged");
		expect(
			evaluateCapabilityRequirements(contract, { requireTools: true }),
		).toBeUndefined();
	});

	it("fails closed when assertToolCapableOrThrow is used", () => {
		const contract = contractFromProviderCapabilities({
			streaming: false,
			tools: false,
			images: false,
			audio: false,
			documents: false,
			local: true,
		});
		expect(() => assertToolCapableOrThrow(contract, "Persistent agent")).toThrow(
			/Kestrel tool support/,
		);
	});
});
