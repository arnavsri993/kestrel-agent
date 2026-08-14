import type { KeyboardEvent } from "react";
import type { UserBrowserTab } from "@kestrel/shared-types";
import { Icon } from "../Icon";

export function TabStrip({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onCreate,
  onCreatePrivate,
  orientation,
}: {
  tabs: UserBrowserTab[];
  activeTabId: string | null;
  onSelect(tabId: string): void;
  onClose(tabId: string): void;
  onCreate(): void;
  onCreatePrivate(): void;
  orientation: "horizontal" | "vertical";
}) {
  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    const previousKey = orientation === "vertical" ? "ArrowUp" : "ArrowLeft";
    const nextKey = orientation === "vertical" ? "ArrowDown" : "ArrowRight";
    if (![previousKey, nextKey, "Home", "End"].includes(event.key)) return;
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
          : (index + (event.key === nextKey ? 1 : -1) + buttons.length) %
            buttons.length;
    buttons[next]?.focus();
  }

  return (
    <div
      className={`browser-tab-row browser-tab-row-${orientation} drag-region-browser`}
    >
      <div
        className="browser-tabs no-drag"
        role="tablist"
        aria-label="Browser tabs"
        aria-orientation={orientation}
        onKeyDown={moveFocus}
      >
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div className={`browser-tab ${active ? "active" : ""} ${tab.mode === "private" ? "private" : ""}`} key={tab.id}>
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
                  {tab.mode === "private" ? <Icon name="private" /> : null}
                  {tab.mode !== "private" && tab.faviconDataUrl ? (
                    <img src={tab.faviconDataUrl} alt="" />
                  ) : tab.mode !== "private" && tab.loading ? (
                    <span className="browser-tab-spinner" />
                  ) : tab.mode !== "private" ? (
                    (tab.url ? new URL(tab.url).hostname.charAt(0) : "K").toUpperCase()
                  ) : null}
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
        <span>New Tab</span>
      </button>
      <button
        type="button"
        className="browser-new-tab browser-private-tab no-drag"
        aria-label="New private tab"
        title="New private tab"
        onClick={onCreatePrivate}
      >
        <Icon name="private" />
        <span>Private</span>
      </button>
      <div className="browser-tab-drag-fill" />
    </div>
  );
}
