export type SensitiveTextReplacement = (kind: string, secret: string) => string;

/**
 * Find the first BEGIN, then scan forward for its next END. The two searches
 * advance over disjoint regions; a missing END searches the suffix only once.
 * Search only the delimiter needed in the current state so irrelevant markers
 * cannot consume hyphens that overlap a relevant marker. Incomplete blocks
 * retain their text rather than removing unrelated trailing instructions.
 */
export function replacePrivateKeyBlocks(
	value: string,
	replace: SensitiveTextReplacement,
	options: { caseInsensitive?: boolean } = {},
): string {
	const flags = options.caseInsensitive ? "giu" : "g";
	const begins = new RegExp("-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----", flags);
	const ends = new RegExp("-----END [A-Z0-9 ]*PRIVATE KEY-----", flags);
	const parts: string[] = [];
	let copiedThrough = 0;
	let begin: RegExpExecArray | null;
	while ((begin = begins.exec(value)) !== null) {
		ends.lastIndex = begins.lastIndex;
		if (ends.exec(value) === null) break;
		parts.push(
			value.slice(copiedThrough, begin.index),
			replace("PRIVATE_KEY", value.slice(begin.index, ends.lastIndex)),
		);
		copiedThrough = ends.lastIndex;
		begins.lastIndex = copiedThrough;
	}
	if (parts.length === 0) return value;
	parts.push(value.slice(copiedThrough));
	return parts.join("");
}

const URL_CREDENTIAL_PATTERN =
	/\b(https?:\/\/)([^:/?#@\s]+):([^@/?#\s]+)@/gi;
const URL_QUERY_PATTERN = /([?&])([^=?#&\s]{1,80})(=)([^&#\s"'<>]+)/g;
const JSON_FIELD_PATTERN =
	/(["'])([^"'`\r\n]{1,80})\1(\s*:\s*)(["'`])([^"'`\r\n]*)\4/g;
const IDENTIFIER_QUOTED_ASSIGNMENT_PATTERN =
	/\b([A-Za-z][A-Za-z0-9_.-]{1,79})(\s*(?:=|:|\bis\b)\s*)(["'`])([^"'`\r\n]*)\3/gi;
const IDENTIFIER_ASSIGNMENT_PATTERN =
	/\b([A-Za-z][A-Za-z0-9_.-]{1,79})(\s*(?:=|:|\bis\b)\s*)([^\s"'`,;&}\]]+)/gi;
const NATURAL_KEY_PATTERN =
	/(?:api[ \t]+key|access[ \t]+token|auth(?:orization)?|client[ \t]+secret|password|secret(?:[ \t]+key)?|private[ \t]+key|session[ \t]+cookie|credential|refresh[ \t]+token|id[ \t]+token)/;
const NATURAL_QUOTED_ASSIGNMENT_PATTERN = new RegExp(
	`\\b(${NATURAL_KEY_PATTERN.source})(\\s*(?:=|:|\\bis\\b)\\s*)(["'\`])([^"'\`\\r\\n]*)\\3`,
	"gi",
);
const NATURAL_ASSIGNMENT_PATTERN = new RegExp(
	`\\b(${NATURAL_KEY_PATTERN.source})(\\s*(?:=|:|\\bis\\b)\\s*)([^\\s"'\`,;&}\\]]+)`,
	"gi",
);
const ANTHROPIC_KEY_PATTERN = /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g;
const OPENAI_KEY_PATTERN =
	/\bsk-(?:proj-[A-Za-z0-9_-]{16,}|[A-Za-z0-9_-]{24,})\b/g;
const GITHUB_TOKEN_PATTERN =
	/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_-]{16,}\b/g;
const GOOGLE_API_KEY_PATTERN = /\bAIza[0-9A-Za-z_-]{20,}\b/g;
const AWS_ACCESS_KEY_PATTERN = /\bAKIA[0-9A-Z]{16}\b/g;
const SLACK_TOKEN_PATTERN = /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g;
const BEARER_TOKEN_PATTERN =
	/(\bBearer[ \t]+)([A-Za-z0-9._~+/=-]{20,})/gi;
const OPAQUE_PLACEHOLDER_PATTERN =
	/\[(?:[A-Z][A-Z0-9_]*_\d+|TASK_SECRET:[A-Za-z0-9._:-]+|REDACTED(?:_[A-Z][A-Z0-9_]*)?)\]/g;

function normalizedKey(key: string): string {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

function sensitiveKeyMatch(key: string): RegExpMatchArray | null {
	return normalizedKey(key).match(
		/(?:^|_)(api_key|access_token|auth_token|authorization|auth|client_secret|password|secret_key|secret|private_key|session_cookie|credentials?|refresh_token|id_token|token)(?:$|_)/,
	);
}

function isSensitiveKey(key: string): boolean {
	const normalized = normalizedKey(key);
	const match = sensitiveKeyMatch(key);
	if (!match || match.index === undefined) return false;
	const tail = normalized.slice(match.index + match[0].length);
	return !/^(?:enabled|disabled|required|configured|present|count|length|status|name|label|hint)$/.test(
		tail,
	);
}

function replacementKind(key: string): string {
	const normalized = normalizedKey(key);
	if (normalized.includes("password")) return "PASSWORD";
	if (normalized.includes("private_key")) return "PRIVATE_KEY";
	if (normalized.includes("cookie")) return "SESSION_COOKIE";
	if (normalized.includes("credential")) return "CREDENTIAL";
	if (normalized.includes("signature") || normalized.endsWith("_sig"))
		return "SIGNATURE";
	if (normalized.includes("secret")) return "SECRET";
	if (normalized.includes("authorization") || normalized === "auth")
		return "AUTHORIZATION";
	if (normalized.includes("access_token")) return "ACCESS_TOKEN";
	if (normalized.includes("refresh_token")) return "REFRESH_TOKEN";
	if (normalized.includes("id_token")) return "ID_TOKEN";
	if (normalized.endsWith("token")) return "TOKEN";
	return "API_KEY";
}

function isSensitiveUrlParameter(key: string): boolean {
	const normalized = normalizedKey(key);
	return /(?:^|_)(?:api_key|access_token|auth|authorization|token|id_token|refresh_token|secret|client_secret|password|credential|signature|sig|key)(?:$|_)/.test(
		normalized,
	);
}

function isSecretCandidate(value: string): boolean {
	const trimmed = value.trim();
	if (/^task-secret-[a-f0-9-]{36}$/.test(trimmed)) return false;
	if (trimmed.length < 8) return false;
	if (
		/^(?:true|false|null|undefined|yes|no|on|off|enabled|disabled|configured|missing|present)$/i.test(
			trimmed,
		)
	)
		return false;
	return !/^\[(?:[A-Z][A-Z0-9_]*_\d+|TASK_SECRET:[^\]]+|REDACTED(?:_[A-Z][A-Z0-9_]*)?)\]$/.test(
		trimmed,
	);
}

/**
 * Find secret-looking text and replace only the secret bytes.
 *
 * Replacements are protected while the remaining matchers run, so an opaque
 * reference returned by the callback is never interpreted as another secret.
 */
export function replaceSensitiveText(
	value: string,
	replace: SensitiveTextReplacement,
): string {
	const protectedValues: string[] = [];
	const knownReplacements = new Map<string, string>();
	let markerPrefix = "\uE000kestrel-sensitive:";
	while (value.includes(markerPrefix)) markerPrefix += ":";
	const markerSuffix = "\uE001";
	const protect = (replacement: string): string => {
		const index = protectedValues.push(replacement) - 1;
		return `${markerPrefix}${index}${markerSuffix}`;
	};
	const replaceSecret = (kind: string, secret: string): string => {
		if (secret.includes(markerPrefix)) return secret;
		const replacement = replace(kind, secret);
		knownReplacements.set(secret, replacement);
		return protect(replacement);
	};

	let result = value.replace(OPAQUE_PLACEHOLDER_PATTERN, (placeholder) =>
		protect(placeholder),
	);
	result = replacePrivateKeyBlocks(result, replaceSecret);
	result = result.replace(
		URL_CREDENTIAL_PATTERN,
		(_match, scheme: string, username: string, password: string) =>
			`${scheme}${replaceSecret("URL_CREDENTIAL", `${username}:${password}`)}@`,
	);
	result = result.replace(
		URL_QUERY_PATTERN,
		(match, prefix: string, key: string, equals: string, secret: string) =>
			isSensitiveUrlParameter(key) && isSecretCandidate(secret)
				? `${prefix}${key}${equals}${replaceSecret(replacementKind(key), secret)}`
				: match,
	);
	result = result.replace(
		JSON_FIELD_PATTERN,
		(match, keyQuote: string, key: string, separator: string, valueQuote: string, secret: string) =>
			isSensitiveKey(key) && isSecretCandidate(secret)
				? `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${replaceSecret(replacementKind(key), secret)}${valueQuote}`
				: match,
	);

	const replaceQuotedAssignment = (
		match: string,
		key: string,
		separator: string,
		quote: string,
		secret: string,
	): string =>
		isSensitiveKey(key) && isSecretCandidate(secret)
			? `${key}${separator}${quote}${replaceSecret(replacementKind(key), secret)}${quote}`
			: match;
	const replaceAssignment = (
		match: string,
		key: string,
		separator: string,
		secret: string,
	): string =>
		isSensitiveKey(key) && isSecretCandidate(secret)
			? `${key}${separator}${replaceSecret(replacementKind(key), secret)}`
			: match;

	result = result.replace(
		NATURAL_QUOTED_ASSIGNMENT_PATTERN,
		replaceQuotedAssignment,
	);
	result = result.replace(
		IDENTIFIER_QUOTED_ASSIGNMENT_PATTERN,
		replaceQuotedAssignment,
	);
	result = result.replace(NATURAL_ASSIGNMENT_PATTERN, replaceAssignment);
	result = result.replace(IDENTIFIER_ASSIGNMENT_PATTERN, replaceAssignment);
	result = result.replace(ANTHROPIC_KEY_PATTERN, (secret) =>
		replaceSecret("ANTHROPIC_API_KEY", secret),
	);
	result = result.replace(OPENAI_KEY_PATTERN, (secret) =>
		replaceSecret("OPENAI_API_KEY", secret),
	);
	result = result.replace(GITHUB_TOKEN_PATTERN, (secret) =>
		replaceSecret("GITHUB_TOKEN", secret),
	);
	result = result.replace(GOOGLE_API_KEY_PATTERN, (secret) =>
		replaceSecret("GOOGLE_API_KEY", secret),
	);
	result = result.replace(AWS_ACCESS_KEY_PATTERN, (secret) =>
		replaceSecret("AWS_ACCESS_KEY", secret),
	);
	result = result.replace(SLACK_TOKEN_PATTERN, (secret) =>
		replaceSecret("SLACK_TOKEN", secret),
	);
	result = result.replace(
		BEARER_TOKEN_PATTERN,
		(_match, prefix: string, secret: string) =>
			`${prefix}${replaceSecret("BEARER_TOKEN", secret)}`,
	);

	const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const markerPattern = `${escapePattern(markerPrefix)}(\\d+)${markerSuffix}`;
	// Match protected markers first. This also masks unlabelled repetitions of
	// any detected value without rewriting opaque references or replacements.
	const repeatedValues = [...knownReplacements.keys()]
		.sort((a, b) => b.length - a.length).map(escapePattern);
	const finalPattern = new RegExp(
		[markerPattern, ...repeatedValues].join("|"), "g",
	);
	return result.replace(finalPattern, (match, index: string | undefined) =>
		index === undefined
			? knownReplacements.get(match) ?? match
			: protectedValues[Number(index)] ?? match,
	);
}

/** Replace secret-looking text with a stable display-safe marker. */
export function maskSensitiveText(value: string): string {
	return replaceSensitiveText(value, () => "[REDACTED]");
}
