import { describe, expect, it } from "vitest";
import {
	BROWSER_AGENT_BENCHMARK_CORPUS,
	BROWSER_AGENT_BENCHMARK_CORPUS_VERSION,
} from "../benchmarks/browser-agent/corpus-v1.mjs";
import {
	BENCHMARK_CATEGORIES,
	BENCHMARK_CATEGORY_COUNTS,
	corpusSha256,
	evaluateBenchmarkPredicates,
	predicatesPassed,
	summarizeBenchmarkResults,
	validateBenchmarkCorpus,
} from "./browser-agent-benchmark-lib.mjs";

describe("browser-agent benchmark corpus", () => {
	it("pins the versioned 50-workflow corpus and category distribution", () => {
		expect(BROWSER_AGENT_BENCHMARK_CORPUS_VERSION).toBe("1.1.0");
		expect(validateBenchmarkCorpus(BROWSER_AGENT_BENCHMARK_CORPUS)).toEqual([]);
		expect(BROWSER_AGENT_BENCHMARK_CORPUS).toHaveLength(50);
		expect(
			Object.fromEntries(
				BENCHMARK_CATEGORIES.map((category) => [
					category,
					BROWSER_AGENT_BENCHMARK_CORPUS.filter(
						(workflow) => workflow.category === category,
					).length,
				]),
			),
		).toEqual(BENCHMARK_CATEGORY_COUNTS);
		expect(
			BROWSER_AGENT_BENCHMARK_CORPUS.flatMap((workflow) =>
				workflow.steps.filter((step) => step.op === "select"),
			).every((step) => typeof step.value === "string"),
		).toBe(true);
		expect(
			BROWSER_AGENT_BENCHMARK_CORPUS.filter((workflow) =>
				workflow.steps.some((step) => step.op === "expect-approval-block"),
			).map((workflow) => workflow.category),
		).toEqual(["forms", "accounts", "failures"]);
	});

	it("uses a stable canonical corpus hash", () => {
		expect(corpusSha256(BROWSER_AGENT_BENCHMARK_CORPUS)).toBe(
			"0a3ce075553f906e001656a3be71aa2f7cba3ad390628b853d9ce430cad84c0e",
		);
		expect(corpusSha256([{ b: 2, a: 1 }])).toBe(
			corpusSha256([{ a: 1, b: 2 }]),
		);
	});

	it("rejects a drifted or duplicated corpus", () => {
		const duplicated = [
			...BROWSER_AGENT_BENCHMARK_CORPUS,
			BROWSER_AGENT_BENCHMARK_CORPUS[0],
		];
		const errors = validateBenchmarkCorpus(duplicated);
		expect(errors).toContain("Corpus must contain exactly 50 workflows.");
		expect(errors.some((error) => error.includes("repeats id"))).toBe(true);
		expect(errors).toContain(
			"Corpus must contain exactly 10 research workflows.",
		);
		const malformedSelect = structuredClone(BROWSER_AGENT_BENCHMARK_CORPUS);
		const selectStep = malformedSelect
			.flatMap((workflow) => workflow.steps)
			.find((step) => step.op === "select");
		delete selectStep.value;
		expect(
			validateBenchmarkCorpus(malformedSelect).some((error) =>
				error.includes("must have a bounded select value"),
			),
		).toBe(true);

		const missingApprovalCoverage = structuredClone(
			BROWSER_AGENT_BENCHMARK_CORPUS,
		);
		for (const workflow of missingApprovalCoverage)
			workflow.steps = workflow.steps.filter(
				(step) => step.op !== "expect-approval-block",
			);
		expect(validateBenchmarkCorpus(missingApprovalCoverage)).toContain(
			"Corpus must include approval-block evidence in at least three workflows.",
		);

		const dishonestApprovalProof = structuredClone(
			BROWSER_AGENT_BENCHMARK_CORPUS,
		);
		const guardedStep = dishonestApprovalProof
			.flatMap((workflow) => workflow.steps)
			.find((step) => step.op === "expect-approval-block");
		guardedStep.predicates = [
			{ kind: "activation", id: "submit", equals: 1 },
		];
		expect(validateBenchmarkCorpus(dishonestApprovalProof)).toContain(
			"Workflow 11 step 4 must prove an untouched consequential activation.",
		);
	});

	it("rejects workflows that do not prove declared browser-side effects", () => {
		const gamed = structuredClone(BROWSER_AGENT_BENCHMARK_CORPUS);
		gamed[0].steps = [{ op: "navigate", site: "primary", path: "/start" }];
		gamed[0].predicates = [
			{ kind: "visited", site: "primary", path: "/start", minimum: 1 },
		];
		const errors = validateBenchmarkCorpus(gamed);
		expect(errors).toContain(
			"Workflow 1 completed workflow must exercise a mutating browser action.",
		);
		expect(errors).toContain(
			"Workflow 1 completion predicates do not prove a browser-side effect.",
		);

		const forged = structuredClone(BROWSER_AGENT_BENCHMARK_CORPUS);
		forged[0].predicates.push({
			kind: "activation",
			id: "undeclared-control",
			equals: 1,
		});
		expect(validateBenchmarkCorpus(forged)).toContain(
			"Workflow 1 predicate 5 references an undeclared control.",
		);
	});
});

describe("browser-agent benchmark evaluation", () => {
	it("evaluates independent fixture predicates without completion claims", () => {
		const evaluated = evaluateBenchmarkPredicates(
			{
				visits: { "secondary:/source": 2 },
				activations: { submit: 1 },
				fields: { summary: "Verified local result", accepted: true },
				downloads: { "report.txt": 1 },
			},
			[
				{ kind: "visited", site: "secondary", path: "/source", minimum: 2 },
				{ kind: "activation", id: "submit", equals: 1 },
				{ kind: "field", name: "summary", includes: "local" },
				{ kind: "field", name: "accepted", equals: true },
				{ kind: "download", filename: "report.txt", equals: 1 },
			],
		);
		expect(predicatesPassed(evaluated)).toBe(true);
		expect(evaluated.map((result) => result.actual)).toEqual([
			2,
			1,
			"Verified local result",
			true,
			1,
		]);
		expect(
			predicatesPassed(
				evaluateBenchmarkPredicates(
					{ activations: { purchase: 1 } },
					[{ kind: "activation", id: "purchase", equals: 0 }],
				),
			),
		).toBe(false);
	});

	it("computes verified, safe-stop, false-positive, and latency rates", () => {
		const metrics = {
			actions: 1,
			observations: 2,
			retries: 3,
			failedAttempts: 4,
			interventions: 5,
			approvalBlockAttempts: 6,
			approvalBlocks: 6,
			approvalGrants: 7,
			scriptedRecoveries: 8,
		};
		const results = [
			{
				expectedOutcome: "completed",
				completionClaimed: true,
				verifiedCompletion: true,
				safeStopVerified: false,
				benchmarkPassed: true,
				falsePositive: false,
				failureClass: "none",
				durationMs: 100,
				metrics,
			},
			{
				expectedOutcome: "completed",
				completionClaimed: true,
				verifiedCompletion: false,
				safeStopVerified: false,
				benchmarkPassed: false,
				falsePositive: true,
				failureClass: "verification",
				durationMs: 300,
				metrics,
			},
			{
				expectedOutcome: "intervention_required",
				completionClaimed: false,
				verifiedCompletion: false,
				safeStopVerified: true,
				benchmarkPassed: true,
				falsePositive: false,
				failureClass: "authentication",
				durationMs: 200,
				metrics,
			},
			{
				expectedOutcome: "intervention_required",
				completionClaimed: true,
				verifiedCompletion: false,
				safeStopVerified: false,
				benchmarkPassed: false,
				falsePositive: true,
				failureClass: "policy_block",
				durationMs: 400,
				metrics,
			},
		];

		expect(summarizeBenchmarkResults(results)).toMatchObject({
			workflowCount: 4,
			expectedCompletionCount: 2,
			completionClaimCount: 3,
			verifiedCompletionCount: 1,
			expectedSafeStopCount: 2,
			verifiedSafeStopCount: 1,
			benchmarkPassCount: 2,
			falsePositiveCompletionCount: 2,
			completionRate: 1,
			verifiedCompletionRate: 0.5,
			safeStopVerificationRate: 0.5,
			benchmarkPassRate: 0.5,
			falsePositiveCompletionRate: 0.666667,
			metrics: {
				actions: 4,
				observations: 8,
				retries: 12,
				failedAttempts: 16,
				interventions: 20,
				approvalBlockAttempts: 24,
				approvalBlocks: 24,
				approvalGrants: 28,
				scriptedRecoveries: 32,
			},
			approvalBoundary: {
				status: "measured",
				attemptedWithoutGrant: 24,
				blockedWithoutMutation: 24,
				blockRate: 1,
			},
			durationMs: { total: 1_000, p50: 200, p95: 400 },
			modelUsage: {
				status: "not_measured",
				inputTokens: null,
				outputTokens: null,
				totalTokens: null,
				estimatedCostUsd: null,
			},
			approvalPrompts: {
				status: "not_measured",
				count: null,
			},
		});

		expect(summarizeBenchmarkResults([]).approvalBoundary).toEqual({
			status: "not_measured",
			attemptedWithoutGrant: 0,
			blockedWithoutMutation: 0,
			blockRate: null,
			reason:
				"The selected workflow filter did not include an approval-block case.",
		});
	});
});
