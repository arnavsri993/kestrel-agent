import type { ModelRoutingDecision, RiskLevel } from "@kestrel/shared-types";

export interface ModelRoutingInput {
  taskId: string;
  riskLevel: RiskLevel;
  complexity: number;
  qualitySensitivity: number;
  latencySensitivity: number;
  estimatedComputeCost: number;
  dailyModelCostRemaining: number;
  deterministicEligible: boolean;
  requiresTools: boolean;
  selectedAt: string;
}

function bounded(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export class ModelRouter {
  select(raw: ModelRoutingInput): ModelRoutingDecision {
    const input = {
      ...raw,
      complexity: bounded(raw.complexity),
      qualitySensitivity: bounded(raw.qualitySensitivity),
      latencySensitivity: bounded(raw.latencySensitivity)
    };

    if (input.deterministicEligible) {
      return {
        taskId: input.taskId,
        model: "local-rules",
        reasoningEffort: "none",
        fastMode: false,
        serviceTier: "standard",
        execution: "local",
        rationale: "Verified local rules cover this task, so no model request or paid Fast-mode tier is needed.",
        selectedAt: input.selectedAt
      };
    }

    const qualityCritical = input.qualitySensitivity >= 0.85 || input.complexity >= 0.82 || input.riskLevel === "high_consequence";
    const simple = input.complexity <= 0.28 && input.qualitySensitivity < 0.7 && !input.requiresTools;
    const model = qualityCritical ? "gpt-5.6-sol" : simple ? "gpt-5.6-luna" : "gpt-5.6-terra";
    const reasoningEffort = model === "gpt-5.6-sol"
      ? (input.complexity >= 0.95 ? "xhigh" : "high")
      : model === "gpt-5.6-terra"
        ? (input.complexity >= 0.7 ? "high" : "medium")
        : (input.complexity <= 0.16 ? "none" : "low");
    const lowerRisk = input.riskLevel === "read_only" || input.riskLevel === "low";
    const hasFastBudgetHeadroom = input.dailyModelCostRemaining > 0
      && input.estimatedComputeCost <= input.dailyModelCostRemaining * 0.2;
    const fastMode = input.latencySensitivity >= 0.7 && lowerRisk && !qualityCritical && hasFastBudgetHeadroom;

    return {
      taskId: input.taskId,
      model,
      reasoningEffort,
      fastMode,
      serviceTier: fastMode ? "priority" : "standard",
      execution: "development_adapter",
      rationale: fastMode
        ? "Automatic routing favors a latency-sensitive, lower-risk task and budget permits the priority tier."
        : qualityCritical
          ? "Automatic routing favors quality and deeper reasoning; Fast mode stays off for this complex or high-consequence task."
          : "Automatic routing balances task complexity, tool use, risk, latency, and remaining model budget.",
      selectedAt: input.selectedAt
    };
  }
}
