import { useMemo, useRef, useState, type FormEvent } from "react";
import type {
  RuntimeSession,
  UserBrowserBookmark,
  UserBrowserHistoryEntry,
  UserBrowserOriginFavicon,
  UserBrowserSettings,
  UserBrowserTab,
  WorkspaceGrant,
} from "@kestrel/shared-types";
import { agentWorkspaceName, agentSessionRecency } from "../../agent-workspace";
import { sessionTitleForDisplay } from "../../chat-title";
import { Icon } from "../Icon";
import {
  browserSiteLabel,
  frequentBrowserSites,
  originFaviconMap,
  siteAccent,
  siteInitial,
  suggestedAgentActions,
  type FrequentBrowserSite,
} from "./new-tab";
import "./new-tab.css";

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

function FrequentTabGlyph({ site }: { site: FrequentBrowserSite }) {
  const [broken, setBroken] = useState(false);
  const showFavicon = Boolean(site.faviconDataUrl) && !broken;

  return (
    <span
      className={`kestrel-home-shortcut-glyph ${
        showFavicon
          ? "has-favicon"
          : `site-accent-${siteAccent(site.hostname)}`
      }`}
      aria-hidden="true"
    >
      {showFavicon ? (
        <img
          src={site.faviconDataUrl}
          alt=""
          onError={() => setBroken(true)}
        />
      ) : (
        siteInitial(site)
      )}
    </span>
  );
}

type SidebarSection = "projects" | "history";

export function NewTabPage({
  history,
  bookmarks = [],
  tabs = [],
  originFavicons = [],
  background,
  agentName,
  sessions = [],
  projects = [],
  onNavigate,
  onNewAgent,
  onOpenSession,
}: {
  history: UserBrowserHistoryEntry[];
  bookmarks?: UserBrowserBookmark[] | undefined;
  tabs?: Pick<UserBrowserTab, "url" | "faviconDataUrl">[] | undefined;
  originFavicons?:
    | Pick<UserBrowserOriginFavicon, "origin" | "faviconDataUrl">[]
    | undefined;
  background: UserBrowserSettings["newTabBackground"];
  agentName: string;
  sessions?: RuntimeSession[] | undefined;
  projects?: WorkspaceGrant[] | undefined;
  onNavigate(input: string): void;
  onNewAgent(prompt?: string): void;
  onOpenSession?: ((sessionId: string) => void) | undefined;
}) {
  const [input, setInput] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarSection, setSidebarSection] =
    useState<SidebarSection>("projects");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const faviconByOrigin = useMemo(
    () => originFaviconMap(originFavicons, tabs),
    [originFavicons, tabs],
  );
  const frequent = useMemo(
    () => frequentBrowserSites(history, 7, faviconByOrigin),
    [faviconByOrigin, history],
  );
  const suggestedActions = useMemo(
    () => suggestedAgentActions(history, 3),
    [history],
  );
  const recentSessions = useMemo(
    () =>
      [...sessions]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 12),
    [sessions],
  );

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
            <details className="kestrel-home-model-selector">
              <summary aria-label="Model selector: Smart" title="Model selector">
                <span>Smart</span>
                <Icon name="chevron" />
              </summary>
              <div className="kestrel-home-model-popover">
                <strong>Smart routing</strong>
                <p>Model and thinking level live in task settings.</p>
                <button type="button" onClick={() => onNewAgent()}>
                  Open task settings
                </button>
              </div>
            </details>

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
            <button
              type="submit"
              className="kestrel-home-send"
              aria-label={`Open message in ${agentName} composer`}
              title={`Open message in ${agentName} composer`}
              disabled={!input.trim()}
            >
              <Icon name="arrow" />
            </button>
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
                  <FrequentTabGlyph site={site} />
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
                <small>Pages you open on this Mac will land here for quick access.</small>
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
