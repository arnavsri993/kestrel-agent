export function findTabToolMatches<T extends { title: string; url: string }>(
	entries: readonly T[],
	query: string,
	limit = entries.length,
): Array<{ entry: T; originalIndex: number }> {
	const needle = query.trim().toLowerCase();
	const matches: Array<{ entry: T; originalIndex: number }> = [];
	for (const [originalIndex, entry] of entries.entries()) {
		if (!`${entry.title} ${entry.url}`.toLowerCase().includes(needle)) continue;
		matches.push({ entry, originalIndex });
		if (matches.length >= limit) break;
	}
	return matches;
}
