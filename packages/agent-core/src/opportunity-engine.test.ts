import { describe, it, expect, beforeEach } from "vitest";
import { OpportunityEngine, ResourceLimits } from "./opportunity-engine";

describe("OpportunityEngine", () => {
  let engine: OpportunityEngine;

  beforeEach(() => {
    engine = new OpportunityEngine();
  });

  describe("score", () => {
    it("should calculate correct score for typical inputs", () => {
      const input = {
        expectedUtility: 10,
        confidence: 0.8,
        urgency: 1.2,
        importance: 1.5,
        estimatedInterruptionCost: 2,
        estimatedComputeCost: 1,
        riskLevel: "low" as const,
      };

      const score = engine.score(input);
      // utility * confidence * urgency * importance
      // 10 * 0.8 * 1.2 * 1.5 = 14.4
      // - interruption (2) - compute (1) - risk (0.4)
      // = 14.4 - 2 - 1 - 0.4 = 11
      expect(score).toBe(11);
    });

    it("should apply correct risk penalties", () => {
      const baseInput = {
        expectedUtility: 5,
        confidence: 1,
        urgency: 1,
        importance: 1,
        estimatedInterruptionCost: 0,
        estimatedComputeCost: 0,
      };

      expect(engine.score({ ...baseInput, riskLevel: "read_only" })).toBe(5);
      expect(engine.score({ ...baseInput, riskLevel: "low" })).toBe(4.6);
      expect(engine.score({ ...baseInput, riskLevel: "external" })).toBe(3.8);
      expect(engine.score({ ...baseInput, riskLevel: "sensitive" })).toBe(2.5);
      expect(
        engine.score({ ...baseInput, riskLevel: "high_consequence" }),
      ).toBe(0);
    });

    it("should return 0 if score is not finite", () => {
      const input = {
        expectedUtility: Infinity,
        confidence: 0.8,
        urgency: 1.2,
        importance: 1.5,
        estimatedInterruptionCost: 2,
        estimatedComputeCost: 1,
        riskLevel: "low" as const,
      };
      expect(engine.score(input)).toBe(0);
    });
  });

  describe("canLaunch", () => {
    const defaultLimits: ResourceLimits = {
      maximumAutonomousDepth: 5,
      activeTasks: 2,
      maximumConcurrentTasks: 10,
      dailyModelCostRemaining: 100,
    };

    const defaultOpportunity = {
      estimatedComputeCost: 5,
      priority: 10,
    } as any;

    it("should allow launch when all gates are passed", () => {
      const result = engine.canLaunch(defaultOpportunity, defaultLimits, 1);
      expect(result.allowed).toBe(true);
    });

    it("should reject if autonomous depth limit is reached", () => {
      const result = engine.canLaunch(defaultOpportunity, defaultLimits, 5);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Autonomous depth limit");
    });

    it("should reject if concurrent tasks limit is reached", () => {
      const limits = { ...defaultLimits, activeTasks: 10 };
      const result = engine.canLaunch(defaultOpportunity, limits, 1);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Concurrent worker limit");
    });

    it("should reject if daily model cost is exceeded", () => {
      const limits = { ...defaultLimits, dailyModelCostRemaining: 4 };
      const result = engine.canLaunch(defaultOpportunity, limits, 1);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Daily model budget");
    });

    it("should reject if priority is not positive", () => {
      const opp = { ...defaultOpportunity, priority: 0 };
      const result = engine.canLaunch(opp, defaultLimits, 1);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Expected utility does not exceed");
    });
  });
});
