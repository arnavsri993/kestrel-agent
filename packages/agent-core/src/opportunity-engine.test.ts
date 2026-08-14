import { describe, expect, it } from "vitest";
import { OpportunityEngine } from "./opportunity-engine.js";
import type { TaskOpportunity } from "@kestrel/shared-types";

describe("OpportunityEngine", () => {
  describe("score", () => {
    it("calculates the correct score", () => {
      const engine = new OpportunityEngine();
      const score = engine.score({
        expectedUtility: 10,
        confidence: 0.8,
        urgency: 1.5,
        importance: 2,
        estimatedInterruptionCost: 1,
        estimatedComputeCost: 2,
        riskLevel: "low",
      });
      // 10 * 0.8 * 1.5 * 2 = 24
      // 24 - 1 - 2 - 0.4 (low risk penalty) = 20.6
      expect(score).toBe(20.6);
    });

    it("returns 0 if score is not finite", () => {
      const engine = new OpportunityEngine();
      const score = engine.score({
        expectedUtility: Infinity,
        confidence: 0.8,
        urgency: 1.5,
        importance: 2,
        estimatedInterruptionCost: 1,
        estimatedComputeCost: 2,
        riskLevel: "low",
      });
      expect(score).toBe(0);
    });
  });

  describe("canLaunch", () => {
    it("allows launching when within limits and positive priority", () => {
      const engine = new OpportunityEngine();
      const result = engine.canLaunch(
        { estimatedComputeCost: 1, priority: 5 } as TaskOpportunity,
        { maximumAutonomousDepth: 5, activeTasks: 1, maximumConcurrentTasks: 3, dailyModelCostRemaining: 10 },
        1
      );
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe("Utility and resource gates passed; approval policy still applies.");
    });

    it("denies if depth limit reached", () => {
      const engine = new OpportunityEngine();
      const result = engine.canLaunch(
        { estimatedComputeCost: 1, priority: 5 } as TaskOpportunity,
        { maximumAutonomousDepth: 2, activeTasks: 1, maximumConcurrentTasks: 3, dailyModelCostRemaining: 10 },
        2
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Autonomous depth limit reached.");
    });

    it("denies if concurrent worker limit reached", () => {
      const engine = new OpportunityEngine();
      const result = engine.canLaunch(
        { estimatedComputeCost: 1, priority: 5 } as TaskOpportunity,
        { maximumAutonomousDepth: 5, activeTasks: 3, maximumConcurrentTasks: 3, dailyModelCostRemaining: 10 },
        1
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Concurrent worker limit reached.");
    });

    it("denies if budget would be exceeded", () => {
      const engine = new OpportunityEngine();
      const result = engine.canLaunch(
        { estimatedComputeCost: 15, priority: 5 } as TaskOpportunity,
        { maximumAutonomousDepth: 5, activeTasks: 1, maximumConcurrentTasks: 3, dailyModelCostRemaining: 10 },
        1
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Daily model budget would be exceeded.");
    });

    it("denies if priority is zero or less", () => {
      const engine = new OpportunityEngine();
      const result = engine.canLaunch(
        { estimatedComputeCost: 1, priority: 0 } as TaskOpportunity,
        { maximumAutonomousDepth: 5, activeTasks: 1, maximumConcurrentTasks: 3, dailyModelCostRemaining: 10 },
        1
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Expected utility does not exceed interruption, compute, and risk cost.");
    });
  });
});
