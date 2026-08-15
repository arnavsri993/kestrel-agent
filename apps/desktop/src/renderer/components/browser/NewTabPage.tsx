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
    title: "Make sense of a new topic",
    prompt:
      "Help me explore a new topic, find the useful starting points, and suggest the next step.",
  },
  {
    icon: "work",
    art: "plan",
    title: "Turn an idea into a plan",
    prompt:
      "Help me turn an idea into a clear plan with the smallest useful next step.",
  },
  {
    icon: "agent",
    art: "continue",
    title: "Pick up where you left off",
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
        </div>
        <button
          type="button"
          className="new-tab-personalize"
          onClick={onOpenSettings}
          aria-label="Personalize"
          title="Personalize"
        >
          <Icon name="settings" />
        </button>
      </header>

      <div className="new-tab-content">
        <div className="new-tab-center">
          <div className="new-tab-welcome-mark" aria-hidden="true">
            <BrandMark />
          </div>
          <h1 id="new-tab-title">Good to see you.</h1>
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
              placeholder={`Ask ${agentName}...`}
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
        </div>

        <section className="new-tab-frequent" aria-labelledby="frequent-title">
          <div className="new-tab-section-heading">
            <h2 id="frequent-title">Frequent</h2>
            <button
              type="button"
              className="new-tab-section-action"
              onClick={onNewTab}
              aria-label="New tab"
              title="New tab"
            >
              <Icon name="plus" />
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
                <strong>Open a site to start</strong>
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
            <h2 id="recommendations-title">Suggestions</h2>
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
                  <h3>{recommendation.title}</h3>
                  <button
                    type="button"
                    aria-label={`Ask ${recommendation.title}`}
                    onClick={() => onNewAgent(recommendation.prompt)}
                  >
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
