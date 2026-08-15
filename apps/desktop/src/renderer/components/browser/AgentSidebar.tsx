import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentState, RuntimeSession, UserBrowserTab } from "@kestrel/shared-types";
import { Brand } from "./Brand";
import { Icon } from "../Icon";
import { sessionTitleForDisplay } from "../../chat-title";

export function AgentSidebar({
  children,
  sessions,
  activeSessionId,
  activeTab,
  agentName,
  collapsed,
  agentState,
  activeDestination,
  onNewAgent,
  onToggleAgent,
  onOpenSession,
  onNavigate,
}: {
  children: ReactNode;
  sessions: RuntimeSession[];
  activeSessionId: string | null;
  activeTab?: UserBrowserTab;
  agentName: string;
  collapsed: boolean;
  agentState: AgentState;
  activeDestination: string;
  onNewAgent(prompt?: string): void;
  onToggleAgent(): void;
  onOpenSession(sessionId: string): void;
  onNavigate(destination: "browser" | "agent" | "history" | "downloads" | "settings" | "commands"): void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!historyOpen) return;
    function close(event: KeyboardEvent) {
      if (event.key === "Escape") setHistoryOpen(false);
    }
    function clickAway(event: PointerEvent) {
      if (event.target instanceof Node && !historyRef.current?.contains(event.target))
        setHistoryOpen(false);
    }
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", clickAway);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("pointerdown", clickAway);
    };
  }, [historyOpen]);

  const sortedSessions = [...sessions].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
  return (
    <aside
      className={`agent-sidebar ${collapsed ? "is-collapsed" : ""}`}
      aria-label={`${agentName} agent`}
      aria-hidden={collapsed}
    >
      <div className="agent-sidebar-header">
        <div className="agent-sidebar-drag" />
        <div className="agent-sidebar-identity">
          <Brand />
          <span className="agent-sidebar-agent-name">{agentName}</span>
          <button
            type="button"
            className="agent-sidebar-collapse"
            aria-label={`Minimize ${agentName}`}
            title={`Minimize ${agentName}`}
            onClick={onToggleAgent}
          >
            <Icon name="chevron" />
          </button>
        </div>
        <div className="agent-sidebar-actions" ref={historyRef}>
          <button type="button" className="agent-new-button" aria-label="New task" aria-keyshortcuts="Meta+N" onClick={() => onNewAgent()}>
            <Icon name="agent" />
            <span>New task</span>
            <kbd>⌘ N</kbd>
          </button>
          <button type="button" className="agent-history-button" aria-label="Task history" aria-expanded={historyOpen} onClick={() => setHistoryOpen((open) => !open)}>
            <Icon name="chat" />
          </button>
          {historyOpen && (
            <div className="agent-history-popover" aria-label="Task history">
              <header><strong>Task history</strong><small>{sortedSessions.length} task{sortedSessions.length === 1 ? "" : "s"}</small></header>
              {sortedSessions.length === 0 ? (
                <p>No tasks yet.</p>
              ) : (
                <div>
                  {sortedSessions.slice(0, 30).map((session) => (
                    <button
                      type="button"
                      key={session.id}
                      className={session.id === activeSessionId ? "active" : ""}
                      aria-current={session.id === activeSessionId ? "page" : undefined}
                      onClick={() => {
                        onOpenSession(session.id);
                        setHistoryOpen(false);
                      }}
                    >
                      <Icon name="chat" />
                      <span><strong>{sessionTitleForDisplay(session.title)}</strong><small>{new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(session.updatedAt))}</small></span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="agent-browser-context" title={activeTab?.url || "No page open"}>
          <Icon name="context" />
          <span><small>Current page</small><strong>{activeTab?.url ? activeTab.title : "No page open"}</strong></span>
        </div>
        <section className="agent-sidebar-history" aria-label="Recent chats">
          <div className="agent-sidebar-section-heading">
            <span>Recent chats</span>
            <button
              type="button"
              aria-label="Open task history"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen((open) => !open)}
            >
              <Icon name="history" />
              <span>All</span>
            </button>
          </div>
          {sortedSessions.length > 0 ? (
            <div className="agent-sidebar-history-list">
              {sortedSessions.slice(0, 6).map((session) => (
                <button
                  type="button"
                  key={session.id}
                  className={session.id === activeSessionId ? "active" : ""}
                  aria-current={session.id === activeSessionId ? "page" : undefined}
                  onClick={() => onOpenSession(session.id)}
                >
                  <Icon name="chat" />
                  <span>{sessionTitleForDisplay(session.title)}</span>
                </button>
              ))}
            </div>
          ) : (
            <p>No chats yet. Start a task below.</p>
          )}
        </section>
      </div>
      <div className="agent-conversation-host">{children}</div>
      <div className="agent-sidebar-footer">
        <nav aria-label="Kestrel destinations">
          {([
            ["browser", "Browser", "browser"],
            ["agent", "Agent", "agent"],
            ["history", "History", "history"],
            ["downloads", "Downloads", "downloads"],
            ["settings", "Settings", "settings"],
            ["commands", "More", "command"],
          ] as const).map(([destination, label, icon]) => (
            <button
              type="button"
              key={destination}
              id={destination === "commands" ? "kestrel-more" : undefined}
              aria-label={label}
              aria-current={activeDestination === destination ? "page" : undefined}
              className={activeDestination === destination ? "active" : ""}
              onClick={() => onNavigate(destination)}
            >
              <Icon name={icon} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="agent-quiet-status" role="status">
          <span className={`agent-dot ${agentState}`} />
          <span>{agentState === "waiting_approval" ? "Needs approval" : agentState === "working" ? "Working" : "Ready"}</span>
        </div>
      </div>
    </aside>
  );
}
