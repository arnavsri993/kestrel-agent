import { z } from "zod";

export const SensitivitySchema = z.enum(["public", "personal", "sensitive", "restricted"]);
export type SensitivityLevel = z.infer<typeof SensitivitySchema>;

export const RiskLevelSchema = z.enum(["read_only", "low", "external", "sensitive", "high_consequence"]);
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
  metadata: z.record(z.string(), z.unknown())
});
export type AgentEvent = z.infer<typeof BaseEventSchema>;

export const MemoryTypeSchema = z.enum(["episodic", "semantic", "procedural", "project", "relationship"]);
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
  status: z.enum(["active", "superseded", "contradicted", "expired", "deleted"]),
  entityIds: z.array(z.string()),
  userConfirmed: z.boolean(),
  inferred: z.boolean()
});
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

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
  updatedAt: z.string().datetime()
});
export type UserModelFact = z.infer<typeof UserModelFactSchema>;
export type UserModelKind = UserModelFact["kind"];
export type UserModelStatus = UserModelFact["status"];

export const SkillLearningProposalSchema = z.object({
  id: z.string().min(1),
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
  description: z.string().min(1).max(1_024),
  instructions: z.string().min(1).max(200_000),
  sourceSessionId: z.string().min(1),
  sourceMessageIds: z.array(z.string().min(1)).min(1),
  status: z.enum(["proposed", "installed", "rejected", "failed"]),
  evaluation: z.object({ valid: z.boolean(), checks: z.array(z.string()), error: z.string().optional() }),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type SkillLearningProposal = z.infer<typeof SkillLearningProposalSchema>;

export const SkillLearningFeedbackSchema = z.object({
  id: z.string().min(1),
  skillName: z.string().min(1),
  succeeded: z.boolean(),
  feedback: z.string().min(1).max(20_000),
  sourceIds: z.array(z.string().min(1)).min(1),
  createdAt: z.string().datetime()
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
  expectedOutputs: z.array(z.object({ type: z.string(), description: z.string() })),
  confidence: z.number().min(0).max(1),
  urgency: z.number().min(0).max(1),
  importance: z.number().min(0).max(1),
  expectedUtility: z.number().min(0),
  estimatedInterruptionCost: z.number().min(0),
  estimatedComputeCost: z.number().min(0),
  estimatedDurationSeconds: z.number().positive().optional(),
  riskLevel: RiskLevelSchema,
  requiredApprovalLevel: ApprovalLevelSchema,
  status: z.enum(["detected", "evaluating", "ignored", "suggested", "queued", "running", "awaiting_approval", "completed", "failed"]),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  priority: z.number()
});
export type TaskOpportunity = z.infer<typeof TaskOpportunitySchema>;

export const EvidenceSchema = z.object({
  id: z.string(),
  label: z.string(),
  value: z.string(),
  source: z.string(),
  confirmed: z.boolean()
});

export const ApprovalSchema = z.object({
  id: z.string(),
  title: z.string(),
  recommendation: z.string(),
  reasoning: z.string(),
  proposedEmail: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
  proposedCalendarEvent: z.object({ title: z.string(), startsAt: z.string(), durationMinutes: z.number() }),
  proposedStudyBlocks: z.array(z.object({ label: z.string(), startsAt: z.string(), durationMinutes: z.number() })),
  evidence: z.array(EvidenceSchema),
  riskLevel: RiskLevelSchema,
  approvalLevel: ApprovalLevelSchema,
  status: z.enum(["pending", "approved", "rejected", "executed", "failed"]),
  policySuggestion: z.string(),
  createdAt: z.string().datetime(),
  executedAt: z.string().datetime().optional()
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const ActivitySchema = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string(),
  timestamp: z.string().datetime(),
  status: z.enum(["observed", "reasoned", "waiting", "verified", "blocked", "failed"]),
  sourceIds: z.array(z.string())
});
export type ActivityItem = z.infer<typeof ActivitySchema>;

export const AgentStateSchema = z.enum(["idle", "observing", "working", "waiting_approval", "paused", "offline", "error", "updating"]);
export type AgentState = z.infer<typeof AgentStateSchema>;

export const ExecutionModelSchema = z.enum(["local-rules", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]);
export type ExecutionModel = z.infer<typeof ExecutionModelSchema>;

export const ReasoningEffortSchema = z.enum(["none", "low", "medium", "high", "xhigh", "max"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const ModelRoutingDecisionSchema = z.object({
  taskId: z.string().min(1),
  model: ExecutionModelSchema,
  reasoningEffort: ReasoningEffortSchema,
  fastMode: z.boolean(),
  serviceTier: z.enum(["standard", "priority"]),
  execution: z.enum(["local", "development_adapter"]),
  rationale: z.string().min(1),
  selectedAt: z.string().datetime()
});
export type ModelRoutingDecision = z.infer<typeof ModelRoutingDecisionSchema>;

export const AutomaticRoutingSchema = z.object({
  model: z.literal("auto"),
  reasoningEffort: z.literal("auto"),
  fastMode: z.literal("auto"),
  currentDecision: ModelRoutingDecisionSchema
});
export type AutomaticRouting = z.infer<typeof AutomaticRoutingSchema>;

export const RuntimeSessionStatusSchema = z.enum(["active", "waiting", "completed", "cancelled", "failed"]);
export type RuntimeSessionStatus = z.infer<typeof RuntimeSessionStatusSchema>;

export const RuntimeCheckpointSchema = z.object({
  id: z.string().min(1),
  sequence: z.number().int().positive(),
  summary: z.string().min(1).max(20_000),
  createdAt: z.string().datetime()
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
  updatedAt: z.string().datetime()
});
export type RuntimeSession = z.infer<typeof RuntimeSessionSchema>;

export const RuntimeMessageSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().min(1).max(1_000_000),
  modelToolCalls: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown())
  })).optional(),
  providerToolCallId: z.string().min(1).optional(),
  toolName: z.string().min(1).optional(),
  parentMessageId: z.string().min(1).optional(),
  toolExecutionId: z.string().min(1).optional(),
  createdAt: z.string().datetime()
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
  undoneAt: z.string().datetime().optional()
});
export type WorkspaceMutation = z.infer<typeof WorkspaceMutationSchema>;

export const RuntimeToolDescriptorSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_.-]+$/),
  title: z.string().min(1),
  description: z.string().min(1),
  category: z.enum(["workspace", "execution", "web", "browser", "connector", "memory", "session", "automation", "media", "extension"]),
  riskLevel: RiskLevelSchema,
  readOnly: z.boolean(),
  requiresWorkspace: z.boolean(),
  source: z.enum(["builtin", "skill", "plugin", "mcp", "connector"]),
  tags: z.array(z.string().min(1))
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
  verification: z.object({
    method: z.string().min(1),
    evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    verifiedAt: z.string().datetime()
  }).optional(),
  error: z.string().optional(),
  idempotencyKey: z.string().min(1).optional(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional()
});
export type RuntimeToolExecution = z.infer<typeof RuntimeToolExecutionSchema>;

export const ApprovalRuleSchema = z.object({
  id: z.string().min(1),
  toolName: z.string().regex(/^[a-z][a-z0-9_.-]+$/),
  decision: z.enum(["allow", "deny"]),
  scope: z.enum(["session", "global"]),
  sessionId: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type ApprovalRule = z.infer<typeof ApprovalRuleSchema>;

export const RuntimeEventSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["session.created", "session.updated", "message.appended", "tool.started", "tool.progress", "tool.completed"]),
  sessionId: z.string().min(1),
  executionId: z.string().min(1).optional(),
  messageId: z.string().min(1).optional(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime()
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
  toolScope: z.array(z.string().regex(/^[a-z][a-z0-9_.-]+$/)).max(200).optional(),
  status: z.enum(["running", "waiting_approval", "completed", "cancelled", "failed"]),
  turn: z.number().int().nonnegative(),
  pendingToolExecutionId: z.string().min(1).optional(),
  pendingProviderToolCallId: z.string().min(1).optional(),
  pendingToolName: z.string().min(1).optional(),
  error: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

export const ModelProviderSummarySchema = z.object({
  id: z.string().min(1).max(100),
  capabilities: z.object({
    streaming: z.boolean(), tools: z.boolean(), images: z.boolean(), audio: z.boolean(), documents: z.boolean(), video: z.boolean().optional(), local: z.boolean()
  })
});
export type ModelProviderSummary = z.infer<typeof ModelProviderSummarySchema>;
export const ProviderVerificationSchema = z.object({ providerId: z.string().min(1), poolId: z.string().min(1).optional(), ok: z.boolean(), latencyMs: z.number().int().nonnegative(), error: z.string().optional() });
export type ProviderVerification = z.infer<typeof ProviderVerificationSchema>;

export const SelectedAttachmentSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(200),
  size: z.number().int().nonnegative().max(10 * 1024 * 1024)
});
export type SelectedAttachment = z.infer<typeof SelectedAttachmentSchema>;

export const ArtifactRecordSchema = z.object({ id: z.string().min(1), filename: z.string().min(1), path: z.string().min(1), mediaType: z.string().min(1), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), providerId: z.string().optional(), model: z.string().optional(), providerRequestId: z.string().optional(), estimatedCostUsd: z.number().nonnegative().optional(), createdAt: z.string().datetime() });
export type ArtifactRecordContract = z.infer<typeof ArtifactRecordSchema>;
export const ChannelSummarySchema = z.object({ id: z.string(), kind: z.enum(["webhook", "slack", "discord", "teams", "gmail"]), inbound: z.boolean() });
export type ChannelSummary = z.infer<typeof ChannelSummarySchema>;

export const AgentStreamEventSchema = z.object({
  streamId: z.string().min(1).max(100),
  sessionId: z.string().min(1),
  delta: z.string()
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
  completedAt: z.string().datetime()
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
  compactedMessages: z.number().int().nonnegative()
});
export type SessionUsageSummary = z.infer<typeof SessionUsageSummarySchema>;

export const ModelTokenRateSchema = z.object({
  inputPerMillionUsd: z.number().nonnegative().max(100_000),
  outputPerMillionUsd: z.number().nonnegative().max(100_000),
  cachedInputPerMillionUsd: z.number().nonnegative().max(100_000),
  reasoningPerMillionUsd: z.number().nonnegative().max(100_000)
});
export const UsagePolicySchema = z.object({
  dailyBudgetUsd: z.number().positive().max(1_000_000),
  monthlyBudgetUsd: z.number().positive().max(10_000_000),
  perCallReservationUsd: z.number().positive().max(100_000),
  maximumConcurrentCalls: z.number().int().min(1).max(64),
  defaultRate: ModelTokenRateSchema,
  rates: z.record(z.string().min(1), ModelTokenRateSchema)
});
export type UsagePolicy = z.infer<typeof UsagePolicySchema>;

export const WebCitationSchema = z.object({ title: z.string(), url: z.string().url(), retrievedAt: z.string().datetime() });
export const WebSearchResultSchema = z.object({ title: z.string(), url: z.string().url(), snippet: z.string(), citation: WebCitationSchema.optional() });
export const WebFetchResultSchema = z.object({ url: z.string().url(), status: z.number().int(), contentType: z.string(), content: z.string(), trust: z.literal("untrusted_external"), citation: WebCitationSchema, cached: z.boolean() });
export type WebCitation = z.infer<typeof WebCitationSchema>;
export type WebSearchResultContract = z.infer<typeof WebSearchResultSchema>;
export type WebFetchResult = z.infer<typeof WebFetchResultSchema>;

export const GoalTaskSchema = z.object({ id: z.string(), title: z.string(), status: z.enum(["pending", "in_progress", "completed"]), dependsOn: z.array(z.string()).optional(), dueAt: z.string().datetime().optional() });
export const GoalRecordSchema = z.object({ id: z.string(), sessionId: z.string(), title: z.string(), objective: z.string(), status: z.enum(["active", "completed", "cancelled"]), tasks: z.array(GoalTaskSchema), sourceOpportunityId: z.string().optional(), deadline: z.string().datetime().optional(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() });
export type GoalRecordContract = z.infer<typeof GoalRecordSchema>;
export const TeamMessageSchema = z.object({ id: z.string(), fromSessionId: z.string(), toSessionId: z.string(), text: z.string(), createdAt: z.string().datetime() });
export const TeamRecordSchema = z.object({ id: z.string(), parentSessionId: z.string(), title: z.string(), memberSessionIds: z.array(z.string()), sharedPlan: z.array(z.string()), messages: z.array(TeamMessageSchema), usage: z.object({ runs: z.number().int().nonnegative(), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).optional(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() });
export type TeamRecordContract = z.infer<typeof TeamRecordSchema>;
export const ScheduledJobSummarySchema = z.object({ id: z.string(), title: z.string(), sessionId: z.string(), model: z.string(), providerIds: z.array(z.string()), schedule: z.union([z.object({ kind: z.literal("once"), nextRunAt: z.string().datetime() }), z.object({ kind: z.literal("interval"), nextRunAt: z.string().datetime(), intervalMs: z.number().int().positive() }), z.object({ kind: z.literal("cron"), nextRunAt: z.string().datetime(), expression: z.string().min(1).max(200) })]), status: z.enum(["pending", "running", "waiting_approval", "completed", "failed", "cancelled"]), lastRunId: z.string().optional(), error: z.string().optional(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() });
export type ScheduledJobSummary = z.infer<typeof ScheduledJobSummarySchema>;
export const BackgroundJobsEventSchema = z.object({ checkedAt: z.string().datetime(), jobs: z.array(ScheduledJobSummarySchema) });
export type BackgroundJobsEvent = z.infer<typeof BackgroundJobsEventSchema>;

export const WorkspaceSnapshotSchema = z.object({
  productName: z.string(),
  agentState: AgentStateSchema,
  autonomyLevel: z.enum(["observer", "assistant", "operator", "high"]),
  opportunity: TaskOpportunitySchema,
  approvals: z.array(ApprovalSchema),
  memories: z.array(MemoryRecordSchema),
  activity: z.array(ActivitySchema),
  connections: z.array(z.object({ id: z.string(), name: z.string(), status: z.enum(["development_adapter", "connected", "disconnected", "error"]), detail: z.string() })),
  resourceUsage: z.object({ modelCostToday: z.number(), modelBudgetDaily: z.number(), activeWorkers: z.number(), maximumWorkers: z.number() }),
  modelRouting: AutomaticRoutingSchema,
  personality: z.object({
    selectedId: z.string().min(1),
    available: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), description: z.string().min(1), preferredModel: z.string().optional(), providerIds: z.array(z.string()).optional(), toolNames: z.array(z.string()).optional(), memoryScope: z.enum(["shared", "isolated"]), builtin: z.boolean() }))
  }),
  updatedAt: z.string().datetime()
});
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;

export const PluginSummarySchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  author: z.object({ name: z.string().min(1), url: z.string().optional() }).optional(),
  license: z.string().optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  interface: z.object({
    displayName: z.string().optional(),
    shortDescription: z.string().optional(),
    category: z.string().optional(),
    capabilities: z.array(z.string()),
    defaultPrompt: z.array(z.string())
  }).optional(),
  enabled: z.boolean(),
  hasSkills: z.boolean(),
  hasMcpServers: z.boolean(),
  mcpConnected: z.boolean(),
  managed: z.boolean()
});
export type PluginSummary = z.infer<typeof PluginSummarySchema>;

export const TrustedPluginPublisherSchema = z.object({ keyId: z.string().min(1).max(128), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) });
export type TrustedPluginPublisher = z.infer<typeof TrustedPluginPublisherSchema>;

export const PluginMutationSchema = z.object({
  action: z.enum(["install", "update", "remove", "restore"]),
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(100),
  replacedVersion: z.string().min(1).max(100).optional(),
  recoveryPath: z.string().min(1).optional()
});
export type PluginMutation = z.infer<typeof PluginMutationSchema>;

export const MigrationProductSchema = z.enum(["openclaw", "hermes", "codex", "claude-code"]);
export const MigrationItemSchema = z.object({ product: MigrationProductSchema, category: z.enum(["instructions", "settings", "memory", "skill", "agent"]), sourceRoot: z.string().min(1), sourcePath: z.string(), destinationPath: z.string().min(1), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/), status: z.enum(["ready", "conflict"]) });
export const MigrationTranslationSchema = z.object({ product: MigrationProductSchema, sourcePath: z.string(), destinationPath: z.string().min(1), values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export const MigrationPlanSchema = z.object({ createdAt: z.string().datetime(), targetRoot: z.string().min(1), items: z.array(MigrationItemSchema).max(2_000), warnings: z.array(z.string()), translations: z.array(MigrationTranslationSchema).max(2_000) });
export type MigrationPlanContract = z.infer<typeof MigrationPlanSchema>;
export const MigrationResultSchema = z.object({ imported: z.array(z.string()), skipped: z.array(z.string()) });
export type MigrationResultContract = z.infer<typeof MigrationResultSchema>;
export const OrganizationMemberSchema = z.object({ externalId: z.string().min(1), email: z.string().email(), displayName: z.string().min(1), role: z.enum(["member", "admin"]), active: z.boolean(), updatedAt: z.string().datetime() });
export type OrganizationMemberContract = z.infer<typeof OrganizationMemberSchema>;
export const EnterpriseAnalyticsSchema = z.object({ sessions: z.number().int().nonnegative(), messages: z.number().int().nonnegative(), runs: z.number().int().nonnegative(), toolExecutions: z.number().int().nonnegative(), modelCalls: z.number().int().nonnegative(), failedModelCalls: z.number().int().nonnegative(), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), estimatedCostUsd: z.number().nonnegative() });
export type EnterpriseAnalytics = z.infer<typeof EnterpriseAnalyticsSchema>;
export const RetentionResultSchema = z.object({ cutoff: z.string().datetime(), deleted: z.record(z.string(), z.number().int().nonnegative()) });

export const CoreRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot") }),
  z.object({ type: z.literal("approve"), approvalId: z.string() }),
  z.object({ type: z.literal("reject"), approvalId: z.string() }),
  z.object({ type: z.literal("edit-approval"), approvalId: z.string(), emailBody: z.string().min(1).max(8000) }),
  z.object({ type: z.literal("troubleshoot"), message: z.string().min(1).max(4000) }),
  z.object({ type: z.literal("set-paused"), paused: z.boolean() }),
  z.object({ type: z.literal("set-personality"), personalityId: z.string().min(1).max(64) }),
  z.object({ type: z.literal("create-personality"), personality: z.object({ id: z.string().min(1).max(64), name: z.string().min(1).max(100), description: z.string().min(1).max(500), instructions: z.string().min(1).max(20_000), preferredModel: z.string().min(1).max(200).optional(), providerIds: z.array(z.string().min(1).max(100)).max(8).optional(), toolNames: z.array(z.string().min(1).max(200)).max(200).optional(), memoryScope: z.enum(["shared", "isolated"]).default("shared") }) }),
  z.object({ type: z.literal("remove-personality"), personalityId: z.string().min(1).max(64) }),
  z.object({ type: z.literal("plugin-list") }),
  z.object({ type: z.literal("plugin-set-enabled"), name: z.string().min(1).max(100), enabled: z.boolean() }),
  z.object({ type: z.literal("plugin-connect-mcp"), name: z.string().min(1).max(100) }),
  z.object({ type: z.literal("plugin-disconnect-mcp"), name: z.string().min(1).max(100) }),
  z.object({ type: z.literal("runtime-list-sessions") }),
  z.object({ type: z.literal("runtime-create-session"), title: z.string().min(1).max(200), workspaceRoot: z.string().min(1).optional() }),
  z.object({ type: z.literal("runtime-fork-session"), sessionId: z.string().min(1), title: z.string().min(1).max(200).optional() }),
  z.object({ type: z.literal("runtime-checkpoint-session"), sessionId: z.string().min(1), summary: z.string().min(1).max(20_000) }),
  z.object({ type: z.literal("runtime-restore-checkpoint"), sessionId: z.string().min(1), checkpointId: z.string().min(1) }),
  z.object({ type: z.literal("runtime-retry-agent"), sessionId: z.string().min(1), model: z.string().min(1).max(200), providerIds: z.array(z.string().min(1).max(100)).min(1), providerModels: z.record(z.string(), z.string().min(1).max(200)).optional(), streamId: z.string().min(1).max(100).optional() }),
  z.object({ type: z.literal("runtime-resume-session"), sessionId: z.string().min(1) }),
  z.object({ type: z.literal("runtime-cancel-session"), sessionId: z.string().min(1) }),
  z.object({ type: z.literal("runtime-append-message"), sessionId: z.string().min(1), role: z.enum(["system", "user", "assistant", "tool"]), content: z.string().min(1).max(1_000_000), parentMessageId: z.string().min(1).optional(), toolExecutionId: z.string().min(1).optional() }),
  z.object({ type: z.literal("runtime-list-messages"), sessionId: z.string().min(1) }),
  z.object({ type: z.literal("runtime-list-runs"), sessionId: z.string().min(1) }),
  z.object({ type: z.literal("runtime-list-executions"), sessionId: z.string().min(1) }),
  z.object({ type: z.literal("runtime-session-usage"), sessionId: z.string().min(1) }),
  z.object({ type: z.literal("runtime-get-usage-policy") }),
  z.object({ type: z.literal("runtime-set-usage-policy"), policy: UsagePolicySchema }),
  z.object({ type: z.literal("runtime-search-messages"), query: z.string().min(1).max(500), limit: z.number().int().positive().max(100).optional() }),
  z.object({ type: z.literal("memory-list") }),
  z.object({ type: z.literal("memory-remember"), memoryType: MemoryTypeSchema, content: z.string().min(1).max(100_000), sensitivity: SensitivitySchema.default("personal"), sourceId: z.string().min(1).max(500).default("desktop-user") }),
  z.object({ type: z.literal("memory-correct"), id: z.string().min(1), content: z.string().min(1).max(100_000), memoryType: MemoryTypeSchema.optional(), sensitivity: SensitivitySchema.optional() }),
  z.object({ type: z.literal("memory-forget"), id: z.string().min(1) }),
  z.object({ type: z.literal("memory-user-model-list") }),
  z.object({ type: z.literal("memory-user-model-review"), id: z.string().min(1), decision: z.enum(["confirm", "reject"]) }),
  z.object({ type: z.literal("skill-learning-list") }),
  z.object({ type: z.literal("skill-learning-propose"), name: z.string().min(1).max(64), description: z.string().min(1).max(1_024), instructions: z.string().min(1).max(200_000), sourceSessionId: z.string().min(1), sourceMessageIds: z.array(z.string().min(1)).min(1) }),
  z.object({ type: z.literal("skill-learning-review"), id: z.string().min(1), decision: z.enum(["install", "reject"]) }),
  z.object({ type: z.literal("skill-learning-feedback"), skillName: z.string().min(1).max(64), succeeded: z.boolean(), feedback: z.string().min(1).max(20_000), sourceIds: z.array(z.string().min(1)).min(1) }),
  z.object({ type: z.literal("web-search-direct"), query: z.string().min(1).max(2_000), maximumResults: z.number().int().min(1).max(20).default(8) }),
  z.object({ type: z.literal("web-fetch-direct"), url: z.string().url().max(8_000) }),
  z.object({ type: z.literal("orchestration-list") }),
  z.object({ type: z.literal("orchestration-goal-create"), sessionId: z.string().min(1), title: z.string().min(1).max(200), objective: z.string().min(1).max(20_000), tasks: z.array(z.string().min(1).max(500)).max(200).default([]) }),
  z.object({ type: z.literal("orchestration-goal-update"), goalId: z.string().min(1), status: z.enum(["active", "completed", "cancelled"]).optional(), taskId: z.string().optional(), taskStatus: z.enum(["pending", "in_progress", "completed"]).optional() }),
  z.object({ type: z.literal("orchestration-opportunity-to-goal"), sessionId: z.string().min(1) }),
  z.object({ type: z.literal("orchestration-team-create"), parentSessionId: z.string().min(1), title: z.string().min(1).max(200), memberSessionIds: z.array(z.string().min(1)).min(1).max(20), sharedPlan: z.array(z.string().max(1_000)).max(200).default([]) }),
  z.object({ type: z.literal("orchestration-team-update"), teamId: z.string().min(1), memberSessionIds: z.array(z.string().min(1)).min(1).max(20).optional(), sharedPlan: z.array(z.string().max(1_000)).max(200).optional() }),
  z.object({ type: z.literal("orchestration-team-message"), teamId: z.string().min(1), fromSessionId: z.string().min(1), toSessionId: z.string().min(1), text: z.string().min(1).max(20_000) }),
  z.object({ type: z.literal("orchestration-delegate"), parentSessionId: z.string().min(1), title: z.string().min(1).max(200), prompt: z.string().min(1).max(100_000), model: z.string().min(1).max(200), providerIds: z.array(z.string().min(1)).min(1), allowedTools: z.array(z.string()).optional(), isolateWorktree: z.boolean().default(false) }),
  z.object({ type: z.literal("orchestration-handoff"), childSessionId: z.string().min(1), summary: z.string().min(1).max(100_000) }),
  z.object({ type: z.literal("orchestration-schedule"), sessionId: z.string().min(1), title: z.string().min(1).max(200), prompt: z.string().min(1).max(100_000), model: z.string().min(1).max(200), providerIds: z.array(z.string().min(1)).min(1), expression: z.string().min(1).max(500) }),
  z.object({ type: z.literal("orchestration-job-cancel"), jobId: z.string().min(1) }),
  z.object({ type: z.literal("orchestration-job-resume"), jobId: z.string().min(1) }),
  z.object({ type: z.literal("enterprise-summary") }),
  z.object({ type: z.literal("enterprise-enforce-retention") }),
  z.object({ type: z.literal("enterprise-member-upsert"), member: OrganizationMemberSchema.omit({ active: true, updatedAt: true }) }),
  z.object({ type: z.literal("enterprise-member-deactivate"), externalId: z.string().min(1) }),
  z.object({ type: z.literal("enterprise-verify-identity"), token: z.string().min(1).max(100_000) }),
  z.object({ type: z.literal("media-list-artifacts") }),
  z.object({ type: z.literal("media-preview-artifact"), artifactId: z.string().min(1).max(200), maximumBytes: z.number().int().positive().max(10_000_000).default(5_000_000) }),
  z.object({ type: z.literal("media-transcribe"), dataBase64: z.string().min(1).max(35_000_000), mediaType: z.string().regex(/^audio\/[a-z0-9.+-]+$/i).max(200) }),
  z.object({ type: z.literal("channel-list") }),
  z.object({ type: z.literal("runtime-list-providers") }),
  z.object({ type: z.literal("runtime-verify-provider"), providerId: z.string().min(1).max(100) }),
  z.object({
    type: z.literal("runtime-run-agent"),
    sessionId: z.string().min(1),
    message: z.string().min(1).max(1_000_000),
    model: z.string().min(1).max(200),
    providerIds: z.array(z.string().min(1).max(100)).min(1),
    providerModels: z.record(z.string(), z.string().min(1).max(200)).optional(),
    maximumTurns: z.number().int().positive().max(50).optional(),
    approvalStatus: z.enum(["pending", "approved"]).optional()
    ,personalityId: z.string().min(1).max(64).optional(),
    streamId: z.string().min(1).max(100).optional(),
    attachments: z.array(SelectedAttachmentSchema).max(8).optional()
  }),
  z.object({
    type: z.literal("runtime-resume-agent"),
    runId: z.string().min(1),
    approvalDecision: z.enum(["approved", "rejected"]).optional(),
    streamId: z.string().min(1).max(100).optional(),
    maximumTurns: z.number().int().positive().max(50).optional()
  }),
  z.object({ type: z.literal("runtime-cancel-stream"), streamId: z.string().min(1).max(100) }),
  z.object({ type: z.literal("runtime-steer-agent"), streamId: z.string().min(1).max(100), sessionId: z.string().min(1), message: z.string().min(1).max(100_000) }),
  z.object({ type: z.literal("runtime-discover-tools"), sessionId: z.string().min(1), query: z.string().max(500).optional() }),
  z.object({
    type: z.literal("runtime-call-tool"),
    sessionId: z.string().min(1),
    toolName: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
    approvalStatus: z.enum(["pending", "approved"]).optional(),
    idempotencyKey: z.string().min(1).max(500).optional(),
    externalContent: z.string().max(100_000).optional()
  }),
  z.object({ type: z.literal("runtime-cancel-execution"), executionId: z.string().min(1) })
  ,z.object({ type: z.literal("runtime-list-approval-rules") })
  ,z.object({ type: z.literal("runtime-set-approval-rule"), toolName: z.string().regex(/^[a-z][a-z0-9_.-]+$/), decision: z.enum(["allow", "deny"]), scope: z.enum(["session", "global"]), sessionId: z.string().min(1).optional() })
  ,z.object({ type: z.literal("runtime-remove-approval-rule"), id: z.string().min(1) })
]);
export type CoreRequest = z.infer<typeof CoreRequestSchema>;

export const CoreResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    snapshot: WorkspaceSnapshotSchema.optional(),
    answer: z.string().optional(),
    routing: ModelRoutingDecisionSchema.optional(),
    sessions: z.array(RuntimeSessionSchema).optional(),
    session: RuntimeSessionSchema.optional(),
    tools: z.array(RuntimeToolDescriptorSchema).optional(),
    execution: RuntimeToolExecutionSchema.optional(),
    run: AgentRunSchema.optional(),
    runs: z.array(AgentRunSchema).optional(),
    messages: z.array(RuntimeMessageSchema).optional(),
    executions: z.array(RuntimeToolExecutionSchema).optional(),
    plugins: z.array(PluginSummarySchema).optional(),
    providers: z.array(ModelProviderSummarySchema).optional()
    ,providerVerifications: z.array(ProviderVerificationSchema).optional()
    ,memories: z.array(MemoryRecordSchema).optional()
    ,userModelFacts: z.array(UserModelFactSchema).optional()
    ,skillProposals: z.array(SkillLearningProposalSchema).optional()
    ,skillFeedback: z.array(SkillLearningFeedbackSchema).optional()
    ,usage: SessionUsageSummarySchema.optional()
    ,webResults: z.array(WebSearchResultSchema).optional()
    ,webPage: WebFetchResultSchema.optional()
    ,cached: z.boolean().optional()
    ,goals: z.array(GoalRecordSchema).optional()
    ,teams: z.array(TeamRecordSchema).optional()
    ,jobs: z.array(ScheduledJobSummarySchema).optional()
    ,taskId: z.string().optional()
    ,approvalRules: z.array(ApprovalRuleSchema).optional()
    ,usagePolicy: UsagePolicySchema.optional()
    ,enterprisePolicy: z.object({ organizationId: z.string(), version: z.number().int(), maximumWorkers: z.number().int(), retentionDays: z.number().int().optional(), analyticsEnabled: z.boolean().optional(), ssoConfigured: z.boolean(), updatedAt: z.string().datetime() }).optional()
    ,enterpriseAnalytics: EnterpriseAnalyticsSchema.optional()
    ,organizationMembers: z.array(OrganizationMemberSchema).optional()
    ,retentionResult: RetentionResultSchema.optional()
    ,artifacts: z.array(ArtifactRecordSchema).optional()
    ,artifactPreview: z.object({ id: z.string(), mediaType: z.string(), dataBase64: z.string(), truncated: z.boolean() }).optional()
    ,transcription: z.object({ text: z.string().min(1).max(1_000_000), model: z.string().min(1).max(200), providerRequestId: z.string().max(200).optional() }).optional()
    ,channels: z.array(ChannelSummarySchema).optional()
  }),
  z.object({ ok: z.literal(false), error: z.string() })
]);
export type CoreResponse = z.infer<typeof CoreResponseSchema>;

export const RendererRequestSchema = z.union([
  CoreRequestSchema,
  z.object({ type: z.literal("get-system-state") }),
  z.object({ type: z.literal("set-launch-at-login"), enabled: z.boolean() }),
  z.object({ type: z.literal("get-workspace-grants") }),
  z.object({ type: z.literal("select-workspace-folder") }),
  z.object({ type: z.literal("remove-workspace-folder"), path: z.string().min(1) }),
  z.object({ type: z.literal("select-context-files"), workspaceRoot: z.string().min(1) }),
  z.object({ type: z.literal("request-microphone-access") }),
  z.object({ type: z.literal("local-model-status") }),
  z.object({ type: z.literal("local-model-pull"), model: z.string().regex(/^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9][a-z0-9._-]*)?$/i).max(200) }),
  z.object({ type: z.literal("local-runtime-bootstrap"), model: z.string().regex(/^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9][a-z0-9._-]*)?$/i).max(200), consent: z.literal(true) }),
  z.object({ type: z.literal("local-runtime-cancel") }),
  z.object({ type: z.literal("system-readiness") }),
  z.object({ type: z.literal("create-local-backup") }),
  z.object({ type: z.literal("reveal-local-backup"), path: z.string().min(1) }),
  z.object({ type: z.literal("subscription-cli-status") }),
  z.object({ type: z.literal("subscription-cli-set"), id: z.enum(["codex", "claude"]), enabled: z.boolean() }),
  z.object({ type: z.literal("credential-list") }),
  z.object({ type: z.literal("credential-set"), credentialId: z.enum(["openai", "openai-secondary", "anthropic", "anthropic-secondary", "gemini", "brave-search", "github"]), value: z.string().min(8).max(20_000) }),
  z.object({ type: z.literal("credential-remove"), credentialId: z.enum(["openai", "openai-secondary", "anthropic", "anthropic-secondary", "gemini", "brave-search", "github"]) }),
  z.object({ type: z.literal("plugin-get-publishers") }),
  z.object({ type: z.literal("plugin-import-publisher") }),
  z.object({ type: z.literal("plugin-remove-publisher"), keyId: z.string().min(1).max(128) }),
  z.object({ type: z.literal("plugin-install-bundle") }),
  z.object({ type: z.literal("plugin-update-bundle") }),
  z.object({ type: z.literal("plugin-remove-installed"), name: z.string().min(1).max(100) }),
  z.object({ type: z.literal("plugin-restore-removed"), recoveryPath: z.string().min(1) }),
  z.object({ type: z.literal("migration-select-plan"), product: MigrationProductSchema }),
  z.object({ type: z.literal("migration-apply-plan"), plan: MigrationPlanSchema, confirmation: z.literal("IMPORT"), overwrite: z.boolean().default(false) }),
  z.object({ type: z.literal("reset-local-data"), confirmation: z.string() })
]);
export type RendererRequest = z.infer<typeof RendererRequestSchema>;

export const WorkspaceGrantSchema = z.object({ path: z.string().min(1), name: z.string().min(1) });
export type WorkspaceGrant = z.infer<typeof WorkspaceGrantSchema>;

export const BrokeredCredentialSummarySchema = z.object({ id: z.enum(["openai", "openai-secondary", "anthropic", "anthropic-secondary", "gemini", "brave-search", "github"]), label: z.string().min(1), configured: z.boolean() });
export type BrokeredCredentialSummary = z.infer<typeof BrokeredCredentialSummarySchema>;

export const SetupSystemProfileSchema = z.object({
  platform: z.string().min(1),
  architecture: z.string().min(1),
  memoryBytes: z.number().int().positive(),
  logicalCpus: z.number().int().positive()
});
export type SetupSystemProfile = z.infer<typeof SetupSystemProfileSchema>;

export const LocalModelSummarySchema = z.object({
  name: z.string().min(1).max(200),
  size: z.number().int().nonnegative(),
  modifiedAt: z.string().optional()
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
    "error"
  ]),
  message: z.string().min(1).max(2_000),
  updatedAt: z.string().datetime(),
  model: z.string().min(1).max(200).optional(),
  downloadedBytes: z.number().int().nonnegative().optional(),
  totalBytes: z.number().int().positive().optional(),
  percent: z.number().min(0).max(100).optional()
});
export type LocalRuntimeProgress = z.infer<typeof LocalRuntimeProgressSchema>;

export const LocalRuntimeStatusSchema = z.object({
  automaticSupported: z.boolean(),
  managedRuntime: z.boolean(),
  ollamaAvailable: z.boolean(),
  source: z.enum(["none", "managed", "external"]),
  runtimeVersion: z.string().min(1).max(100).optional(),
  runtimeDownloadBytes: z.number().int().positive(),
  localModels: z.array(LocalModelSummarySchema)
});
export type LocalRuntimeStatus = z.infer<typeof LocalRuntimeStatusSchema>;

export const SystemReadinessCheckSchema = z.object({
  id: z.string().min(1).max(100),
  label: z.string().min(1).max(200),
  status: z.enum(["pass", "warning", "fail"]),
  detail: z.string().min(1).max(2_000)
});
export type SystemReadinessCheck = z.infer<typeof SystemReadinessCheckSchema>;

export const SystemReadinessSchema = z.object({
  checkedAt: z.string().datetime(),
  readyForLiveWork: z.boolean(),
  checks: z.array(SystemReadinessCheckSchema)
});
export type SystemReadiness = z.infer<typeof SystemReadinessSchema>;

export const LocalBackupResultSchema = z.object({
  path: z.string().min(1),
  createdAt: z.string().datetime(),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  verified: z.boolean()
});
export type LocalBackupResult = z.infer<typeof LocalBackupResultSchema>;

export const SubscriptionCliStatusSchema = z.object({
  id: z.enum(["codex", "claude"]),
  label: z.string().min(1),
  detected: z.boolean(),
  enabled: z.boolean(),
  path: z.string().min(1).optional(),
  detail: z.string().min(1)
});
export type SubscriptionCliStatus = z.infer<typeof SubscriptionCliStatusSchema>;

export type RendererResponse = CoreResponse
  | { ok: true; launchAtLogin: boolean; launchStatus: string }
  | { ok: true; workspaceGrants: WorkspaceGrant[]; cancelled?: boolean; snapshot?: WorkspaceSnapshot }
  | { ok: true; selectedAttachments: SelectedAttachment[]; cancelled?: boolean }
  | { ok: true; microphoneAccess: boolean }
  | { ok: true; credentials: BrokeredCredentialSummary[] }
  | { ok: true; systemProfile: SetupSystemProfile; ollamaAvailable: boolean; localModels: LocalModelSummary[]; localRuntime: LocalRuntimeStatus; localModelError?: string }
  | { ok: true; downloadedModel: LocalModelSummary; localModels: LocalModelSummary[] }
  | { ok: true; localRuntime: LocalRuntimeStatus }
  | { ok: true; systemReadiness: SystemReadiness }
  | { ok: true; localBackup: LocalBackupResult; cancelled?: boolean }
  | { ok: true; subscriptionClis: SubscriptionCliStatus[] }
  | { ok: true; pluginPublishers: TrustedPluginPublisher[]; cancelled?: boolean }
  | { ok: true; pluginMutation: PluginMutation; plugins: PluginSummary[] }
  | { ok: true; migrationPlan: MigrationPlanContract; cancelled?: boolean }
  | { ok: true; migrationResult: MigrationResultContract }
  | { ok: true };

export interface RendererBridge {
  request(request: RendererRequest): Promise<RendererResponse>;
  onSnapshot(callback: (snapshot: WorkspaceSnapshot) => void): () => void;
  onRuntimeEvent(callback: (event: RuntimeEvent) => void): () => void;
  onAgentStream(callback: (event: AgentStreamEvent) => void): () => void;
  onLocalRuntimeProgress(callback: (progress: LocalRuntimeProgress) => void): () => void;
}
