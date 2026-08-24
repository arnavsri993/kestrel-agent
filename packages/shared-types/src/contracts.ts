import { z } from "zod";
import {
	CommunicationCodeScanSchema,
	CommunicationCodeMatchSchema,
	CommunicationSourceStatusSchema,
} from "./communication";
import {
	NewTabGreetingActivitySchema,
	NewTabGreetingContextSchema,
} from "./new-tab-greeting";

export const SensitivitySchema = z.enum([
	"public",
	"personal",
	"sensitive",
	"restricted",
]);
export type SensitivityLevel = z.infer<typeof SensitivitySchema>;

export const RiskLevelSchema = z.enum([
	"read_only",
	"low",
	"external",
	"sensitive",
	"high_consequence",
]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const ApprovalLevelSchema = z.number().int().min(0).max(4);
export type ApprovalLevel = z.infer<typeof ApprovalLevelSchema>;

export const BaseEventSchema = z.object({
	id: z.string().min(1),
	type: z.string().min(1),
	source: z.string().min(1),
	sourceAccountId: z.string().optional(),
	occurredAt: z.string().datetime(),
	receivedAt: z.string().datetime(),
	sensitivity: SensitivitySchema,
	rawReference: z.string().optional(),
	metadata: z.record(z.string(), z.unknown()),
});
export type AgentEvent = z.infer<typeof BaseEventSchema>;

export const MemoryTypeSchema = z.enum([
	"episodic",
	"semantic",
	"procedural",
	"project",
	"relationship",
]);
export const MemoryRecordSchema = z.object({
	id: z.string(),
	type: MemoryTypeSchema,
	content: z.string(),
	structuredData: z.record(z.string(), z.unknown()),
	sourceIds: z.array(z.string()),
	sourceType: z.string(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
	validFrom: z.string().datetime().optional(),
	validUntil: z.string().datetime().optional(),
	confidence: z.number().min(0).max(1),
	importance: z.number().min(0).max(1),
	sensitivity: SensitivitySchema,
	status: z.enum([
		"active",
		"superseded",
		"contradicted",
		"expired",
		"deleted",
	]),
	entityIds: z.array(z.string()),
	userConfirmed: z.boolean(),
	inferred: z.boolean(),
	subject: z.string().min(1).max(500).optional(),
	layer: z.enum(["short_term", "mid_term", "long_term", "archived"]).optional(),
	confirmationStatus: z
		.enum([
			"inferred",
			"suggested",
			"explicit",
			"provider_confirmed",
			"user_confirmed",
		])
		.optional(),
	lastAccessedAt: z.string().datetime().optional(),
	relevanceScore: z.number().min(0).max(1).optional(),
	reviewAt: z.string().datetime().optional(),
	archivedAt: z.string().datetime().optional(),
	relatedPersonIds: z.array(z.string()).optional(),
	relatedProjectIds: z.array(z.string()).optional(),
	relatedEventIds: z.array(z.string()).optional(),
	relatedLocationIds: z.array(z.string()).optional(),
	conflictingMemoryIds: z.array(z.string()).optional(),
	version: z.number().int().positive().optional(),
});
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

export const MemoryVersionSchema = z.object({
	id: z.string().min(1),
	memoryId: z.string().min(1),
	version: z.number().int().positive(),
	content: z.string().max(100_000),
	structuredData: z.record(z.string(), z.unknown()),
	sourceIds: z.array(z.string().min(1)).min(1),
	sourceType: z.string().min(1),
	changedAt: z.string().datetime(),
	changedBy: z.enum(["user", "agent", "provider", "maintenance"]),
});
export type MemoryVersion = z.infer<typeof MemoryVersionSchema>;

export const PersonFactSchema = z.object({
	id: z.string().min(1),
	key: z.string().min(1).max(200),
	value: z.string().min(1).max(20_000),
	sourceIds: z.array(z.string().min(1)).min(1),
	sourceType: z.string().min(1).max(200),
	confidence: z.number().min(0).max(1),
	sensitivity: SensitivitySchema,
	userConfirmed: z.boolean(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
	validFrom: z.string().datetime().optional(),
	validUntil: z.string().datetime().optional(),
	status: z.enum(["active", "superseded", "contradicted", "deleted"]),
	conflictingFactIds: z.array(z.string()).default([]),
});
export type PersonFact = z.infer<typeof PersonFactSchema>;

export const PersonRecordSchema = z.object({
	id: z.string().min(1),
	displayName: z.string().min(1).max(300),
	nicknames: z.array(z.string().min(1).max(200)).max(40),
	relationship: z.string().max(500).optional(),
	organization: z.string().max(500).optional(),
	role: z.string().max(500).optional(),
	timeZone: z.string().max(200).optional(),
	communicationStyle: z
		.object({
			tone: z.string().max(500).optional(),
			formality: z
				.enum(["casual", "neutral", "professional", "formal"])
				.optional(),
			greeting: z.string().max(500).optional(),
			signOff: z.string().max(500).optional(),
			boundaries: z.array(z.string().max(1_000)).max(50).default([]),
		})
		.default({ boundaries: [] }),
	facts: z.array(PersonFactSchema).max(2_000),
	sourceIds: z.array(z.string().min(1)).min(1),
	confidence: z.number().min(0).max(1),
	sensitivity: SensitivitySchema,
	status: z.enum(["active", "archived", "deleted"]),
	lastInteractionAt: z.string().datetime().optional(),
	relevanceScore: z.number().min(0).max(1),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type PersonRecord = z.infer<typeof PersonRecordSchema>;

export const CalendarEventOriginSchema = z.enum([
	"provider",
	"explicit",
	"inferred",
	"suggested",
]);
export type CalendarEventOrigin = z.infer<typeof CalendarEventOriginSchema>;

export const CalendarAttendeeSchema = z.object({
	name: z.string().max(300).optional(),
	email: z.string().email().max(500).optional(),
	responseStatus: z.string().max(100).optional(),
	personId: z.string().optional(),
	organizer: z.boolean().optional(),
});
export type CalendarAttendee = z.infer<typeof CalendarAttendeeSchema>;

export const UnifiedCalendarEventSchema = z.object({
	id: z.string().min(1),
	externalId: z.string().max(1_024).optional(),
	providerId: z
		.enum(["google", "apple", "outlook", "caldav", "local", "agent"])
		.default("local"),
	calendarId: z.string().max(1_024).optional(),
	origin: CalendarEventOriginSchema,
	status: z.enum([
		"confirmed",
		"tentative",
		"suggested",
		"superseded",
		"cancelled",
		"deleted",
	]),
	title: z.string().min(1).max(2_000),
	description: z.string().max(20_000).optional(),
	startsAt: z.string().datetime(),
	endsAt: z.string().datetime(),
	allDay: z.boolean().default(false),
	timeZone: z.string().max(200).optional(),
	location: z.string().max(2_000).optional(),
	meetingUrl: z.string().url().max(4_000).optional(),
	notes: z.string().max(20_000).optional(),
	attendees: z.array(CalendarAttendeeSchema).max(500).default([]),
	recurrenceRule: z.string().max(4_000).optional(),
	recurrenceDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
	confidence: z.number().min(0).max(1),
	confidenceReason: z.string().max(2_000).optional(),
	sourceIds: z.array(z.string().min(1)).min(1),
	relatedMemoryIds: z.array(z.string()).default([]),
	relatedPersonIds: z.array(z.string()).default([]),
	userConfirmed: z.boolean(),
	externalReadOnly: z.boolean().default(false),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
	lastSyncedAt: z.string().datetime().optional(),
});
export type UnifiedCalendarEvent = z.infer<typeof UnifiedCalendarEventSchema>;

export const CalendarProviderStatusSchema = z.object({
	id: z.enum(["google", "apple", "outlook", "caldav", "local"]),
	label: z.string().min(1),
	state: z.enum(["connected", "disconnected", "unsupported", "error"]),
	detail: z.string().min(1),
	readOnly: z.boolean(),
	lastSyncedAt: z.string().datetime().optional(),
});
export type CalendarProviderStatus = z.infer<
	typeof CalendarProviderStatusSchema
>;

export const ContextInfluenceSchema = z.object({
	kind: z.enum(["memory", "person", "event", "user_model"]),
	id: z.string().min(1),
	reason: z.string().min(1).max(1_000),
	confidence: z.number().min(0).max(1),
	sensitivity: SensitivitySchema,
});
export type ContextInfluence = z.infer<typeof ContextInfluenceSchema>;

export const AgentContextBundleSchema = z.object({
	id: z.string().min(1),
	query: z.string().max(10_000),
	memories: z.array(MemoryRecordSchema).max(20),
	people: z.array(PersonRecordSchema).max(10),
	events: z.array(UnifiedCalendarEventSchema).max(30),
	influences: z.array(ContextInfluenceSchema).max(60),
	prompt: z.string().max(100_000),
	createdAt: z.string().datetime(),
});
export type AgentContextBundle = z.infer<typeof AgentContextBundleSchema>;

export const UserModelFactSchema = z.object({
	id: z.string().min(1),
	kind: z.enum(["preference", "profile", "relationship", "boundary"]),
	key: z.string().min(1).max(200),
	value: z.string().min(1).max(10_000),
	sourceIds: z.array(z.string().min(1)).min(1),
	confidence: z.number().min(0).max(1),
	sensitivity: z.enum(["normal", "sensitive"]),
	status: z.enum(["proposed", "confirmed", "rejected", "superseded"]),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type UserModelFact = z.infer<typeof UserModelFactSchema>;
export type UserModelKind = UserModelFact["kind"];
export type UserModelStatus = UserModelFact["status"];

export const SkillLearningProposalSchema = z.object({
	id: z.string().min(1),
	name: z
		.string()
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
		.max(64),
	description: z.string().min(1).max(1_024),
	instructions: z.string().min(1).max(200_000),
	sourceSessionId: z.string().min(1),
	sourceMessageIds: z.array(z.string().min(1)).min(1),
	status: z.enum(["proposed", "installed", "rejected", "failed"]),
	evaluation: z.object({
		valid: z.boolean(),
		checks: z.array(z.string()),
		error: z.string().optional(),
	}),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type SkillLearningProposal = z.infer<typeof SkillLearningProposalSchema>;

export const SkillLearningFeedbackSchema = z.object({
	id: z.string().min(1),
	skillName: z.string().min(1),
	succeeded: z.boolean(),
	feedback: z.string().min(1).max(20_000),
	sourceIds: z.array(z.string().min(1)).min(1),
	createdAt: z.string().datetime(),
});
export type SkillLearningFeedback = z.infer<typeof SkillLearningFeedbackSchema>;

export const TaskOpportunitySchema = z.object({
	id: z.string(),
	title: z.string(),
	description: z.string(),
	reasonDetected: z.string(),
	triggerEventIds: z.array(z.string()),
	relatedEntityIds: z.array(z.string()),
	relevantMemoryIds: z.array(z.string()),
	proposedGoal: z.string(),
	expectedOutputs: z.array(
		z.object({ type: z.string(), description: z.string() }),
	),
	confidence: z.number().min(0).max(1),
	urgency: z.number().min(0).max(1),
	importance: z.number().min(0).max(1),
	expectedUtility: z.number().min(0),
	estimatedInterruptionCost: z.number().min(0),
	estimatedComputeCost: z.number().min(0),
	estimatedDurationSeconds: z.number().positive().optional(),
	riskLevel: RiskLevelSchema,
	requiredApprovalLevel: ApprovalLevelSchema,
	status: z.enum([
		"detected",
		"evaluating",
		"ignored",
		"suggested",
		"queued",
		"running",
		"awaiting_approval",
		"completed",
		"failed",
	]),
	createdAt: z.string().datetime(),
	expiresAt: z.string().datetime().optional(),
	priority: z.number(),
});
export type TaskOpportunity = z.infer<typeof TaskOpportunitySchema>;

export const EvidenceSchema = z.object({
	id: z.string(),
	label: z.string(),
	value: z.string(),
	source: z.string(),
	confirmed: z.boolean(),
});

export const ApprovalSchema = z.object({
	id: z.string(),
	title: z.string(),
	recommendation: z.string(),
	reasoning: z.string(),
	proposedEmail: z.object({
		to: z.string(),
		subject: z.string(),
		body: z.string(),
	}),
	proposedCalendarEvent: z.object({
		title: z.string(),
		startsAt: z.string(),
		durationMinutes: z.number(),
	}),
	proposedStudyBlocks: z.array(
		z.object({
			label: z.string(),
			startsAt: z.string(),
			durationMinutes: z.number(),
		}),
	),
	evidence: z.array(EvidenceSchema),
	riskLevel: RiskLevelSchema,
	approvalLevel: ApprovalLevelSchema,
	status: z.enum(["pending", "approved", "rejected", "executed", "failed"]),
	policySuggestion: z.string(),
	createdAt: z.string().datetime(),
	executedAt: z.string().datetime().optional(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const ActivitySchema = z.object({
	id: z.string(),
	title: z.string(),
	detail: z.string(),
	timestamp: z.string().datetime(),
	status: z.enum([
		"observed",
		"reasoned",
		"waiting",
		"verified",
		"blocked",
		"failed",
	]),
	sourceIds: z.array(z.string()),
});
export type ActivityItem = z.infer<typeof ActivitySchema>;

export const AgentStateSchema = z.enum([
	"idle",
	"observing",
	"working",
	"waiting_approval",
	"paused",
	"offline",
	"error",
	"updating",
]);
export type AgentState = z.infer<typeof AgentStateSchema>;

export const ExecutionModelSchema = z.string().min(1).max(200);
export type ExecutionModel = z.infer<typeof ExecutionModelSchema>;

export const ReasoningEffortSchema = z.enum([
	"none",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const ModelTierSchema = z.enum([
	"frontier",
	"advanced",
	"standard",
	"permissive_fallback",
	"local_private",
	"specialized",
]);
export type ModelTier = z.infer<typeof ModelTierSchema>;

export const ModelCapabilitySchema = z.enum([
	"complex_reasoning",
	"coding",
	"backend_architecture",
	"frontend_implementation",
	"ui_visual_design",
	"creative_writing",
	"technical_writing",
	"research",
	"long_context",
	"image_understanding",
	"tool_use",
	"planning",
	"debugging",
	"code_review",
	"mathematical_reasoning",
	"speed",
	"cost_efficiency",
	"reliability",
	"instruction_following",
	"structured_output",
]);
export type ModelCapability = z.infer<typeof ModelCapabilitySchema>;

const CapabilityScoresSchema = z.record(
	ModelCapabilitySchema,
	z.number().min(0).max(1),
);

export const ModelProfileSchema = z.object({
	id: z.string().min(1).max(300),
	provider: z.string().min(1).max(100),
	endpointId: z.string().min(1).max(100),
	model: z.string().min(1).max(200),
	displayName: z.string().min(1).max(300),
	enabled: z.boolean(),
	local: z.boolean(),
	tier: ModelTierSchema.optional(),
	capabilities: CapabilityScoresSchema,
	cost: z.object({
		inputPerMillion: z.number().nonnegative().optional(),
		outputPerMillion: z.number().nonnegative().optional(),
		fixedRequestCost: z.number().nonnegative().optional(),
		priorityMultiplier: z.number().min(1).optional(),
	}),
	latency: z.object({
		averageMs: z.number().nonnegative().optional(),
		p95Ms: z.number().nonnegative().optional(),
	}),
	limits: z.object({
		contextWindow: z.number().int().positive().optional(),
		maxOutputTokens: z.number().int().positive().optional(),
		concurrency: z.number().int().positive().optional(),
	}),
	features: z.object({
		tools: z.boolean(),
		vision: z.boolean(),
		structuredOutput: z.boolean(),
		reasoningLevels: z.boolean(),
		fastMode: z.boolean(),
		streaming: z.boolean(),
	}),
	reliability: z.object({
		successRate: z.number().min(0).max(1).optional(),
		toolSuccessRate: z.number().min(0).max(1).optional(),
		structuredOutputRate: z.number().min(0).max(1).optional(),
		refusalRate: z.number().min(0).max(1).optional(),
		refusalCount: z.number().int().nonnegative().optional(),
		recoverySuccessRate: z.number().min(0).max(1).optional(),
	}),
	learnedPerformance: CapabilityScoresSchema,
	observations: z.number().int().nonnegative().default(0),
	lastEvaluatedAt: z.string().datetime().optional(),
});
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

export const RoutingModeSchema = z.enum([
	"fastest",
	"cheapest",
	"balanced",
	"best_quality",
	"local_first",
	"privacy_first",
	"maximum_parallelism",
	"custom_budget",
]);
export type RoutingMode = z.infer<typeof RoutingModeSchema>;

export const RoutingPolicySchema = z.object({
	mode: RoutingModeSchema,
	maximumTaskCostUsd: z.number().nonnegative().optional(),
	maximumLatencyMs: z.number().int().positive().optional(),
	allowExternal: z.boolean(),
	preferLocal: z.boolean(),
	maximumParallelism: z.number().int().min(1).max(64),
	maximumRetries: z.number().int().min(0).max(8),
	maximumDelegationDepth: z.number().int().min(0).max(8),
	maximumTaskDurationMs: z.number().int().min(1_000).max(86_400_000),
	requireReviewAboveRisk: z.enum([
		"read_only",
		"low",
		"sensitive",
		"high_consequence",
	]),
});
export type RoutingPolicy = z.infer<typeof RoutingPolicySchema>;

export const RoutingDecisionSchema = z.object({
	id: z.string().min(1),
	taskId: z.string().min(1),
	selectedModelId: z.string().min(1),
	providerId: z.string().min(1),
	endpointId: z.string().min(1),
	model: z.string().min(1),
	tier: ModelTierSchema.optional(),
	role: z.enum(["orchestrator", "worker", "reviewer", "fallback"]),
	reasoningLevel: ReasoningEffortSchema,
	fastMode: z.boolean(),
	estimatedCost: z.number().nonnegative().optional(),
	confidence: z.number().min(0).max(1),
	reasons: z.array(z.string().min(1)).min(1).max(12),
	fallbackModelIds: z.array(z.string().min(1)).max(8),
	traceId: z.string().min(1).optional(),
	validationStrategy: z.string().min(1).optional(),
	refusalRecovery: z.boolean().optional(),
	switchedFromModelId: z.string().min(1).optional(),
	settings: z.object({
		temperature: z.number().min(0).max(2),
		maximumOutputTokens: z.number().int().positive(),
		maximumContextCharacters: z.number().int().positive(),
		retryCount: z.number().int().min(0).max(8),
		parallelism: z.number().int().min(1).max(64),
		reviewRequired: z.boolean(),
	}),
	selectedAt: z.string().datetime(),
});
export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;

export const RoutingTraceSchema = z.object({
	id: z.string().min(1),
	parentTraceId: z.string().min(1).optional(),
	taskId: z.string().min(1),
	summary: z.string().min(1).max(2_000),
	status: z.enum(["planned", "running", "completed", "failed", "cancelled"]),
	policy: RoutingPolicySchema,
	decisions: z.array(RoutingDecisionSchema),
	escalationCount: z.number().int().nonnegative(),
	estimatedCostUsd: z.number().nonnegative(),
	actualCostUsd: z.number().nonnegative(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type RoutingTrace = z.infer<typeof RoutingTraceSchema>;

export const ModelRoutingDecisionSchema = z.object({
	taskId: z.string().min(1),
	model: ExecutionModelSchema,
	providerId: z.string().min(1).optional(),
	selectedModelId: z.string().min(1).optional(),
	tier: ModelTierSchema.optional(),
	reasoningEffort: ReasoningEffortSchema,
	fastMode: z.boolean(),
	serviceTier: z.enum(["standard", "priority"]),
	execution: z.enum(["local", "configured_endpoint", "development_adapter"]),
	rationale: z.string().min(1),
	confidence: z.number().min(0).max(1).optional(),
	traceId: z.string().min(1).optional(),
	fallbackModelIds: z.array(z.string().min(1)).optional(),
	reviewRequired: z.boolean().optional(),
	refusalRecovery: z.boolean().optional(),
	selectedAt: z.string().datetime(),
});
export type ModelRoutingDecision = z.infer<typeof ModelRoutingDecisionSchema>;

export const DelegatedWorkerRouteSchema = z.object({
	providerId: z.string().min(1),
	model: z.string().min(1),
	selectedModelId: z.string().min(1).optional(),
	tier: ModelTierSchema.optional(),
	role: z.enum(["orchestrator", "worker", "reviewer", "fallback"]).optional(),
	reasoningEffort: ReasoningEffortSchema,
	fastMode: z.boolean().optional(),
	local: z.boolean(),
	confidence: z.number().min(0).max(1).optional(),
	estimatedCost: z.number().nonnegative().optional(),
	fallbackModelIds: z.array(z.string().min(1)).optional(),
	traceId: z.string().min(1).optional(),
	refusalRecovery: z.boolean().optional(),
	verifiedAt: z.string().datetime(),
	verificationLatencyMs: z.number().int().nonnegative(),
	rationale: z.string().min(1),
});
export type DelegatedWorkerRoute = z.infer<typeof DelegatedWorkerRouteSchema>;

export const AutomaticRoutingSchema = z.object({
	model: z.literal("auto"),
	reasoningEffort: z.literal("auto"),
	fastMode: z.literal("auto"),
	currentDecision: ModelRoutingDecisionSchema,
});
export type AutomaticRouting = z.infer<typeof AutomaticRoutingSchema>;

export const RuntimeSessionStatusSchema = z.enum([
	"active",
	"waiting",
	"completed",
	"cancelled",
	"failed",
]);
export type RuntimeSessionStatus = z.infer<typeof RuntimeSessionStatusSchema>;

export const RuntimeCheckpointSchema = z.object({
	id: z.string().min(1),
	sequence: z.number().int().positive(),
	summary: z.string().min(1).max(20_000),
	createdAt: z.string().datetime(),
});
export type RuntimeCheckpoint = z.infer<typeof RuntimeCheckpointSchema>;

export const RuntimeSessionSchema = z.object({
	id: z.string().min(1),
	title: z.string().min(1).max(200),
	parentSessionId: z.string().min(1).optional(),
	workspaceRoot: z.string().min(1).optional(),
	allowedTools: z.array(z.string().min(1)),
	status: RuntimeSessionStatusSchema,
	checkpoints: z.array(RuntimeCheckpointSchema),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type RuntimeSession = z.infer<typeof RuntimeSessionSchema>;

export const RuntimeMessageSchema = z.object({
	id: z.string().min(1),
	sessionId: z.string().min(1),
	role: z.enum(["system", "user", "assistant", "tool"]),
	content: z.string().min(1).max(1_000_000),
	modelToolCalls: z
		.array(
			z.object({
				id: z.string().min(1),
				name: z.string().min(1),
				arguments: z.record(z.string(), z.unknown()),
			}),
		)
		.optional(),
	providerToolCallId: z.string().min(1).optional(),
	toolName: z.string().min(1).optional(),
	parentMessageId: z.string().min(1).optional(),
	toolExecutionId: z.string().min(1).optional(),
	createdAt: z.string().datetime(),
});
export type RuntimeMessage = z.infer<typeof RuntimeMessageSchema>;

export const WorkspaceMutationSchema = z.object({
	id: z.string().min(1),
	sessionId: z.string().min(1),
	toolExecutionId: z.string().min(1),
	operation: z.enum(["create", "update", "delete", "move"]),
	entryKind: z.enum(["file", "directory"]).optional(),
	path: z.string().min(1),
	destinationPath: z.string().min(1).optional(),
	beforeContent: z.string().max(1_000_000).optional(),
	afterContent: z.string().max(1_000_000).optional(),
	createdAt: z.string().datetime(),
	undoneAt: z.string().datetime().optional(),
});
export type WorkspaceMutation = z.infer<typeof WorkspaceMutationSchema>;

export const RuntimeToolDescriptorSchema = z.object({
	name: z.string().regex(/^[a-z][a-z0-9_.-]+$/),
	title: z.string().min(1),
	description: z.string().min(1),
	category: z.enum([
		"workspace",
		"execution",
		"web",
		"browser",
		"connector",
		"memory",
		"session",
		"automation",
		"media",
		"extension",
		"configuration",
	]),
	riskLevel: RiskLevelSchema,
	readOnly: z.boolean(),
	requiresWorkspace: z.boolean(),
	source: z.enum(["builtin", "skill", "plugin", "mcp", "connector"]),
	tags: z.array(z.string().min(1)),
	approvalMode: z.enum(["policy", "always"]).optional(),
});
export type RuntimeToolDescriptor = z.infer<typeof RuntimeToolDescriptorSchema>;

export const RuntimeToolExecutionSchema = z.object({
	id: z.string().min(1),
	sessionId: z.string().min(1),
	toolName: z.string().min(1),
	status: z.enum(["running", "verified", "blocked", "failed", "cancelled"]),
	riskLevel: RiskLevelSchema,
	input: z.record(z.string(), z.unknown()),
	output: z.record(z.string(), z.unknown()).optional(),
	verification: z
		.object({
			method: z.string().min(1),
			evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
			verifiedAt: z.string().datetime(),
		})
		.optional(),
	error: z.string().optional(),
	idempotencyKey: z.string().min(1).optional(),
	startedAt: z.string().datetime(),
	completedAt: z.string().datetime().optional(),
});
export type RuntimeToolExecution = z.infer<typeof RuntimeToolExecutionSchema>;

export const ApprovalRuleSchema = z.object({
	id: z.string().min(1),
	toolName: z.string().regex(/^[a-z][a-z0-9_.-]+$/),
	decision: z.enum(["allow", "deny"]),
	scope: z.enum(["session", "global"]),
	sessionId: z.string().min(1).optional(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type ApprovalRule = z.infer<typeof ApprovalRuleSchema>;

export const RuntimeEventSchema = z.object({
	id: z.string().min(1),
	type: z.enum([
		"session.created",
		"session.updated",
		"message.appended",
		"tool.started",
		"tool.progress",
		"tool.completed",
	]),
	sessionId: z.string().min(1),
	executionId: z.string().min(1).optional(),
	messageId: z.string().min(1).optional(),
	payload: z.record(z.string(), z.unknown()),
	createdAt: z.string().datetime(),
});
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

export const AgentRunSchema = z.object({
	id: z.string().min(1),
	sessionId: z.string().min(1),
	model: z.string().min(1),
	providerIds: z.array(z.string().min(1)).min(1),
	providerModels: z.record(z.string(), z.string().min(1)).optional(),
	reasoningEffort: ReasoningEffortSchema.optional(),
	serviceTier: z.enum(["standard", "priority"]).optional(),
	maximumTurns: z.number().int().positive().max(50).optional(),
	maximumContextCharacters: z
		.number()
		.int()
		.positive()
		.max(10_000_000)
		.optional(),
	maximumOutputTokens: z.number().int().positive().max(1_000_000).optional(),
	temperature: z.number().min(0).max(2).optional(),
	toolScope: z
		.array(z.string().regex(/^[a-z][a-z0-9_.-]+$/))
		.max(200)
		.optional(),
	status: z.enum([
		"running",
		"waiting_approval",
		"completed",
		"cancelled",
		"failed",
	]),
	turn: z.number().int().nonnegative(),
	fallbackModelIds: z.array(z.string().min(1)).optional(),
	refusalRecoveryCount: z.number().int().nonnegative().optional(),
	pendingToolExecutionId: z.string().min(1).optional(),
	pendingProviderToolCallId: z.string().min(1).optional(),
	pendingToolName: z.string().min(1).optional(),
	error: z.string().optional(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

export const ModelProviderSummarySchema = z.object({
	id: z.string().min(1).max(100),
	capabilities: z.object({
		streaming: z.boolean(),
		tools: z.boolean(),
		images: z.boolean(),
		audio: z.boolean(),
		documents: z.boolean(),
		video: z.boolean().optional(),
		local: z.boolean(),
	}),
});
export type ModelProviderSummary = z.infer<typeof ModelProviderSummarySchema>;
export const ProviderVerificationSchema = z.object({
	providerId: z.string().min(1),
	poolId: z.string().min(1).optional(),
	ok: z.boolean(),
	latencyMs: z.number().int().nonnegative(),
	error: z.string().optional(),
});
export type ProviderVerification = z.infer<typeof ProviderVerificationSchema>;

export const SelectedAttachmentSchema = z.object({
	path: z.string().min(1),
	name: z.string().min(1).max(255),
	mediaType: z.string().min(1).max(200),
	size: z
		.number()
		.int()
		.nonnegative()
		.max(10 * 1024 * 1024),
	source: z.enum(["workspace", "external"]).optional(),
});
export type SelectedAttachment = z.infer<typeof SelectedAttachmentSchema>;

/**
 * A local file opened as a first-class Kestrel tab. The path is retained so
 * the trusted main process can revalidate it before previewing or attaching;
 * the renderer never reads it directly from the filesystem.
 */
export const UserBrowserFileSchema = z.object({
	path: z.string().min(1).max(4_096),
	name: z.string().min(1).max(255),
	extension: z.string().max(32),
	mediaType: z.string().min(1).max(200),
	size: z.number().int().nonnegative().max(2 * 1024 * 1024 * 1024),
	modifiedAt: z.string().datetime().optional(),
	status: z.enum(["available", "missing"]),
});
export type UserBrowserFile = z.infer<typeof UserBrowserFileSchema>;

export const FilePreviewSchema = z.object({
	tabId: z.string().regex(/^tab-[a-f0-9-]{36}$/),
	kind: z.enum(["text", "image", "pdf", "audio", "video", "metadata"]),
	mediaType: z.string().min(1).max(200),
	bytes: z.number().int().nonnegative(),
	text: z.string().max(1_100_000).optional(),
	// 32 MB inline media becomes roughly 44.7 MB after base64 encoding.
	dataUrl: z.string().max(48_000_000).optional(),
	truncated: z.boolean().optional(),
	detail: z.string().max(2_000).optional(),
});
export type FilePreview = z.infer<typeof FilePreviewSchema>;

export const ExternalIntakeSchema = z.object({
	kind: z.enum(["ask", "open"]),
	text: z.string().max(20_000).optional(),
	attachments: z.array(SelectedAttachmentSchema).max(8),
});
export type ExternalIntake = z.infer<typeof ExternalIntakeSchema>;

export const ArtifactRecordSchema = z.object({
	id: z.string().min(1),
	filename: z.string().min(1),
	path: z.string().min(1),
	mediaType: z.string().min(1),
	bytes: z.number().int().nonnegative(),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	width: z.number().int().positive().optional(),
	height: z.number().int().positive().optional(),
	providerId: z.string().optional(),
	model: z.string().optional(),
	providerRequestId: z.string().optional(),
	estimatedCostUsd: z.number().nonnegative().optional(),
	artifactKind: z.enum(["media", "widget"]).optional(),
	title: z.string().min(1).max(80).optional(),
	sessionId: z.string().min(1).max(200).optional(),
	createdAt: z.string().datetime(),
});
export type ArtifactRecordContract = z.infer<typeof ArtifactRecordSchema>;
export const ChannelSummarySchema = z.object({
	id: z.string(),
	kind: z.enum(["webhook", "slack", "discord", "teams", "gmail"]),
	inbound: z.boolean(),
	editableProgress: z.boolean(),
	typingSignals: z.boolean(),
	reactions: z.boolean(),
});
export type ChannelSummary = z.infer<typeof ChannelSummarySchema>;

const SkinColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i);
export const SkinColorsSchema = z
	.object({
		canvas: SkinColorSchema,
		sidebar: SkinColorSchema,
		sidebarHover: SkinColorSchema,
		surface: SkinColorSchema,
		surfaceStrong: SkinColorSchema,
		panel: SkinColorSchema,
		ink: SkinColorSchema,
		muted: SkinColorSchema,
		faint: SkinColorSchema,
		line: SkinColorSchema,
		lineStrong: SkinColorSchema,
		solid: SkinColorSchema,
		solidHover: SkinColorSchema,
		solidText: SkinColorSchema,
		signal: SkinColorSchema,
		signalDeep: SkinColorSchema,
		statusSoft: SkinColorSchema,
		statusInk: SkinColorSchema,
		healthy: SkinColorSchema,
		warning: SkinColorSchema,
		warningSoft: SkinColorSchema,
		warningInk: SkinColorSchema,
		danger: SkinColorSchema,
		dangerSoft: SkinColorSchema,
		dangerInk: SkinColorSchema,
		brand: SkinColorSchema,
	})
	.strict();
export const TerminalSkinSchema = z
	.object({
		accent: z.number().int().min(0).max(255),
		muted: z.number().int().min(0).max(255),
		success: z.number().int().min(0).max(255),
		warning: z.number().int().min(0).max(255),
		error: z.number().int().min(0).max(255),
		promptSymbol: z.string().min(1).max(8),
		responseLabel: z.string().min(1).max(40),
		toolPrefix: z.string().min(1).max(8),
		thinkingVerbs: z.array(z.string().min(1).max(40)).min(1).max(12),
	})
	.strict();
export const SkinDefinitionSchema = z
	.object({
		id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
		name: z.string().min(1).max(60),
		description: z.string().min(1).max(240),
		mode: z.enum(["dark", "light"]),
		colors: SkinColorsSchema,
		terminal: TerminalSkinSchema,
		builtin: z.boolean(),
	})
	.strict();
export type SkinDefinition = z.infer<typeof SkinDefinitionSchema>;
export const SkinImportSchema = z
	.object({
		version: z.literal(1),
		id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
		name: z.string().min(1).max(60),
		description: z.string().min(1).max(240),
		base: z
			.string()
			.regex(/^[a-z][a-z0-9-]{0,39}$/)
			.default("workstrand"),
		mode: z.enum(["dark", "light"]).optional(),
		colors: SkinColorsSchema.partial().optional(),
		terminal: TerminalSkinSchema.partial().optional(),
	})
	.strict();
export type SkinImport = z.infer<typeof SkinImportSchema>;
export const SkinStatusSchema = z.object({
	selectedId: z.string().min(1),
	skins: z.array(SkinDefinitionSchema).max(24),
});
export type SkinStatus = z.infer<typeof SkinStatusSchema>;

export const PetActivityStateSchema = z.enum([
	"idle",
	"wave",
	"run",
	"failed",
	"review",
	"jump",
	"waiting",
]);
export type PetActivityState = z.infer<typeof PetActivityStateSchema>;
export const PetGalleryEntrySchema = z
	.object({
		slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
		displayName: z.string().min(1).max(120),
		kind: z.string().min(1).max(60),
		submittedBy: z.string().min(1).max(120),
		spritesheetUrl: z.string().url().max(2_000),
		petJsonUrl: z.string().url().max(2_000),
	})
	.strict();
export type PetGalleryEntry = z.infer<typeof PetGalleryEntrySchema>;
export const InstalledPetSchema = z
	.object({
		slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
		displayName: z.string().min(1).max(120),
		description: z.string().max(500),
		kind: z.string().min(1).max(60),
		submittedBy: z.string().min(1).max(120),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
		bytes: z.number().int().positive().max(8_000_000),
		width: z.literal(1536),
		height: z.union([z.literal(1664), z.literal(1872)]),
		installedAt: z.string().datetime(),
	})
	.strict();
export type InstalledPet = z.infer<typeof InstalledPetSchema>;
export const PetConfigurationSchema = z
	.object({
		enabled: z.boolean(),
		selectedSlug: z
			.string()
			.regex(/^[a-z0-9][a-z0-9-]{0,79}$/)
			.optional(),
		scale: z.number().min(0.1).max(3),
		renderMode: z.enum(["auto", "kitty", "iterm", "sixel", "unicode", "off"]),
		poppedOut: z.boolean().default(false),
	})
	.strict();
export type PetConfiguration = z.infer<typeof PetConfigurationSchema>;
export const PetStatusSchema = z.object({
	configuration: PetConfigurationSchema,
	installed: z.array(InstalledPetSchema).max(100),
});
export type PetStatus = z.infer<typeof PetStatusSchema>;
export const PetHatchCapabilitySchema = z
	.object({
		available: z.boolean(),
		providerId: z.string().min(1).max(100).optional(),
		model: z.string().min(1).max(200).optional(),
		reason: z.string().min(1).max(1_000).optional(),
	})
	.strict();
export type PetHatchCapability = z.infer<typeof PetHatchCapabilitySchema>;
export const PetHatchDraftSchema = z
	.object({
		id: z.string().regex(/^draft-[a-f0-9-]{36}$/),
		concept: z.string().min(1).max(500),
		style: z.string().min(1).max(80),
		mediaType: z.literal("image/png"),
		dataBase64: z.string().min(1).max(12_000_000),
		providerId: z.string().min(1).max(100),
		model: z.string().min(1).max(200),
		createdAt: z.string().datetime(),
	})
	.strict();
export type PetHatchDraft = z.infer<typeof PetHatchDraftSchema>;
export const PetHatchResultSchema = z
	.object({
		slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
		displayName: z.string().min(1).max(120),
		states: z.array(z.string().min(1).max(40)).min(6).max(9),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
		providerId: z.string().min(1).max(100),
		model: z.string().min(1).max(200),
	})
	.strict();
export type PetHatchResult = z.infer<typeof PetHatchResultSchema>;

export const AgentStreamEventSchema = z.object({
	streamId: z.string().min(1).max(100),
	sessionId: z.string().min(1),
	delta: z.string(),
});
export type AgentStreamEvent = z.infer<typeof AgentStreamEventSchema>;

export const ModelCallAuditSchema = z.object({
	id: z.string().min(1),
	runId: z.string().min(1),
	sessionId: z.string().min(1),
	providerId: z.string().min(1),
	model: z.string().min(1),
	status: z.enum(["completed", "failed"]),
	inputTokens: z.number().int().nonnegative(),
	outputTokens: z.number().int().nonnegative(),
	cachedInputTokens: z.number().int().nonnegative().optional(),
	reasoningTokens: z.number().int().nonnegative().optional(),
	estimatedCostUsd: z.number().nonnegative().default(0),
	durationMs: z.number().int().nonnegative(),
	error: z.string().optional(),
	startedAt: z.string().datetime(),
	completedAt: z.string().datetime(),
});
export type ModelCallAudit = z.infer<typeof ModelCallAuditSchema>;

export const SessionUsageSummarySchema = z.object({
	sessionId: z.string().min(1),
	runs: z.number().int().nonnegative(),
	modelCalls: z.number().int().nonnegative(),
	inputTokens: z.number().int().nonnegative(),
	outputTokens: z.number().int().nonnegative(),
	cachedInputTokens: z.number().int().nonnegative(),
	reasoningTokens: z.number().int().nonnegative(),
	estimatedCostUsd: z.number().nonnegative(),
	compactedMessages: z.number().int().nonnegative(),
});
export type SessionUsageSummary = z.infer<typeof SessionUsageSummarySchema>;

export const ModelTokenRateSchema = z.object({
	inputPerMillionUsd: z.number().nonnegative().max(100_000),
	outputPerMillionUsd: z.number().nonnegative().max(100_000),
	cachedInputPerMillionUsd: z.number().nonnegative().max(100_000),
	reasoningPerMillionUsd: z.number().nonnegative().max(100_000),
});
export const UsagePolicySchema = z.object({
	dailyBudgetUsd: z.number().positive().max(1_000_000),
	monthlyBudgetUsd: z.number().positive().max(10_000_000),
	perCallReservationUsd: z.number().positive().max(100_000),
	maximumConcurrentCalls: z.number().int().min(1).max(64),
	defaultRate: ModelTokenRateSchema,
	rates: z.record(z.string().min(1), ModelTokenRateSchema),
});
export type UsagePolicy = z.infer<typeof UsagePolicySchema>;

export const WebCitationSchema = z.object({
	title: z.string(),
	url: z.string().url(),
	retrievedAt: z.string().datetime(),
});
export const WebSearchResultSchema = z.object({
	title: z.string(),
	url: z.string().url(),
	snippet: z.string(),
	citation: WebCitationSchema.optional(),
});
export const WebFetchResultSchema = z.object({
	url: z.string().url(),
	status: z.number().int(),
	contentType: z.string(),
	content: z.string(),
	trust: z.literal("untrusted_external"),
	citation: WebCitationSchema,
	cached: z.boolean(),
});
export type WebCitation = z.infer<typeof WebCitationSchema>;
export type WebSearchResultContract = z.infer<typeof WebSearchResultSchema>;
export type WebFetchResult = z.infer<typeof WebFetchResultSchema>;

export const GoalTaskSchema = z.object({
	id: z.string(),
	title: z.string(),
	status: z.enum(["pending", "in_progress", "completed"]),
	assigneeSessionId: z.string().optional(),
	dependsOn: z.array(z.string()).optional(),
	dueAt: z.string().datetime().optional(),
});
export const GoalRecordSchema = z.object({
	id: z.string(),
	sessionId: z.string(),
	title: z.string(),
	objective: z.string(),
	status: z.enum(["active", "completed", "cancelled"]),
	tasks: z.array(GoalTaskSchema),
	sourceOpportunityId: z.string().optional(),
	deadline: z.string().datetime().optional(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type GoalRecordContract = z.infer<typeof GoalRecordSchema>;
export const TeamMessageSchema = z.object({
	id: z.string(),
	fromSessionId: z.string(),
	toSessionId: z.string(),
	text: z.string(),
	createdAt: z.string().datetime(),
});
export const TeamRecordSchema = z.object({
	id: z.string(),
	parentSessionId: z.string(),
	title: z.string(),
	memberSessionIds: z.array(z.string()),
	sharedPlan: z.array(z.string()),
	messages: z.array(TeamMessageSchema),
	usage: z
		.object({
			runs: z.number().int().nonnegative(),
			inputTokens: z.number().int().nonnegative(),
			outputTokens: z.number().int().nonnegative(),
		})
		.optional(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type TeamRecordContract = z.infer<typeof TeamRecordSchema>;
export const ScheduledJobSummarySchema = z.object({
	id: z.string(),
	title: z.string(),
	sessionId: z.string(),
	model: z.string(),
	providerIds: z.array(z.string()),
	schedule: z.union([
		z.object({ kind: z.literal("once"), nextRunAt: z.string().datetime() }),
		z.object({
			kind: z.literal("interval"),
			nextRunAt: z.string().datetime(),
			intervalMs: z.number().int().positive(),
		}),
		z.object({
			kind: z.literal("cron"),
			nextRunAt: z.string().datetime(),
			expression: z.string().min(1).max(200),
		}),
	]),
	status: z.enum([
		"pending",
		"running",
		"waiting_approval",
		"completed",
		"failed",
		"cancelled",
	]),
	lastRunId: z.string().optional(),
	error: z.string().optional(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type ScheduledJobSummary = z.infer<typeof ScheduledJobSummarySchema>;
export const BackgroundJobsEventSchema = z.object({
	checkedAt: z.string().datetime(),
	jobs: z.array(ScheduledJobSummarySchema),
});
export type BackgroundJobsEvent = z.infer<typeof BackgroundJobsEventSchema>;

export const WorkspaceSnapshotSchema = z.object({
	productName: z.string(),
	agentState: AgentStateSchema,
	autonomyLevel: z.enum(["observer", "assistant", "operator", "high"]),
	opportunity: TaskOpportunitySchema,
	approvals: z.array(ApprovalSchema),
	memories: z.array(MemoryRecordSchema),
	activity: z.array(ActivitySchema),
	connections: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			status: z.enum([
				"development_adapter",
				"connected",
				"disconnected",
				"error",
			]),
			detail: z.string(),
		}),
	),
	resourceUsage: z.object({
		modelCostToday: z.number(),
		modelBudgetDaily: z.number(),
		activeWorkers: z.number(),
		maximumWorkers: z.number(),
	}),
	modelRouting: AutomaticRoutingSchema,
	personality: z.object({
		selectedId: z.string().min(1),
		available: z.array(
			z.object({
				id: z.string().min(1),
				name: z.string().min(1),
				description: z.string().min(1),
				preferredModel: z.string().optional(),
				providerIds: z.array(z.string()).optional(),
				toolNames: z.array(z.string()).optional(),
				memoryScope: z.enum(["shared", "isolated"]),
				builtin: z.boolean(),
			}),
		),
	}),
	configuration: z.object({
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
		ui: z.object({
			density: z.enum(["comfortable", "compact"]),
			showToolActivity: z.boolean(),
			showConfigurationDiffs: z.boolean(),
			announceVerification: z.boolean(),
		}),
	}),
	updatedAt: z.string().datetime(),
});
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;

export const DashboardRouteSchema = z.enum([
	"readiness",
	"approvals",
	"memory",
	"research",
	"artifacts",
	"work",
	"activity",
	"connections",
	"settings",
]);
export type DashboardRoute = z.infer<typeof DashboardRouteSchema>;

export const DashboardMetricSourceSchema = z.enum([
	"agent-state",
	"pending-approvals",
	"model-cost-today",
	"model-budget-daily",
	"active-workers",
	"maximum-workers",
	"runtime-sessions",
	"plugin-version",
	"plugin-capabilities",
]);
export type DashboardMetricSource = z.infer<typeof DashboardMetricSourceSchema>;

export const DashboardContributionSchema = z
	.object({
		version: z.literal(1),
		title: z.string().min(1).max(80),
		description: z.string().min(1).max(320),
		navigationLabel: z.string().min(1).max(24).optional(),
		panels: z
			.array(
				z
					.object({
						id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
						title: z.string().min(1).max(100),
						description: z.string().max(500).optional(),
						tone: z.enum(["neutral", "accent", "warning"]).default("neutral"),
						metrics: z
							.array(
								z
									.object({
										label: z.string().min(1).max(60),
										source: DashboardMetricSourceSchema,
									})
									.strict(),
							)
							.max(8)
							.default([]),
						items: z.array(z.string().min(1).max(240)).max(12).default([]),
						actions: z
							.array(
								z
									.object({
										label: z.string().min(1).max(60),
										page: DashboardRouteSchema,
									})
									.strict(),
							)
							.max(6)
							.default([]),
					})
					.strict(),
			)
			.min(1)
			.max(12),
	})
	.strict();
export type DashboardContribution = z.infer<typeof DashboardContributionSchema>;

export const PluginSummarySchema = z.object({
	name: z.string().min(1),
	version: z.string().min(1),
	description: z.string().min(1),
	author: z
		.object({ name: z.string().min(1), url: z.string().optional() })
		.optional(),
	license: z.string().optional(),
	homepage: z.string().optional(),
	repository: z.string().optional(),
	dependencies: z.record(z.string(), z.string()).optional(),
	interface: z
		.object({
			displayName: z.string().optional(),
			shortDescription: z.string().optional(),
			category: z.string().optional(),
			capabilities: z.array(z.string()),
			defaultPrompt: z.array(z.string()),
		})
		.optional(),
	enabled: z.boolean(),
	hasSkills: z.boolean(),
	hasMcpServers: z.boolean(),
	hasDashboard: z.boolean(),
	dashboard: DashboardContributionSchema.optional(),
	mcpConnected: z.boolean(),
	managed: z.boolean(),
});
export type PluginSummary = z.infer<typeof PluginSummarySchema>;

export const TrustedPluginPublisherSchema = z.object({
	keyId: z.string().min(1).max(128),
	fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export type TrustedPluginPublisher = z.infer<
	typeof TrustedPluginPublisherSchema
>;

export const PluginMutationSchema = z.object({
	action: z.enum(["install", "update", "remove", "restore"]),
	name: z.string().min(1).max(100),
	version: z.string().min(1).max(100),
	replacedVersion: z.string().min(1).max(100).optional(),
	recoveryPath: z.string().min(1).optional(),
});
export type PluginMutation = z.infer<typeof PluginMutationSchema>;

export const MigrationProductSchema = z.enum([
	"openclaw",
	"hermes",
	"codex",
	"claude-code",
]);
export const MigrationItemSchema = z.object({
	product: MigrationProductSchema,
	category: z.enum(["instructions", "settings", "memory", "skill", "agent"]),
	sourceRoot: z.string().min(1),
	sourcePath: z.string(),
	destinationPath: z.string().min(1),
	bytes: z.number().int().nonnegative(),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	status: z.enum(["ready", "conflict"]),
});
export const MigrationTranslationSchema = z.object({
	product: MigrationProductSchema,
	sourcePath: z.string(),
	destinationPath: z.string().min(1),
	values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const MigrationPlanSchema = z.object({
	createdAt: z.string().datetime(),
	targetRoot: z.string().min(1),
	items: z.array(MigrationItemSchema).max(2_000),
	warnings: z.array(z.string()),
	translations: z.array(MigrationTranslationSchema).max(2_000),
});
export type MigrationPlanContract = z.infer<typeof MigrationPlanSchema>;
export const MigrationResultSchema = z.object({
	imported: z.array(z.string()),
	skipped: z.array(z.string()),
});
export type MigrationResultContract = z.infer<typeof MigrationResultSchema>;
export const OrganizationMemberSchema = z.object({
	externalId: z.string().min(1),
	email: z.string().email(),
	displayName: z.string().min(1),
	role: z.enum(["member", "admin"]),
	active: z.boolean(),
	updatedAt: z.string().datetime(),
});
export type OrganizationMemberContract = z.infer<
	typeof OrganizationMemberSchema
>;
export const EnterpriseAnalyticsSchema = z.object({
	sessions: z.number().int().nonnegative(),
	messages: z.number().int().nonnegative(),
	runs: z.number().int().nonnegative(),
	toolExecutions: z.number().int().nonnegative(),
	modelCalls: z.number().int().nonnegative(),
	failedModelCalls: z.number().int().nonnegative(),
	inputTokens: z.number().int().nonnegative(),
	outputTokens: z.number().int().nonnegative(),
	estimatedCostUsd: z.number().nonnegative(),
});
export type EnterpriseAnalytics = z.infer<typeof EnterpriseAnalyticsSchema>;
export const RetentionResultSchema = z.object({
	cutoff: z.string().datetime(),
	deleted: z.record(z.string(), z.number().int().nonnegative()),
});
export const ObservabilityConfigurationSchema = z.object({
	enabled: z.boolean(),
	otlp: z.object({
		enabled: z.boolean(),
		endpoint: z.string().max(2_000).default(""),
		serviceName: z
			.string()
			.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
			.default("workstrand-agent"),
		headerName: z
			.string()
			.regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/)
			.default("authorization"),
		metrics: z.boolean(),
		traces: z.boolean(),
		sampleRate: z.number().min(0).max(1),
		exportIntervalMs: z.number().int().min(1_000).max(300_000),
	}),
	prometheus: z.object({ enabled: z.boolean() }),
});
export type ObservabilityConfiguration = z.infer<
	typeof ObservabilityConfigurationSchema
>;
export const ObservabilityStatusSchema = z.object({
	running: z.boolean(),
	otlpConfigured: z.boolean(),
	prometheusAvailable: z.boolean(),
	hasHeaderValue: z.boolean(),
	detail: z.string().min(1),
	lastExportAt: z.string().datetime().optional(),
	lastExportState: z.enum(["success", "error"]).optional(),
});
export type ObservabilityStatus = z.infer<typeof ObservabilityStatusSchema>;

export const DreamingConfigurationSchema = z.object({
	enabled: z.boolean(),
	scheduleHour: z.number().int().min(0).max(23),
	minimumScore: z.number().min(0).max(1),
	minimumRecallCount: z.number().int().min(2).max(20),
	minimumUniqueDays: z.number().int().min(1).max(30),
});
export type DreamingConfiguration = z.infer<typeof DreamingConfigurationSchema>;

export const DreamingCandidateSchema = z.object({
	id: z.string().min(1),
	memoryId: z.string().min(1),
	memoryType: MemoryTypeSchema,
	sourceCount: z.number().int().positive(),
	uniqueDays: z.number().int().positive(),
	score: z.number().min(0).max(1),
	reasons: z.array(z.string().min(1).max(300)).min(1).max(8),
	status: z.enum(["review", "promoted", "rejected"]),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type DreamingCandidate = z.infer<typeof DreamingCandidateSchema>;

export const DreamDiaryEntrySchema = z.object({
	id: z.string().min(1),
	startedAt: z.string().datetime(),
	completedAt: z.string().datetime(),
	lightCandidates: z.number().int().nonnegative(),
	remThemes: z.number().int().nonnegative(),
	deepCandidates: z.number().int().nonnegative(),
	summary: z.string().min(1).max(1_000),
	preview: z.boolean(),
});
export type DreamDiaryEntry = z.infer<typeof DreamDiaryEntrySchema>;

export const DreamingStatusSchema = z.object({
	configuration: DreamingConfigurationSchema,
	phase: z.enum(["idle", "light", "rem", "deep", "error"]),
	candidates: z.array(DreamingCandidateSchema).max(500),
	diary: z.array(DreamDiaryEntrySchema).max(100),
	lastRunAt: z.string().datetime().optional(),
	nextRunAt: z.string().datetime().optional(),
	detail: z.string().min(1).max(1_000),
});
export type DreamingStatus = z.infer<typeof DreamingStatusSchema>;

export const HonchoMemoryConfigurationSchema = z
	.object({
		enabled: z.boolean(),
		baseUrl: z.string().url().max(2_000),
		workspaceId: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
		userPeerId: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
		agentPeerId: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
		recallMode: z.enum(["hybrid", "context", "tools"]),
		sessionStrategy: z.enum(["per-session", "per-project", "global"]),
		observationMode: z.enum(["directional", "unified"]),
		saveMessages: z.boolean(),
		contextTokens: z.number().int().min(256).max(16_000),
		contextCadence: z.number().int().min(1).max(20),
		dialecticCadence: z.number().int().min(1).max(20),
		dialecticDepth: z.number().int().min(1).max(3),
		dialecticReasoningLevel: z.enum([
			"minimal",
			"low",
			"medium",
			"high",
			"max",
		]),
		reasoningHeuristic: z.boolean(),
		dialecticMaxChars: z.number().int().min(100).max(4_000),
	})
	.strict();
export type HonchoMemoryConfiguration = z.infer<
	typeof HonchoMemoryConfigurationSchema
>;

export const HonchoMemoryStatusSchema = z.object({
	configuration: HonchoMemoryConfigurationSchema,
	state: z.enum(["disabled", "needs_credential", "ready", "verified", "error"]),
	credentialConfigured: z.boolean(),
	detail: z.string().min(1).max(1_000),
	lastVerifiedAt: z.string().datetime().optional(),
	lastSyncedAt: z.string().datetime().optional(),
	syncedMessages: z.number().int().nonnegative(),
	remoteDataDisclosure: z.string().min(1).max(1_000),
});
export type HonchoMemoryStatus = z.infer<typeof HonchoMemoryStatusSchema>;

export const PresenceEntrySchema = z.object({
	instanceId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
	mode: z.enum(["ui", "webchat", "node", "test"]),
	status: z.enum(["active", "idle"]),
	version: z.string().min(1).max(100).optional(),
	reason: z.string().min(1).max(200).optional(),
	firstSeenAt: z.string().datetime(),
	lastSeenAt: z.string().datetime(),
});
export type PresenceEntry = z.infer<typeof PresenceEntrySchema>;

export const EventApplicationAnswerSchema = z.object({
	id: z.string().min(1).max(200),
	label: z.string().min(1).max(300),
	value: z.string().max(20_000),
	required: z.boolean(),
	reviewed: z.boolean(),
	sensitivity: z.enum(["public", "personal", "sensitive"]),
	source: z.enum(["profile", "event", "agent"]),
});
export const EventEligibilityItemSchema = z.object({
	id: z.string().min(1).max(200),
	label: z.string().min(1).max(500),
	met: z.boolean().nullable(),
	evidence: z.string().max(2_000).optional(),
});
export const EventApplicationSchema = z.object({
	id: z.string().regex(/^event-application-[a-f0-9-]{36}$/),
	title: z.string().min(1).max(200),
	organizer: z.string().min(1).max(200),
	url: z.string().url().max(8_000),
	deadline: z.string().datetime().optional(),
	status: z.enum([
		"draft",
		"preparing",
		"ready",
		"approved",
		"submitted",
		"needs_attention",
	]),
	eligibility: z.array(EventEligibilityItemSchema).max(100),
	answers: z.array(EventApplicationAnswerSchema).max(100),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
	approvedAt: z.string().datetime().optional(),
	submittedAt: z.string().datetime().optional(),
	receipt: z.string().max(4_000).optional(),
});
export type EventApplicationContract = z.infer<typeof EventApplicationSchema>;

export const ChannelInteractionConfigurationSchema = z.object({
	progressMode: z.enum(["off", "partial", "block", "progress"]),
	typingMode: z.enum(["never", "instant", "thinking", "message"]),
	typingIntervalSeconds: z.number().int().min(2).max(30),
	reactionLevel: z
		.enum(["off", "ack", "minimal", "extensive"])
		.default("minimal"),
});
export type ChannelInteractionConfiguration = z.infer<
	typeof ChannelInteractionConfigurationSchema
>;

export const CoreRequestSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("snapshot") }),
	z.object({
		type: z.literal("communication-code-search"),
		domain: z.string().min(1).max(253),
		after: z.string().datetime(),
		maxResults: z.number().int().min(1).max(10).default(5),
	}),
	z.object({ type: z.literal("approve"), approvalId: z.string() }),
	z.object({ type: z.literal("reject"), approvalId: z.string() }),
	z.object({
		type: z.literal("edit-approval"),
		approvalId: z.string(),
		emailBody: z.string().min(1).max(8000),
	}),
	z.object({
		type: z.literal("troubleshoot"),
		message: z.string().min(1).max(4000),
	}),
	z.object({
		type: z.literal("new-tab-greeting"),
		...NewTabGreetingContextSchema.shape,
	}),
	z.object({ type: z.literal("set-paused"), paused: z.boolean() }),
	z.object({
		type: z.literal("set-personality"),
		personalityId: z.string().min(1).max(64),
	}),
	z.object({
		type: z.literal("create-personality"),
		personality: z.object({
			id: z.string().min(1).max(64),
			name: z.string().min(1).max(100),
			description: z.string().min(1).max(500),
			instructions: z.string().min(1).max(20_000),
			preferredModel: z.string().min(1).max(200).optional(),
			providerIds: z.array(z.string().min(1).max(100)).max(8).optional(),
			toolNames: z.array(z.string().min(1).max(200)).max(200).optional(),
			memoryScope: z.enum(["shared", "isolated"]).default("shared"),
		}),
	}),
	z.object({
		type: z.literal("remove-personality"),
		personalityId: z.string().min(1).max(64),
	}),
	z.object({ type: z.literal("plugin-list") }),
	z.object({
		type: z.literal("plugin-set-enabled"),
		name: z.string().min(1).max(100),
		enabled: z.boolean(),
	}),
	z.object({
		type: z.literal("plugin-connect-mcp"),
		name: z.string().min(1).max(100),
	}),
	z.object({
		type: z.literal("plugin-disconnect-mcp"),
		name: z.string().min(1).max(100),
	}),
	z.object({ type: z.literal("runtime-list-sessions") }),
	z.object({
		type: z.literal("runtime-create-session"),
		title: z.string().min(1).max(200),
		workspaceRoot: z.string().min(1).optional(),
	}),
	z.object({
		type: z.literal("runtime-fork-session"),
		sessionId: z.string().min(1),
		title: z.string().min(1).max(200).optional(),
	}),
	z.object({
		type: z.literal("runtime-checkpoint-session"),
		sessionId: z.string().min(1),
		summary: z.string().min(1).max(20_000),
	}),
	z.object({
		type: z.literal("runtime-restore-checkpoint"),
		sessionId: z.string().min(1),
		checkpointId: z.string().min(1),
	}),
	z.object({
		type: z.literal("runtime-retry-agent"),
		sessionId: z.string().min(1),
		model: z.string().min(1).max(200),
		providerIds: z.array(z.string().min(1).max(100)).min(1),
		providerModels: z.record(z.string(), z.string().min(1).max(200)).optional(),
		streamId: z.string().min(1).max(100).optional(),
	}),
	z.object({
		type: z.literal("runtime-resume-session"),
		sessionId: z.string().min(1),
	}),
	z.object({
		type: z.literal("runtime-cancel-session"),
		sessionId: z.string().min(1),
	}),
	z.object({
		type: z.literal("runtime-append-message"),
		sessionId: z.string().min(1),
		role: z.enum(["system", "user", "assistant", "tool"]),
		content: z.string().min(1).max(1_000_000),
		parentMessageId: z.string().min(1).optional(),
		toolExecutionId: z.string().min(1).optional(),
	}),
	z.object({
		type: z.literal("runtime-list-messages"),
		sessionId: z.string().min(1),
		beforeMessageId: z.string().min(1).optional(),
		limit: z.number().int().positive().max(200).optional(),
	}),
	z.object({
		type: z.literal("runtime-list-runs"),
		sessionId: z.string().min(1),
	}),
	z.object({
		type: z.literal("runtime-list-executions"),
		sessionId: z.string().min(1).optional(),
		limit: z.number().int().positive().max(200).optional(),
	}),
	z.object({
		type: z.literal("runtime-list-pending-tool-approvals"),
	}),
	z.object({
		type: z.literal("runtime-session-usage"),
		sessionId: z.string().min(1),
	}),
	z.object({ type: z.literal("runtime-get-usage-policy") }),
	z.object({
		type: z.literal("runtime-set-usage-policy"),
		policy: UsagePolicySchema,
	}),
	z.object({
		type: z.literal("runtime-search-messages"),
		query: z.string().min(1).max(500),
		limit: z.number().int().positive().max(100).optional(),
	}),
	z.object({ type: z.literal("memory-list") }),
	z.object({
		type: z.literal("memory-remember"),
		memoryType: MemoryTypeSchema,
		content: z.string().min(1).max(100_000),
		sensitivity: SensitivitySchema.default("personal"),
		sourceId: z.string().min(1).max(500).default("desktop-user"),
		subject: z.string().min(1).max(500).optional(),
		layer: z
			.enum(["short_term", "mid_term", "long_term", "archived"])
			.optional(),
	}),
	z.object({
		type: z.literal("memory-correct"),
		id: z.string().min(1),
		content: z.string().min(1).max(100_000),
		memoryType: MemoryTypeSchema.optional(),
		sensitivity: SensitivitySchema.optional(),
		layer: z
			.enum(["short_term", "mid_term", "long_term", "archived"])
			.optional(),
	}),
	z.object({ type: z.literal("memory-forget"), id: z.string().min(1) }),
	z.object({
		type: z.literal("memory-versions"),
		id: z.string().min(1),
	}),
	z.object({ type: z.literal("memory-run-maintenance") }),
	z.object({ type: z.literal("memory-user-model-list") }),
	z.object({
		type: z.literal("memory-user-model-review"),
		id: z.string().min(1),
		decision: z.enum(["confirm", "reject"]),
	}),
	z.object({ type: z.literal("people-list") }),
	z.object({
		type: z.literal("people-upsert"),
		id: z.string().min(1).optional(),
		displayName: z.string().min(1).max(300),
		nicknames: z.array(z.string().min(1).max(200)).max(40).default([]),
		relationship: z.string().max(500).optional(),
		organization: z.string().max(500).optional(),
		role: z.string().max(500).optional(),
		timeZone: z.string().max(200).optional(),
		tone: z.string().max(500).optional(),
		formality: z
			.enum(["casual", "neutral", "professional", "formal"])
			.optional(),
		email: z.string().email().max(500).optional(),
		phone: z.string().max(200).optional(),
		sourceId: z.string().min(1).max(500).default("desktop-user"),
		sensitivity: SensitivitySchema.default("personal"),
	}),
	z.object({
		type: z.literal("people-delete"),
		id: z.string().min(1),
	}),
	z.object({
		type: z.literal("calendar-list"),
		startsAt: z.string().datetime(),
		endsAt: z.string().datetime(),
	}),
	z.object({
		type: z.literal("calendar-sync"),
		startsAt: z.string().datetime(),
		endsAt: z.string().datetime(),
	}),
	z.object({
		type: z.literal("calendar-create-local"),
		title: z.string().min(1).max(2_000),
		startsAt: z.string().datetime(),
		endsAt: z.string().datetime(),
		description: z.string().max(20_000).optional(),
		location: z.string().max(2_000).optional(),
		origin: z.enum(["explicit", "inferred", "suggested"]).default("explicit"),
		confidence: z.number().min(0).max(1).default(1),
		sourceId: z.string().min(1).max(500).default("desktop-user"),
	}),
	z.object({
		type: z.literal("calendar-delete-local"),
		id: z.string().min(1),
	}),
	z.object({
		type: z.literal("life-context-preview"),
		query: z.string().min(1).max(10_000),
		includeSensitive: z.boolean().default(false),
		includeRestricted: z.boolean().default(false),
	}),
	z.object({ type: z.literal("honcho-memory-get") }),
	z.object({
		type: z.literal("honcho-memory-configure"),
		configuration: HonchoMemoryConfigurationSchema,
	}),
	z.object({ type: z.literal("honcho-memory-verify") }),
	z.object({ type: z.literal("dreaming-get") }),
	z.object({
		type: z.literal("dreaming-set"),
		configuration: DreamingConfigurationSchema,
	}),
	z.object({
		type: z.literal("dreaming-run"),
		preview: z.boolean().default(false),
	}),
	z.object({
		type: z.literal("dreaming-review"),
		id: z.string().min(1),
		decision: z.enum(["promote", "reject"]),
	}),
	z.object({ type: z.literal("presence-list") }),
	z.object({
		type: z.literal("presence-beacon"),
		instanceId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
		mode: z.enum(["ui", "webchat", "node", "test"]),
		version: z.string().min(1).max(100).optional(),
		reason: z.string().min(1).max(200).optional(),
	}),
	z.object({ type: z.literal("event-applications-list") }),
	z.object({
		type: z.literal("event-applications-create"),
		title: z.string().min(1).max(200),
		organizer: z.string().min(1).max(200),
		url: z.string().url().max(8_000),
		deadline: z.string().datetime().optional(),
	}),
	z.object({
		type: z.literal("event-applications-update"),
		id: z.string().regex(/^event-application-[a-f0-9-]{36}$/),
		status: z
			.enum(["draft", "preparing", "ready", "approved", "needs_attention"])
			.optional(),
		eligibility: z.array(EventEligibilityItemSchema).max(100).optional(),
		answers: z.array(EventApplicationAnswerSchema).max(100).optional(),
	}),
	z.object({
		type: z.literal("event-applications-submitted"),
		id: z.string().regex(/^event-application-[a-f0-9-]{36}$/),
		receipt: z.string().min(1).max(4_000),
	}),
	z.object({
		type: z.literal("event-applications-remove"),
		id: z.string().regex(/^event-application-[a-f0-9-]{36}$/),
	}),
	z.object({ type: z.literal("skill-learning-list") }),
	z.object({
		type: z.literal("skill-learning-suggest"),
		sessionId: z.string().min(1),
	}),
	z.object({
		type: z.literal("skill-learning-propose"),
		name: z.string().min(1).max(64),
		description: z.string().min(1).max(1_024),
		instructions: z.string().min(1).max(200_000),
		sourceSessionId: z.string().min(1),
		sourceMessageIds: z.array(z.string().min(1)).min(1),
	}),
	z.object({
		type: z.literal("skill-learning-review"),
		id: z.string().min(1),
		decision: z.enum(["install", "reject"]),
	}),
	z.object({
		type: z.literal("skill-learning-feedback"),
		skillName: z.string().min(1).max(64),
		succeeded: z.boolean(),
		feedback: z.string().min(1).max(20_000),
		sourceIds: z.array(z.string().min(1)).min(1),
	}),
	z.object({
		type: z.literal("web-search-direct"),
		query: z.string().min(1).max(2_000),
		maximumResults: z.number().int().min(1).max(20).default(8),
	}),
	z.object({
		type: z.literal("web-fetch-direct"),
		url: z.string().url().max(8_000),
	}),
	z.object({ type: z.literal("orchestration-list") }),
	z.object({ type: z.literal("orchestration-model-registry") }),
	z.object({ type: z.literal("orchestration-routing-policy-get") }),
	z.object({
		type: z.literal("orchestration-routing-policy-set"),
		policy: RoutingPolicySchema,
	}),
	z.object({ type: z.literal("orchestration-routing-traces") }),
	z.object({
		type: z.literal("orchestration-routing-feedback"),
		modelId: z.string().min(1),
		capabilities: z.partialRecord(
			ModelCapabilitySchema,
			z.number().min(0).max(1),
		),
		outcome: z.enum(["accepted", "corrected", "rejected"]),
		reviewerConfidence: z.number().min(0).max(1).optional(),
	}),
	z.object({
		type: z.literal("orchestration-goal-create"),
		sessionId: z.string().min(1),
		title: z.string().min(1).max(200),
		objective: z.string().min(1).max(20_000),
		tasks: z.array(z.string().min(1).max(500)).max(200).default([]),
	}),
	z.object({
		type: z.literal("orchestration-goal-update"),
		goalId: z.string().min(1),
		status: z.enum(["active", "completed", "cancelled"]).optional(),
		taskId: z.string().optional(),
		taskStatus: z.enum(["pending", "in_progress", "completed"]).optional(),
		assigneeSessionId: z.string().min(1).nullable().optional(),
	}),
	z.object({
		type: z.literal("orchestration-opportunity-to-goal"),
		sessionId: z.string().min(1),
	}),
	z.object({
		type: z.literal("orchestration-team-create"),
		parentSessionId: z.string().min(1),
		title: z.string().min(1).max(200),
		memberSessionIds: z.array(z.string().min(1)).min(1).max(20),
		sharedPlan: z.array(z.string().max(1_000)).max(200).default([]),
	}),
	z.object({
		type: z.literal("orchestration-team-update"),
		teamId: z.string().min(1),
		memberSessionIds: z.array(z.string().min(1)).min(1).max(20).optional(),
		sharedPlan: z.array(z.string().max(1_000)).max(200).optional(),
	}),
	z.object({
		type: z.literal("orchestration-team-message"),
		teamId: z.string().min(1),
		fromSessionId: z.string().min(1),
		toSessionId: z.string().min(1),
		text: z.string().min(1).max(20_000),
	}),
	z.object({
		type: z.literal("orchestration-delegate"),
		parentSessionId: z.string().min(1),
		title: z.string().min(1).max(200),
		prompt: z.string().min(1).max(100_000),
		model: z.string().min(1).max(200),
		providerIds: z.array(z.string().min(1)).min(1),
		reasoningEffort: ReasoningEffortSchema.optional(),
		role: z.enum(["orchestrator", "worker", "reviewer", "fallback"]).optional(),
		requiredCapabilities: z
			.partialRecord(ModelCapabilitySchema, z.number().min(0).max(1))
			.optional(),
		allowedTools: z.array(z.string()).optional(),
		isolateWorktree: z.boolean().default(false),
	}),
	z.object({
		type: z.literal("orchestration-handoff"),
		childSessionId: z.string().min(1),
		summary: z.string().min(1).max(100_000),
	}),
	z.object({
		type: z.literal("orchestration-schedule"),
		sessionId: z.string().min(1),
		title: z.string().min(1).max(200),
		prompt: z.string().min(1).max(100_000),
		model: z.string().min(1).max(200),
		providerIds: z.array(z.string().min(1)).min(1),
		expression: z.string().min(1).max(500),
	}),
	z.object({
		type: z.literal("orchestration-job-cancel"),
		jobId: z.string().min(1),
	}),
	z.object({
		type: z.literal("orchestration-job-resume"),
		jobId: z.string().min(1),
	}),
	z.object({ type: z.literal("enterprise-summary") }),
	z.object({ type: z.literal("enterprise-enforce-retention") }),
	z.object({
		type: z.literal("enterprise-member-upsert"),
		member: OrganizationMemberSchema.omit({ active: true, updatedAt: true }),
	}),
	z.object({
		type: z.literal("enterprise-member-deactivate"),
		externalId: z.string().min(1),
	}),
	z.object({
		type: z.literal("enterprise-verify-identity"),
		token: z.string().min(1).max(100_000),
	}),
	z.object({ type: z.literal("observability-get") }),
	z.object({
		type: z.literal("observability-set"),
		configuration: ObservabilityConfigurationSchema,
		headerValue: z.string().min(1).max(20_000).optional(),
	}),
	z.object({ type: z.literal("observability-test") }),
	z.object({ type: z.literal("media-list-artifacts") }),
	z.object({
		type: z.literal("media-preview-artifact"),
		artifactId: z.string().min(1).max(200),
		maximumBytes: z
			.number()
			.int()
			.positive()
			.max(10_000_000)
			.default(5_000_000),
	}),
	z.object({
		type: z.literal("media-transcribe"),
		dataBase64: z.string().min(1).max(35_000_000),
		mediaType: z
			.string()
			.regex(/^audio\/[a-z0-9.+-]+$/i)
			.max(200),
	}),
	z.object({ type: z.literal("channel-list") }),
	z.object({ type: z.literal("channel-interaction-get") }),
	z.object({
		type: z.literal("channel-interaction-set"),
		configuration: ChannelInteractionConfigurationSchema,
	}),
	z.object({ type: z.literal("skin-get") }),
	z.object({
		type: z.literal("skin-select"),
		skinId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
	}),
	z.object({
		type: z.literal("skin-import"),
		source: z.string().min(1).max(65_536),
	}),
	z.object({
		type: z.literal("skin-remove"),
		skinId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
	}),
	z.object({ type: z.literal("pet-get") }),
	z.object({
		type: z.literal("pet-gallery"),
		query: z.string().max(100).default(""),
		limit: z.number().int().min(1).max(100).default(24),
	}),
	z.object({
		type: z.literal("pet-install"),
		slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
		select: z.boolean().default(true),
		force: z.boolean().default(false),
	}),
	z.object({
		type: z.literal("pet-select"),
		slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
	}),
	z.object({
		type: z.literal("pet-configure"),
		enabled: z.boolean().optional(),
		scale: z.number().min(0.1).max(3).optional(),
		renderMode: z
			.enum(["auto", "kitty", "iterm", "sixel", "unicode", "off"])
			.optional(),
		poppedOut: z.boolean().optional(),
	}),
	z.object({
		type: z.literal("pet-remove"),
		slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
	}),
	z.object({
		type: z.literal("pet-asset"),
		slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
	}),
	z.object({ type: z.literal("pet-decoder-diagnostic") }),
	z.object({ type: z.literal("pet-hatch-status") }),
	z.object({
		type: z.literal("pet-hatch-drafts"),
		concept: z.string().min(1).max(500),
		style: z.string().min(1).max(80).default("auto"),
		count: z.number().int().min(1).max(4).default(4),
	}),
	z.object({
		type: z.literal("pet-hatch-complete"),
		draftId: z.string().regex(/^draft-[a-f0-9-]{36}$/),
		slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
		displayName: z.string().min(1).max(120),
		description: z.string().max(500).default(""),
	}),
	z.object({ type: z.literal("runtime-list-providers") }),
	z.object({
		type: z.literal("runtime-verify-provider"),
		providerId: z.string().min(1).max(100),
	}),
	z.object({
		type: z.literal("runtime-run-agent"),
		sessionId: z.string().min(1),
		message: z.string().min(1).max(1_000_000),
		model: z.string().min(1).max(200),
		providerIds: z.array(z.string().min(1).max(100)).min(1),
		providerModels: z.record(z.string(), z.string().min(1).max(200)).optional(),
		maximumTurns: z.number().int().positive().max(50).optional(),
		approvalStatus: z.enum(["pending", "approved"]).optional(),
		personalityId: z.string().min(1).max(64).optional(),
		streamId: z.string().min(1).max(100).optional(),
		attachments: z.array(SelectedAttachmentSchema).max(8).optional(),
		browserContext: z.lazy(() => UserBrowserPageContextSchema).optional(),
		reasoningEffort: ReasoningEffortSchema.optional(),
	}),
	z.object({
		type: z.literal("runtime-resume-agent"),
		runId: z.string().min(1),
		approvalDecision: z.enum(["approved", "rejected"]),
		streamId: z.string().min(1).max(100).optional(),
		maximumTurns: z.number().int().positive().max(50).optional(),
	}),
	z.object({
		type: z.literal("runtime-cancel-stream"),
		streamId: z.string().min(1).max(100),
	}),
	z.object({
		type: z.literal("runtime-steer-agent"),
		streamId: z.string().min(1).max(100),
		sessionId: z.string().min(1),
		message: z.string().min(1).max(100_000),
	}),
	z.object({
		type: z.literal("runtime-discover-tools"),
		sessionId: z.string().min(1),
		query: z.string().max(500).optional(),
	}),
	z.object({
		type: z.literal("runtime-call-tool"),
		sessionId: z.string().min(1),
		toolName: z.string().min(1),
		input: z.record(z.string(), z.unknown()),
		approvalStatus: z.enum(["pending", "approved"]).optional(),
		idempotencyKey: z.string().min(1).max(500).optional(),
		externalContent: z.string().max(100_000).optional(),
	}),
	z.object({
		type: z.literal("runtime-cancel-execution"),
		executionId: z.string().min(1),
	}),
	z.object({ type: z.literal("runtime-list-approval-rules") }),
	z.object({
		type: z.literal("runtime-set-approval-rule"),
		toolName: z.string().regex(/^[a-z][a-z0-9_.-]+$/),
		decision: z.enum(["allow", "deny"]),
		scope: z.enum(["session", "global"]),
		sessionId: z.string().min(1).optional(),
	}),
	z.object({
		type: z.literal("runtime-remove-approval-rule"),
		id: z.string().min(1),
	}),
]);
export type CoreRequest = z.infer<typeof CoreRequestSchema>;

export const CoreResponseSchema = z.discriminatedUnion("ok", [
	z.object({
		ok: z.literal(true),
		snapshot: WorkspaceSnapshotSchema.optional(),
		answer: z.string().optional(),
		newTabGreeting: z.string().max(120).optional(),
		routing: ModelRoutingDecisionSchema.optional(),
		delegationRouting: DelegatedWorkerRouteSchema.optional(),
		sessions: z.array(RuntimeSessionSchema).optional(),
		session: RuntimeSessionSchema.optional(),
		tools: z.array(RuntimeToolDescriptorSchema).optional(),
		execution: RuntimeToolExecutionSchema.optional(),
		run: AgentRunSchema.optional(),
		runs: z.array(AgentRunSchema).optional(),
		messages: z.array(RuntimeMessageSchema).optional(),
		hasMoreMessages: z.boolean().optional(),
		executions: z.array(RuntimeToolExecutionSchema).optional(),
		plugins: z.array(PluginSummarySchema).optional(),
		providers: z.array(ModelProviderSummarySchema).optional(),
		modelProfiles: z.array(ModelProfileSchema).optional(),
		routingPolicy: RoutingPolicySchema.optional(),
		routingTraces: z.array(RoutingTraceSchema).optional(),
		providerVerifications: z.array(ProviderVerificationSchema).optional(),
		memories: z.array(MemoryRecordSchema).optional(),
		memoryVersions: z.array(MemoryVersionSchema).optional(),
		userModelFacts: z.array(UserModelFactSchema).optional(),
		people: z.array(PersonRecordSchema).optional(),
		calendarEvents: z.array(UnifiedCalendarEventSchema).optional(),
		calendarProviders: z.array(CalendarProviderStatusSchema).optional(),
		contextBundle: AgentContextBundleSchema.optional(),
		skillProposals: z.array(SkillLearningProposalSchema).optional(),
		skillFeedback: z.array(SkillLearningFeedbackSchema).optional(),
		usage: SessionUsageSummarySchema.optional(),
		webResults: z.array(WebSearchResultSchema).optional(),
		webPage: WebFetchResultSchema.optional(),
		cached: z.boolean().optional(),
		goals: z.array(GoalRecordSchema).optional(),
		teams: z.array(TeamRecordSchema).optional(),
		jobs: z.array(ScheduledJobSummarySchema).optional(),
		taskId: z.string().optional(),
		approvalRules: z.array(ApprovalRuleSchema).optional(),
		usagePolicy: UsagePolicySchema.optional(),
		enterprisePolicy: z
			.object({
				organizationId: z.string(),
				version: z.number().int(),
				maximumWorkers: z.number().int(),
				retentionDays: z.number().int().optional(),
				analyticsEnabled: z.boolean().optional(),
				ssoConfigured: z.boolean(),
				updatedAt: z.string().datetime(),
			})
			.optional(),
		enterpriseAnalytics: EnterpriseAnalyticsSchema.optional(),
		organizationMembers: z.array(OrganizationMemberSchema).optional(),
		retentionResult: RetentionResultSchema.optional(),
		observabilityConfiguration: ObservabilityConfigurationSchema.optional(),
		observabilityStatus: ObservabilityStatusSchema.optional(),
		dreamingStatus: DreamingStatusSchema.optional(),
		honchoMemoryStatus: HonchoMemoryStatusSchema.optional(),
		presence: z.array(PresenceEntrySchema).optional(),
		eventApplications: z.array(EventApplicationSchema).optional(),
		artifacts: z.array(ArtifactRecordSchema).optional(),
		artifactPreview: z
			.object({
				id: z.string(),
				mediaType: z.string(),
				dataBase64: z.string(),
				truncated: z.boolean(),
			})
			.optional(),
		transcription: z
			.object({
				text: z.string().min(1).max(1_000_000),
				model: z.string().min(1).max(200),
				providerRequestId: z.string().max(200).optional(),
			})
			.optional(),
		channels: z.array(ChannelSummarySchema).optional(),
		communicationMatches: z.array(CommunicationCodeMatchSchema).max(10).optional(),
		channelInteractionConfiguration:
			ChannelInteractionConfigurationSchema.optional(),
		skinStatus: SkinStatusSchema.optional(),
		petStatus: PetStatusSchema.optional(),
		petGallery: z.array(PetGalleryEntrySchema).optional(),
		petAsset: z
			.object({
				slug: z.string(),
				mediaType: z.enum(["image/webp", "image/png"]),
				dataBase64: z.string().max(12_000_000),
			})
			.optional(),
		petDecoderDiagnostic: z
			.object({
				decoder: z.literal("sharp"),
				version: z.string().min(1).max(100),
				ok: z.literal(true),
			})
			.optional(),
		petHatchCapability: PetHatchCapabilitySchema.optional(),
		petHatchDrafts: z.array(PetHatchDraftSchema).max(12).optional(),
		petHatchResult: PetHatchResultSchema.optional(),
	}),
	z.object({ ok: z.literal(false), error: z.string() }),
]);
export type CoreResponse = z.infer<typeof CoreResponseSchema>;

export const ExternalSecretProviderIdSchema = z.enum([
	"onepassword",
	"bitwarden",
	"command",
]);
export type ExternalSecretProviderId = z.infer<
	typeof ExternalSecretProviderIdSchema
>;

const ExternalCredentialIdSchema = z.enum([
	"openai",
	"openai-secondary",
	"anthropic",
	"anthropic-secondary",
	"gemini",
	"nous",
	"groq",
	"mistral",
	"openrouter",
	"cloudflare",
	"xai",
	"deepseek",
	"together",
	"fireworks",
	"nvidia",
	"huggingface",
	"perplexity",
	"github-models",
	"cohere",
	"brave-search",
	"github",
	"honcho",
	"fal",
]);
export const ExternalSecretConfigurationSchema = z.object({
	version: z.literal(1),
	onepassword: z.object({
		enabled: z.boolean(),
		binaryPath: z.string().max(2_000).optional(),
		account: z.string().max(300).default(""),
		mappings: z.partialRecord(
			ExternalCredentialIdSchema,
			z.string().min(1).max(2_000),
		),
		overrideStored: z.boolean(),
	}),
	bitwarden: z.object({
		enabled: z.boolean(),
		binaryPath: z.string().max(2_000).optional(),
		projectId: z.string().max(300).default(""),
		serverUrl: z.string().max(2_000).default(""),
		autoInstall: z.boolean(),
		overrideStored: z.boolean(),
	}),
	command: z.object({
		enabled: z.boolean(),
		executablePath: z.string().max(2_000).default(""),
		arguments: z.array(z.string().max(1_000)).max(32),
		timeoutMs: z.number().int().min(250).max(10_000),
		overrideStored: z.boolean(),
	}),
});
export type ExternalSecretConfiguration = z.infer<
	typeof ExternalSecretConfigurationSchema
>;

export const ExternalSecretProviderStatusSchema = z.object({
	id: ExternalSecretProviderIdSchema,
	label: z.string().min(1),
	state: z.enum(["disabled", "needs_setup", "ready", "verified", "error"]),
	available: z.boolean(),
	managedBinary: z.boolean(),
	detail: z.string().min(1),
	binaryPath: z.string().min(1).optional(),
	resolvedCredentialIds: z.array(ExternalCredentialIdSchema),
	lastSyncedAt: z.string().datetime().optional(),
});
export type ExternalSecretProviderStatus = z.infer<
	typeof ExternalSecretProviderStatusSchema
>;

export const UserBrowserFaviconDataUrlSchema = z
	.string()
	.max(200_000)
	.refine((value) => value.startsWith("data:image/"), {
		message: "Browser favicons must be image data URLs.",
	});
export type UserBrowserFaviconDataUrl = z.infer<
	typeof UserBrowserFaviconDataUrlSchema
>;

export const UserBrowserTabSchema = z.object({
	id: z.string().regex(/^tab-[a-f0-9-]{36}$/),
	title: z.string().min(1).max(500),
	url: z.string().max(8_192),
	file: UserBrowserFileSchema.optional(),
	faviconDataUrl: UserBrowserFaviconDataUrlSchema.optional(),
	loading: z.boolean(),
	canGoBack: z.boolean(),
	canGoForward: z.boolean(),
	discarded: z.boolean(),
	crashed: z.boolean(),
	error: z.string().min(1).max(500).optional(),
	pinned: z.boolean().default(false),
	muted: z.boolean().default(false),
	createdAt: z.string().datetime(),
	lastActiveAt: z.string().datetime(),
});
export type UserBrowserTab = z.infer<typeof UserBrowserTabSchema>;

export const UserBrowserOriginFaviconSchema = z.object({
	origin: z.string().url().max(8_192),
	faviconDataUrl: UserBrowserFaviconDataUrlSchema,
	updatedAt: z.string().datetime(),
});
export type UserBrowserOriginFavicon = z.infer<
	typeof UserBrowserOriginFaviconSchema
>;

export const UserBrowserHistoryEntrySchema = z.object({
	id: z.string().regex(/^visit-[a-f0-9-]{36}$/),
	tabId: z.string().regex(/^tab-[a-f0-9-]{36}$/),
	url: z.string().url().max(8_192),
	title: z.string().min(1).max(500),
	visitedAt: z.string().datetime(),
});
export type UserBrowserHistoryEntry = z.infer<
	typeof UserBrowserHistoryEntrySchema
>;

export const UserBrowserDownloadSchema = z.object({
	id: z.string().regex(/^download-[a-f0-9-]{36}$/),
	tabId: z
		.string()
		.regex(/^tab-[a-f0-9-]{36}$/)
		.optional(),
	filename: z.string().min(1).max(255),
	sourceUrl: z.string().url().max(8_192),
	receivedBytes: z.number().int().nonnegative(),
	totalBytes: z.number().int().nonnegative(),
	status: z.enum(["progressing", "completed", "cancelled", "failed"]),
	startedAt: z.string().datetime(),
	completedAt: z.string().datetime().optional(),
	canReveal: z.boolean(),
});
export type UserBrowserDownload = z.infer<typeof UserBrowserDownloadSchema>;

export const UserBrowserBookmarkSchema = z.object({
	id: z.string().regex(/^bookmark-[a-f0-9-]{36}$/),
	url: z.string().url().max(8_192),
	title: z.string().min(1).max(500),
	createdAt: z.string().datetime(),
});
export type UserBrowserBookmark = z.infer<typeof UserBrowserBookmarkSchema>;

export const UserBrowserSitePermissionSchema = z.object({
	origin: z.string().min(1).max(8_192),
	permission: z.string().min(1).max(80),
	decision: z.enum(["allow", "deny"]),
	updatedAt: z.string().datetime(),
});
export type UserBrowserSitePermission = z.infer<
	typeof UserBrowserSitePermissionSchema
>;

export const NEW_TAB_WIDGET_IDS = [
	"frequent-tabs",
	"bookmarks",
	"downloads",
	"recent-work",
	"quick-actions",
	"open-tabs",
	"pinned-tabs",
	"recent-pages",
] as const;

export const DEFAULT_NEW_TAB_WIDGET_IDS = [
	"frequent-tabs",
	"recent-work",
	"quick-actions",
] as const;

export const NewTabWidgetIdSchema = z.enum(NEW_TAB_WIDGET_IDS);
export type NewTabWidgetId = z.infer<typeof NewTabWidgetIdSchema>;
export const NewTabWidgetLayoutClassSchema = z.enum([
	"compact",
	"standard",
	"wide",
	"ultrawide",
]);
export type NewTabWidgetLayoutClass = z.infer<
	typeof NewTabWidgetLayoutClassSchema
>;
export const NewTabWidgetSizeSchema = z.enum(["small", "medium", "large"]);
export type NewTabWidgetSize = z.infer<typeof NewTabWidgetSizeSchema>;
export const NewTabWidgetLayoutItemSchema = z.object({
	id: NewTabWidgetIdSchema,
	size: NewTabWidgetSizeSchema,
});
export type NewTabWidgetLayoutItem = z.infer<
	typeof NewTabWidgetLayoutItemSchema
>;
export const NewTabWidgetLayoutSchema = z.object({
	items: z.array(NewTabWidgetLayoutItemSchema).max(12),
	customized: z.boolean().default(false),
});
export type NewTabWidgetLayout = z.infer<typeof NewTabWidgetLayoutSchema>;

const DEFAULT_NEW_TAB_WIDGET_SETTINGS = {
	version: 1 as const,
	enabled: [...DEFAULT_NEW_TAB_WIDGET_IDS],
	layouts: {},
};

/**
 * New Tab widget preferences live beside the browser settings so they use the
 * same atomic, profile-owned persistence path as tabs, bookmarks, and history.
 * A bad or future widget payload falls back to the safe default without
 * discarding the rest of the browser profile.
 */
export const NewTabWidgetSettingsSchema = z
	.object({
		version: z.literal(1).default(1),
		enabled: z
			.array(NewTabWidgetIdSchema)
			.max(NEW_TAB_WIDGET_IDS.length)
			.default([...DEFAULT_NEW_TAB_WIDGET_IDS]),
		layouts: z
			.object({
				compact: NewTabWidgetLayoutSchema.optional(),
				standard: NewTabWidgetLayoutSchema.optional(),
				wide: NewTabWidgetLayoutSchema.optional(),
				ultrawide: NewTabWidgetLayoutSchema.optional(),
			})
			.default({}),
	})
	.default(DEFAULT_NEW_TAB_WIDGET_SETTINGS)
	.catch(DEFAULT_NEW_TAB_WIDGET_SETTINGS);
export type NewTabWidgetSettings = z.infer<typeof NewTabWidgetSettingsSchema>;

export const UserBrowserFindMatchSchema = z.object({
	tabId: z.string().regex(/^tab-[a-f0-9-]{36}$/),
	activeMatchOrdinal: z.number().int().nonnegative(),
	matches: z.number().int().nonnegative(),
	finalUpdate: z.boolean(),
});
export type UserBrowserFindMatch = z.infer<typeof UserBrowserFindMatchSchema>;

export const UserBrowserSettingsSchema = z.object({
	searchEngine: z
		.enum([
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
		])
		.default("google"),
	customSearchUrl: z.string().max(8_192).optional(),
	customSearchName: z.string().max(100).optional(),
	tabLayout: z.enum(["horizontal", "vertical"]).default("horizontal"),
	newTabBackground: z
		.enum(["graphite", "meadow", "dawn", "mountains", "paper", "custom"])
		.default("graphite"),
	newTabBackgroundCustomDataUrl: z
		.string()
		.max(7_000_000)
		.regex(
			/^data:image\/(?:avif|gif|jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/,
		)
		.optional(),
	newTabGreetingActivity: NewTabGreetingActivitySchema,
	newTabWidgets: NewTabWidgetSettingsSchema,
	restoreSession: z.boolean().default(true),
	historyRetentionDays: z
		.union([
			z.literal(0),
			z.literal(7),
			z.literal(30),
			z.literal(90),
			z.literal(365),
		])
		.default(90),
	sleepingTabsEnabled: z.boolean().default(true),
	sleepingTabTimeoutMinutes: z
		.union([
			z.literal(5),
			z.literal(15),
			z.literal(30),
			z.literal(60),
			z.literal(120),
			z.literal(240),
			z.literal(480),
			z.literal(1440),
		])
		.default(30),
	sleepingTabExcludedDomains: z.array(z.string().max(200)).default([]),
	memorySaverMode: z.boolean().default(true),
	showBookmarksBar: z.boolean().default(true),
});
export type UserBrowserSettings = z.infer<typeof UserBrowserSettingsSchema>;

export const InstalledExtensionSchema = z.object({
	id: z.string().min(1).max(100),
	name: z.string().min(1).max(200),
	version: z.string().min(1).max(50),
	description: z.string().max(2000).optional(),
	enabled: z.boolean(),
	iconUrl: z.string().optional(),
	homepageUrl: z.string().optional(),
	source: z.enum(["chrome_web_store", "unpacked", "file", "other"]),
	path: z.string().min(1),
	installedAt: z.string().datetime(),
});
export type InstalledExtension = z.infer<typeof InstalledExtensionSchema>;

export const UserBrowserStateSchema = z.object({
	tabs: z.array(UserBrowserTabSchema).max(32),
	activeTabId: z
		.string()
		.regex(/^tab-[a-f0-9-]{36}$/)
		.nullable(),
	history: z.array(UserBrowserHistoryEntrySchema).max(5_000),
	originFavicons: z
		.array(UserBrowserOriginFaviconSchema)
		.max(200)
		.default([]),
	downloads: z.array(UserBrowserDownloadSchema).max(500),
	bookmarks: z.array(UserBrowserBookmarkSchema).max(2_000).default([]),
	sitePermissions: z
		.array(UserBrowserSitePermissionSchema)
		.max(500)
		.default([]),
	settings: UserBrowserSettingsSchema,
});
export type UserBrowserState = z.infer<typeof UserBrowserStateSchema>;

export const UserBrowserPageContextSchema = z.object({
	tabId: z.string().regex(/^tab-[a-f0-9-]{36}$/),
	url: z.string().url().max(8_192),
	title: z.string().min(1).max(500),
	description: z.string().max(2_000).optional(),
	selectedText: z.string().max(20_000),
	visibleText: z.string().max(40_000),
	headings: z.array(z.string().min(1).max(500)).max(60),
	links: z
		.array(
			z.object({
				text: z.string().max(500),
				url: z.string().url().max(8_192),
			}),
		)
		.max(100),
	forms: z
		.array(
			z.object({
				label: z.string().max(500),
				type: z.string().max(100),
				name: z.string().max(500),
			}),
		)
		.max(60),
	viewport: z.object({
		width: z.number().int().positive().max(10_000),
		height: z.number().int().positive().max(10_000),
		scrollX: z.number().finite(),
		scrollY: z.number().finite(),
	}),
	capturedAt: z.string().datetime(),
	trust: z.literal("untrusted_browser"),
});
export type UserBrowserPageContext = z.infer<
	typeof UserBrowserPageContextSchema
>;

export const BrowserActivityEventSchema = z.strictObject({
	id: z.string().regex(/^browser-activity-[a-f0-9-]{36}$/),
	ownerSessionId: z.string().min(1).max(200),
	surface: z.enum(["autonomous", "visible"]),
	toolName: z.enum(["browser.act", "browser.visible-act"]),
	toolExecutionId: z.string().min(1).max(200).optional(),
	target: z.discriminatedUnion("kind", [
		z.strictObject({
			kind: z.literal("session"),
			browserSessionId: z.string().min(1).max(200),
		}),
		z.strictObject({
			kind: z.literal("tab"),
			tabId: z.string().regex(/^tab-[a-f0-9-]{36}$/),
		}),
	]),
	intent: z.strictObject({
		type: z.enum(["click", "type", "key", "scroll"]),
		target: z.string().min(1).max(2_000).optional(),
		key: z.string().min(1).max(40).optional(),
		dx: z.number().finite().optional(),
		dy: z.number().finite().optional(),
		textChars: z.number().int().nonnegative().max(20_000).optional(),
	}),
	approval: z.strictObject({
		required: z.boolean(),
		result: z.enum(["not_required", "approved", "denied", "pending"]),
		approvalId: z.string().min(1).max(200).optional(),
	}),
	observation: z
		.strictObject({
			before: z.strictObject({
				url: z.string().max(2_048),
				title: z.string().max(500),
			}),
			after: z.strictObject({
				url: z.string().max(2_048),
				title: z.string().max(500),
			}),
			added: z.number().int().nonnegative(),
			removed: z.number().int().nonnegative(),
			changed: z.number().int().nonnegative(),
			truncated: z.boolean(),
			trust: z.literal("untrusted_browser"),
		})
		.optional(),
	outcome: z.enum(["performed", "blocked", "failed", "cancelled"]),
	error: z.string().max(500).optional(),
	createdAt: z.string().datetime(),
	completedAt: z.string().datetime(),
	trust: z.literal("untrusted_browser"),
});
export type BrowserActivityEvent = z.infer<typeof BrowserActivityEventSchema>;

export const UserBrowserEventSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("state"),
		state: UserBrowserStateSchema,
	}),
	z.object({
		type: z.literal("find-in-page"),
		match: UserBrowserFindMatchSchema,
	}),
]);
export type UserBrowserEvent = z.infer<typeof UserBrowserEventSchema>;
export const UserBrowserCommandSchema = z.enum([
	"focus-address",
	"new-agent",
	"open-commands",
	"open-history",
	"open-downloads",
	"open-bookmarks",
	"open-settings",
	"show-shortcuts",
	"toggle-sidebar",
	"reopen-closed-tab",
	"find-in-page",
	"print-page",
]);
export type UserBrowserCommand = z.infer<typeof UserBrowserCommandSchema>;

export const KestrelDeepLinkSchema = z
	.string()
	.min(1)
	.max(8_192)
	.refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
		message: "Deep link contains control characters.",
	})
	.refine((value) => {
		try {
			const url = new URL(value);
			return url.protocol === "kestrel:" && !url.username && !url.password;
		} catch {
			return false;
		}
	}, "Deep link must use the Kestrel protocol.");
export type KestrelDeepLink = z.infer<typeof KestrelDeepLinkSchema>;

export const RendererRequestSchema = z.union([
	CoreRequestSchema,
	z.object({ type: z.literal("communication-sources") }),
	z.object({
		type: z.literal("communication-code-notify"),
		tabId: z.string().regex(/^tab-[a-f0-9-]{36}$/),
	}),
	z.object({
		type: z.literal("communication-code-scan"),
		tabId: z.string().regex(/^tab-[a-f0-9-]{36}$/),
	}),
	z.object({
		type: z.literal("communication-code-use"),
		scanId: z.string().regex(/^scan-[a-f0-9-]{36}$/),
		candidateId: z.string().regex(/^candidate-[a-f0-9-]{36}$/),
	}),
	z.object({ type: z.literal("communication-messages-open-settings") }),
	z.object({ type: z.literal("browser-get-state") }),
	z.object({
		type: z.literal("browser-open-file-tabs"),
		paths: z.array(z.string().min(1).max(4_096)).min(1).max(8),
		active: z.boolean().default(true),
	}),
	z.object({
		type: z.literal("browser-file-preview"),
		tabId: z.string().regex(/^tab-[a-f0-9-]{36}$/),
	}),
	z.object({
		type: z.literal("browser-open-file-default"),
		tabId: z.string().regex(/^tab-[a-f0-9-]{36}$/),
	}),
	z.object({
		type: z.enum(["window-minimize", "window-toggle-zoom", "window-close"]),
	}),
	z.object({
		type: z.literal("browser-create-tab"),
		input: z.string().max(8_192).optional(),
		active: z.boolean().default(true),
	}),
	z.object({ type: z.literal("browser-reopen-closed-tab") }),
	z.object({
		type: z.literal("browser-close-tab"),
		tabId: z.string().regex(/^tab-[a-f0-9-]{36}$/),
	}),
	z.object({
		type: z.literal("browser-select-tab"),
		tabId: z.string().regex(/^tab-[a-f0-9-]{36}$/),
	}),
	z.object({
		type: z.literal("browser-navigate"),
		tabId: z.string().regex(/^tab-[a-f0-9-]{36}$/),
		input: z.string().min(1).max(8_192),
	}),
	z.object({
		type: z.enum([
			"browser-back",
			"browser-forward",
			"browser-reload",
			"browser-stop",
			"browser-get-context",
			"browser-zoom-in",
			"browser-zoom-out",
			"browser-zoom-reset",
		]),
		tabId: z.string().regex(/^tab-[a-f0-9-]{36}$/),
		ignoreCache: z.boolean().optional(),
	}),
	z.object({
		type: z.literal("browser-set-content-bounds"),
		bounds: z.object({
			x: z.number().int().min(0).max(20_000),
			y: z.number().int().min(0).max(20_000),
			width: z.number().int().min(0).max(20_000),
			height: z.number().int().min(0).max(20_000),
		}),
		visible: z.boolean(),
	}),
	z.object({
		type: z.literal("browser-toggle-calculator"),
		bounds: z
			.object({
				x: z.number().int().min(0).max(20_000),
				y: z.number().int().min(0).max(20_000),
				width: z.number().int().min(0).max(20_000),
				height: z.number().int().min(0).max(20_000),
			})
			.optional(),
	}),
	z.object({ type: z.literal("browser-close-calculator") }),
	z.object({
		type: z.literal("browser-update-settings"),
		settings: UserBrowserSettingsSchema,
	}),
	z.object({ type: z.literal("browser-clear-history") }),
	z.object({
		type: z.literal("browser-clear-data"),
		history: z.boolean().default(false),
		cookies: z.boolean().default(false),
		cache: z.boolean().default(false),
	}),
	z.object({
		type: z.literal("browser-reveal-download"),
		downloadId: z.string().regex(/^download-[a-f0-9-]{36}$/),
	}),
	z.object({
		type: z.literal("browser-open-download"),
		downloadId: z.string().regex(/^download-[a-f0-9-]{36}$/),
	}),
	z.object({
		type: z.literal("browser-cancel-download"),
		downloadId: z.string().regex(/^download-[a-f0-9-]{36}$/),
	}),
	z.object({
		type: z.literal("browser-toggle-bookmark"),
		url: z.string().max(8_192).optional(),
		title: z.string().max(500).optional(),
	}),
	z.object({
		type: z.literal("browser-remove-bookmark"),
		bookmarkId: z.string().regex(/^bookmark-[a-f0-9-]{36}$/),
	}),
	z.object({
		type: z.literal("browser-pin-tab"),
		tabId: z.string().regex(/^tab-[a-f0-9-]{36}$/),
		pinned: z.boolean(),
	}),
	z.object({
		type: z.literal("browser-mute-tab"),
		tabId: z.string().regex(/^tab-[a-f0-9-]{36}$/),
		muted: z.boolean(),
	}),
	z.object({
		type: z.literal("browser-duplicate-tab"),
		tabId: z.string().regex(/^tab-[a-f0-9-]{36}$/),
	}),
	z.object({
		type: z.literal("browser-close-other-tabs"),
		tabId: z.string().regex(/^tab-[a-f0-9-]{36}$/),
	}),
	z.object({
		type: z.literal("browser-move-tab"),
		tabId: z.string().regex(/^tab-[a-f0-9-]{36}$/),
		toIndex: z.number().int().min(0).max(31),
	}),
	z.object({
		type: z.literal("browser-detach-tab"),
		tabId: z.string().regex(/^tab-[a-f0-9-]{36}$/),
	}),
	z.object({
		type: z.literal("browser-find-in-page"),
		tabId: z.string().regex(/^tab-[a-f0-9-]{36}$/),
		query: z.string().max(2_000),
		findNext: z.boolean().optional(),
		forward: z.boolean().optional(),
	}),
	z.object({
		type: z.literal("browser-stop-find-in-page"),
		tabId: z.string().regex(/^tab-[a-f0-9-]{36}$/),
	}),
	z.object({
		type: z.literal("browser-print"),
		tabId: z.string().regex(/^tab-[a-f0-9-]{36}$/),
	}),
	z.object({
		type: z.literal("browser-open-devtools"),
		tabId: z.string().regex(/^tab-[a-f0-9-]{36}$/),
	}),
	z.object({
		type: z.literal("browser-save-screenshot"),
		tabId: z.string().regex(/^tab-[a-f0-9-]{36}$/),
	}),
	z.object({
		type: z.literal("browser-set-site-permission"),
		origin: z.string().min(1).max(8_192),
		permission: z.string().min(1).max(80),
		decision: z.enum(["allow", "deny"]),
	}),
	z.object({
		type: z.literal("list-workspace-files"),
		workspaceRoot: z.string().min(1),
		query: z.string().max(200).optional(),
	}),
	z.object({ type: z.literal("browser-list-extensions") }),
	z.object({
		type: z.literal("browser-install-extension-url"),
		urlOrId: z.string().min(1).max(8_192),
	}),
	z.object({ type: z.literal("browser-install-extension-file") }),
	z.object({
		type: z.literal("browser-toggle-extension"),
		extensionId: z.string().min(1).max(100),
		enabled: z.boolean(),
	}),
	z.object({
		type: z.literal("browser-uninstall-extension"),
		extensionId: z.string().min(1).max(100),
	}),
	z.object({
		type: z.literal("browser-sleep-tab"),
		tabId: z.string().regex(/^tab-[a-f0-9-]{36}$/),
	}),
	z.object({ type: z.literal("browser-sleep-inactive-tabs") }),
	z.object({ type: z.literal("get-system-state") }),
	z.object({ type: z.literal("get-default-browser-status") }),
	z.object({ type: z.literal("set-default-browser") }),
	z.object({ type: z.literal("set-launch-at-login"), enabled: z.boolean() }),
	z.object({ type: z.literal("get-workspace-grants") }),
	z.object({ type: z.literal("select-workspace-folder") }),
	z.object({
		type: z.literal("remove-workspace-folder"),
		path: z.string().min(1),
	}),
	z.object({
		type: z.literal("select-context-files"),
		workspaceRoot: z.string().min(1),
	}),
	z.object({ type: z.literal("request-microphone-access") }),
	z.object({ type: z.literal("local-model-status") }),
	z.object({
		type: z.literal("local-model-pull"),
		model: z
			.string()
			.regex(/^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9][a-z0-9._-]*)?$/i)
			.max(200),
	}),
	z.object({
		type: z.literal("local-runtime-bootstrap"),
		model: z
			.string()
			.regex(/^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9][a-z0-9._-]*)?$/i)
			.max(200),
		consent: z.literal(true),
	}),
	z.object({ type: z.literal("local-runtime-cancel") }),
	z.object({ type: z.literal("system-readiness") }),
	z.object({ type: z.literal("create-local-backup") }),
	z.object({ type: z.literal("reveal-local-backup"), path: z.string().min(1) }),
	z.object({ type: z.literal("subscription-cli-status") }),
	z.object({
		type: z.literal("subscription-cli-set"),
		id: z.enum(["codex", "claude", "opencode"]),
		enabled: z.boolean(),
	}),
	z.object({ type: z.literal("oauth-chatgpt-connect") }),
	z.object({ type: z.literal("oauth-chatgpt-cancel") }),
	z.object({ type: z.literal("oauth-google-status") }),
	z.object({
		type: z.literal("oauth-google-connect"),
		clientId: z.string().min(30).max(300),
	}),
	z.object({ type: z.literal("oauth-google-cancel") }),
	z.object({ type: z.literal("oauth-google-disconnect") }),
	z.object({ type: z.literal("credential-list") }),
	z.object({
		type: z.literal("credential-set"),
		credentialId: z.enum([
			"openai",
			"openai-secondary",
			"anthropic",
			"anthropic-secondary",
			"gemini",
			"nous",
			"groq",
			"mistral",
			"openrouter",
			"cloudflare",
			"xai",
			"deepseek",
			"together",
			"fireworks",
			"nvidia",
			"huggingface",
			"perplexity",
			"github-models",
			"cohere",
			"brave-search",
			"github",
			"honcho",
			"fal",
		]),
		value: z.string().min(8).max(20_000),
	}),
	z.object({
		type: z.literal("credential-remove"),
		credentialId: z.enum([
			"openai",
			"openai-secondary",
			"anthropic",
			"anthropic-secondary",
			"gemini",
			"nous",
			"groq",
			"mistral",
			"openrouter",
			"cloudflare",
			"xai",
			"deepseek",
			"together",
			"fireworks",
			"nvidia",
			"huggingface",
			"perplexity",
			"github-models",
			"cohere",
			"brave-search",
			"github",
			"honcho",
			"fal",
		]),
	}),
	z.object({ type: z.literal("external-secret-list") }),
	z.object({
		type: z.literal("external-secret-save"),
		configuration: ExternalSecretConfigurationSchema,
		onePasswordToken: z.string().min(8).max(20_000).optional(),
		bitwardenToken: z.string().min(8).max(20_000).optional(),
	}),
	z.object({
		type: z.literal("external-secret-sync"),
		providerId: ExternalSecretProviderIdSchema,
	}),
	z.object({ type: z.literal("external-secret-install-bitwarden") }),
	z.object({
		type: z.literal("external-secret-remove"),
		providerId: ExternalSecretProviderIdSchema,
	}),
	z.object({ type: z.literal("plugin-get-publishers") }),
	z.object({ type: z.literal("plugin-import-publisher") }),
	z.object({
		type: z.literal("plugin-remove-publisher"),
		keyId: z.string().min(1).max(128),
	}),
	z.object({ type: z.literal("plugin-install-bundle") }),
	z.object({ type: z.literal("plugin-update-bundle") }),
	z.object({
		type: z.literal("plugin-remove-installed"),
		name: z.string().min(1).max(100),
	}),
	z.object({
		type: z.literal("plugin-restore-removed"),
		recoveryPath: z.string().min(1),
	}),
	z.object({ type: z.literal("skin-import-file") }),
	z.object({ type: z.literal("pet-overlay-open") }),
	z.object({ type: z.literal("pet-overlay-close") }),
	z.object({ type: z.literal("pet-overlay-toggle-main") }),
	z.object({
		type: z.literal("migration-select-plan"),
		product: MigrationProductSchema,
	}),
	z.object({
		type: z.literal("migration-apply-plan"),
		plan: MigrationPlanSchema,
		confirmation: z.literal("IMPORT"),
		overwrite: z.boolean().default(false),
	}),
	z.object({ type: z.literal("reset-local-data"), confirmation: z.string() }),
]);
export type RendererRequest = z.infer<typeof RendererRequestSchema>;

export const WorkspaceGrantSchema = z.object({
	path: z.string().min(1),
	name: z.string().min(1),
	available: z.boolean().optional(),
});
export type WorkspaceGrant = z.infer<typeof WorkspaceGrantSchema>;

export const BrokeredCredentialSummarySchema = z.object({
	id: z.enum([
		"openai",
		"openai-secondary",
		"anthropic",
		"anthropic-secondary",
		"gemini",
		"nous",
		"groq",
		"mistral",
		"openrouter",
		"cloudflare",
		"xai",
		"deepseek",
		"together",
		"fireworks",
		"nvidia",
		"huggingface",
		"perplexity",
		"github-models",
		"cohere",
		"brave-search",
		"github",
		"honcho",
		"fal",
	]),
	label: z.string().min(1),
	configured: z.boolean(),
});
export type BrokeredCredentialSummary = z.infer<
	typeof BrokeredCredentialSummarySchema
>;

export const SetupSystemProfileSchema = z.object({
	platform: z.string().min(1),
	architecture: z.string().min(1),
	memoryBytes: z.number().int().positive(),
	logicalCpus: z.number().int().positive(),
});
export type SetupSystemProfile = z.infer<typeof SetupSystemProfileSchema>;

export const LocalModelSummarySchema = z.object({
	name: z.string().min(1).max(200),
	size: z.number().int().nonnegative(),
	modifiedAt: z.string().optional(),
});
export type LocalModelSummary = z.infer<typeof LocalModelSummarySchema>;

export const LocalRuntimeProgressSchema = z.object({
	stage: z.enum([
		"detecting",
		"downloading-runtime",
		"verifying-runtime",
		"installing-runtime",
		"starting-runtime",
		"downloading-model",
		"verifying-model",
		"ready",
		"cancelled",
		"error",
	]),
	message: z.string().min(1).max(2_000),
	updatedAt: z.string().datetime(),
	model: z.string().min(1).max(200).optional(),
	downloadedBytes: z.number().int().nonnegative().optional(),
	totalBytes: z.number().int().positive().optional(),
	percent: z.number().min(0).max(100).optional(),
});
export type LocalRuntimeProgress = z.infer<typeof LocalRuntimeProgressSchema>;

export const LocalRuntimeStatusSchema = z.object({
	automaticSupported: z.boolean(),
	managedRuntime: z.boolean(),
	ollamaAvailable: z.boolean(),
	source: z.enum(["none", "managed", "external"]),
	runtimeVersion: z.string().min(1).max(100).optional(),
	runtimeDownloadBytes: z.number().int().positive(),
	localModels: z.array(LocalModelSummarySchema),
	verifiedModel: z.string().min(1).max(200).optional(),
	verifiedAt: z.string().datetime().optional(),
});
export type LocalRuntimeStatus = z.infer<typeof LocalRuntimeStatusSchema>;

export const SystemReadinessCheckSchema = z.object({
	id: z.string().min(1).max(100),
	label: z.string().min(1).max(200),
	status: z.enum(["pass", "warning", "fail"]),
	detail: z.string().min(1).max(2_000),
});
export type SystemReadinessCheck = z.infer<typeof SystemReadinessCheckSchema>;

export const SystemReadinessSchema = z.object({
	checkedAt: z.string().datetime(),
	readyForLiveWork: z.boolean(),
	checks: z.array(SystemReadinessCheckSchema),
});
export type SystemReadiness = z.infer<typeof SystemReadinessSchema>;

export const LocalBackupResultSchema = z.object({
	path: z.string().min(1),
	createdAt: z.string().datetime(),
	files: z.number().int().nonnegative(),
	bytes: z.number().int().nonnegative(),
	verified: z.boolean(),
});
export type LocalBackupResult = z.infer<typeof LocalBackupResultSchema>;

export const SubscriptionCliStatusSchema = z.object({
	id: z.enum(["codex", "claude", "opencode"]),
	label: z.string().min(1),
	detected: z.boolean(),
	enabled: z.boolean(),
	path: z.string().min(1).optional(),
	detail: z.string().min(1),
	authenticated: z.boolean().optional(),
	accountType: z.enum(["chatgpt", "apiKey"]).optional(),
	email: z.string().email().optional(),
	planType: z.string().min(1).max(100).optional(),
});
export type SubscriptionCliStatus = z.infer<typeof SubscriptionCliStatusSchema>;

export const GoogleWorkspaceOAuthStatusSchema = z.object({
	connected: z.boolean(),
	email: z.string().email().optional(),
	scopes: z.array(z.string().min(1).max(500)),
	connectedAt: z.string().datetime().optional(),
	clientIdSuffix: z.string().min(1).max(100).optional(),
});
export type GoogleWorkspaceOAuthStatus = z.infer<
	typeof GoogleWorkspaceOAuthStatusSchema
>;

export type RendererResponse =
	| CoreResponse
	| { ok: true; browserState: UserBrowserState }
	| {
			ok: true;
			browserState: UserBrowserState;
			selectedAttachments: SelectedAttachment[];
		}
	| { ok: true; filePreview: FilePreview }
	| { ok: true; extensions: InstalledExtension[] }
	| { ok: true; extension: InstalledExtension }
	| { ok: true; screenshotPath?: string; cancelled?: boolean }
	| { ok: true; browserContext: UserBrowserPageContext }
	| {
			ok: true;
			isDefault: boolean;
			canSetAsDefault: boolean;
			success?: boolean;
	  }
	| {
			ok: true;
			launchAtLogin: boolean;
			launchStatus: string;
			isDefaultBrowser?: boolean;
			userName?: string;
	  }
	| {
			ok: true;
			workspaceGrants: WorkspaceGrant[];
			cancelled?: boolean;
			selectedWorkspacePath?: string;
			snapshot?: WorkspaceSnapshot;
	  }
	| { ok: true; selectedAttachments: SelectedAttachment[]; cancelled?: boolean }
	| { ok: true; workspaceFiles: SelectedAttachment[] }
	| { ok: true; microphoneAccess: boolean }
	| { ok: true; credentials: BrokeredCredentialSummary[] }
	| {
			ok: true;
			systemProfile: SetupSystemProfile;
			ollamaAvailable: boolean;
			localModels: LocalModelSummary[];
			localRuntime: LocalRuntimeStatus;
			localModelError?: string;
	  }
	| {
			ok: true;
			downloadedModel: LocalModelSummary;
			localModels: LocalModelSummary[];
	  }
	| { ok: true; localRuntime: LocalRuntimeStatus }
	| { ok: true; systemReadiness: SystemReadiness }
	| { ok: true; localBackup: LocalBackupResult; cancelled?: boolean }
	| { ok: true; subscriptionClis: SubscriptionCliStatus[] }
	| { ok: true; googleWorkspaceOAuth: GoogleWorkspaceOAuthStatus }
	| { ok: true; communicationSources: z.infer<typeof CommunicationSourceStatusSchema>[] }
	| { ok: true; communicationScan: z.infer<typeof CommunicationCodeScanSchema> }
	| { ok: true; communicationCodeInserted: true }
	| {
			ok: true;
			externalSecretSources: ExternalSecretProviderStatus[];
			externalSecretConfiguration: ExternalSecretConfiguration;
	  }
	| {
			ok: true;
			pluginPublishers: TrustedPluginPublisher[];
			cancelled?: boolean;
	  }
	| { ok: true; pluginMutation: PluginMutation; plugins: PluginSummary[] }
	| { ok: true; migrationPlan: MigrationPlanContract; cancelled?: boolean }
	| { ok: true; migrationResult: MigrationResultContract }
	| { ok: true };

export interface RendererBridge {
	request(request: RendererRequest): Promise<RendererResponse>;
	getPathForFile(file: unknown): string;
	onBrowserEvent(callback: (event: UserBrowserEvent) => void): () => void;
	onBrowserCommand(callback: (command: UserBrowserCommand) => void): () => void;
	onDeepLink(callback: (deepLink: KestrelDeepLink) => void): () => void;
	onExternalIntake(callback: (intake: ExternalIntake) => void): () => void;
	onFileDrag(callback: (event: { active: boolean }) => void): () => void;
	onSnapshot(callback: (snapshot: WorkspaceSnapshot) => void): () => void;
	onPetStatus(callback: (status: PetStatus) => void): () => void;
	onPetActivity(callback: (activity: PetActivityState) => void): () => void;
	onRuntimeEvent(callback: (event: RuntimeEvent) => void): () => void;
	onAgentStream(callback: (event: AgentStreamEvent) => void): () => void;
	onLocalRuntimeProgress(
		callback: (progress: LocalRuntimeProgress) => void,
	): () => void;
}
