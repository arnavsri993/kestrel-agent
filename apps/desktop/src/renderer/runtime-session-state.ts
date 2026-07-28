import type {
  RuntimeEvent,
  RuntimeSession,
  WorkspaceGrant,
} from "@kestrel/shared-types";

export type RuntimeRunScope = "idle" | "active" | "background";

export function runtimeSessionsAfterEvent(
  sessions: RuntimeSession[],
  event: RuntimeEvent,
): RuntimeSession[] {
  if (event.type !== "message.appended") return sessions;
  const rawUpdatedAt = event.payload.sessionUpdatedAt;
  if (typeof rawUpdatedAt !== "string") return sessions;
  const updatedAtTime = Date.parse(rawUpdatedAt);
  if (!Number.isFinite(updatedAtTime)) return sessions;
  const updatedAt = new Date(updatedAtTime).toISOString();
  let changed = false;
  const next = sessions.map((session) => {
    if (
      session.id !== event.sessionId ||
      updatedAtTime <= Date.parse(session.updatedAt)
    )
      return session;
    changed = true;
    return { ...session, updatedAt };
  });
  return changed ? next : sessions;
}

export function availableWorkspaceGrants(
  grants: WorkspaceGrant[],
): WorkspaceGrant[] {
  return grants.filter((grant) => grant.available !== false);
}

export function runtimeTaskWorkspace(input: {
  activeSessionId: string | null;
  sessionWorkspaceRoot?: string | undefined;
  draftWorkspaceRoot: string;
}): string | undefined {
  return input.activeSessionId
    ? input.sessionWorkspaceRoot
    : input.draftWorkspaceRoot || undefined;
}

export function shouldPreserveActiveRun(input: {
  streamId: string | null;
  streamSessionId: string | null;
  activeSessionId: string | null;
}): boolean {
  return (
    Boolean(input.streamId) &&
    input.streamSessionId !== null &&
    input.streamSessionId === input.activeSessionId
  );
}

export function runtimeRunScope(input: {
  busy: boolean;
  streamSessionId: string | null;
  activeSessionId: string | null;
  hasOptimisticNewTask: boolean;
}): RuntimeRunScope {
  if (!input.busy) return "idle";
  if (input.streamSessionId)
    return input.streamSessionId === input.activeSessionId
      ? "active"
      : "background";
  return input.hasOptimisticNewTask && input.activeSessionId === null
    ? "active"
    : "background";
}
