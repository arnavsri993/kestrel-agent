import { useMemo, useRef, useState, type FormEvent } from "react";
import type {
  UserBrowserBookmark,
  UserBrowserHistoryEntry,
  UserBrowserOriginFavicon,
  UserBrowserSettings,
  UserBrowserTab,
} from "@kestrel/shared-types";
import meadowLandscape from "../../assets/new-tab-meadow.svg";
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

export function NewTabPage({
  history,
  bookmarks = [],
  tabs = [],
  originFavicons = [],
  background,
  agentName,
  onNavigate,
  onNewAgent,
}: {
  history: UserBrowserHistoryEntry[];
  bookmarks?: UserBrowserBookmark[];
  tabs?: Pick<UserBrowserTab, "url" | "faviconDataUrl">[];
  originFavicons?: Pick<UserBrowserOriginFavicon, "origin" | "faviconDataUrl">[];
  background: UserBrowserSettings["newTabBackground"];
  agentName: string;
  onNavigate(input: string): void;
  onNewAgent(prompt?: string): void;
}) {
  const [input, setInput] = useState("");
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
    () => suggestedAgentActions(history),
    [history],
  );
  const hasBackgroundImage = background === "graphite" || background === "meadow";

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
      className={`new-tab-page kestrel-home new-tab-page-${background}`}
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
                className="kestrel-home-composer-icon"
                aria-label="Add context"
                title="Add context in the agent workspace"
                disabled
              >
                <Icon name="plus" />
              </button>

              <details className="kestrel-home-model-selector">
                <summary aria-label="Model selector: Smart" title="Model selector">
                  <span>Smart</span>
                  <Icon name="chevron" />
                </summary>
                <div className="kestrel-home-model-popover">
                  <strong>Smart routing</strong>
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

          <ol className="kestrel-home-action-list">
            {suggestedActions.map((action, index) => (
              <li key={action.id}>
                <button
                  type="button"
                  className="kestrel-home-action"
                  onClick={() => chooseAction(action.prompt)}
                  aria-label={`Add to ${agentName} composer: ${action.title}`}
                >
                  <span className="kestrel-home-action-index" aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="kestrel-home-action-copy">
                    <strong>{action.title}</strong>
                  </span>
                  <span className="kestrel-home-action-affordance" aria-hidden="true">
                    <span>Use prompt</span>
                    <Icon name="arrow" />
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </section>
  );
}
