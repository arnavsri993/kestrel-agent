import { describe, expect, it } from "vitest";
import { ModelRouter } from "./model-router";

describe("automatic model routing", () => {
  const router = new ModelRouter();
  const base = {
    taskId: "task-test",
    riskLevel: "read_only" as const,
    complexity: 0.5,
    qualitySensitivity: 0.6,
    latencySensitivity: 0.8,
    estimatedComputeCost: 0.02,
    dailyModelCostRemaining: 2,
    deterministicEligible: false,
    requiresTools: false,
    selectedAt: "2026-07-22T15:00:00.000Z"
  };

  it("uses local rules and disables reasoning and Fast mode when a verified deterministic path exists", () => {
    expect(router.select({ ...base, deterministicEligible: true })).toMatchObject({
      model: "local-rules", reasoningEffort: "none", fastMode: false, serviceTier: "standard", execution: "local"
    });
  });

  it("uses Luna with no reasoning and Fast mode for simple latency-sensitive work", () => {
    expect(router.select({ ...base, complexity: 0.14 })).toMatchObject({
      model: "gpt-5.6-luna", reasoningEffort: "none", fastMode: true, serviceTier: "priority"
    });
  });

  it("uses Terra with medium reasoning for balanced tool work", () => {
    expect(router.select({ ...base, requiresTools: true })).toMatchObject({
      model: "gpt-5.6-terra", reasoningEffort: "medium", fastMode: true, serviceTier: "priority"
    });
  });

  it("uses Sol with deeper reasoning and keeps Fast mode off for quality-critical work", () => {
    expect(router.select({ ...base, riskLevel: "high_consequence", complexity: 0.88, qualitySensitivity: 0.94 })).toMatchObject({
      model: "gpt-5.6-sol", reasoningEffort: "high", fastMode: false, serviceTier: "standard"
    });
  });

  it("keeps Fast mode off when the estimated task cost lacks budget headroom", () => {
    expect(router.select({ ...base, estimatedComputeCost: 0.5, dailyModelCostRemaining: 1 })).toMatchObject({
      model: "gpt-5.6-terra", fastMode: false, serviceTier: "standard"
    });
  });

  it("bounds complexity, qualitySensitivity, and latencySensitivity to [0, 1]", () => {
    // Check below 0
    expect(router.select({ ...base, complexity: -0.5, qualitySensitivity: -0.1, latencySensitivity: -2 })).toMatchObject({
      model: "gpt-5.6-luna", reasoningEffort: "none", fastMode: false // simple logic triggered because complexity (bounded to 0) <= 0.28, but latencySensitivity (bounded to 0) < 0.7 means fastMode false
    });
    // Check above 1
    expect(router.select({ ...base, complexity: 1.5, qualitySensitivity: 1.1, latencySensitivity: 1.1 })).toMatchObject({
      model: "gpt-5.6-sol", reasoningEffort: "xhigh" // complexity (bounded to 1) >= 0.95 -> xhigh
    });
  });

  describe("model === 'gpt-5.6-sol'", () => {
    it("uses xhigh reasoning when complexity >= 0.95", () => {
      expect(router.select({ ...base, qualitySensitivity: 0.9, complexity: 0.96 })).toMatchObject({
        model: "gpt-5.6-sol", reasoningEffort: "xhigh"
      });
    });

    it("uses high reasoning when complexity < 0.95", () => {
      expect(router.select({ ...base, qualitySensitivity: 0.9, complexity: 0.85 })).toMatchObject({
        model: "gpt-5.6-sol", reasoningEffort: "high"
      });
    });
  });

  describe("model === 'gpt-5.6-terra'", () => {
    it("uses high reasoning when complexity >= 0.7", () => {
      expect(router.select({ ...base, complexity: 0.75, qualitySensitivity: 0.5, requiresTools: true })).toMatchObject({
        model: "gpt-5.6-terra", reasoningEffort: "high"
      });
    });

    it("uses medium reasoning when complexity < 0.7", () => {
      expect(router.select({ ...base, complexity: 0.5, qualitySensitivity: 0.5, requiresTools: true })).toMatchObject({
        model: "gpt-5.6-terra", reasoningEffort: "medium"
      });
    });
  });

  describe("model === 'gpt-5.6-luna'", () => {
    it("uses none reasoning when complexity <= 0.16", () => {
      expect(router.select({ ...base, complexity: 0.1, qualitySensitivity: 0.5 })).toMatchObject({
        model: "gpt-5.6-luna", reasoningEffort: "none"
      });
    });

    it("uses low reasoning when complexity > 0.16", () => {
      expect(router.select({ ...base, complexity: 0.2, qualitySensitivity: 0.5 })).toMatchObject({
        model: "gpt-5.6-luna", reasoningEffort: "low"
      });
    });
  });

  describe("fastMode logic", () => {
    it("is false when latencySensitivity < 0.7", () => {
      expect(router.select({ ...base, latencySensitivity: 0.6, complexity: 0.1 })).toMatchObject({
        model: "gpt-5.6-luna", fastMode: false, serviceTier: "standard"
      });
    });

    it("is false when riskLevel is not lowerRisk", () => {
      expect(router.select({ ...base, riskLevel: "high_consequence", complexity: 0.1 })).toMatchObject({
        fastMode: false, serviceTier: "standard"
      });
    });

    it("is false when qualityCritical is true", () => {
      expect(router.select({ ...base, qualitySensitivity: 0.9 })).toMatchObject({
        fastMode: false, serviceTier: "standard"
      });
    });

    it("is false when missing budget headroom (estimatedComputeCost > dailyModelCostRemaining * 0.2)", () => {
      expect(router.select({ ...base, estimatedComputeCost: 1, dailyModelCostRemaining: 2, complexity: 0.1 })).toMatchObject({
        fastMode: false, serviceTier: "standard"
      });
    });

    it("is false when dailyModelCostRemaining is 0 or less", () => {
      expect(router.select({ ...base, dailyModelCostRemaining: 0, complexity: 0.1 })).toMatchObject({
        fastMode: false, serviceTier: "standard"
      });
    });
  });
});
