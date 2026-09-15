import { z } from "zod";
export const SourceObservationSchema = z.object({
 providerMessageId: z.string().min(1).max(500).optional(),
 senderId: z.string().max(500).optional(),
 senderName: z.string().max(300).optional(),
 occurredAt: z.string().datetime(),
 originalTimestamp: z.string().max(200).optional(),
 timezone: z.string().max(100).optional(),
 text: z.string().max(20_000),
 replyTo: z.string().max(500).optional(),
 attachments: z.array(z.object({ reference: z.string().max(2000), status: z.enum(["not_processed", "unavailable"]) })).max(30).default([]),
 state: z.enum(["observed", "edited", "deleted", "expired"]).default("observed"),
}).strict();
export type SourceObservation = z.infer<typeof SourceObservationSchema>;
export const SourceSelectionSchema = z.object({
 connectionId: z.string().min(1).max(300),
 resourceId: z.string().min(1).max(1000),
 sessionId: z.string().min(1).max(200),
 label: z.string().min(1).max(300),
 dateOrder: z.enum(["MDY", "DMY"]).optional(),
 timezone: z.string().max(100).optional(),
 processingConsent: z.literal(true),
 modelProcessingConsent: z.boolean(),
 privacy: z.enum(["permitted", "unknown", "blocked"]),
 status: z.enum(["ready", "paused", "login_required", "unavailable", "privacy_blocked", "structure_changed", "interrupted", "disconnected"]),
 coverage: z.enum(["unknown", "partial", "interrupted"]),
 lastSyncedAt: z.string().datetime().optional(),
 oldestObservedAt: z.string().datetime().optional(),
 newestObservedAt: z.string().datetime().optional(),
 checkpoint: z.string().max(200).optional(),
 updatedAt: z.string().datetime(),
}).strict();
export type SourceSelection = z.infer<typeof SourceSelectionSchema>;
