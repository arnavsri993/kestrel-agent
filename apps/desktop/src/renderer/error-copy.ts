/**
 * Keep implementation details out of the product UI while preserving useful,
 * short service messages such as an invalid key or an unavailable provider.
 */
export function userFacingError(cause: unknown, fallback: string): string {
	const raw =
		typeof cause === "string"
			? cause
			: cause instanceof Error
				? cause.message
				: "";
	const message = raw.trim();
	if (!message) return fallback;
	if (
		/^error invoking remote method\b/i.test(message) ||
		/(?:^|\n)\s*at\s+(?:file:|\/|node:)/i.test(message) ||
		/(?:^|\s)(?:node_modules|node:internal|electron\/)/i.test(message) ||
		message.includes("/Users/")
	)
		return fallback;
	const clean = message.replace(/^error:\s*/i, "").trim();
	return clean.length > 240 ? fallback : clean || fallback;
}
