import { useMemo, useState, type FormEvent } from "react";
import type { UserBrowserHistoryEntry } from "@kestrel/shared-types";
import { BrandMark } from "../BrandMark";
import { Icon } from "../Icon";

export function NewTabPage({
  history,
  onNavigate,
  onNewTab,
  onNewAgent,
}: {
  history: UserBrowserHistoryEntry[];
  onNavigate(input: string): void;
  onNewTab(): void;
  onNewAgent(): void;
}) {
  const [input, setInput] = useState("");
  const recent = useMemo(() => {
    const seen = new Set<string>();
    return [...history]
      .reverse()
      .filter((entry) => {
        try {
          const origin = new URL(entry.url).origin;
          if (seen.has(origin)) return false;
          seen.add(origin);
          return true;
        } catch {
          return false;
        }
      })
      .slice(0, 6);
  }, [history]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (input.trim()) onNavigate(input);
  }

  return (
    <section className="new-tab-page" aria-labelledby="new-tab-title">
      <div className="new-tab-primary-actions" aria-label="Create new">
        <button type="button" onClick={onNewTab}>
          <Icon name="plus" />
          <span><strong>New Tab</strong><small>Browse or search</small></span>
        </button>
        <button type="button" onClick={onNewAgent}>
          <Icon name="agent" />
          <span><strong>New Agent</strong><small>Start a fresh conversation</small></span>
        </button>
      </div>
      <div className="new-tab-center">
        <BrandMark />
        <h1 id="new-tab-title">Where to?</h1>
        <form onSubmit={submit}>
          <Icon name="search" />
          <label className="sr-only" htmlFor="new-tab-search">Search or enter an address</label>
          <input
            id="new-tab-search"
            autoFocus
            value={input}
            placeholder="Search or enter an address"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => setInput(event.target.value)}
          />
        </form>
      </div>
      {recent.length > 0 && (
        <div className="new-tab-recents">
          <h2>Recent</h2>
          <div>
            {recent.map((entry) => (
              <button key={entry.id} type="button" onClick={() => onNavigate(entry.url)}>
                <span>{new URL(entry.url).hostname.replace(/^www\./, "").charAt(0).toUpperCase()}</span>
                <strong>{entry.title}</strong>
                <small>{new URL(entry.url).hostname.replace(/^www\./, "")}</small>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
