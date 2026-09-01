import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MARKDOWN_PATH, renderOpenClaw2Markdown } from "./generate-openclaw2-register.mjs";
import {
	EXPECTED_OPENCLAW_RELEASE,
	loadBehaviorRegister,
	validateBehaviorRegister,
} from "./verify-openclaw2.mjs";

function registerCopy() {
	return structuredClone(loadBehaviorRegister());
}

describe("OpenClaw 2.0 behavior register verifier", () => {
	it("accepts the committed register and keeps markdown generation deterministic", () => {
		const register = registerCopy();
		const summary = validateBehaviorRegister(register);
		expect(summary.total).toBe(35);
		expect(summary.unresolvedP0P1).toBe(0);
		expect(renderOpenClaw2Markdown(register)).toBe(
			readFileSync(MARKDOWN_PATH, "utf8"),
		);
	});

	it.each([
		[
			"duplicate IDs",
			(register) => {
				register.behaviors[1].id = register.behaviors[0].id;
			},
			/duplicate behavior ID/,
		],
		[
			"unknown classifications",
			(register) => {
				register.behaviors[0].classification = "automatic-parity";
			},
			/unknown classification/,
		],
		[
			"stale release tag",
			(register) => {
				register.behaviors[0].openclawTag = "main";
			},
			/stale OpenClaw tag/,
		],
		[
			"mismatched release commit",
			(register) => {
				register.release.commit = "0".repeat(40);
			},
			/release\.commit must be/,
		],
		[
			"missing implementation evidence",
			(register) => {
				register.behaviors[0].implementationEvidence = [
					"packages/agent-core/src/missing-evidence.ts",
				];
			},
			/implementationEvidence entry does not exist/,
		],
		[
			"missing test evidence",
			(register) => {
				register.behaviors[0].testEvidence = [
					"packages/agent-core/src/missing-evidence.test.ts",
				];
			},
			/testEvidence entry does not exist/,
		],
		[
			"missing behavioral evidence",
			(register) => {
				delete register.behaviors[0].behavioralTestEvidence;
			},
			/behavioralTestEvidence must be a non-empty array/,
		],
		[
			"primitive-only behavioral evidence",
			(register) => {
				register.behaviors[0].behavioralTestEvidence[0].evidenceLevel = "primitive";
			},
			/must use behavioral evidence/,
		],
		[
			"missing verification script",
			(register) => {
				register.behaviors[0].verificationCommand =
					"node scripts/missing-verification-script.mjs";
			},
			/verification script does not exist/,
		],
		[
			"family-versus-behavior confusion",
			(register) => {
				register.behaviors[0].behaviorType = "capability-family";
			},
			/must be marked exact-behavior/,
		],
		[
			"unresolved P0/P1 entry",
			(register) => {
				register.behaviors[0].classification = "unresolved";
			},
			/unresolved P0 behavior is release-blocking/,
		],
		[
			"lowered frozen priority",
			(register) => {
				const behavior = register.behaviors.find(
					(entry) => entry.id === "oc2.questions.structured-input",
				);
				behavior.priority = "P2";
			},
			/cannot be lowered to P2/,
		],
	])("rejects %s", (_label, mutate, error) => {
		const register = registerCopy();
		mutate(register);
		expect(() => validateBehaviorRegister(register)).toThrow(error);
	});

	it("keeps the pinned identity explicit in the verifier contract", () => {
		expect(EXPECTED_OPENCLAW_RELEASE).toMatchObject({
		name: "OpenClaw 2.0",
		tag: "v2026.8.1",
		commit: "ea806575e6450e4d1efdfc72c19f04be982a1b9b",
	});
});
});
