import { z } from "zod";

export const NEW_TAB_GREETING_TIME_BUCKETS = [
	"late-night",
	"early-morning",
	"morning",
	"afternoon",
	"evening",
] as const;
export type NewTabGreetingTimeBucket =
	(typeof NEW_TAB_GREETING_TIME_BUCKETS)[number];
export const NewTabGreetingTimeBucketSchema = z.enum(
	NEW_TAB_GREETING_TIME_BUCKETS,
);

export const NewTabGreetingUsualVisitTimeSchema = z.enum([
	...NEW_TAB_GREETING_TIME_BUCKETS,
	"varied",
	"unknown",
] as const);
export type NewTabGreetingUsualVisitTime = z.infer<
	typeof NewTabGreetingUsualVisitTimeSchema
>;

export const NewTabGreetingVisitFrequencySchema = z.enum([
	"first-time",
	"occasional",
	"regular",
	"frequent",
] as const);
export type NewTabGreetingVisitFrequency = z.infer<
	typeof NewTabGreetingVisitFrequencySchema
>;

export const NewTabGreetingTodayVisitSchema = z.enum([
	"first-today",
	"returning-today",
] as const);
export type NewTabGreetingTodayVisit = z.infer<
	typeof NewTabGreetingTodayVisitSchema
>;

const DEFAULT_TIME_BUCKET_COUNTS = {
	"late-night": 0,
	"early-morning": 0,
	morning: 0,
	afternoon: 0,
	evening: 0,
} as const;

export const NewTabGreetingTimeBucketCountsSchema = z
	.object({
		"late-night": z.number().int().min(0).max(100).default(0),
		"early-morning": z.number().int().min(0).max(100).default(0),
		morning: z.number().int().min(0).max(100).default(0),
		afternoon: z.number().int().min(0).max(100).default(0),
		evening: z.number().int().min(0).max(100).default(0),
	})
	.strict()
	.default(DEFAULT_TIME_BUCKET_COUNTS);
export type NewTabGreetingTimeBucketCounts = z.infer<
	typeof NewTabGreetingTimeBucketCountsSchema
>;

export const NewTabGreetingActivityDaySchema = z
	.object({
		// This is a local calendar day only; no timestamp, URL, title, or page
		// identity is retained for the front-desk style greeting.
		day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
		visits: z.number().int().min(1).max(100).default(1),
		buckets: NewTabGreetingTimeBucketCountsSchema,
	})
	.strict();
export type NewTabGreetingActivityDay = z.infer<
	typeof NewTabGreetingActivityDaySchema
>;

const DEFAULT_NEW_TAB_GREETING_ACTIVITY = {
	version: 1 as const,
	days: [],
};

/**
 * Local-only, bounded presence metadata for the New Tab welcome. It is
 * deliberately separate from browsing history and contains no page data.
 */
export const NewTabGreetingActivitySchema = z
	.object({
		version: z.literal(1).default(1),
		days: z.array(NewTabGreetingActivityDaySchema).max(31).default([]),
	})
	.strict()
	.default(DEFAULT_NEW_TAB_GREETING_ACTIVITY)
	.catch(DEFAULT_NEW_TAB_GREETING_ACTIVITY);
export type NewTabGreetingActivity = z.infer<
	typeof NewTabGreetingActivitySchema
>;

export const NewTabGreetingContextSchema = z
	.object({
		firstName: z.string().max(40).optional(),
		currentTimeOfDay: NewTabGreetingTimeBucketSchema,
		usualVisitTime: NewTabGreetingUsualVisitTimeSchema,
		visitFrequency: NewTabGreetingVisitFrequencySchema,
		todayVisit: NewTabGreetingTodayVisitSchema,
	})
	.strict();
export type NewTabGreetingContext = z.infer<
	typeof NewTabGreetingContextSchema
>;

/**
 * Keep the local account display name to a single harmless first-name token.
 * This is shared by the renderer and Agent Core so model input and fallback
 * copy have the same privacy boundary.
 */
export function safeNewTabGreetingName(
	value: string | undefined,
): string | undefined {
	const normalized = value?.normalize("NFKC").trim();
	if (
		!normalized ||
		normalized.length > 80 ||
		!/^[\p{L}\p{M}'\-\s]+$/u.test(normalized)
	)
		return undefined;
	const token = normalized.split(/\s+/)[0];
	if (
		!token ||
		token.length > 40 ||
		!/^[\p{L}\p{M}][\p{L}\p{M}'-]*$/u.test(token)
	)
		return undefined;
	return token;
}

/**
 * Defense-in-depth validation for model output. The model receives only the
 * bounded context above, but its response still must not introduce URLs,
 * personal-data references, exact counts, or a second sentence.
 */
export function validateNewTabGreeting(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	if (
		!text ||
		text.length > 120 ||
		text.split(/\s+/).length > 14 ||
		/[\r\n\u0000-\u001f\u007f]/u.test(text) ||
		/[<>[\]{}*_#`~|]/u.test(text) ||
		!/^[\p{L}\p{M}\s,.?!'\-]+$/u.test(text) ||
		/\d/u.test(text) ||
		/(?:https?:\/\/|www\.|@)/iu.test(text) ||
		!/[\p{L}]/u.test(text) ||
		!/[.!?]$/u.test(text) ||
		(text.match(/[.!?]/gu) ?? []).length !== 1
	)
		return undefined;

	if (
		/\b(?:browser|browsing|email|emails|file|files|history|message|messages|page|pages|past|project|projects|site|sites|tab|tabs|topic|topics|url|urls|yesterday|last\s+(?:time|visit)|remember(?:ed|ing)?|location|cannot|can't|unable|sorry|assistant|language\s+model|instruction|prompt)\b/iu.test(
			text,
		)
	)
		return undefined;
	if (
		/\b(?:once|twice|one|two|three|four|five|six|seven|eight|nine|ten|several|dozens?)\b/iu.test(
			text,
		)
	)
		return undefined;
	return text;
}

export function newTabGreetingFallback(name?: string): string {
	const firstName = safeNewTabGreetingName(name);
	return firstName ? `Hello, ${firstName}.` : "Hello.";
}

export function emptyNewTabGreetingActivity(): NewTabGreetingActivity {
	return NewTabGreetingActivitySchema.parse({});
}
