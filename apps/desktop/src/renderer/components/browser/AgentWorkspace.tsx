import { useMemo, useRef, useState } from "react";
import type { AgentState, RuntimeSession } from "@kestrel/shared-types";
import {
  agentSessionRecency,
  agentSessionsForWorkspace,
  agentSessionStatusLabel,
  agentStateLabel,
  agentWorkspaceName,
  type AgentSessionFilter,
} from "../../agent-workspace";
import { sessionTitleForDisplay } from "../../chat-title";
import { BrandMark } from "../BrandMark";
import { Icon } from "../Icon";

const filters: Array<{ id: AgentSessionFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "done", label: "Done" },
  { id: "archived", label: "Archived" },
];

export function AgentWorkspace({
  sessions,
  activeSessionId,
  agentState,
  pendingApprovals,
  onNewTask,
  onOpenSession,
  onSetSessionArchived,
  onOpenApprovals,
  onOpenWork,
}: {
  sessions: RuntimeSession[];
  activeSessionId: string | null;
  agentState: AgentState;
  pendingApprovals: number;
  onNewTask(): void;
  onOpenSession(sessionId: string): void;
  onSetSessionArchived(sessionId: string, archived: boolean): Promise<void>;
  onOpenApprovals(): void;
  onOpenWork(): void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AgentSessionFilter>("all");
  const [archiveBusyId, setArchiveBusyId] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState("");
  const allFilterRef = useRef<HTMLButtonElement>(null);
  const archivedFilterRef = useRef<HTMLButtonElement>(null);
  const visibleSessions = useMemo(
    () => agentSessionsForWorkspace(sessions, query, filter),
    [filter, query, sessions],
  );
  const currentSessions = sessions.filter((session) => !session.archivedAt);
  const archivedCount = sessions.length - currentSessions.length;
  const openCount = currentSessions.filter((session) =>
    ["active", "waiting"].includes(session.status),
  ).length;

  async function setSessionArchived(
    session: RuntimeSession,
    archived: boolean,
  ) {
    const previousFocus = document.activeElement;
    (archived ? archivedFilterRef : allFilterRef).current?.focus();
    setArchiveBusyId(session.id);
    setArchiveError("");
    try {
      await onSetSessionArchived(session.id, archived);
    } catch (cause) {
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
      setArchiveError(
        cause instanceof Error
          ? cause.message
          : "Could not update the task archive.",
      );
    } finally {
      setArchiveBusyId(null);
    }
  }

  return (
    <main className="agent-workspace" aria-labelledby="agent-workspace-title">
      <header className="agent-workspace-header">
        <div className="agent-workspace-heading">
          <span className="agent-workspace-mark" aria-hidden="true"><BrandMark /></span>
          <div>
            <h1 id="agent-workspace-title">Your agent</h1>
            <p>Start work, return to it, and see what needs you.</p>
          </div>
        </div>
      </header>

      <section className="agent-workspace-status" aria-label="Agent status">
        <div>
          <span className={`agent-dot ${agentState}`} aria-hidden="true" />
          <span>
            <small>Agent</small>
            <strong>{agentStateLabel(agentState)}</strong>
          </span>
        </div>
        <div>
          <Icon name="work" />
          <span>
            <small>Open tasks</small>
            <strong>{openCount}</strong>
          </span>
        </div>
        <button type="button" onClick={onOpenApprovals}>
          <Icon name="approvals" />
          <span>
            <small>Approvals</small>
            <strong>{pendingApprovals ? `${pendingApprovals} need${pendingApprovals === 1 ? "s" : ""} you` : "None waiting"}</strong>
          </span>
          <Icon name="chevron" />
        </button>
        <button type="button" onClick={onOpenWork}>
          <Icon name="work" />
          <span>
            <small>Plans and schedules</small>
            <strong>Open Work</strong>
          </span>
          <Icon name="chevron" />
        </button>
      </section>

      <section className="agent-task-library" aria-labelledby="agent-task-library-title">
        <header>
          <div>
            <h2 id="agent-task-library-title">Tasks</h2>
            <span>
              {currentSessions.length} current
              {archivedCount ? ` · ${archivedCount} archived` : ""}
            </span>
          </div>
          <label className="agent-task-search">
            <Icon name="search" />
            <span className="sr-only">Find a task or project</span>
            <input
              type="search"
              value={query}
              placeholder="Find a task or project"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="agent-task-filters" aria-label="Filter tasks">
            {filters.map((item) => (
              <button
                type="button"
                key={item.id}
                ref={
                  item.id === "all"
                    ? allFilterRef
                    : item.id === "archived"
                      ? archivedFilterRef
                      : undefined
                }
                aria-pressed={filter === item.id}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <p className="sr-only" id="agent-task-archive-description">
            Archiving hides a task without deleting its history and pauses its
            scheduled work until the task is restored.
          </p>
        </header>

        {visibleSessions.length ? (
          <ul className="agent-task-list">
            {visibleSessions.map((session) => {
              const active = session.id === activeSessionId;
              const archived = Boolean(session.archivedAt);
              const statusLabel = archived
                ? "Archived"
                : agentSessionStatusLabel(session.status);
              return (
                <li key={session.id}>
                  <button
                    type="button"
                    className={`agent-task-open ${active ? "active" : ""}`}
                    aria-current={active ? "page" : undefined}
                    aria-label={`${sessionTitleForDisplay(session.title)}, ${statusLabel}, ${agentWorkspaceName(session.workspaceRoot)}`}
                    disabled={archived}
                    title={archived ? "Restore this task before opening it" : undefined}
                    onClick={() => onOpenSession(session.id)}
                  >
                    <span className={`agent-task-state ${session.status}`} aria-hidden="true" />
                    <span className="agent-task-copy">
                      <strong>{sessionTitleForDisplay(session.title)}</strong>
                      <small>{agentWorkspaceName(session.workspaceRoot)}</small>
                    </span>
                    <span className="agent-task-meta">
                      <strong>{statusLabel}</strong>
                      <time dateTime={session.updatedAt}>{agentSessionRecency(session.updatedAt)}</time>
                    </span>
                    <Icon name="chevron" />
                  </button>
                  <button
                    type="button"
                    className="agent-task-archive"
                    disabled={archiveBusyId === session.id}
                    aria-label={`${archived ? "Restore" : "Archive"} ${sessionTitleForDisplay(session.title)}`}
                    aria-describedby="agent-task-archive-description"
                    title={
                      archived
                        ? "Restore this task to the main list"
                        : "Hide this task without deleting its history and pause scheduled work"
                    }
                    onClick={() =>
                      void setSessionArchived(session, !archived)
                    }
                  >
                    <Icon name={archived ? "restore" : "archive"} />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="agent-task-empty">
            <Icon name={query ? "search" : "agent"} />
            <h3>{query ? "No matching tasks" : sessions.length ? `No ${filter} tasks` : "No tasks yet"}</h3>
            <p>{query ? "Try a title or project name." : sessions.length ? "Choose another filter to see your work." : "Start with an outcome. Kestrel will keep the conversation, project, approvals, and result together."}</p>
            {query ? (
              <button type="button" className="quiet-link" onClick={() => setQuery("")}>Clear search</button>
            ) : !sessions.length ? (
              <button type="button" className="button primary" onClick={onNewTask}>Start a task</button>
            ) : null}
          </div>
        )}
        {archiveError && (
          <p className="agent-task-error" role="alert">
            {archiveError}
          </p>
        )}
      </section>
    </main>
  );
}
