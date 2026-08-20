import { useMemo, useRef, useState, type FormEvent } from "react";
import type {
  RuntimeSession,
  UserBrowserBookmark,
  UserBrowserHistoryEntry,
  UserBrowserSettings,
  WorkspaceGrant,
} from "@kestrel/shared-types";
import meadowLandscape from "../../assets/new-tab-meadow.svg";
import { agentWorkspaceName, agentSessionRecency } from "../../agent-workspace";
import { sessionTitleForDisplay } from "../../chat-title";
import { Icon } from "../Icon";
import {
  browserSiteLabel,
  frequentBrowserSites,
  type FrequentBrowserSite,
  siteAccent,
  siteFaviconUrl,
  siteInitial,
  suggestedAgentActions,
} from "./new-tab";
import "./new-tab.css";

function FrequentFavicon({ site }: { site: FrequentBrowserSite }) {
  const [failed, setFailed] = useState(false);
  if (failed) return siteInitial(site);
  return (
    <img
      src={siteFaviconUrl(site.hostname)}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function homeInputLooksLikeBrowse(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (/^(https?:\/\/|localhost(:\d+)?(\/|$))/i.test(trimmed)) return true;
  try {
    const parsed = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
    );
    return (
      ["http:", "https:"].includes(parsed.protocol) && parsed.hostname.includes(".")
    );
  } catch {
    return false;
  }
}

type SidebarSection = "projects" | "history";

export function NewTabPage({
  history,
  bookmarks = [],
  background,
  agentName,
  sessions = [],
  projects = [],
  onNavigate,
  onNewAgent,
  onOpenSession,
}: {
  history: UserBrowserHistoryEntry[];
  bookmarks?: UserBrowserBookmark[];
  background: UserBrowserSettings["newTabBackground"];
  agentName: string;
  sessions?: RuntimeSession[];
  projects?: WorkspaceGrant[];
  onNavigate(input: string): void;
  onNewAgent(prompt?: string): void;
  onOpenSession?(sessionId: string): void;
}) {
  const [input, setInput] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarSection, setSidebarSection] =
    useState<SidebarSection>("projects");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const frequent = useMemo(
    () => frequentBrowserSites(history, 7),
    [history],
  );
  const suggestedActions = useMemo(
    () => suggestedAgentActions(history),
    [history],
  );
  const recentSessions = useMemo(
    () =>
      [...sessions]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 12),
    [sessions],
  );
  const hasBackgroundImage = background === "graphite" || background === "meadow";
  const modelRoutingLabel = "Smart";
  const modelRoutingTitle = "Smart routing";

  function submitChat(event: FormEvent) {
    event.preventDefault();
    const prompt = input.trim();
    if (!prompt) return;
    setInput("");
    if (homeInputLooksLikeBrowse(prompt)) {
      onNavigate(prompt);
      return;
    }
    onNewAgent(prompt);
  }

  function chooseAction(prompt: string) {
    onNewAgent(prompt);
  }

  return (
    <section
      className={`new-tab-page kestrel-home new-tab-page-${background}${
        sidebarOpen ? " new-tab-sidebar-open" : " new-tab-sidebar-collapsed"
      }`}
      aria-labelledby="new-tab-title"
    >
      <div
        className="kestrel-home-backdrop"
        aria-hidden="true"
        style={
          hasBackgroundImage
            ? { backgroundImage: `url("${meadowLandscape}")` }
            : undefined
        }
      />

      <aside
        className="new-tab-sidebar"
        aria-label="Projects and chat history"
      >
        <button
          type="button"
          className="new-tab-sidebar-toggle"
          aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          onClick={() => setSidebarOpen((value) => !value)}
        >
          <Icon name={sidebarOpen ? "back" : "forward"} />
        </button>

        {sidebarOpen && (
          <>
            <div
              className="new-tab-sidebar-tabs"
              role="tablist"
              aria-label="Sidebar sections"
            >
              <button
                type="button"
                role="tab"
                aria-selected={sidebarSection === "projects"}
                className={sidebarSection === "projects" ? "active" : ""}
                onClick={() => setSidebarSection("projects")}
              >
                Projects
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sidebarSection === "history"}
                className={sidebarSection === "history" ? "active" : ""}
                onClick={() => setSidebarSection("history")}
              >
                Chat history
              </button>
            </div>

            <div className="new-tab-sidebar-panel" role="tabpanel">
              {sidebarSection === "projects" ? (
                projects.length > 0 ? (
                  <ul className="new-tab-sidebar-list">
                    {projects.map((project) => (
                      <li key={project.path}>
                        <button
                          type="button"
                          title={project.path}
                          onClick={() =>
                            onNewAgent(
                              `Review ${project.name} and recommend the highest-impact next step.`,
                            )
                          }
                        >
                          <Icon name="work" />
                          <span>{project.name}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="new-tab-sidebar-empty">No projects connected yet.</p>
                )
              ) : recentSessions.length > 0 ? (
                <ul className="new-tab-sidebar-list">
                  {recentSessions.map((session) => (
                    <li key={session.id}>
                      <button
                        type="button"
                        title={agentWorkspaceName(session.workspaceRoot)}
                        onClick={() => onOpenSession?.(session.id)}
                      >
                        <Icon name="agent" />
                        <span>
                          <strong>{sessionTitleForDisplay(session.title)}</strong>
                          <small>{agentSessionRecency(session.updatedAt)}</small>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="new-tab-sidebar-empty">Chat history will appear here.</p>
              )}
            </div>
          </>
        )}
      </aside>

      <div className="kestrel-home-content">
        <header className="kestrel-home-hero">
          <h1 id="new-tab-title">Hi there, what should we dive into today?</h1>

          <form className="kestrel-home-composer" onSubmit={submitChat}>
            <label className="sr-only" htmlFor="new-tab-chat-input">
              Message {agentName} or enter a website
            </label>
            <input
              ref={inputRef}
              id="new-tab-chat-input"
              value={input}
              placeholder={`Message ${agentName}, enter a website, or @ mention a tab`}
              autoCapitalize="sentences"
              autoCorrect="on"
              spellCheck
              onChange={(event) => setInput(event.target.value)}
            />
            <div className="kestrel-home-composer-footer">
              <button
                type="button"
                className="kestrel-home-composer-icon is-disabled"
                aria-label="Add context"
                aria-disabled="true"
                title="Add context in the agent workspace"
                disabled
              >
                <Icon name="plus" />
              </button>

              <details className="kestrel-home-model-selector">
                <summary
                  aria-label={`Model selector: ${modelRoutingLabel}`}
                  title={`Model selector · ${modelRoutingTitle}`}
                >
                  <span>{modelRoutingLabel}</span>
                  <Icon name="chevron" />
                </summary>
                <div className="kestrel-home-model-popover">
                  <strong>{modelRoutingTitle}</strong>
                  <button type="button" onClick={() => onNewAgent()}>
                    Open task settings
                  </button>
                </div>
              </details>

              <button
                type="submit"
                className="kestrel-home-send"
                aria-label={`Open message in ${agentName} composer`}
                title={`Open message in ${agentName} composer`}
                disabled={!input.trim()}
              >
                <Icon name="arrow" />
              </button>
            </div>
          </form>
        </header>

        <section className="kestrel-home-shortcuts" aria-labelledby="frequent-title">
          <div className="kestrel-home-section-heading">
            <h2 id="frequent-title">Frequent tabs</h2>
          </div>

          {frequent.length > 0 ? (
            <div className="kestrel-home-shortcut-list">
              {frequent.map((site) => (
                <button
                  key={site.origin}
                  type="button"
                  className="kestrel-home-shortcut"
                  onClick={() => onNavigate(site.url)}
                  title={`${browserSiteLabel(site)} · ${site.hostname}`}
                >
                  <span
                    className={`kestrel-home-shortcut-glyph site-accent-${siteAccent(site.hostname)}`}
                    aria-hidden="true"
                  >
                    <FrequentFavicon site={site} />
                  </span>
                  <span className="kestrel-home-shortcut-copy">
                    <strong>{browserSiteLabel(site, 24)}</strong>
                    <small>{site.hostname}</small>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="kestrel-home-shortcuts-empty">
              <span className="kestrel-home-shortcuts-empty-glyph" aria-hidden="true">
                <Icon name="history" />
              </span>
              <span>
                <strong>Your shortcuts will appear here.</strong>
              </span>
            </div>
          )}
        </section>

        {bookmarks.length > 0 && (
          <section className="kestrel-home-shortcuts" aria-labelledby="bookmark-links-title">
            <div className="kestrel-home-section-heading">
              <div>
                <span className="kestrel-home-section-kicker">Saved in this profile</span>
                <h2 id="bookmark-links-title">Bookmarks</h2>
              </div>
            </div>
            <div className="kestrel-home-shortcut-list">
              {bookmarks.slice(0, 8).map((bookmark) => (
                <button
                  key={bookmark.id}
                  type="button"
                  className="kestrel-home-shortcut"
                  onClick={() => onNavigate(bookmark.url)}
                  title={bookmark.url}
                >
                  <span className="kestrel-home-shortcut-glyph" aria-hidden="true">
                    <Icon name="star" />
                  </span>
                  <span className="kestrel-home-shortcut-copy">
                    <strong>{bookmark.title}</strong>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="kestrel-home-actions" aria-labelledby="suggested-actions-title">
          <div className="kestrel-home-section-heading">
            <h2 id="suggested-actions-title">Suggested actions</h2>
          </div>

          <div className="kestrel-home-action-buttons">
            {suggestedActions.map((action) => (
              <button
                key={action.id}
                type="button"
                className="kestrel-home-action-chip"
                onClick={() => chooseAction(action.prompt)}
                aria-label={`Add to ${agentName} composer: ${action.title}`}
                title={action.title}
              >
                {action.title}
              </button>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}
