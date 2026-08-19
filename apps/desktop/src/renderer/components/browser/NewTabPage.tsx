import { useMemo, useRef, useState, type FormEvent } from "react";
import type {
  UserBrowserHistoryEntry,
  UserBrowserSettings,
} from "@kestrel/shared-types";
import meadowLandscape from "../../assets/new-tab-meadow.svg";
import { Icon } from "../Icon";
import {
  browserSiteLabel,
  frequentBrowserSites,
  siteAccent,
  siteInitial,
  suggestedAgentActions,
} from "./new-tab";
import "./new-tab.css";

export function NewTabPage({
  history,
  background,
  agentName,
  onNavigate,
  onNewAgent,
}: {
  history: UserBrowserHistoryEntry[];
  background: UserBrowserSettings["newTabBackground"];
  agentName: string;
  onNavigate(input: string): void;
  onNewAgent(prompt?: string): void;
}) {
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const frequent = useMemo(
    () => frequentBrowserSites(history, 7),
    [history],
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
              Message {agentName}
            </label>
            <input
              ref={inputRef}
              id="new-tab-chat-input"
              value={input}
              placeholder={`Message ${agentName} or @ mention a tab`}
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
                  <p>
                    Kestrel chooses the model, reasoning, and service tier for
                    this task.
                  </p>
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
            <div>
              <span className="kestrel-home-section-kicker">From your local history</span>
              <h2 id="frequent-title">Frequent tabs</h2>
            </div>
            <small>
              {frequent.length > 0
                ? "Private to this profile"
                : "Open pages to build shortcuts"}
            </small>
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
                    {siteInitial(site)}
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
                <small>Only this profile&apos;s local browser history is used.</small>
              </span>
            </div>
          )}
        </section>

        <section className="kestrel-home-actions" aria-labelledby="suggested-actions-title">
          <div className="kestrel-home-section-heading">
            <div>
              <span className="kestrel-home-section-kicker">A useful place to begin</span>
              <h2 id="suggested-actions-title">Suggested actions</h2>
            </div>
            <small>Five ways to start</small>
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
                    <small>{action.description}</small>
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
