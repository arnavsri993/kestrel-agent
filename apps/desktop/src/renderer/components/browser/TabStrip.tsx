import type { KeyboardEvent } from "react";
import type { UserBrowserTab } from "@kestrel/shared-types";
import { Icon } from "../Icon";

export function TabStrip({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onCreate,
}: {
  tabs: UserBrowserTab[];
  activeTabId: string | null;
  onSelect(tabId: string): void;
  onClose(tabId: string): void;
  onCreate(): void;
}) {
  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='tab']"),
    );
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0 || buttons.length === 0) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) %
            buttons.length;
    buttons[next]?.focus();
  }

  return (
    <div className="browser-tab-row drag-region-browser">
      <div
        className="browser-tabs no-drag"
        role="tablist"
        aria-label="Browser tabs"
        onKeyDown={moveFocus}
      >
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div className={`browser-tab ${active ? "active" : ""}`} key={tab.id}>
              <button
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls="browser-viewport"
                tabIndex={active ? 0 : -1}
                title={`${tab.title}${tab.url ? ` — ${tab.url}` : ""}`}
                onClick={() => onSelect(tab.id)}
              >
                <span className="browser-favicon" aria-hidden="true">
                  {tab.faviconDataUrl ? (
                    <img src={tab.faviconDataUrl} alt="" />
                  ) : tab.loading ? (
                    <span className="browser-tab-spinner" />
                  ) : (
                    (tab.url ? new URL(tab.url).hostname.charAt(0) : "K").toUpperCase()
                  )}
                </span>
                <span>{tab.title}</span>
              </button>
              <button
                type="button"
                className="browser-tab-close"
                aria-label={`Close ${tab.title}`}
                onClick={() => onClose(tab.id)}
              >
                <Icon name="close" />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="browser-new-tab no-drag"
        aria-label="New Tab"
        aria-keyshortcuts="Meta+T"
        onClick={onCreate}
      >
        <Icon name="plus" />
      </button>
      <div className="browser-tab-drag-fill" />
    </div>
  );
}
