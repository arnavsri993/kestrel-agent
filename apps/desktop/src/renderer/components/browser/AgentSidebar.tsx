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
  agentState,
  activeDestination,
  onNewAgent,
  onOpenSession,
  onNavigate,
}: {
  children: ReactNode;
  sessions: RuntimeSession[];
  activeSessionId: string | null;
  activeTab?: UserBrowserTab;
  agentState: AgentState;
  activeDestination: string;
  onNewAgent(): void;
  onOpenSession(sessionId: string): void;
  onNavigate(destination: "browser" | "history" | "downloads" | "settings" | "commands"): void;
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
    <aside className="agent-sidebar" aria-label="Kestrel agent">
      <div className="agent-sidebar-header">
        <div className="agent-sidebar-drag" />
        <Brand />
        <div className="agent-sidebar-actions" ref={historyRef}>
          <button type="button" className="agent-new-button" aria-label="New Agent" aria-keyshortcuts="Meta+N" onClick={onNewAgent}>
            <Icon name="agent" />
            <span>New Agent</span>
            <kbd>⌘ N</kbd>
          </button>
          <button type="button" className="agent-history-button" aria-label="Agent history" aria-expanded={historyOpen} onClick={() => setHistoryOpen((open) => !open)}>
            <Icon name="chat" />
          </button>
          {historyOpen && (
            <div className="agent-history-popover" aria-label="Agent history">
              <header><strong>Agent history</strong><small>{sessions.length} conversation{sessions.length === 1 ? "" : "s"}</small></header>
              {sortedSessions.length === 0 ? (
                <p>No conversations yet.</p>
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
          <span><small>Current page</small><strong>{activeTab?.url ? activeTab.title : "New Tab"}</strong></span>
        </div>
      </div>
      <div className="agent-conversation-host">{children}</div>
      <div className="agent-sidebar-footer">
        <nav aria-label="Kestrel destinations">
          {([
            ["browser", "Browser", "browser"],
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
