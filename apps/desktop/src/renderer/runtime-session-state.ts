import type { WorkspaceGrant } from "@kestrel/shared-types";

export type RuntimeRunScope = "idle" | "active" | "background";

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
