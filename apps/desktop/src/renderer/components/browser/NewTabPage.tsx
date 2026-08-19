import { useMemo } from "react";
import type { UserBrowserHistoryEntry } from "@kestrel/shared-types";
import { Icon } from "../Icon";
import {
  browserSiteLabel,
  frequentBrowserSites,
  siteInitial,
  suggestedAgentActions,
} from "./new-tab";
import "./new-tab.css";

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
  const suggestedActions = useMemo(
    () => suggestedAgentActions(history),
    [history],
  );
  const recommendedLinks = useMemo(
    () => frequentBrowserSites(history, 5),
    [history],
  );
  const hasPersonalization = recommendedLinks.length > 0;

  return (
    <section
      className="new-tab-page kestrel-home"
      aria-labelledby="new-tab-title"
    >
      <div className="kestrel-home-shell">
        <header className="kestrel-home-intro">
          <span className="kestrel-home-eyebrow">Ready when you are</span>
          <h1 id="new-tab-title">Good to see you.</h1>
          <p>
            Pick a starting point. Kestrel will place it in {agentName}&apos;s
            composer so you can review it before sending.
          </p>
        </header>

        <div className="kestrel-home-layout">
          <section
            className="kestrel-home-suggestions"
            aria-labelledby="suggested-actions-title"
          >
            <div className="kestrel-home-section-heading">
              <div>
                <span className="kestrel-home-section-kicker">
                  {hasPersonalization ? "For you" : "Start here"}
                </span>
                <h2 id="suggested-actions-title">Suggested actions</h2>
              </div>
              <small>
                {hasPersonalization ? "Shaped by local history" : "Five useful prompts"}
              </small>
            </div>

            <ol className="kestrel-home-action-list">
              {suggestedActions.map((action, index) => (
                <li key={action.id}>
                  <button
                    type="button"
                    className="kestrel-home-action"
                    onClick={() => onNewAgent(action.prompt)}
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

          <section
            className="kestrel-home-links"
            aria-labelledby="recommended-links-title"
          >
            <div className="kestrel-home-section-heading">
              <div>
                <span className="kestrel-home-section-kicker">Private to this profile</span>
                <h2 id="recommended-links-title">Recommended links</h2>
              </div>
              {hasPersonalization && <small>Local history only</small>}
            </div>

            {hasPersonalization ? (
              <ul className="kestrel-home-link-list">
                {recommendedLinks.map((site) => (
                  <li key={site.origin}>
                    <button
                      type="button"
                      className="kestrel-home-link"
                      onClick={() => onNavigate(site.url)}
                      title={`${browserSiteLabel(site)} · ${site.hostname}`}
                    >
                      <span className="kestrel-home-link-glyph" aria-hidden="true">
                        {siteInitial(site)}
                      </span>
                      <span className="kestrel-home-link-copy">
                        <strong>{browserSiteLabel(site)}</strong>
                        <small>{site.hostname}</small>
                      </span>
                      <Icon name="arrow" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="kestrel-home-links-empty">
                <span aria-hidden="true">
                  <Icon name="history" />
                </span>
                <strong>Your links will learn from browsing.</strong>
                <p>
                  Open a few pages and Kestrel will surface useful places from
                  this profile&apos;s local history. Nothing is sent elsewhere.
                </p>
              </div>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}
