import type { AgentState, RuntimeSession } from "@kestrel/shared-types";
import { useMemo, useState } from "react";
import {
  type AgentSessionFilter,
  agentSessionRecency,
  agentSessionStatusLabel,
  agentSessionTreeForWorkspace,
  agentStateLabel,
  agentWorkspaceName,
} from "../../agent-workspace";
import { sessionTitleForDisplay } from "../../chat-title";
import { Icon } from "../Icon";
import { SurfaceBackButton } from "./SurfaceBackButton";
import { Button, EmptyState, PageFrame, Status } from "../ui";
import "./surface-pages.css";

const filters: Array<{ id: AgentSessionFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "done", label: "Completed" },
];

export function AgentWorkspace({
  sessions,
  activeSessionId,
  agentState,
  pendingApprovals,
  onNewTask,
  onOpenSession,
  onOpenApprovals,
  onOpenWork,
  onBack,
}: {
  sessions: RuntimeSession[];
  activeSessionId: string | null;
  agentState: AgentState;
  pendingApprovals: number;
  onNewTask(): void;
  onOpenSession(sessionId: string): void;
  onOpenApprovals(): void;
  onOpenWork(): void;
  onBack?(): void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AgentSessionFilter>("all");
  const visibleSessions = useMemo(
    () => agentSessionTreeForWorkspace(sessions, query, filter),
    [filter, query, sessions],
  );
  const openCount = sessions.filter((session) =>
    ["active", "waiting"].includes(session.status),
  ).length;

  return (
    <main className="agent-workspace" aria-labelledby="agent-workspace-title">
      <PageFrame
        as="div"
        title="Tasks"
        titleId="agent-workspace-title"
        description="Open work stays local, with run state and approvals visible before you enter a task."
        measure="wide"
        actions={
          <>
            {onBack ? <SurfaceBackButton onBack={onBack} /> : null}
            <Button variant="solid" size="compact" onClick={onNewTask}>
              Start a task
            </Button>
          </>
        }
      >
        <section
          className="agent-workspace-status surface-row-group"
          aria-label="Agent status"
        >
          <div>
            <span className={`agent-dot ${agentState}`} aria-hidden="true" />
            <span>
              <small>Agent</small>
              <Status
                tone={
                  agentState === "error"
                    ? "error"
                    : agentState === "working"
                      ? "running"
                      : "neutral"
                }
              >
                {agentStateLabel(agentState)}
              </Status>
            </span>
          </div>
          <div>
            <Icon name="work" />
            <span>
              <small>Open</small>
              <strong>{openCount} tasks</strong>
            </span>
          </div>
          <button type="button" onClick={onOpenWork}>
            <Icon name="work" />
            <span>
              <small>Work</small>
              <strong>Goals and runs</strong>
            </span>
            <Icon name="chevron" />
          </button>
        </section>

        <section
          className="agent-task-library"
          aria-labelledby="agent-task-library-title"
        >
          <header>
            <div>
              <h2 id="agent-task-library-title" className="sr-only">
                Task list
              </h2>
            </div>
            <label className="agent-task-search">
              <Icon name="search" />
              <span className="sr-only">Find a task</span>
              <input
                type="search"
                value={query}
                placeholder="Search tasks…"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="agent-task-filters" aria-label="Filter tasks">
              {filters.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  aria-pressed={filter === item.id}
                  onClick={() => setFilter(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </header>

          {visibleSessions.length ? (
            <ul className="agent-task-list">
              {visibleSessions.map(({ session, depth, parentTitle }) => {
                const active = session.id === activeSessionId;
                const workspaceName = agentWorkspaceName(session.workspaceRoot);
                const lineage = parentTitle
                  ? `From ${sessionTitleForDisplay(parentTitle)}${workspaceName ? ` · ${workspaceName}` : ""}`
                  : workspaceName;
                return (
                  <li key={session.id}>
                    <button
                      type="button"
                      className={active ? "active" : ""}
                      style={
                        depth > 0
                          ? {
                              paddingInlineStart: `calc(18px + ${depth * 24}px)`,
                            }
                          : undefined
                      }
                      aria-current={active ? "page" : undefined}
                      aria-label={`${sessionTitleForDisplay(session.title)}, ${agentSessionStatusLabel(session.status)}${lineage ? `, ${lineage}` : ""}`}
                      onClick={() => onOpenSession(session.id)}
                    >
                      <span
                        className={`agent-task-state ${session.status}`}
                        aria-hidden="true"
                      />
                      <span className="agent-task-copy">
                        <strong>{sessionTitleForDisplay(session.title)}</strong>
                        {lineage ? <small>{lineage}</small> : null}
                      </span>
                      <span className="agent-task-meta">
                        <strong>
                          {agentSessionStatusLabel(session.status)}
                        </strong>
                        <time dateTime={session.updatedAt}>
                          {agentSessionRecency(session.updatedAt)}
                        </time>
                      </span>
                      <Icon name="chevron" />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState
              className="agent-task-empty"
              title={
                query
                  ? "No matching tasks"
                  : sessions.length
                    ? `No ${filter === "done" ? "completed" : filter} tasks`
                    : "No tasks yet"
              }
              detail={
                query
                  ? "Try a different search."
                  : sessions.length
                    ? "Switch filters to see the rest."
                    : "Tasks you start will appear here with their project and state."
              }
              action={
                query ? (
                  <Button
                    variant="quiet"
                    size="compact"
                    onClick={() => setQuery("")}
                  >
                    Clear search
                  </Button>
                ) : !sessions.length ? (
                  <Button variant="solid" onClick={onNewTask}>
                    Start a task
                  </Button>
                ) : undefined
              }
            />
          )}
        </section>
      </PageFrame>
    </main>
  );
}
