import type { ApprovalLevel, RiskLevel } from "@kestrel/shared-types";

const injectionPatterns = [
	/ignore (all|any|the) (previous|prior|user|system) instructions/i,
	/(upload|send|exfiltrate).{0,30}(all|every).{0,20}(file|document|secret)/i,
	/(reveal|print|return).{0,20}(api key|password|token|secret)/i,
	/you are now (?:the )?(?:system|administrator|developer)/i,
];

export interface ContentAssessment {
	trusted: false;
	suspicious: boolean;
	reasons: string[];
}

export function assessExternalContent(content: string): ContentAssessment {
	const reasons = injectionPatterns
		.filter((pattern) => pattern.test(content))
		.map((pattern) => `Matched unsafe instruction pattern: ${pattern.source}`);
	return { trusted: false, suspicious: reasons.length > 0, reasons };
}

const RISK_LEVEL_MAP: Record<RiskLevel, ApprovalLevel> = {
	read_only: 0,
	low: 1,
	external: 2,
	sensitive: 3,
	high_consequence: 4,
};

export function approvalLevelForRisk(risk: RiskLevel): ApprovalLevel {
	return RISK_LEVEL_MAP[risk];
}

export function mayExecute(params: {
	risk: RiskLevel;
	approvalStatus?: string;
	externalContentSuspicious?: boolean;
}): { allowed: boolean; approvalRequired: boolean; reason: string } {
	if (params.externalContentSuspicious)
		return {
			allowed: false,
			approvalRequired: false,
			reason:
				"External content contains instruction-like text that conflicts with the user-goal boundary.",
		};
	const level = approvalLevelForRisk(params.risk);
	if (level >= 2 && params.approvalStatus !== "approved")
		return {
			allowed: false,
			approvalRequired: true,
			reason: `Approval level ${level} is required before this action can execute.`,
		};
	return {
		allowed: true,
		approvalRequired: false,
		reason:
			level === 0
				? "Read-only action is within scope."
				: "Required policy and approval checks passed.",
	};
}
