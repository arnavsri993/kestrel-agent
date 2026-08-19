export type BrowserMcpCallSession =
	| { ok: true; sessionId: string }
	| { ok: false; reason: "none" | "ambiguous" };

export function resolveUniqueMappedSession(
	activeThreadIds: Iterable<string>,
	threadToSession: ReadonlyMap<string, string>,
): BrowserMcpCallSession {
	const sessionIds = new Set<string>();
	for (const threadId of activeThreadIds) {
		const sessionId = threadToSession.get(threadId);
		if (sessionId) sessionIds.add(sessionId);
	}
	if (sessionIds.size === 0) return { ok: false, reason: "none" };
	if (sessionIds.size > 1) return { ok: false, reason: "ambiguous" };
	return { ok: true, sessionId: [...sessionIds][0]! };
}
