import { z } from "zod";

// Trusted native host only. These operations are not agent/Core requests and
// never accept database paths, row identifiers, source data or lease metadata.
export const NativeEmbeddingRecoveryRequestSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("native-embedding-recovery-status") }).strict(),
	z.object({ type: z.literal("native-embedding-recovery-review") }).strict(),
	z.object({ type: z.literal("native-embedding-recovery-apply"), planId: z.string().uuid() }).strict(),
	z.object({ type: z.literal("native-embedding-recovery-discard"), planId: z.string().uuid() }).strict(),
]);
export type NativeEmbeddingRecoveryRequest = z.infer<typeof NativeEmbeddingRecoveryRequestSchema>;
export const NativeEmbeddingRecoveryPreviewSchema = z.discriminatedUnion("state", [
	z.object({ state: z.literal("not-needed"), coreStatus: z.literal("ready") }).strict(),
	z.object({ state: z.literal("review"), planId: z.string().uuid(), expiresAt: z.string().datetime(),
		cancelledJobs: z.literal(1), coreStatus: z.literal("ready") }).strict(),
]);
export type NativeEmbeddingRecoveryPreview = z.infer<typeof NativeEmbeddingRecoveryPreviewSchema>;
export const NativeEmbeddingRecoveryAppliedSchema = z.object({
	cancelledJobs: z.literal(1), coreStatus: z.enum(["ready", "restart-required"]),
}).strict();
export type NativeEmbeddingRecoveryApplied = z.infer<typeof NativeEmbeddingRecoveryAppliedSchema>;
export const NativeEmbeddingRecoveryStatusSchema = z.discriminatedUnion("state", [
	z.object({ state: z.literal("idle") }).strict(),
	z.object({ state: z.literal("in-progress") }).strict(),
	z.object({ state: z.literal("unconfirmed") }).strict(),
	z.object({ state: z.literal("applied"), cancelledJobs: z.literal(1), coreStatus: z.enum(["ready", "restart-required"]) }).strict(),
]);
export type NativeEmbeddingRecoveryStatus = z.infer<typeof NativeEmbeddingRecoveryStatusSchema>;
