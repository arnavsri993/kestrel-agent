import { z } from "zod";

export const GMAIL_READONLY_SCOPE =
	"https://www.googleapis.com/auth/gmail.readonly";

export const CommunicationSourceIdSchema = z.enum(["mac-messages", "gmail"]);
export type CommunicationSourceId = z.infer<typeof CommunicationSourceIdSchema>;

export const CommunicationSourceStatusSchema = z.object({
	id: CommunicationSourceIdSchema,
	label: z.string().min(1).max(100),
	kind: z.enum(["local", "email"]),
	state: z.enum([
		"connected",
		"not_connected",
		"needs_permission",
		"needs_reconnect",
		"unavailable",
	]),
	detail: z.string().min(1).max(500),
	account: z.string().email().optional(),
});
export type CommunicationSourceStatus = z.infer<
	typeof CommunicationSourceStatusSchema
>;

const LOGIN_CODE_SCHEMA = z
	.string()
	.regex(/^[A-Z0-9][A-Z0-9-]{3,15}$/);

export const CommunicationCodeMatchSchema = z.object({
	sourceId: CommunicationSourceIdSchema,
	sourceLabel: z.string().min(1).max(100),
	account: z.string().email().optional(),
	sender: z.string().max(500).optional(),
	subject: z.string().max(500).optional(),
	code: LOGIN_CODE_SCHEMA,
	receivedAt: z.string().datetime(),
});
export type CommunicationCodeMatch = z.infer<
	typeof CommunicationCodeMatchSchema
>;

export const CommunicationCodeCandidateSchema = CommunicationCodeMatchSchema.extend(
	{
		id: z.string().regex(/^candidate-[a-f0-9-]{36}$/),
	},
);
export type CommunicationCodeCandidate = z.infer<
	typeof CommunicationCodeCandidateSchema
>;

export const CommunicationCodeScanSchema = z.object({
	scanId: z.string().regex(/^scan-[a-f0-9-]{36}$/),
	domain: z.string().min(1).max(253),
	siteLabel: z.string().min(1).max(200),
	scannedAt: z.string().datetime(),
	candidates: z.array(CommunicationCodeCandidateSchema).max(10),
	sources: z.array(CommunicationSourceStatusSchema).max(10),
});
export type CommunicationCodeScan = z.infer<typeof CommunicationCodeScanSchema>;

const CHALLENGE_HINT =
	/\b(?:verification|security|one[\s-]?time|login|log[\s-]?in|sign[\s-]?in|authentication|confirmation|passcode|otp)\b/i;
const CODE_HINT =
	/\b(?:code|passcode|pin|otp|one[\s-]?time[\s-]?password|verification)\b/i;
const ACTION_HINT =
	/\b(?:enter|type|provide|use|sent|received|expires|expire|verify)\b/i;

export interface LoginCodeChallengeInput {
	url: string;
	title: string;
	visibleText: string;
	forms: Array<{ label: string; type: string; name: string }>;
}

/**
 * Detect only the common verification-code handoff state. Page text is
 * untrusted browser content and stays in the renderer; this predicate merely
 * decides whether to offer a user-controlled code lookup.
 */
export function isLoginCodeChallenge(
	input: LoginCodeChallengeInput,
): boolean {
	const formText = input.forms
		.map((form) => `${form.label} ${form.type} ${form.name}`)
		.join(" ");
	const text = `${input.title}\n${input.visibleText}\n${formText}`.slice(
		0,
		60_000,
	);
	const hasCodeField = input.forms.some((form) =>
		/(one-time|otp|verification|security|passcode|auth|code|pin)/i.test(
			`${form.label} ${form.type} ${form.name}`,
		),
	);
	const hasPrompt =
		ACTION_HINT.test(text) && CHALLENGE_HINT.test(text) && CODE_HINT.test(text);
	if (!hasCodeField && !hasPrompt) return false;
	try {
		const url = new URL(input.url);
		return url.protocol === "https:" || url.protocol === "http:";
	} catch {
		return false;
	}
}

function validLoginCode(value: string): string | undefined {
	const normalized = value.replace(/\s+/g, "").toUpperCase();
	if (!LOGIN_CODE_SCHEMA.safeParse(normalized).success) return undefined;
	if (/^(.)\1+$/.test(normalized)) return undefined;
	return normalized;
}

/**
 * Extract short verification codes without returning the surrounding message
 * body. Numeric codes are accepted only beside an authentication hint so a
 * timestamp, phone number, or invoice number is not promoted as a login code.
 */
export function extractLoginCodes(value: string): string[] {
	const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 250_000);
	const values = new Set<string>();
	const add = (candidate: string) => {
		const normalized = validLoginCode(candidate);
		if (normalized) values.add(normalized);
	};

	const candidate =
		"(?<![A-Z0-9])([0-9](?:[0-9]|[- ](?=[0-9])){3,15}|[A-Z][A-Z0-9-]{3,15})(?![A-Z0-9])";
	for (const match of text.matchAll(
		new RegExp(
			`\\b(?:verification|security|login|log[\\s-]?in|sign[\\s-]?in|authentication|confirmation|one[\\s-]?time|passcode|otp|pin)\\b[^\\n]{0,60}?\\b(?:code|passcode|pin|otp|password)\\b[^\\n]{0,20}?(?:is|:|=|-)??\\s*${candidate}`,
			"gi",
		),
	))
		add(match[1] ?? "");

	if (values.size === 0 && CHALLENGE_HINT.test(text) && CODE_HINT.test(text))
		for (const match of text.matchAll(
			new RegExp(
				`\\b(?:code|passcode|pin|otp)\\b[^\\n]{0,20}?(?:is|:|=|-)\\s*${candidate}`,
				"gi",
			),
		))
			add(match[1] ?? "");

	return [...values].slice(0, 3);
}
