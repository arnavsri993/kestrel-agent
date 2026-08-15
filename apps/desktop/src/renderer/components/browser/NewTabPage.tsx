import { useMemo, useState, type FormEvent } from "react";
import type { UserBrowserHistoryEntry } from "@kestrel/shared-types";
import { BrandMark } from "../BrandMark";
import { Icon } from "../Icon";
import meadowLandscape from "../../assets/new-tab-meadow.svg";
import {
  frequentBrowserSites,
  siteAccent,
  siteInitial,
  type NewTabBackground,
} from "./new-tab";

const recommendations = [
  {
    icon: "research",
    art: "research",
    eyebrow: "Explore",
    title: "Make sense of a new topic",
    detail: "Find the useful starting points, then turn them into a next step.",
    prompt:
      "Help me explore a new topic, find the useful starting points, and suggest the next step.",
  },
  {
    icon: "work",
    art: "plan",
    eyebrow: "Get organized",
    title: "Turn an idea into a plan",
    detail: "Start with an outcome and keep the work, context, and approvals together.",
    prompt:
      "Help me turn an idea into a clear plan with the smallest useful next step.",
  },
  {
    icon: "agent",
    art: "continue",
    eyebrow: "Ask",
    title: "Pick up where you left off",
    detail: "Open a fresh chat and bring the important context with you.",
    prompt:
      "Help me pick up where I left off and decide what is most useful to do next.",
  },
] as const;

export function NewTabPage({
  history,
  background,
  agentName,
  onNavigate,
  onNewTab,
  onNewAgent,
  onOpenSettings,
}: {
  history: UserBrowserHistoryEntry[];
  background: NewTabBackground;
  agentName: string;
  onNavigate(input: string): void;
  onNewTab(): void;
  onNewAgent(prompt?: string): void;
  onOpenSettings(): void;
}) {
  const [input, setInput] = useState("");
  const frequent = useMemo(() => frequentBrowserSites(history), [history]);

  function submitChat(event: FormEvent) {
    event.preventDefault();
    const prompt = input.trim();
    if (!prompt) return;
    setInput("");
    onNewAgent(prompt);
  }

  return (
    <section
      className={`new-tab-page new-tab-page-${background}`}
      aria-labelledby="new-tab-title"
    >
      <div
        className="new-tab-backdrop"
        aria-hidden="true"
        style={
          background === "meadow"
            ? { backgroundImage: `url("${meadowLandscape}")` }
            : undefined
        }
      />
      <header className="new-tab-home-header">
        <div className="new-tab-home-identity">
          <BrandMark />
          <span>
            <strong>Kestrel home</strong>
            <small>Browser + agent</small>
          </span>
        </div>
        <button
          type="button"
          className="new-tab-personalize"
          onClick={onOpenSettings}
        >
          <Icon name="settings" />
          <span>Personalize</span>
        </button>
      </header>

      <div className="new-tab-content">
        <div className="new-tab-center">
          <div className="new-tab-welcome-mark" aria-hidden="true">
            <BrandMark />
          </div>
          <p className="new-tab-eyebrow">Ready when you are</p>
          <h1 id="new-tab-title">Good to see you.</h1>
          <p className="new-tab-support">
            Ask {agentName} to think, plan, or get something done.
          </p>
          <form className="new-tab-chat" onSubmit={submitChat}>
            <span className="new-tab-chat-mark" aria-hidden="true">
              <Icon name="agent" />
            </span>
            <label className="sr-only" htmlFor="new-tab-chat-input">
              Ask {agentName}
            </label>
            <input
              id="new-tab-chat-input"
              autoFocus
              value={input}
              placeholder={`Ask ${agentName} anything`}
              autoCapitalize="sentences"
              autoCorrect="on"
              spellCheck
              onChange={(event) => setInput(event.target.value)}
            />
            <button
              type="submit"
              aria-label={`Send to ${agentName}`}
              disabled={!input.trim()}
            >
              <Icon name="arrow" />
            </button>
          </form>
          <small className="new-tab-chat-note">
            The address bar above is for the web. This starts a private local chat.
          </small>
        </div>

        <section className="new-tab-frequent" aria-labelledby="frequent-title">
          <div className="new-tab-section-heading">
            <div>
              <span className="new-tab-section-kicker">From your local history</span>
              <h2 id="frequent-title">Frequent tabs</h2>
            </div>
            <button
              type="button"
              className="new-tab-section-action"
              onClick={onNewTab}
            >
              <Icon name="plus" />
              <span>New tab</span>
            </button>
          </div>
          {frequent.length > 0 ? (
            <div className="new-tab-frequent-list">
              {frequent.map((site) => (
                <button
                  key={site.origin}
                  type="button"
                  className="new-tab-site"
                  onClick={() => onNavigate(site.url)}
                  title={`${site.title} · ${site.hostname}`}
                >
                  <span
                    className={`new-tab-site-glyph site-accent-${siteAccent(site.hostname)}`}
                    aria-hidden="true"
                  >
                    {siteInitial(site)}
                  </span>
                  <span className="new-tab-site-copy">
                    <strong>{site.title}</strong>
                    <small>{site.hostname}</small>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <button
              type="button"
              className="new-tab-frequent-empty"
              onClick={onNewTab}
            >
              <span className="new-tab-site-glyph" aria-hidden="true">
                <Icon name="plus" />
              </span>
              <span>
                <strong>Open a site to build your shortcuts</strong>
                <small>Only local browser history appears here.</small>
              </span>
              <Icon name="arrow" />
            </button>
          )}
        </section>

        <section
          className="new-tab-recommendations"
          aria-labelledby="recommendations-title"
        >
          <div className="new-tab-section-heading">
            <div>
              <span className="new-tab-section-kicker">A little inspiration</span>
              <h2 id="recommendations-title">Start with {agentName}</h2>
            </div>
            <small>Three ways to begin</small>
          </div>
          <div className="new-tab-recommendation-grid">
            {recommendations.map((recommendation) => (
              <article
                className={`new-tab-recommendation new-tab-recommendation-${recommendation.art}`}
                key={recommendation.title}
              >
                <div className="new-tab-recommendation-art" aria-hidden="true">
                  <span className="new-tab-recommendation-art-glow" />
                  <span className="new-tab-recommendation-art-icon">
                    <Icon name={recommendation.icon} />
                  </span>
                </div>
                <div className="new-tab-recommendation-body">
                  <div className="new-tab-recommendation-heading">
                    <span>
                      {recommendation.eyebrow === "Ask"
                        ? `Ask ${agentName}`
                        : recommendation.eyebrow}
                    </span>
                  </div>
                  <h3>{recommendation.title}</h3>
                  <p>{recommendation.detail}</p>
                  <button
                    type="button"
                    onClick={() => onNewAgent(recommendation.prompt)}
                  >
                    Open in chat
                    <Icon name="arrow" />
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}
