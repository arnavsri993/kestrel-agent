import type { TaskOpportunity } from "@kestrel/shared-types";

export interface ResourceLimits {
  dailyModelCostRemaining: number;
  maximumAutonomousDepth: number;
  activeTasks: number;
  maximumConcurrentTasks: number;
}

export class OpportunityEngine {
  score(input: Pick<TaskOpportunity, "expectedUtility" | "confidence" | "urgency" | "importance" | "estimatedInterruptionCost" | "estimatedComputeCost" | "riskLevel">): number {
    const riskPenalty = ({ read_only: 0, low: 0.4, external: 1.2, sensitive: 2.5, high_consequence: 5 } as const)[input.riskLevel];
    const score = input.expectedUtility * input.confidence * input.urgency * input.importance - input.estimatedInterruptionCost - input.estimatedComputeCost - riskPenalty;
    return Number.isFinite(score) ? Number(score.toFixed(2)) : 0;
  }

  canLaunch(opportunity: TaskOpportunity, limits: ResourceLimits, currentDepth: number): { allowed: boolean; reason: string } {
    if (currentDepth >= limits.maximumAutonomousDepth) return { allowed: false, reason: "Autonomous depth limit reached." };
    if (limits.activeTasks >= limits.maximumConcurrentTasks) return { allowed: false, reason: "Concurrent worker limit reached." };
    if (opportunity.estimatedComputeCost > limits.dailyModelCostRemaining) return { allowed: false, reason: "Daily model budget would be exceeded." };
    if (opportunity.priority <= 0) return { allowed: false, reason: "Expected utility does not exceed interruption, compute, and risk cost." };
    return { allowed: true, reason: "Utility and resource gates passed; approval policy still applies." };
  }
}
