import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type RefObject,
} from "react";
import type { InstalledExtension, UserBrowserTab } from "@kestrel/shared-types";
import { Icon } from "../Icon";

type ToolbarMenu = "extensions" | "tools" | "screen" | null;

type MenuTriggerEvent = FormEvent | MouseEvent<HTMLButtonElement>;

const PINNED_EXTENSIONS_KEY = "kestrel:browser-pinned-extensions";

function readPinnedExtensions(): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(PINNED_EXTENSIONS_KEY) ?? "[]",
    );
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function BrowserToolbar({
  tab,
  agentOpen,
  addressRef,
  bookmarked,
  showBookmarksBar,
  sleepingTabsEnabled,
  onToggleAgent,
  onToggleBookmarksBar,
  onToggleSleepingTabs,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onStop,
  onOpenHistory,
  onOpenDownloads,
  onOpenBookmarks,
  onOpenFind,
  onPrint,
  onOpenDevTools,
  onSaveScreenshot,
  onToggleBookmark,
  onOpenSettings,
  onToggleCalculator,
  onOpenMenu,
}: {
  tab: UserBrowserTab;
  agentOpen: boolean;
  addressRef: RefObject<HTMLInputElement | null>;
  bookmarked: boolean;
  showBookmarksBar: boolean;
  sleepingTabsEnabled: boolean;
  onToggleAgent(): void;
  onToggleBookmarksBar(): void;
  onToggleSleepingTabs(): void;
  onNavigate(input: string): void;
  onBack(): void;
  onForward(): void;
  onReload(): void;
  onStop(): void;
  onOpenHistory(): void;
  onOpenDownloads(): void;
  onOpenBookmarks(): void;
  onOpenFind(): void;
  onPrint(): void;
  onOpenDevTools(): void;
  onSaveScreenshot(): Promise<string | undefined>;
  onToggleBookmark(): void;
  onOpenSettings(): void;
  onToggleCalculator(): void;
  onOpenMenu(): void;
}) {
  const [address, setAddress] = useState(tab.url);
  const [openMenu, setOpenMenu] = useState<ToolbarMenu>(null);
  const [extensions, setExtensions] = useState<InstalledExtension[]>([]);
  const [pinnedExtensionIds, setPinnedExtensionIds] = useState(
    readPinnedExtensions,
  );
  const [toolNotice, setToolNotice] = useState("");
  const menuRef = useRef<HTMLDivElement | null>(null);
  const lastTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => setAddress(tab.url), [tab.id, tab.url]);

  const loadExtensions = useCallback(async () => {
    try {
      const response = await window.kestrel.request({
        type: "browser-list-extensions",
      });
      if (response.ok && "extensions" in response)
        setExtensions(response.extensions);
    } catch {
      // Extension management is optional; the menu remains useful without it.
    }
  }, []);

  useEffect(() => {
    void loadExtensions();
  }, [loadExtensions]);

  useEffect(() => {
    if (openMenu === "extensions") void loadExtensions();
  }, [loadExtensions, openMenu]);

  const closeMenu = useCallback(() => {
    setOpenMenu(null);
    window.requestAnimationFrame(() => {
      lastTriggerRef.current?.focus();
    });
  }, []);

  useEffect(() => {
    if (!openMenu) return;
    const frame = window.requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLElement>(
          "button[role='menuitem'], button[role='menuitemcheckbox']",
        )
        ?.focus();
    });
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        !menuRef.current?.contains(target) &&
        !lastTriggerRef.current?.contains(target)
      )
        closeMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
        return;
      }
      if (!menuRef.current || !["ArrowDown", "ArrowUp"].includes(event.key))
        return;
      const items = Array.from(
        menuRef.current.querySelectorAll<HTMLElement>(
          "button[role='menuitem'], button[role='menuitemcheckbox'], input",
        ),
      );
      if (items.length === 0) return;
      const index = items.indexOf(document.activeElement as HTMLElement);
      const delta = event.key === "ArrowDown" ? 1 : -1;
      event.preventDefault();
      items[(index + delta + items.length) % items.length]?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closeMenu, openMenu]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (address.trim()) onNavigate(address);
  }

  function toggleMenu(menu: Exclude<ToolbarMenu, null>, event: MenuTriggerEvent) {
    lastTriggerRef.current = event.currentTarget as HTMLButtonElement;
    setToolNotice("");
    setOpenMenu((current) => (current === menu ? null : menu));
  }

  function updatePinnedExtensions(id: string) {
    setPinnedExtensionIds((current) => {
      const next = current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id];
      try {
        localStorage.setItem(PINNED_EXTENSIONS_KEY, JSON.stringify(next));
      } catch {
        // A browser profile may be read-only; the current session still works.
      }
      return next;
    });
  }

  function runAndClose(action: () => void) {
    action();
    closeMenu();
  }

  async function saveScreenshot() {
    setToolNotice("Saving screenshot…");
    try {
      const path = await onSaveScreenshot();
      setToolNotice(path ? "Screenshot saved" : "Screenshot canceled");
    } catch {
      setToolNotice("Screenshot could not be saved");
    }
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

  const pinnedExtensions = pinnedExtensionIds
    .map((id) => extensions.find((extension) => extension.id === id))
    .filter((extension): extension is InstalledExtension => Boolean(extension));

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
        {tab.canGoForward && (
          <button
            type="button"
            aria-label="Forward"
            aria-keyshortcuts="Meta+]"
            title="Forward (⌘])"
            onClick={onForward}
          >
            <Icon name="forward" />
          </button>
        )}
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
          placeholder="Search or enter an address"
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
      <div className="browser-toolbar-actions">
        <div className="browser-extension-cluster">
          <button
            type="button"
            className={`browser-toolbar-menu-trigger ${openMenu === "extensions" ? "active" : ""}`}
            aria-label="Extensions"
            aria-haspopup="menu"
            aria-expanded={openMenu === "extensions"}
            title="Extensions"
            onClick={(event) => toggleMenu("extensions", event)}
          >
            <Icon name="extensions" />
          </button>
          {pinnedExtensions.map((extension) => (
            <button
              type="button"
              className="browser-pinned-extension"
              key={extension.id}
              aria-label={`Open extensions menu for ${extension.name}`}
              title={`${extension.name}${extension.enabled ? "" : " (disabled)"}`}
              onClick={(event) => toggleMenu("extensions", event)}
            >
              <Icon name="extensions" />
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`browser-toolbar-menu-trigger ${openMenu === "tools" ? "active" : ""}`}
          aria-label="Tools"
          aria-haspopup="menu"
          aria-expanded={openMenu === "tools"}
          title="Tools"
          onClick={(event) => toggleMenu("tools", event)}
        >
          <Icon name="tools" />
        </button>
        <button
          type="button"
          className={`browser-toolbar-menu-trigger ${openMenu === "screen" ? "active" : ""}`}
          aria-label="Page options"
          aria-haspopup="menu"
          aria-expanded={openMenu === "screen"}
          title="Page options"
          onClick={(event) => toggleMenu("screen", event)}
        >
          <Icon name="sliders" />
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
        <button
          id="browser-agent-toggle"
          type="button"
          className={`browser-agent-toggle ${agentOpen ? "active" : ""}`}
          aria-label={agentOpen ? "Hide Pragmatic" : "Show Pragmatic"}
          aria-expanded={agentOpen}
          title={agentOpen ? "Hide Pragmatic" : "Show Pragmatic"}
          onClick={onToggleAgent}
        >
          <span className="pragmatic-logo" aria-hidden="true">
            <Icon name="pragmatic" />
          </span>
          <span>Pragmatic</span>
        </button>

        {openMenu && (
          <div
            ref={menuRef}
            className={`browser-toolbar-popover browser-toolbar-popover-${openMenu}`}
            role="menu"
            aria-label={
              openMenu === "extensions"
                ? "Extensions"
                : openMenu === "tools"
                  ? "Tools"
                  : "Page options"
              }
          >
            {openMenu === "extensions" && (
              <>
                <header className="browser-toolbar-popover-header">
                  <Icon name="extensions" />
                  <span>
                    <strong>Extensions</strong>
                    <small>Pin quick actions beside the logo</small>
                  </span>
                </header>
                {extensions.length === 0 ? (
                  <p className="browser-toolbar-popover-empty">
                    No browser extensions installed yet.
                  </p>
                ) : (
                  <div className="browser-extension-list">
                    {extensions.map((extension) => {
                      const pinned = pinnedExtensionIds.includes(extension.id);
                      return (
                        <div className="browser-extension-row" key={extension.id}>
                          <span className="browser-extension-icon" aria-hidden="true">
                            <Icon name="extensions" />
                          </span>
                          <span className="browser-extension-copy">
                            <strong>{extension.name}</strong>
                            <small>
                              {extension.enabled ? "Enabled" : "Disabled"}
                            </small>
                          </span>
                            <button
                              type="button"
                              className={`browser-extension-pin ${pinned ? "active" : ""}`}
                              role="menuitemcheckbox"
                              aria-checked={pinned}
                              aria-label={pinned ? `Unpin ${extension.name}` : `Pin ${extension.name}`}
                              title={pinned ? "Unpin extension" : "Pin extension"}
                              onClick={() => updatePinnedExtensions(extension.id)}
                            >
                              <Icon name="pin" />
                            </button>
                          </div>
                        );
                    })}
                  </div>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className="browser-toolbar-menu-link"
                  onClick={() => runAndClose(onOpenSettings)}
                >
                  <Icon name="settings" />
                  <span>Manage extensions</span>
                  <Icon name="chevron" />
                </button>
              </>
            )}
            {openMenu === "tools" && (
              <>
                <header className="browser-toolbar-popover-header">
                  <Icon name="tools" />
                  <span>
                    <strong>Tools</strong>
                    <small>Common actions for this page</small>
                  </span>
                </header>
                <div className="browser-toolbar-tool-grid">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void saveScreenshot()}
                  >
                    <Icon name="screenshot" />
                    <span>Screenshot</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => runAndClose(onToggleCalculator)}
                  >
                    <Icon name="calculator" />
                    <span>Calculator</span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => runAndClose(onOpenHistory)}>
                    <Icon name="history" />
                    <span>History</span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => runAndClose(onOpenBookmarks)}>
                    <Icon name="star" />
                    <span>Bookmarks</span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => runAndClose(onOpenDownloads)}>
                    <Icon name="downloads" />
                    <span>Downloads</span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => runAndClose(onOpenFind)}>
                    <Icon name="search" />
                    <span>Find in page</span>
                    <kbd>⌘F</kbd>
                  </button>
                  <button type="button" role="menuitem" onClick={() => runAndClose(onPrint)}>
                    <Icon name="print" />
                    <span>Print page</span>
                    <kbd>⌘P</kbd>
                  </button>
                  <button type="button" role="menuitem" onClick={() => runAndClose(onOpenDevTools)}>
                    <Icon name="devtools" />
                    <span>Developer tools</span>
                  </button>
                </div>
                {toolNotice && (
                  <p className="browser-toolbar-popover-notice" role="status">
                    {toolNotice}
                  </p>
                )}
              </>
            )}
            {openMenu === "screen" && (
              <>
                <header className="browser-toolbar-popover-header">
                  <Icon name="sliders" />
                  <span>
                    <strong>Page options</strong>
                    <small>Quick settings for this browser surface</small>
                  </span>
                </header>
                <div className="browser-toolbar-settings-list">
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={showBookmarksBar}
                    onClick={onToggleBookmarksBar}
                  >
                    <Icon name="star" />
                    <span>Show bookmarks bar</span>
                    <Icon name={showBookmarksBar ? "check" : "close"} />
                  </button>
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={sleepingTabsEnabled}
                    onClick={onToggleSleepingTabs}
                  >
                    <Icon name="sleep" />
                    <span>Sleep inactive tabs</span>
                    <Icon name={sleepingTabsEnabled ? "check" : "close"} />
                  </button>
                  <button type="button" role="menuitem" onClick={() => runAndClose(onOpenSettings)}>
                    <Icon name="settings" />
                    <span>All browser settings</span>
                    <Icon name="chevron" />
                  </button>
                  <button type="button" role="menuitem" onClick={() => runAndClose(onOpenMenu)}>
                    <Icon name="command" />
                    <span>Capabilities and commands</span>
                    <Icon name="chevron" />
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
      <span className="browser-toolbar-drag-fill" aria-hidden="true" />
    </div>
  );
}
