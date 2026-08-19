import { useMemo, useState, type FormEvent } from "react";
import type { UserBrowserBookmark, UserBrowserHistoryEntry } from "@kestrel/shared-types";
import { Icon } from "../Icon";
import {
  browserSiteLabel,
  frequentBrowserSites,
  homeInputLooksLikeBrowse,
  siteInitial,
  suggestedAgentActions,
} from "./new-tab";
import "./new-tab.css";

export function NewTabPage({
  history,
  bookmarks = [],
  agentName,
  onNavigate,
  onNewAgent,
}: {
  history: UserBrowserHistoryEntry[];
  bookmarks?: UserBrowserBookmark[];
  agentName: string;
  onNavigate(input: string): void;
  onNewTab?(): void;
  onNewAgent(prompt?: string): void;
  onOpenSettings?(): void;
}) {
  const [draft, setDraft] = useState("");
  const suggestedActions = useMemo(
    () => suggestedAgentActions(history),
    [history],
  );
  const recommendedLinks = useMemo(
    () => frequentBrowserSites(history, 5),
    [history],
  );

  function submitHome(event: FormEvent) {
    event.preventDefault();
    const value = draft.trim();
    if (!value) return;
    setDraft("");
    if (homeInputLooksLikeBrowse(value)) {
      onNavigate(value);
      return;
    }
    onNewAgent(value);
  }

  return (
    <section
      className="new-tab-page kestrel-home"
      aria-labelledby="new-tab-title"
    >
      <div className="kestrel-home-shell">
        <header className="kestrel-home-intro">
          <h1 id="new-tab-title">Good to see you.</h1>
          <form className="kestrel-home-composer" onSubmit={submitHome}>
            <label className="sr-only" htmlFor="kestrel-home-input">
              Ask {agentName} or enter a website
            </label>
            <Icon name="search" />
            <input
              id="kestrel-home-input"
              value={draft}
              placeholder="Ask Kestrel, or enter a website"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button
              type="submit"
              className="kestrel-home-send"
              aria-label="Go"
              disabled={!draft.trim()}
            >
              <Icon name="arrow" />
            </button>
          </form>
        </header>

        <div className={`kestrel-home-layout ${recommendedLinks.length ? "has-links" : ""}`}>
          <section
            className="kestrel-home-suggestions"
            aria-labelledby="suggested-actions-title"
          >
            <h2 id="suggested-actions-title">Suggestions</h2>
            <ol className="kestrel-home-action-list">
              {suggestedActions.map((action) => (
                <li key={action.id}>
                  <button
                    type="button"
                    className="kestrel-home-action"
                    onClick={() => onNewAgent(action.prompt)}
                    aria-label={`Ask ${agentName}: ${action.title}`}
                  >
                    <strong>{action.title}</strong>
                    <Icon name="arrow" />
                  </button>
                </li>
              ))}
            </ol>
          </section>

          {recommendedLinks.length > 0 && (
            <section
              className="kestrel-home-links"
              aria-labelledby="recommended-links-title"
            >
              <h2 id="recommended-links-title">Frequent</h2>
              <ul className="kestrel-home-link-list">
                {recommendedLinks.map((site) => (
                  <li key={site.origin}>
                    <button
                      type="button"
                      className="kestrel-home-link"
                      onClick={() => onNavigate(site.url)}
                      title={browserSiteLabel(site)}
                    >
                      <span className="kestrel-home-link-glyph" aria-hidden="true">
                        {siteInitial(site)}
                      </span>
                      <strong>{browserSiteLabel(site)}</strong>
                      <Icon name="arrow" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {bookmarks.length > 0 && (
            <section
              className="kestrel-home-links"
              aria-labelledby="bookmark-links-title"
            >
              <h2 id="bookmark-links-title">Bookmarks</h2>
              <ul className="kestrel-home-link-list">
                {bookmarks.slice(0, 8).map((bookmark) => (
                  <li key={bookmark.id}>
                    <button
                      type="button"
                      className="kestrel-home-link"
                      onClick={() => onNavigate(bookmark.url)}
                      title={bookmark.url}
                    >
                      <span className="kestrel-home-link-glyph" aria-hidden="true">
                        <Icon name="star" />
                      </span>
                      <strong>{bookmark.title}</strong>
                      <Icon name="arrow" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </section>
  );
}
