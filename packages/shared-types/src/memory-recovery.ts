import { z } from "zod";
import { AgentMemoryRecordSchema } from "./memory-architecture";
export const MemoryRecoveryEnvelopeSchema = z.object({ ciphertext: z.string().max(14_000_000), iv: z.string().max(32), authTag: z.string().max(32) }).strict();

export const AgentKnowledgeBackupSchema = z.object({
	format: z.literal("kestrel-agent-knowledge-v1"),
	agentId: z.string().min(1).max(200),
	createdAt: z.string().datetime(),
	records: z.array(AgentMemoryRecordSchema).max(1000),
}).strict();

export const MemoryRecoveryPreviewSchema = z.object({
	planId: z.string().uuid(),
	scopeName: z.string(),
	newRecords: z.number().int().nonnegative(),
	existingRecords: z.number().int().nonnegative(),
	expiresAt: z.string().datetime(),
});
export type MemoryRecoveryPreview = z.infer<typeof MemoryRecoveryPreviewSchema>;
