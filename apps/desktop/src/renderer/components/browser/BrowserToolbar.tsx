import { useEffect, useState, type FormEvent, type RefObject } from "react";
import type { UserBrowserTab } from "@kestrel/shared-types";
import { Icon } from "../Icon";

export function BrowserToolbar({
  tab,
  addressRef,
  contextEnabled,
  isBookmarked,
  onToggleContext,
  onToggleBookmark,
  onAskAgent,
  onOpenBookmarks,
  onOpenDevTools,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onStop,
  onOpenHistory,
  onOpenDownloads,
  onOpenMenu,
}: {
  tab: UserBrowserTab;
  addressRef: RefObject<HTMLInputElement | null>;
  contextEnabled: boolean;
  isBookmarked: boolean;
  onToggleContext(): void;
  onToggleBookmark(): void;
  onAskAgent(): void;
  onOpenBookmarks(): void;
  onOpenDevTools(): void;
  onNavigate(input: string): void;
  onBack(): void;
  onForward(): void;
  onReload(): void;
  onStop(): void;
  onOpenHistory(): void;
  onOpenDownloads(): void;
  onOpenMenu(): void;
}) {
  const [address, setAddress] = useState(tab.url);
  useEffect(() => setAddress(tab.url), [tab.id, tab.url]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (address.trim()) onNavigate(address);
  }

  let host = "Search or enter an address";
  let secure = false;
  if (tab.url) {
    try {
      const url = new URL(tab.url);
      host = url.hostname;
      secure = url.protocol === "https:";
    } catch {
      host = tab.url;
    }
  }

  return (
    <div className="browser-toolbar" aria-label="Browser toolbar">
      <div className="browser-navigation">
        <button type="button" aria-label="Back" disabled={!tab.canGoBack} onClick={onBack}>
          <Icon name="back" />
        </button>
        <button type="button" aria-label="Forward" disabled={!tab.canGoForward} onClick={onForward}>
          <Icon name="forward" />
        </button>
        <button
          type="button"
          aria-label={tab.loading ? "Stop loading" : "Reload"}
          onClick={tab.loading ? onStop : onReload}
        >
          <Icon name={tab.loading ? "close" : "reload"} />
        </button>
      </div>
      <form className="browser-address" onSubmit={submit}>
        <span className={`site-indicator ${secure ? "secure" : ""}`} title={secure ? "Secure connection" : tab.url ? "Connection is not secure" : "Search or address"}>
          <Icon name={secure ? "lock" : "search"} />
        </span>
        <label className="sr-only" htmlFor="browser-address-input">
          Search or enter an address
        </label>
        <input
          id="browser-address-input"
          ref={addressRef}
          value={address}
          placeholder="Search or enter an address"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setAddress(event.target.value)}
        />
        {tab.url && <span className="browser-address-host" aria-hidden="true">{host}</span>}
      </form>
      <button
        type="button"
        className={`browser-bookmark-toggle ${isBookmarked ? "active" : ""}`}
        aria-label={isBookmarked ? "Remove bookmark" : "Bookmark this page"}
        aria-pressed={isBookmarked}
        disabled={!tab.url || tab.mode === "private"}
        title={tab.mode === "private" ? "Private tabs cannot save bookmarks" : isBookmarked ? "Remove bookmark" : "Bookmark this page"}
        onClick={onToggleBookmark}
      >
        <Icon name="bookmark" />
      </button>
      <button
        type="button"
        className={`browser-context-toggle ${contextEnabled ? "active" : ""}`}
        aria-pressed={contextEnabled}
        title={
          contextEnabled
            ? "The active page is available to this agent"
            : "The active page is excluded from this agent"
        }
        onClick={onToggleContext}
      >
        <Icon name="context" />
        <span>{contextEnabled ? "Page on" : "Page off"}</span>
      </button>
      <div className="browser-toolbar-actions">
        <button type="button" aria-label="Ask Kestrel about this page" disabled={!tab.url} onClick={onAskAgent}>
          <Icon name="agent" />
        </button>
        <button type="button" aria-label="Bookmarks" onClick={onOpenBookmarks}>
          <Icon name="bookmark" />
        </button>
        <button type="button" aria-label="Developer tools" disabled={!tab.url} onClick={onOpenDevTools}>
          <Icon name="devtools" />
        </button>
        <button type="button" aria-label="History" onClick={onOpenHistory}>
          <Icon name="history" />
        </button>
        <button type="button" aria-label="Downloads" onClick={onOpenDownloads}>
          <Icon name="downloads" />
        </button>
        <button type="button" aria-label="Kestrel menu" onClick={onOpenMenu}>
          <Icon name="more" />
        </button>
      </div>
    </div>
  );
}
