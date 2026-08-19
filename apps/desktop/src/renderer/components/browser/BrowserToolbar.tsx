import { useEffect, useState, type FormEvent, type RefObject } from "react";
import type { UserBrowserTab } from "@kestrel/shared-types";
import { Icon } from "../Icon";

export function BrowserToolbar({
  tab,
  agentName,
  agentOpen,
  addressRef,
  contextEnabled,
  onToggleContext,
  onToggleAgent,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onStop,
  onOpenHistory,
  onOpenDownloads,
  onOpenBookmarks,
  onToggleBookmark,
  bookmarked,
  onOpenMenu,
}: {
  tab: UserBrowserTab;
  agentName: string;
  agentOpen: boolean;
  addressRef: RefObject<HTMLInputElement | null>;
  contextEnabled: boolean;
  bookmarked: boolean;
  onToggleContext(): void;
  onToggleAgent(): void;
  onNavigate(input: string): void;
  onBack(): void;
  onForward(): void;
  onReload(): void;
  onStop(): void;
  onOpenHistory(): void;
  onOpenDownloads(): void;
  onOpenBookmarks(): void;
  onToggleBookmark(): void;
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
        <button
          type="button"
          aria-label="Back"
          aria-keyshortcuts="Meta+["
          title="Back (⌘[)"
          disabled={!tab.canGoBack}
          onClick={onBack}
        >
          <Icon name="back" />
        </button>
        <button
          type="button"
          aria-label="Forward"
          aria-keyshortcuts="Meta+]"
          title="Forward (⌘])"
          disabled={!tab.canGoForward}
          onClick={onForward}
        >
          <Icon name="forward" />
        </button>
        <button
          type="button"
          aria-label={tab.loading ? "Stop loading" : "Reload"}
          aria-keyshortcuts={tab.loading ? "Escape" : "Meta+R"}
          title={tab.loading ? "Stop loading (Esc)" : "Reload (⌘R)"}
          onClick={tab.loading ? onStop : onReload}
        >
          <Icon name={tab.loading ? "close" : "reload"} />
        </button>
      </div>
      <form className="browser-address" onSubmit={submit}>
        <span
          className={`site-indicator ${secure ? "secure" : ""}`}
          title={
            secure
              ? "Secure connection"
              : tab.url
                ? "Connection is not secure"
                : "Search or address"
          }
        >
          <Icon name={secure ? "lock" : "search"} />
        </span>
        <label className="sr-only" htmlFor="browser-address-input">
          Search or enter an address
        </label>
        <input
          id="browser-address-input"
          ref={addressRef}
          value={address}
          placeholder="Search or enter address"
          aria-keyshortcuts="Meta+L"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setAddress(event.target.value)}
        />
        {tab.url && (
          <button
            type="button"
            className={`browser-bookmark ${bookmarked ? "active" : ""}`}
            aria-label={bookmarked ? "Remove bookmark" : "Bookmark this page"}
            aria-pressed={bookmarked}
            aria-keyshortcuts="Meta+D"
            title={bookmarked ? "Remove bookmark (⌘D)" : "Bookmark this page (⌘D)"}
            onClick={onToggleBookmark}
          >
            <Icon name="star" />
          </button>
        )}
        {tab.url && (
          <span className="browser-address-host" aria-hidden="true">
            {host}
          </span>
        )}
      </form>
      <button
        type="button"
        className={`browser-context-toggle ${contextEnabled ? "active" : ""}`}
        aria-pressed={contextEnabled}
        aria-label={
          contextEnabled
            ? "Stop sharing page context with agent"
            : "Share page context with agent"
        }
        title={
          contextEnabled
            ? "The agent can use this page as task context. Click to stop sharing."
            : "The agent cannot use this page as task context. Click to share."
        }
        onClick={onToggleContext}
      >
        <Icon name="context" />
        <span>{contextEnabled ? "Shared with agent" : "Share with agent"}</span>
      </button>
      <div className="browser-toolbar-actions">
        <button
          id="browser-agent-toggle"
          type="button"
          className={`browser-agent-toggle ${agentOpen ? "active" : ""}`}
          aria-label={agentOpen ? `Hide ${agentName}` : `Chat with ${agentName}`}
          aria-expanded={agentOpen}
          title={agentOpen ? `Hide ${agentName}` : `Chat with ${agentName}`}
          onClick={onToggleAgent}
        >
          <Icon name="chat" />
          <span>{agentOpen ? `Hide ${agentName}` : `Chat with ${agentName}`}</span>
        </button>
        <button
          type="button"
          aria-label="History"
          aria-keyshortcuts="Meta+H"
          title="History (⌘H)"
          onClick={onOpenHistory}
        >
          <Icon name="history" />
        </button>
        <button
          type="button"
          aria-label="Bookmarks"
          aria-keyshortcuts="Meta+Shift+D"
          title="Bookmarks (⌘⇧D)"
          onClick={onOpenBookmarks}
        >
          <Icon name="star" />
        </button>
        <button
          type="button"
          aria-label="Downloads"
          aria-keyshortcuts="Meta+J"
          title="Downloads (⌘J)"
          onClick={onOpenDownloads}
        >
          <Icon name="downloads" />
        </button>
        <button
          type="button"
          aria-label="Capabilities and commands"
          aria-keyshortcuts="Meta+K"
          title="Capabilities (⌘K)"
          onClick={onOpenMenu}
        >
          <Icon name="more" />
        </button>
      </div>
    </div>
  );
}
