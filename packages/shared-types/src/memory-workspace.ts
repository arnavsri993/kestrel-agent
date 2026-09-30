import { z } from "zod";
import { TimelineEventSchema } from "./memory-architecture";

const identifier = z.string().trim().min(1).max(200);
const domains = z.array(identifier).max(100).default([]);
const sources = z.array(z.string().min(1).max(2_000)).max(500).default([]);
export const MemoryWorkspaceQuerySchema = z.object({
	viewerId: identifier.default("user"),
	domainId: identifier.optional(),
	startAt: z.string().datetime().optional(),
	endAt: z.string().datetime().optional(),
	includeSensitive: z.boolean().default(false),
}).refine(value => !value.startAt || !value.endAt || value.startAt < value.endAt, {
	message: "The end must follow the start.", path: ["endAt"],
});
export type MemoryWorkspaceQuery = z.infer<typeof MemoryWorkspaceQuerySchema>;
export const MemoryPassageSchema = z.object({
	id: identifier,
	text: z.string().trim().min(1).max(100_000),
	domainIds: domains,
	ownerAgentId: identifier.optional(),
	sharing: z.enum(["owner_only", "domain_shared"]).default("owner_only"),
	sourceIds: sources,
	sensitivity: z.enum(["public", "personal", "sensitive", "restricted"]).default("personal"),
	confidence: z.number().min(0).max(1).default(1),
	confirmation: z.enum(["confirmed", "inferred"]).default("confirmed"),
});
export type MemoryPassage = z.infer<typeof MemoryPassageSchema>;

/** Canonical text is a user surface. Scoped readers receive visible passages only. */
export const MemoryDocumentSchema = z.object({
	id: identifier,
	kind: z.enum(["memory", "person", "tool", "knowledge"]),
	title: z.string().trim().min(1).max(500),
	text: z.string().trim().min(1).max(100_000),
	tier: z.enum(["short_term", "mid_term", "long_term"]).default("long_term"),
	domainIds: domains,
	ownerAgentId: identifier.optional(),
	sharing: z.enum(["owner_only", "domain_shared"]).default("owner_only"),
	sourceIds: sources,
	confidence: z.number().min(0).max(1).default(1),
	confirmation: z.enum(["confirmed", "inferred"]).default("confirmed"),
	sensitivity: z.enum(["public", "personal", "sensitive", "restricted"]).default("personal"),
	passages: z.array(MemoryPassageSchema).max(500).default([]),
	canonicalEntityId: identifier.optional(),
	origin: z.enum(["manual", "legacy", "evidence"]).default("manual"),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
	version: z.number().int().positive().default(1),
});
export type MemoryDocument = z.infer<typeof MemoryDocumentSchema>;
export const MemoryDocumentSaveSchema = MemoryDocumentSchema.omit({
	id: true, createdAt: true, updatedAt: true, version: true,
}).extend({
	id: identifier.optional(),
	viewerId: identifier.default("user"),
	expectedVersion: z.number().int().nonnegative().optional(),
});
export type MemoryDocumentSave = z.infer<typeof MemoryDocumentSaveSchema>;

export const MemoryWorkspaceDaySummarySchema = z.object({
	id: identifier,
	viewerId: identifier,
	domainId: identifier.optional(),
	day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	summary: z.string().trim().min(1).max(20_000),
	summaryMethod: z.enum(["model", "deterministic"]),
	fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
	sourceIds: sources,
	eventIds: z.array(identifier).max(2_000).default([]),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
	version: z.number().int().positive(),
});
export type MemoryWorkspaceDaySummary = z.infer<typeof MemoryWorkspaceDaySummarySchema>;
export const MemoryWorkspaceDaySummarySaveSchema = MemoryWorkspaceDaySummarySchema.omit({
	id: true, createdAt: true, updatedAt: true, version: true,
}).extend({ expectedVersion: z.number().int().nonnegative().optional() });
export type MemoryWorkspaceDaySummarySave = z.infer<typeof MemoryWorkspaceDaySummarySaveSchema>;

export const MemoryWorkspaceSchema = z.object({
	query: MemoryWorkspaceQuerySchema,
	viewers: z.array(z.object({ id: identifier, label: z.string().max(300), parentId: identifier.optional(), sessionId: identifier.optional() })).max(1_001),
	domains: z.array(z.object({ id: identifier, label: z.string().max(500) })).max(1_000),
	documents: z.array(MemoryDocumentSchema).max(2_000),
	days: z.array(z.object({
		day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
		summary: z.string().max(20_000),
		summaryMethod: z.enum(["model", "deterministic"]),
		summaryUpdatedAt: z.string().datetime().optional(),
		events: z.array(TimelineEventSchema).max(2_000),
		eventCount: z.number().int().nonnegative(),
		sourceIds: sources,
	})).max(2_000),
	generatedAt: z.string().datetime(),
	summaryMethod: z.enum(["model", "deterministic"]),
	truncated: z.boolean(),
});
export type MemoryWorkspace = z.infer<typeof MemoryWorkspaceSchema>;
