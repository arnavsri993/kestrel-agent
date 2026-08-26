import { z } from "zod";

/**
 * Writing is a local-first product surface. These contracts deliberately
 * describe voice adaptation and review, not detector scores or authorship
 * claims.
 */
export const WritingGenreSchema = z.enum([
	"email",
	"message",
	"professional",
	"general",
	"marketing",
	"academic",
	"social",
]);
export type WritingGenre = z.infer<typeof WritingGenreSchema>;

export const WritingAdaptationStrengthSchema = z.enum([
	"light",
	"balanced",
	"strong",
]);
export type WritingAdaptationStrength = z.infer<
	typeof WritingAdaptationStrengthSchema
>;

export const WritingProfileConfigSchema = z.object({
	enabled: z.boolean().default(false),
	useSelectedExemplars: z.boolean().default(false),
	maxExemplars: z.number().int().min(0).max(5).default(3),
});
export type WritingProfileConfig = z.infer<typeof WritingProfileConfigSchema>;

/** Aggregate signals are intentionally non-linguistic summaries. Raw text is
 * only retained for explicitly selected exemplars and remains encrypted. */
export const WritingProfileAggregateSchema = z.object({
	sampleCount: z.number().int().nonnegative(),
	wordCount: z.number().int().nonnegative(),
	sentenceCount: z.number().int().nonnegative(),
	paragraphCount: z.number().int().nonnegative(),
	averageSentenceWords: z.number().nonnegative(),
	sentenceLengthVariation: z.number().nonnegative(),
	averageParagraphSentences: z.number().nonnegative(),
	contractionRate: z.number().min(0).max(1),
	questionRate: z.number().min(0).max(1),
	exclamationRate: z.number().min(0).max(1),
	semicolonRate: z.number().min(0).max(1),
	emDashRate: z.number().min(0).max(1),
	parentheticalRate: z.number().min(0).max(1),
	firstPersonRate: z.number().min(0).max(1),
	shortSentenceRate: z.number().min(0).max(1),
	longSentenceRate: z.number().min(0).max(1),
});
export type WritingProfileAggregate = z.infer<
	typeof WritingProfileAggregateSchema
>;

export const WritingProfileStatusSchema = z.object({
	status: z.enum(["disabled", "learning", "ready"]),
	config: WritingProfileConfigSchema,
	sampleCount: z.number().int().nonnegative(),
	wordCount: z.number().int().nonnegative(),
	exemplarCount: z.number().int().nonnegative().max(5),
	aggregate: WritingProfileAggregateSchema,
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type WritingProfileStatus = z.infer<typeof WritingProfileStatusSchema>;

export const WritingContextCategorySchema = z.enum([
	"recipient",
	"relationship",
	"confirmed-profile",
	"memories",
	"calendar",
	"voice-profile",
]);
export type WritingContextCategory = z.infer<
	typeof WritingContextCategorySchema
>;

export const WritingContextPreviewSchema = z.object({
	requestedRecipient: z.string().max(300).optional(),
	recipient: z
		.object({
			id: z.string().min(1),
			displayName: z.string().min(1).max(300),
			relationship: z.string().max(500).optional(),
			organization: z.string().max(500).optional(),
			role: z.string().max(500).optional(),
		})
		.optional(),
	categories: z.array(WritingContextCategorySchema).max(6),
		confirmedProfileFacts: z.number().int().nonnegative(),
		memories: z.number().int().nonnegative(),
		calendarEvents: z.number().int().nonnegative(),
		sensitiveIncluded: z.boolean(),
	restrictedIncluded: z.literal(false),
	notes: z.array(z.string().min(1).max(500)).max(8),
});
export type WritingContextPreview = z.infer<typeof WritingContextPreviewSchema>;

export const WritingQualitySchema = z.object({
	factualAnchorCoverage: z.number().min(0).max(1),
	protectedAnchors: z.array(z.string().min(1).max(500)).max(80),
	missingAnchors: z.array(z.string().min(1).max(500)).max(40),
	reviewerIssues: z.array(z.string().min(1).max(1_000)).max(20),
	modelReviewed: z.boolean(),
	status: z.enum(["passed", "needs_attention"]),
	note: z.string().min(1).max(1_000),
});
export type WritingQuality = z.infer<typeof WritingQualitySchema>;

export const WritingResultSchema = z.object({
	id: z.string().min(1).max(200),
	genre: WritingGenreSchema,
	recipient: z.string().max(300).optional(),
	subject: z.string().max(500).optional(),
	body: z.string().min(1).max(50_000),
	sourceMode: z.enum(["compose", "adapt"]),
	context: WritingContextPreviewSchema,
	quality: WritingQualitySchema,
	createdAt: z.string().datetime(),
});
export type WritingResult = z.infer<typeof WritingResultSchema>;
