import { z } from "zod";

/**
 * Contracts for the local memory substrate.  These types intentionally keep
 * captured payloads opaque to SQLite callers: the database stores the
 * normalized fields needed for bounded queries and encrypts the rest.
 */

export const MemoryHorizonSchema = z.enum([
	"short_term",
	"mid_term",
	"long_term",
	"archived",
]);
export type MemoryHorizon = z.infer<typeof MemoryHorizonSchema>;

export const TimelineEventTypeSchema = z.enum([
	"conversation",
	"browser_tab",
	"web_page",
	"search",
	"file",
	"agent_execution",
	"subagent_execution",
	"command",
	"task",
	"error",
	"approval",
	"calendar",
	"email",
	"communication",
	"note",
	"project_activity",
	"context_switch",
	"system",
]);
export type TimelineEventType = z.infer<typeof TimelineEventTypeSchema>;

export const TimelineActorSchema = z.enum([
	"user",
	"assistant",
	"agent",
	"subagent",
	"system",
]);
export type TimelineActor = z.infer<typeof TimelineActorSchema>;

export const TimelineRetentionPolicySchema = z.enum([
	"session",
	"days",
	"durable",
	"indefinite",
]);
export type TimelineRetentionPolicy = z.infer<
	typeof TimelineRetentionPolicySchema
>;

export const TimelineEmbeddingStatusSchema = z.enum([
	"not_requested",
	"queued",
	"ready",
	"unavailable",
	"stale",
	"failed",
]);
export type TimelineEmbeddingStatus = z.infer<
	typeof TimelineEmbeddingStatusSchema
>;

export const TimelineEventSchema = z.object({
	id: z.string().min(1).max(200),
	startedAt: z.string().datetime(),
	endedAt: z.string().datetime().optional(),
	eventType: TimelineEventTypeSchema,
	source: z.string().min(1).max(200),
	sourceId: z.string().min(1).max(2_000).optional(),
	/** Stable source conversation/session identifier, retained when sessionization rewrites sessionId. */
	sourceSessionId: z.string().min(1).max(200).optional(),
	sessionId: z.string().min(1).max(200).optional(),
	actor: TimelineActorSchema,
	agentId: z.string().min(1).max(200).optional(),
	subagentId: z.string().min(1).max(200).optional(),
	projectIds: z.array(z.string().min(1).max(200)).max(100),
	personIds: z.array(z.string().min(1).max(200)).max(100),
	entityIds: z.array(z.string().min(1).max(200)).max(100),
	taskId: z.string().min(1).max(200).optional(),
	applicationContext: z.string().max(500).optional(),
	browserTabId: z.string().max(500).optional(),
	url: z.string().max(8_000).optional(),
	filePath: z.string().max(4_096).optional(),
	textSummary: z.string().min(1).max(20_000),
	structuredData: z.record(z.string(), z.unknown()),
	importance: z.number().min(0).max(1),
	sensitivity: z.enum(["public", "personal", "sensitive", "restricted"]),
	retentionPolicy: TimelineRetentionPolicySchema,
	retentionDays: z.number().int().positive().max(36_500).optional(),
	embeddingStatus: TimelineEmbeddingStatusSchema,
	status: z.enum(["active", "deleted"]),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

export const TimelineSessionStatusSchema = z.enum([
	"active",
	"closed",
	"deleted",
]);
export type TimelineSessionStatus = z.infer<typeof TimelineSessionStatusSchema>;

export const TimelineSessionSchema = z.object({
	id: z.string().min(1).max(200),
	startedAt: z.string().datetime(),
	endedAt: z.string().datetime().optional(),
	title: z.string().min(1).max(500),
	summary: z.string().min(1).max(20_000),
	eventIds: z.array(z.string().min(1)).max(2_000),
	activityBlockIds: z.array(z.string().min(1)).max(500),
	projectIds: z.array(z.string().min(1).max(200)).max(100),
	personIds: z.array(z.string().min(1).max(200)).max(100),
	entityIds: z.array(z.string().min(1).max(200)).max(100),
	sourceSessionIds: z.array(z.string().min(1).max(200)).max(100),
	importance: z.number().min(0).max(1),
	confidence: z.number().min(0).max(1),
	status: TimelineSessionStatusSchema,
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type TimelineSession = z.infer<typeof TimelineSessionSchema>;

export const ActivityBlockSchema = z.object({
	id: z.string().min(1).max(200),
	sessionId: z.string().min(1).max(200),
	startedAt: z.string().datetime(),
	endedAt: z.string().datetime().optional(),
	title: z.string().min(1).max(500),
	summary: z.string().min(1).max(20_000),
	eventIds: z.array(z.string().min(1)).max(500),
	projectIds: z.array(z.string().min(1).max(200)).max(100),
	personIds: z.array(z.string().min(1).max(200)).max(100),
	entityIds: z.array(z.string().min(1).max(200)).max(100),
	importance: z.number().min(0).max(1),
	confidence: z.number().min(0).max(1),
	status: z.enum(["active", "deleted"]),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type ActivityBlock = z.infer<typeof ActivityBlockSchema>;

export const DailySummarySchema = z.object({
	id: z.string().min(1).max(200),
	day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	title: z.string().min(1).max(500),
	summary: z.string().min(1).max(30_000),
	activityBlockIds: z.array(z.string().min(1)).max(2_000),
	eventIds: z.array(z.string().min(1)).max(2_000),
	projectIds: z.array(z.string().min(1).max(200)).max(100),
	personIds: z.array(z.string().min(1).max(200)).max(100),
	importance: z.number().min(0).max(1),
	confidence: z.number().min(0).max(1),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type DailySummary = z.infer<typeof DailySummarySchema>;

export const EntityKindSchema = z.enum([
	"person",
	"project",
	"application",
	"repository",
	"topic",
	"organization",
	"event",
	"file",
	"device",
	"trip",
	"assignment",
	"product",
	"task",
	"unknown",
]);
export type EntityKind = z.infer<typeof EntityKindSchema>;

export const EntityStatusSchema = z.enum([
	"active",
	"ambiguous",
	"merged",
	"deleted",
]);
export type EntityStatus = z.infer<typeof EntityStatusSchema>;

export const EntityRecordSchema = z.object({
	id: z.string().min(1).max(200),
	kind: EntityKindSchema,
	canonicalName: z.string().min(1).max(500),
	aliases: z.array(z.string().min(1).max(500)).max(100),
	description: z.string().max(20_000).optional(),
	structuredData: z.record(z.string(), z.unknown()),
	sourceIds: z.array(z.string().min(1).max(2_000)).min(1).max(500),
	confidence: z.number().min(0).max(1),
	sensitivity: z.enum(["public", "personal", "sensitive", "restricted"]),
	status: EntityStatusSchema,
	firstSeenAt: z.string().datetime(),
	lastSeenAt: z.string().datetime(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type EntityRecord = z.infer<typeof EntityRecordSchema>;

export const EntityRelationSchema = z.enum([
	"related_to",
	"supports",
	"supersedes",
	"contradicts",
	"confirms",
	"derived_from",
	"updates",
	"duplicate_of",
	"mentions",
	"assigned_to",
	"participates_in",
]);
export type EntityRelation = z.infer<typeof EntityRelationSchema>;

export const EntityEdgeSchema = z.object({
	id: z.string().min(1).max(200),
	fromEntityId: z.string().min(1).max(200),
	toEntityId: z.string().min(1).max(200),
	relation: EntityRelationSchema,
	weight: z.number().min(0).max(1),
	sourceIds: z.array(z.string().min(1).max(2_000)).min(1).max(500),
	status: z.enum(["active", "deleted"]),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type EntityEdge = z.infer<typeof EntityEdgeSchema>;

export const AgentIdentityKindSchema = z.enum(["main", "subagent"]);
export type AgentIdentityKind = z.infer<typeof AgentIdentityKindSchema>;

export const AgentIdentitySchema = z.object({
	id: z.string().min(1).max(200),
	kind: AgentIdentityKindSchema,
	parentAgentId: z.string().min(1).max(200).optional(),
	sessionId: z.string().min(1).max(200).optional(),
	name: z.string().min(1).max(300),
	purpose: z.string().max(2_000),
	specialization: z.string().max(2_000),
	memoryScope: z.enum(["private", "project_shared"]),
	status: z.enum(["active", "archived", "deleted"]),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;

export const AgentMemoryKindSchema = z.enum([
	"fact",
	"procedure",
	"lesson",
	"outcome",
	"unresolved",
	"preference",
]);
export type AgentMemoryKind = z.infer<typeof AgentMemoryKindSchema>;

export const AgentMemoryRecordSchema = z.object({
	id: z.string().min(1).max(200),
	agentId: z.string().min(1).max(200),
	kind: AgentMemoryKindSchema,
	horizon: MemoryHorizonSchema,
	content: z.string().min(1).max(100_000),
	sourceIds: z.array(z.string().min(1).max(2_000)).min(1).max(500),
	taskIds: z.array(z.string().min(1).max(200)).max(100),
	projectIds: z.array(z.string().min(1).max(200)).max(100),
	personIds: z.array(z.string().min(1).max(200)).max(100).default([]),
	entityIds: z.array(z.string().min(1).max(200)).max(100).default([]),
	confidence: z.number().min(0).max(1),
	importance: z.number().min(0).max(1),
	sensitivity: z.enum(["public", "personal", "sensitive", "restricted"]),
	status: z.enum(["active", "superseded", "expired", "deleted"]),
	validUntil: z.string().datetime().optional(),
	lastAccessedAt: z.string().datetime().optional(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type AgentMemoryRecord = z.infer<typeof AgentMemoryRecordSchema>;

export const TaskEvidenceSchema = z.object({
	type: z.string().min(1).max(100),
	id: z.string().min(1).max(2_000),
	label: z.string().max(500).optional(),
	detail: z.string().max(5_000).optional(),
});
export type TaskEvidence = z.infer<typeof TaskEvidenceSchema>;

export const WorkingTaskSchema = z.object({
	id: z.string().min(1).max(200),
	sessionId: z.string().min(1).max(200).optional(),
	parentTaskId: z.string().min(1).max(200).optional(),
	/** Other task records that must finish before this task can run. */
	dependencyTaskIds: z.array(z.string().min(1).max(200)).max(100).default([]),
	agentId: z.string().min(1).max(200).optional(),
	sourceIds: z.array(z.string().min(1).max(2_000)).max(500).default([]),
	projectIds: z.array(z.string().min(1).max(200)).max(100).default([]),
	personIds: z.array(z.string().min(1).max(200)).max(100).default([]),
	entityIds: z.array(z.string().min(1).max(200)).max(100).default([]),
	goal: z.string().min(1).max(20_000),
	plan: z.array(z.string().min(1).max(2_000)).max(100),
	status: z.enum([
		"planned",
		"running",
		"waiting",
		"completed",
		"failed",
		"cancelled",
	]),
	evidence: z.array(TaskEvidenceSchema).max(500),
	artifacts: z.array(z.string().min(1).max(2_000)).max(500),
	failures: z.array(z.string().max(5_000)).max(100),
	unresolvedQuestions: z.array(z.string().max(5_000)).max(100),
	subtaskIds: z.array(z.string().min(1).max(200)).max(100),
	outcomeSummary: z.string().max(20_000).optional(),
	startedAt: z.string().datetime(),
	completedAt: z.string().datetime().optional(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type WorkingTask = z.infer<typeof WorkingTaskSchema>;

export const ProvenanceOwnerTypeSchema = z.enum([
	"timeline_event",
	"timeline_session",
	"activity_block",
	"daily_summary",
	"memory",
	"entity",
	"entity_edge",
	"agent_memory",
	"task",
]);
export type ProvenanceOwnerType = z.infer<typeof ProvenanceOwnerTypeSchema>;

export const ProvenanceRecordSchema = z.object({
	id: z.string().min(1).max(200),
	ownerType: ProvenanceOwnerTypeSchema,
	ownerId: z.string().min(1).max(200),
	sourceType: z.string().min(1).max(200),
	sourceId: z.string().min(1).max(2_000),
	timelineEventId: z.string().min(1).max(200).optional(),
	actor: TimelineActorSchema,
	extractionMethod: z.enum([
		"user",
		"deterministic",
		"pattern",
		"provider",
		"import",
	]),
	originalContentRef: z.string().max(2_000).optional(),
	excerpt: z.string().max(10_000).optional(),
	confidence: z.number().min(0).max(1),
	transformationHistory: z.array(z.string().max(2_000)).max(100),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type ProvenanceRecord = z.infer<typeof ProvenanceRecordSchema>;

export const CapturePolicySchema = z.object({
	id: z.string().min(1).max(200),
	scope: z.enum([
		"domain",
		"tab",
		"file",
		"application",
		"session",
		"conversation",
	]),
	pattern: z.string().min(1).max(4_096),
	enabled: z.boolean(),
	retentionDays: z.number().int().positive().max(36_500).optional(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type CapturePolicy = z.infer<typeof CapturePolicySchema>;

export const CaptureConfigurationSchema = z.object({
	version: z.literal(1),
	enabled: z.boolean(),
	defaultRetentionDays: z.number().int().positive().max(36_500),
	policies: z.array(CapturePolicySchema).max(500),
	updatedAt: z.string().datetime(),
});
export type CaptureConfiguration = z.infer<typeof CaptureConfigurationSchema>;

export const CaptureStatusSchema = z.object({
	configuration: CaptureConfigurationSchema,
	eventsCaptured: z.number().int().nonnegative(),
	activeTimelineSessions: z.number().int().nonnegative(),
	activityBlocks: z.number().int().nonnegative(),
	pendingJobs: z.number().int().nonnegative(),
	failedJobs: z.number().int().nonnegative(),
	readyEmbeddings: z.number().int().nonnegative(),
	lastCapturedAt: z.string().datetime().optional(),
	localProcessing: z.literal(true),
});
export type CaptureStatus = z.infer<typeof CaptureStatusSchema>;

export const MemoryJobKindSchema = z.enum([
	"extract",
	"sessionize",
	"consolidate",
	"embed",
	"decay",
	"cleanup",
]);
export type MemoryJobKind = z.infer<typeof MemoryJobKindSchema>;

export const MemoryJobStatusSchema = z.enum([
	"pending",
	"running",
	"completed",
	"failed",
	"cancelled",
]);
export type MemoryJobStatus = z.infer<typeof MemoryJobStatusSchema>;

export const MemoryJobSchema = z.object({
	id: z.string().min(1).max(200),
	kind: MemoryJobKindSchema,
	dedupeKey: z.string().min(1).max(500),
	status: MemoryJobStatusSchema,
	payload: z.record(z.string(), z.unknown()),
	attempts: z.number().int().nonnegative().max(20),
	maxAttempts: z.number().int().positive().max(20),
	runAfter: z.string().datetime(),
	lockedAt: z.string().datetime().optional(),
	leaseUntil: z.string().datetime().optional(),
	lastError: z.string().max(10_000).optional(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type MemoryJob = z.infer<typeof MemoryJobSchema>;

export const EmbeddingStatusSchema = z.enum([
	"ready",
	"queued",
	"unavailable",
	"failed",
	"stale",
	"deleted",
]);
export type EmbeddingStatus = z.infer<typeof EmbeddingStatusSchema>;

export const EmbeddingRecordSchema = z.object({
	id: z.string().min(1).max(200),
	ownerType: z.enum([
		"timeline_event",
		"timeline_session",
		"activity_block",
		"daily_summary",
		"memory",
		"agent_memory",
		"task",
	]),
	ownerId: z.string().min(1).max(200),
	provider: z.string().min(1).max(200),
	model: z.string().min(1).max(200),
	dimension: z.number().int().positive().max(16_384),
	contentHash: z.string().regex(/^[a-f0-9]{64}$/),
	vector: z.array(z.number().finite()).max(16_384),
	status: EmbeddingStatusSchema,
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type EmbeddingRecord = z.infer<typeof EmbeddingRecordSchema>;

export const MemoryQuerySchema = z.object({
	query: z.string().max(10_000).default(""),
	startAt: z.string().datetime().optional(),
	endAt: z.string().datetime().optional(),
	personIds: z.array(z.string().min(1).max(200)).max(100).default([]),
	projectIds: z.array(z.string().min(1).max(200)).max(100).default([]),
	entityIds: z.array(z.string().min(1).max(200)).max(100).default([]),
	agentId: z.string().min(1).max(200).optional(),
	sessionId: z.string().min(1).max(200).optional(),
	sourceSessionId: z.string().min(1).max(200).optional(),
	horizons: z.array(MemoryHorizonSchema).max(4).default([]),
	eventTypes: z.array(TimelineEventTypeSchema).max(20).default([]),
	includeTimeline: z.boolean().default(true),
	includeMemories: z.boolean().default(true),
	includeEntities: z.boolean().default(true),
	includeAgents: z.boolean().default(true),
	includeTasks: z.boolean().default(true),
	includeSensitive: z.boolean().default(false),
	includeRestricted: z.boolean().default(false),
	limit: z.number().int().positive().max(200).default(30),
	sort: z.enum(["relevance", "chronological", "recent"]).default("relevance"),
});
export type MemoryQuery = z.infer<typeof MemoryQuerySchema>;

export const MemorySearchResultSchema = z.object({
	kind: z.enum([
		"timeline_event",
		"timeline_session",
		"activity_block",
		"daily_summary",
		"memory",
		"person",
		"entity",
		"agent_memory",
		"task",
	]),
	id: z.string().min(1).max(200),
	title: z.string().min(1).max(500),
	summary: z.string().min(1).max(20_000),
	startedAt: z.string().datetime().optional(),
	endedAt: z.string().datetime().optional(),
	score: z.number().min(0).max(100),
	lexicalScore: z.number().min(0).max(1),
	semanticScore: z.number().min(0).max(1),
	importance: z.number().min(0).max(1),
	confidence: z.number().min(0).max(1),
	sensitivity: z.enum(["public", "personal", "sensitive", "restricted"]),
	horizon: MemoryHorizonSchema.optional(),
	provenanceIds: z.array(z.string().min(1)).max(100),
	sourceIds: z.array(z.string().min(1)).max(100),
	relatedIds: z.array(z.string().min(1)).max(100),
});
export type MemorySearchResult = z.infer<typeof MemorySearchResultSchema>;

export const MemoryTimelineQueryResultSchema = z.object({
	results: z.array(MemorySearchResultSchema).max(200),
	events: z.array(TimelineEventSchema).max(200),
	sessions: z.array(TimelineSessionSchema).max(100),
	activityBlocks: z.array(ActivityBlockSchema).max(200),
	dailySummaries: z.array(DailySummarySchema).max(100),
	hasMore: z.boolean(),
});
export type MemoryTimelineQueryResult = z.infer<
	typeof MemoryTimelineQueryResultSchema
>;

export const MemoryContextBundleSchema = z.object({
	query: z.string().max(10_000),
	agentId: z.string().min(1).max(200).optional(),
	durable: z.array(MemorySearchResultSchema).max(40),
	current: z.array(MemorySearchResultSchema).max(40),
	retrieved: z.array(MemorySearchResultSchema).max(60),
	tasks: z.array(WorkingTaskSchema).max(20),
	evidence: z.array(ProvenanceRecordSchema).max(100),
	prompt: z.string().max(120_000),
	createdAt: z.string().datetime(),
});
export type MemoryContextBundle = z.infer<typeof MemoryContextBundleSchema>;

export const MemoryDiagnosticsSchema = z.object({
	events: z.number().int().nonnegative(),
	sessions: z.number().int().nonnegative(),
	activityBlocks: z.number().int().nonnegative(),
	dailySummaries: z.number().int().nonnegative(),
	entities: z.number().int().nonnegative(),
	edges: z.number().int().nonnegative(),
	agentIdentities: z.number().int().nonnegative(),
	agentMemories: z.number().int().nonnegative(),
	tasks: z.number().int().nonnegative(),
	provenance: z.number().int().nonnegative(),
	pendingJobs: z.number().int().nonnegative(),
	failedJobs: z.number().int().nonnegative(),
	embeddings: z.object({
		ready: z.number().int().nonnegative(),
		queued: z.number().int().nonnegative(),
		failed: z.number().int().nonnegative(),
		unavailable: z.number().int().nonnegative(),
	}),
	lastJobError: z.string().max(10_000).optional(),
	localOnly: z.literal(true),
	updatedAt: z.string().datetime(),
});
export type MemoryDiagnostics = z.infer<typeof MemoryDiagnosticsSchema>;

export const MemoryMaintenanceResultSchema = z.object({
	jobsProcessed: z.number().int().nonnegative(),
	jobsCompleted: z.number().int().nonnegative(),
	jobsRetried: z.number().int().nonnegative(),
	jobsFailed: z.number().int().nonnegative(),
	eventsSessionized: z.number().int().nonnegative(),
	blocksBuilt: z.number().int().nonnegative(),
	memoriesExtracted: z.number().int().nonnegative(),
	memoriesChanged: z.number().int().nonnegative(),
	deletedArtifacts: z.number().int().nonnegative(),
	updatedAt: z.string().datetime(),
});
export type MemoryMaintenanceResult = z.infer<
	typeof MemoryMaintenanceResultSchema
>;

export const MemoryDeleteResultSchema = z.object({
	timelineEvents: z.number().int().nonnegative(),
	sessions: z.number().int().nonnegative(),
	activityBlocks: z.number().int().nonnegative(),
	dailySummaries: z.number().int().nonnegative(),
	entities: z.number().int().nonnegative().default(0),
	edges: z.number().int().nonnegative().default(0),
	tasks: z.number().int().nonnegative().default(0),
	jobs: z.number().int().nonnegative().default(0),
	memories: z.number().int().nonnegative(),
	agentMemories: z.number().int().nonnegative(),
	provenance: z.number().int().nonnegative(),
	embeddings: z.number().int().nonnegative(),
});
export type MemoryDeleteResult = z.infer<typeof MemoryDeleteResultSchema>;
