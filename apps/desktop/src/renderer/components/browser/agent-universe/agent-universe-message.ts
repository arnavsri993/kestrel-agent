export interface AgentUniverseMessageAttempt {
	requestId: number;
	streamId: string;
	sessionId: string;
}

export interface AgentUniverseMessageLifecycle {
	mounted: boolean;
	nextRequestId: number;
	active: AgentUniverseMessageAttempt | null;
}

export function createAgentUniverseMessageLifecycle(): AgentUniverseMessageLifecycle {
	return { mounted: true, nextRequestId: 0, active: null };
}

export function beginAgentUniverseMessage(
	lifecycle: AgentUniverseMessageLifecycle,
	sessionId: string,
	streamId: string,
): AgentUniverseMessageAttempt | null {
	if (!lifecycle.mounted || lifecycle.active) return null;
	const attempt = {
		requestId: lifecycle.nextRequestId + 1,
		streamId,
		sessionId,
	};
	lifecycle.nextRequestId = attempt.requestId;
	lifecycle.active = attempt;
	return attempt;
}

export function isCurrentAgentUniverseMessage(
	lifecycle: AgentUniverseMessageLifecycle,
	attempt: AgentUniverseMessageAttempt,
): boolean {
	return (
		lifecycle.mounted &&
		lifecycle.active?.requestId === attempt.requestId &&
		lifecycle.active.streamId === attempt.streamId &&
		lifecycle.active.sessionId === attempt.sessionId
	);
}

export function isCurrentAgentUniverseStream(
	lifecycle: AgentUniverseMessageLifecycle,
	streamId: string,
	sessionId: string,
): boolean {
	return (
		lifecycle.mounted &&
		lifecycle.active?.streamId === streamId &&
		lifecycle.active.sessionId === sessionId
	);
}

export function finishAgentUniverseMessage(
	lifecycle: AgentUniverseMessageLifecycle,
	attempt: AgentUniverseMessageAttempt,
): void {
	if (isCurrentAgentUniverseMessage(lifecycle, attempt)) lifecycle.active = null;
}

export function resetAgentUniverseMessage(
	lifecycle: AgentUniverseMessageLifecycle,
): void {
	lifecycle.active = null;
	lifecycle.nextRequestId += 1;
}

export function unmountAgentUniverseMessage(
	lifecycle: AgentUniverseMessageLifecycle,
): void {
	lifecycle.mounted = false;
	lifecycle.active = null;
	lifecycle.nextRequestId += 1;
}
