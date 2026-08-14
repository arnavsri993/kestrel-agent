import { describe, expect, test } from "vitest";
import { OpportunityEngine, type ResourceLimits } from "./opportunity-engine";

describe("OpportunityEngine", () => {
	const engine = new OpportunityEngine();

	describe("score", () => {
		test("calculates positive score for high utility low cost", () => {
			const score = engine.score({
				expectedUtility: 10,
				confidence: 0.9,
				urgency: 2,
				importance: 1.5,
				estimatedInterruptionCost: 2,
				estimatedComputeCost: 1,
				riskLevel: "low",
			});
			// 10 * 0.9 * 2 * 1.5 = 27
			// cost: 2 + 1 + 0.4(risk) = 3.4
			// score: 27 - 3.4 = 23.6
			expect(score).toBeCloseTo(23.6);
		});

		test("applies different risk penalties correctly", () => {
			const baseArgs = {
				expectedUtility: 5,
				confidence: 1,
				urgency: 1,
				importance: 1,
				estimatedInterruptionCost: 0,
				estimatedComputeCost: 0,
			};

			expect(engine.score({ ...baseArgs, riskLevel: "read_only" })).toBe(5);
			expect(engine.score({ ...baseArgs, riskLevel: "low" })).toBe(4.6);
			expect(engine.score({ ...baseArgs, riskLevel: "external" })).toBe(3.8);
			expect(engine.score({ ...baseArgs, riskLevel: "sensitive" })).toBe(2.5);
			expect(engine.score({ ...baseArgs, riskLevel: "high_consequence" })).toBe(
				0,
			);
		});

		test("returns 0 for infinite inputs", () => {
			expect(
				engine.score({
					expectedUtility: Infinity,
					confidence: 1,
					urgency: 1,
					importance: 1,
					estimatedInterruptionCost: 0,
					estimatedComputeCost: 0,
					riskLevel: "read_only",
				}),
			).toBe(0);
		});
	});

	describe("canLaunch", () => {
		const defaultLimits: ResourceLimits = {
			dailyModelCostRemaining: 100,
			maximumAutonomousDepth: 5,
			activeTasks: 1,
			maximumConcurrentTasks: 3,
		};

		const defaultOpp: any = {
			priority: 10,
			estimatedComputeCost: 5,
		};

		test("allows launch when limits are respected", () => {
			const result = engine.canLaunch(defaultOpp, defaultLimits, 0);
			expect(result.allowed).toBe(true);
			expect(result.reason).toContain("passed");
		});

		test("blocks launch if depth is exceeded", () => {
			const result = engine.canLaunch(defaultOpp, defaultLimits, 5);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain("depth limit reached");
		});

		test("blocks launch if concurrent tasks exceeded", () => {
			const result = engine.canLaunch(
				defaultOpp,
				{ ...defaultLimits, activeTasks: 3 },
				0,
			);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain("Concurrent worker limit reached");
		});

		test("blocks launch if budget exceeded", () => {
			const result = engine.canLaunch(
				{ ...defaultOpp, estimatedComputeCost: 105 },
				defaultLimits,
				0,
			);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain("budget would be exceeded");
		});

		test("blocks launch if priority is non-positive", () => {
			const result = engine.canLaunch(
				{ ...defaultOpp, priority: 0 },
				defaultLimits,
				0,
			);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain("utility does not exceed");
		});
	});
});
