import { useMemo, useState, type FormEvent } from "react";
import type { UserBrowserHistoryEntry } from "@kestrel/shared-types";
import { BrandMark } from "../BrandMark";
import { Icon } from "../Icon";
import {
  frequentBrowserSites,
  siteAccent,
  siteInitial,
  type NewTabBackground,
} from "./new-tab";

const recommendations = [
  {
    icon: "research",
    eyebrow: "Explore",
    title: "Make sense of a new topic",
    detail: "Ask Kestrel to gather the useful starting points and a next step.",
    prompt: "Help me explore a new topic, find the useful starting points, and suggest the next step.",
  },
  {
    icon: "work",
    eyebrow: "Get organized",
    title: "Turn an idea into a plan",
    detail: "Start with an outcome and keep the work, context, and approvals together.",
    prompt: "Help me turn an idea into a clear plan with the smallest useful next step.",
  },
  {
    icon: "agent",
    eyebrow: "Ask Kestrel",
    title: "Pick up where you left off",
    detail: "Open a fresh chat and bring the important context with you.",
    prompt: "Help me pick up where I left off and decide what is most useful to do next.",
  },
] as const;

export function NewTabPage({
  history,
  background,
  onNavigate,
  onNewTab,
  onNewAgent,
  onOpenSettings,
}: {
  history: UserBrowserHistoryEntry[];
  background: NewTabBackground;
  onNavigate(input: string): void;
  onNewTab(): void;
  onNewAgent(prompt?: string): void;
  onOpenSettings(): void;
}) {
  const [input, setInput] = useState("");
  const frequent = useMemo(() => frequentBrowserSites(history), [history]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (input.trim()) onNavigate(input);
  }

  return (
    <section
      className={`new-tab-page new-tab-page-${background}`}
      aria-labelledby="new-tab-title"
    >
      <div className="new-tab-backdrop" aria-hidden="true" />
      <header className="new-tab-home-header">
        <div className="new-tab-home-identity">
          <BrandMark />
          <span>
            <strong>Kestrel home</strong>
            <small>Local browser</small>
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
          <p className="new-tab-eyebrow">Start with a question, a site, or a task</p>
          <h1 id="new-tab-title">Where to?</h1>
          <p className="new-tab-support">
            Search the web or ask Kestrel without leaving your current tab.
          </p>
          <form className="new-tab-search" onSubmit={submit}>
            <Icon name="search" />
            <label className="sr-only" htmlFor="new-tab-search">
              Search the web or enter an address
            </label>
            <input
              id="new-tab-search"
              autoFocus
              value={input}
              placeholder="Search the web or enter an address"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => setInput(event.target.value)}
            />
            <button type="submit" aria-label="Search or open address" disabled={!input.trim()}>
              <Icon name="arrow" />
            </button>
          </form>
        </div>

        <section className="new-tab-frequent" aria-labelledby="frequent-title">
          <div className="new-tab-section-heading">
            <div>
              <span className="new-tab-section-kicker">Your shortcuts</span>
              <h2 id="frequent-title">Frequent tabs</h2>
            </div>
            <button type="button" onClick={onNewTab}>
              <Icon name="plus" />
              <span>Open a tab</span>
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
                  <Icon name="arrow" />
                </button>
              ))}
            </div>
          ) : (
            <button type="button" className="new-tab-frequent-empty" onClick={onNewTab}>
              <span className="new-tab-site-glyph" aria-hidden="true">
                <Icon name="plus" />
              </span>
              <span>
                <strong>Your frequent tabs will appear here</strong>
                <small>Open a site to start building this local shortcut row.</small>
              </span>
              <Icon name="arrow" />
            </button>
          )}
        </section>

        <section className="new-tab-recommendations" aria-labelledby="recommendations-title">
          <div className="new-tab-section-heading">
            <div>
              <span className="new-tab-section-kicker">A useful next move</span>
              <h2 id="recommendations-title">Try something with Kestrel</h2>
            </div>
            <small>Three ways to start</small>
          </div>
          <div className="new-tab-recommendation-grid">
            {recommendations.map((recommendation) => (
              <article className="new-tab-recommendation" key={recommendation.title}>
                <div className="new-tab-recommendation-heading">
                  <span className="new-tab-recommendation-icon" aria-hidden="true">
                    <Icon name={recommendation.icon} />
                  </span>
                  <span>{recommendation.eyebrow}</span>
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
              </article>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}
