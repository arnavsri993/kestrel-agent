import { z } from "zod";
import { RiskLevelSchema } from "./contracts";

const ToolPatternSchema = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[a-z*][a-z0-9*_.-]*$/);

export const AgentConfigurationDocumentSchema = z.strictObject({
	schemaVersion: z.literal(1),
	behavior: z.strictObject({
		userInstructions: z.string().max(50_000),
		responseStyle: z.enum(["concise", "balanced", "detailed"]),
		proactiveImprovementSuggestions: z.boolean(),
	}),
	prompts: z.strictObject({
		systemAddon: z.string().max(50_000),
	}),
	tools: z.strictObject({
		enabled: z.array(ToolPatternSchema).min(1).max(200),
		disabled: z.array(ToolPatternSchema).max(200),
	}),
	permissions: z.strictObject({
		additionalApprovalTools: z.array(ToolPatternSchema).max(200),
	}),
	workflows: z.strictObject({
		maximumTurns: z.number().int().min(1).max(50),
		codeChangeMode: z.literal("isolated_pull_request"),
		verifyBeforeApply: z.literal(true),
		reversibleByDefault: z.literal(true),
	}),
	ui: z.strictObject({
		density: z.enum(["comfortable", "compact"]),
		showToolActivity: z.boolean(),
		showConfigurationDiffs: z.boolean(),
		announceVerification: z.boolean(),
	}),
	browser: z.strictObject({
		searchEngine: z.enum([
			"duckduckgo",
			"google",
			"bing",
			"brave",
			"ecosia",
			"startpage",
			"yahoo",
			"kagi",
			"qwant",
			"mojeek",
			"baidu",
			"yandex",
			"custom",
		]),
		blockThirdPartyCookies: z.boolean(),
		blockTrackers: z.boolean(),
		adBlocking: z.boolean(),
		contentBlocking: z.enum(["standard", "strict", "custom"]),
		javascriptEnabled: z.boolean(),
		doNotTrack: z.boolean(),
			newTabBackground: z.enum([
				"graphite",
				"meadow",
				"dawn",
				"mountains",
				"paper",
			]),
		contextEnabled: z.boolean(),
	}),
	appearance: z.strictObject({
		skin: z.string().min(1).max(50),
		petEnabled: z.boolean(),
		petSlug: z.string().min(1).max(50),
		petScale: z.number().min(0.25).max(2),
		petRenderMode: z.enum(["unicode", "canvas"]),
	}),
	system: z.strictObject({
		launchAtLogin: z.boolean(),
		paused: z.boolean(),
	}),
	memory: z.strictObject({
		captureExplicit: z.boolean(),
		useSharedContext: z.boolean(),
		improvementLookbackDays: z.number().int().min(1).max(90),
		minimumFailureCount: z.number().int().min(2).max(100),
	}),
	integrations: z.strictObject({
		hostedFallback: z.enum(["ask", "allowed", "disabled"]),
	}),
	settings: z.strictObject({
		locale: z
			.string()
			.min(2)
			.max(40)
			.regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
		timezone: z.string().min(1).max(100),
		explainConfigurationChanges: z.boolean(),
		improvementReviewCadenceHours: z.number().int().min(1).max(168),
	}),
});
export type AgentConfigurationDocument = z.infer<
	typeof AgentConfigurationDocumentSchema
>;

export const AgentConfigurationPatchOperationSchema = z.discriminatedUnion(
	"op",
	[
		z.strictObject({
			op: z.enum(["add", "replace"]),
			path: z.string().startsWith("/").max(500),
			value: z.json(),
		}),
		z.strictObject({
			op: z.literal("remove"),
			path: z.string().startsWith("/").max(500),
		}),
	],
);
export type AgentConfigurationPatchOperation = z.infer<
	typeof AgentConfigurationPatchOperationSchema
>;

export const AgentConfigurationCheckSchema = z.strictObject({
	id: z.string().min(1).max(100),
	status: z.enum(["passed", "failed"]),
	detail: z.string().min(1).max(2_000),
});
export type AgentConfigurationCheck = z.infer<
	typeof AgentConfigurationCheckSchema
>;

export const AgentConfigurationSurfaceSchema = z.strictObject({
	id: z.string().regex(/^[a-z][a-z0-9.-]{0,99}$/),
	title: z.string().min(1).max(100),
	description: z.string().min(1).max(1_000),
	editablePaths: z.array(z.string().startsWith("/")).max(100),
	riskLevel: RiskLevelSchema,
	liveEffect: z.string().min(1).max(1_000),
	examples: z.array(z.string().min(1).max(500)).max(10),
});
export type AgentConfigurationSurface = z.infer<
	typeof AgentConfigurationSurfaceSchema
>;

export const ProtectedAgentBoundarySchema = z.strictObject({
	id: z.string().regex(/^[a-z][a-z0-9.-]{0,99}$/),
	title: z.string().min(1).max(100),
	reason: z.string().min(1).max(1_000),
	safeAlternative: z.string().min(1).max(1_000),
});
export type ProtectedAgentBoundary = z.infer<
	typeof ProtectedAgentBoundarySchema
>;

export const AgentConfigurationVersionSchema = z.strictObject({
	id: z.string().regex(/^config-version-[a-f0-9-]{36}$/),
	sequence: z.number().int().positive(),
	parentVersionId: z
		.string()
		.regex(/^config-version-[a-f0-9-]{36}$/)
		.optional(),
	restoredFromVersionId: z
		.string()
		.regex(/^config-version-[a-f0-9-]{36}$/)
		.optional(),
	sourceProposalId: z
		.string()
		.regex(/^config-proposal-[a-f0-9-]{36}$/)
		.optional(),
	document: AgentConfigurationDocumentSchema,
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	knownGood: z.boolean(),
	createdBy: z.enum(["system", "user", "agent"]),
	createdAt: z.string().datetime(),
});
export type AgentConfigurationVersion = z.infer<
	typeof AgentConfigurationVersionSchema
>;

export const AgentConfigurationProposalSchema = z.strictObject({
	id: z.string().regex(/^config-proposal-[a-f0-9-]{36}$/),
	requestSummary: z.string().min(1).max(2_000),
	origin: z.enum(["user_request", "self_improvement"]),
	sourceSessionId: z.string().min(1).max(500),
	baseVersionId: z.string().regex(/^config-version-[a-f0-9-]{36}$/),
	baseSha256: z.string().regex(/^[a-f0-9]{64}$/),
	candidateSha256: z.string().regex(/^[a-f0-9]{64}$/),
	patch: z.array(AgentConfigurationPatchOperationSchema).min(1).max(100),
	diff: z.string().min(1).max(250_000),
	riskLevel: RiskLevelSchema,
	requiresExplicitApproval: z.literal(true),
	isolatedChecks: z.array(AgentConfigurationCheckSchema).min(1).max(50),
	status: z.enum(["staged", "applied", "rejected", "superseded", "failed"]),
	appliedVersionId: z
		.string()
		.regex(/^config-version-[a-f0-9-]{36}$/)
		.optional(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type AgentConfigurationProposal = z.infer<
	typeof AgentConfigurationProposalSchema
>;

export const AgentConfigurationAuditEventSchema = z.strictObject({
	id: z.string().regex(/^config-audit-[a-f0-9-]{36}$/),
	action: z.enum([
		"initialized",
		"staged",
		"applied",
		"rejected",
		"superseded",
		"rolled_back",
		"restored_known_good",
		"recovery_fallback",
		"improvement_detected",
	]),
	actor: z.enum(["system", "user", "agent"]),
	versionId: z
		.string()
		.regex(/^config-version-[a-f0-9-]{36}$/)
		.optional(),
	proposalId: z
		.string()
		.regex(/^config-proposal-[a-f0-9-]{36}$/)
		.optional(),
	detail: z.string().min(1).max(4_000),
	evidence: z.array(z.string().min(1).max(2_000)).max(50),
	createdAt: z.string().datetime(),
});
export type AgentConfigurationAuditEvent = z.infer<
	typeof AgentConfigurationAuditEventSchema
>;

export const AgentImprovementProposalSchema = z.strictObject({
	id: z.string().regex(/^agent-improvement-[a-f0-9-]{36}$/),
	weaknessId: z.string().min(1).max(500),
	title: z.string().min(1).max(200),
	rationale: z.string().min(1).max(2_000),
	evidence: z.array(z.string().min(1).max(2_000)).min(1).max(50),
	recommendedPatch: z
		.array(AgentConfigurationPatchOperationSchema)
		.min(1)
		.max(100),
	baseVersionId: z
		.string()
		.regex(/^config-version-[a-f0-9-]{36}$/)
		.optional(),
	riskLevel: RiskLevelSchema,
	status: z.enum(["proposed", "staged", "applied", "dismissed"]),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type AgentImprovementProposal = z.infer<
	typeof AgentImprovementProposalSchema
>;

export const AgentConfigurationStatusSchema = z.strictObject({
	currentVersionId: z.string().regex(/^config-version-[a-f0-9-]{36}$/),
	sequence: z.number().int().positive(),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	knownGood: z.boolean(),
	pendingProposals: z.number().int().nonnegative(),
	pendingImprovements: z.number().int().nonnegative(),
	rollbackVersionId: z
		.string()
		.regex(/^config-version-[a-f0-9-]{36}$/)
		.optional(),
	ui: AgentConfigurationDocumentSchema.shape.ui,
});
export type AgentConfigurationStatus = z.infer<
	typeof AgentConfigurationStatusSchema
>;
