import { describe, expect, it } from "vitest";
import { OpportunityEngine, type ResourceLimits } from "./opportunity-engine";
import type { TaskOpportunity } from "@kestrel/shared-types";

describe("OpportunityEngine", () => {
  describe("score", () => {
    it("calculates positive score when utility outweighs costs and penalties", () => {
      const engine = new OpportunityEngine();
      const score = engine.score({
        expectedUtility: 10,
        confidence: 0.9,
        urgency: 1.5,
        importance: 1.2,
        estimatedInterruptionCost: 2,
        estimatedComputeCost: 1,
        riskLevel: "low"
      });
      // 10 * 0.9 * 1.5 * 1.2 = 16.2
      // penalty = 0.4 (low risk)
      // score = 16.2 - 2 - 1 - 0.4 = 12.8
      expect(score).toBe(12.8);
    });

    it("calculates negative score when risks or costs are too high", () => {
      const engine = new OpportunityEngine();
      const score = engine.score({
        expectedUtility: 5,
        confidence: 0.5,
        urgency: 1.0,
        importance: 1.0,
        estimatedInterruptionCost: 5,
        estimatedComputeCost: 2,
        riskLevel: "high_consequence"
      });
      // 5 * 0.5 * 1.0 * 1.0 = 2.5
      // penalty = 5 (high_consequence)
      // score = 2.5 - 5 - 2 - 5 = -9.5
      expect(score).toBe(-9.5);
    });

    it("handles read_only risk level with 0 penalty", () => {
      const engine = new OpportunityEngine();
      const score = engine.score({
        expectedUtility: 10,
        confidence: 1.0,
        urgency: 1.0,
        importance: 1.0,
        estimatedInterruptionCost: 0,
        estimatedComputeCost: 0,
        riskLevel: "read_only"
      });
      // 10 - 0 - 0 - 0 = 10
      expect(score).toBe(10);
    });
  });

  describe("canLaunch", () => {
    const limits: ResourceLimits = {
      dailyModelCostRemaining: 10,
      maximumAutonomousDepth: 5,
      activeTasks: 1,
      maximumConcurrentTasks: 3
    };

    const opportunityBase = {
      id: "test",
      prompt: "test",
      expectedUtility: 10,
      confidence: 1,
      urgency: 1,
      importance: 1,
      estimatedInterruptionCost: 1,
      estimatedComputeCost: 2,
      riskLevel: "low",
      priority: 5,
      created_at: new Date().toISOString()
    } as unknown as TaskOpportunity;

    it("allows launch when all conditions are met", () => {
      const engine = new OpportunityEngine();
      const result = engine.canLaunch(opportunityBase, limits, 0);
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("passed");
    });

    it("prevents launch if depth limit reached", () => {
      const engine = new OpportunityEngine();
      const result = engine.canLaunch(opportunityBase, limits, 5);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("depth limit reached");
    });

    it("prevents launch if concurrent tasks limit reached", () => {
      const engine = new OpportunityEngine();
      const tightLimits = { ...limits, activeTasks: 3 };
      const result = engine.canLaunch(opportunityBase, tightLimits, 0);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Concurrent worker limit reached");
    });

    it("prevents launch if compute cost exceeds remaining budget", () => {
      const engine = new OpportunityEngine();
      const expensiveOp = { ...opportunityBase, estimatedComputeCost: 15 };
      const result = engine.canLaunch(expensiveOp, limits, 0);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("budget would be exceeded");
    });

    it("prevents launch if priority is less than or equal to 0", () => {
      const engine = new OpportunityEngine();
      const lowPriorityOp = { ...opportunityBase, priority: 0 };
      const result = engine.canLaunch(lowPriorityOp, limits, 0);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Expected utility does not exceed");
    });
  });
});
