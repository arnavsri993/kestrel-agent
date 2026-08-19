import { useMemo, useState, type FormEvent } from "react";
import type { UserBrowserHistoryEntry } from "@kestrel/shared-types";
import { BrandMark } from "../BrandMark";
import { Icon } from "../Icon";
import { frequentBrowserSites, siteInitial } from "./new-tab";

const recommendations = [
  {
    icon: "research",
    title: "Make sense of a new topic",
    description: "Find useful starting points and a next step.",
    prompt:
      "Help me explore a new topic, find the useful starting points, and suggest the next step.",
  },
  {
    icon: "work",
    title: "Turn an idea into a plan",
    description: "Turn a rough idea into the smallest useful plan.",
    prompt:
      "Help me turn an idea into a clear plan with the smallest useful next step.",
  },
  {
    icon: "agent",
    title: "Pick up where you left off",
    description: "Bring important context into the next step.",
    prompt:
      "Help me pick up where I left off and decide what is most useful to do next.",
  },
] as const;

export function NewTabPage({
  history,
  agentName,
  onNavigate,
  onNewAgent,
}: {
  history: UserBrowserHistoryEntry[];
  agentName: string;
  onNavigate(input: string): void;
  onNewAgent(prompt?: string): void;
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
    <section className="new-tab-page" aria-labelledby="new-tab-title">
      <div className="new-tab-content">
        <div className="new-tab-center">
          <div className="new-tab-welcome-mark" aria-hidden="true">
            <BrandMark />
          </div>
          <h1 id="new-tab-title">Good to see you.</h1>
          <form className="new-tab-chat" onSubmit={submitChat}>
            <span className="new-tab-chat-mark" aria-hidden="true">
              <Icon name="sparkle" />
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

        {frequent.length > 0 && (
          <section className="new-tab-frequent" aria-labelledby="frequent-title">
            <div className="new-tab-section-heading">
              <div>
                <h2 id="frequent-title">Frequent tabs</h2>
                <small>From local history</small>
              </div>
            </div>
            <div className="new-tab-frequent-list">
              {frequent.map((site) => (
                <button
                  key={site.origin}
                  type="button"
                  className="new-tab-site"
                  onClick={() => onNavigate(site.url)}
                  title={`${site.title} · ${site.hostname}`}
                >
                  <span className="new-tab-site-glyph" aria-hidden="true">
                    {siteInitial(site)}
                  </span>
                  <span className="new-tab-site-copy">
                    <strong>{site.title}</strong>
                    <small>{site.hostname}</small>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        <section
          className="new-tab-recommendations"
          aria-labelledby="recommendations-title"
        >
          <div className="new-tab-section-heading">
            <h2 id="recommendations-title">Suggestions</h2>
            <small>Open a guided chat</small>
          </div>
          <div className="new-tab-recommendation-grid">
            {recommendations.map((recommendation) => (
              <button
                type="button"
                className="new-tab-recommendation"
                key={recommendation.title}
                aria-label={`Ask Kestrel: ${recommendation.title}`}
                onClick={() => onNewAgent(recommendation.prompt)}
              >
                <span className="new-tab-recommendation-icon" aria-hidden="true">
                  <Icon name={recommendation.icon} />
                </span>
                <span className="new-tab-recommendation-copy">
                  <strong>{recommendation.title}</strong>
                  <small>{recommendation.description}</small>
                </span>
                <span className="new-tab-recommendation-action" aria-hidden="true">
                  Ask <Icon name="arrow" />
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}
