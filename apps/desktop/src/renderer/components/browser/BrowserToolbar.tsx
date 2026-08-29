import {
  useCallback,
  useEffect,
  useRef,
  useMemo,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type RefObject,
} from "react";
import type {
  InstalledExtension,
  UserBrowserBookmark,
  UserBrowserHistoryEntry,
  UserBrowserOriginFavicon,
  UserBrowserSettings,
  UserBrowserTab,
} from "@kestrel/shared-types";
import { Icon } from "../Icon";
import {
  getAddressBarSuggestions,
  getInlineAddressCompletion,
  type AddressBarSuggestion,
  type AddressBarSuggestionFilter,
} from "./address-bar-suggestions";
import { BrowserHistoryPopover } from "./BrowserHistoryPopover";

type ToolbarMenu = "extensions" | "tools" | "screen" | "history" | null;

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
  history,
  bookmarks,
  tabs,
  activeTabId,
  originFavicons,
  searchEngine,
  customSearchName,
  addressBarSuggestionsEnabled,
  agentOpen,
  addressRef,
  bookmarked,
  showBookmarksBar,
  sleepingTabsEnabled,
  onToggleAgent,
  onToggleBookmarksBar,
  onToggleSleepingTabs,
  onNavigate,
  onSelectTab,
  onBack,
  onForward,
  onReload,
  onStop,
  onOpenHistoryFull,
  onClearHistory,
  historyPopoverRequestId = 0,
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
  onMenuOpenChange,
}: {
  tab: UserBrowserTab;
  history: readonly UserBrowserHistoryEntry[];
  bookmarks: readonly UserBrowserBookmark[];
  tabs: readonly UserBrowserTab[];
  activeTabId: string | null;
  originFavicons: readonly UserBrowserOriginFavicon[];
  searchEngine: UserBrowserSettings["searchEngine"];
  customSearchName?: string;
  addressBarSuggestionsEnabled: boolean;
  agentOpen: boolean;
  addressRef: RefObject<HTMLInputElement | null>;
  bookmarked: boolean;
  showBookmarksBar: boolean;
  sleepingTabsEnabled: boolean;
  onToggleAgent(): void;
  onToggleBookmarksBar(): void;
  onToggleSleepingTabs(): void;
  onNavigate(input: string): void;
  onSelectTab(tabId: string): void;
  onBack(): void;
  onForward(): void;
  onReload(): void;
  onStop(): void;
  onOpenHistoryFull(): void;
  onClearHistory(): void;
  historyPopoverRequestId?: number;
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
  onMenuOpenChange?(open: boolean): void;
}) {
  const [address, setAddress] = useState(tab.url);
  const [suggestionQuery, setSuggestionQuery] = useState("");
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [suggestionFilter, setSuggestionFilter] =
    useState<AddressBarSuggestionFilter>("all");
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const [openMenu, setOpenMenu] = useState<ToolbarMenu>(null);
  const [extensions, setExtensions] = useState<InstalledExtension[]>([]);
  const [pinnedExtensionIds, setPinnedExtensionIds] = useState(
    readPinnedExtensions,
  );
  const [toolNotice, setToolNotice] = useState("");
  const menuRef = useRef<HTMLDivElement | null>(null);
  const lastTriggerRef = useRef<HTMLButtonElement | null>(null);
  const historyTriggerRef = useRef<HTMLButtonElement | null>(null);
  const historyPopoverRequestRef = useRef(0);
  const suggestionsCloseTimerRef = useRef<number | null>(null);
  const inlineCompletionRef = useRef<{ typed: string; completed: string } | null>(
    null,
  );

  const suggestionSource = useMemo(
    () => ({
      history,
      bookmarks,
      tabs,
      activeTabId,
      originFavicons,
      searchEngineName:
        customSearchName?.trim() ||
        ({
          google: "Google",
          duckduckgo: "DuckDuckGo",
          bing: "Bing",
          brave: "Brave Search",
          ecosia: "Ecosia",
          startpage: "Startpage",
          yahoo: "Yahoo",
          kagi: "Kagi",
          qwant: "Qwant",
          mojeek: "Mojeek",
          baidu: "Baidu",
          yandex: "Yandex",
          custom: "Search",
        }[searchEngine] ?? "Search"),
    }),
    [
      activeTabId,
      bookmarks,
      customSearchName,
      history,
      originFavicons,
      searchEngine,
      tabs,
    ],
  );
  const suggestions = useMemo(
    () =>
      getAddressBarSuggestions({
        ...suggestionSource,
        query: suggestionQuery,
        filter: suggestionFilter,
      }),
    [suggestionFilter, suggestionQuery, suggestionSource],
  );
  const showSuggestions =
    suggestionsOpen &&
    addressBarSuggestionsEnabled &&
    (suggestions.length > 0 ||
      suggestionQuery.trim().length > 0 ||
      suggestionFilter !== "all");

  function clearSuggestionsCloseTimer() {
    if (suggestionsCloseTimerRef.current === null) return;
    window.clearTimeout(suggestionsCloseTimerRef.current);
    suggestionsCloseTimerRef.current = null;
  }

  function closeSuggestions() {
    clearSuggestionsCloseTimer();
    setSuggestionsOpen(false);
    setSuggestionFilter("all");
    setActiveSuggestionIndex(-1);
  }

  function scheduleCloseSuggestions() {
    clearSuggestionsCloseTimer();
    suggestionsCloseTimerRef.current = window.setTimeout(() => {
      suggestionsCloseTimerRef.current = null;
      closeSuggestions();
    }, 120);
  }

  useEffect(() => {
    setAddress(tab.url);
    setSuggestionQuery("");
    setSuggestionsOpen(false);
    setSuggestionFilter("all");
    setActiveSuggestionIndex(-1);
    inlineCompletionRef.current = null;
  }, [tab.id, tab.url]);

  useEffect(() => {
    if (addressBarSuggestionsEnabled) return;
    closeSuggestions();
    inlineCompletionRef.current = null;
  }, [addressBarSuggestionsEnabled]);

  useEffect(
    () => () => clearSuggestionsCloseTimer(),
    [],
  );

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

  useEffect(() => {
    if (
      historyPopoverRequestId <= 0 ||
      historyPopoverRequestRef.current === historyPopoverRequestId
    )
      return;
    historyPopoverRequestRef.current = historyPopoverRequestId;
    lastTriggerRef.current = historyTriggerRef.current;
    setOpenMenu("history");
  }, [historyPopoverRequestId]);

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

  useEffect(() => {
    onMenuOpenChange?.(Boolean(openMenu || showSuggestions));
  }, [onMenuOpenChange, openMenu, showSuggestions]);

  function chooseSuggestion(suggestion: AddressBarSuggestion) {
    closeSuggestions();
    inlineCompletionRef.current = null;
    if (suggestion.kind === "tab" && suggestion.tabId) {
      onSelectTab(suggestion.tabId);
      return;
    }
    if (suggestion.value.trim()) onNavigate(suggestion.value);
  }

  function handleAddressChange(
    event: ChangeEvent<HTMLInputElement>,
  ): void {
    const input = event.currentTarget;
    const typed = input.value;
    const inputType = (event.nativeEvent as InputEvent).inputType;
    inlineCompletionRef.current = null;
    setAddress(typed);
    setSuggestionQuery(typed);
    setSuggestionFilter("all");
    setActiveSuggestionIndex(-1);
    setSuggestionsOpen(addressBarSuggestionsEnabled);

    // Deletions are an explicit correction signal. Do not immediately put the
    // same suffix back after Backspace/Delete, which is one of the most
    // frustrating omnibox behaviours in otherwise good browser UIs.
    if (inputType?.startsWith("delete")) return;
    if (!addressBarSuggestionsEnabled) return;
    const nextSuggestions = getAddressBarSuggestions({
      ...suggestionSource,
      query: typed,
      filter: "all",
    });
    const completion = getInlineAddressCompletion(typed, nextSuggestions);
    if (!completion) return;
    inlineCompletionRef.current = { typed, completed: completion.value };
    setAddress(completion.value);
    window.requestAnimationFrame(() => {
      if (
        document.activeElement === input &&
        input.value === completion.value
      )
        input.setSelectionRange(typed.length, completion.value.length);
    });
  }

  function handleAddressKeyDown(
    event: ReactKeyboardEvent<HTMLInputElement>,
  ): void {
    if (event.key === "Escape" && (showSuggestions || inlineCompletionRef.current)) {
      event.preventDefault();
      const inline = inlineCompletionRef.current;
      closeSuggestions();
      inlineCompletionRef.current = null;
      if (inline) {
        setAddress(inline.typed);
        setSuggestionQuery(inline.typed);
        window.requestAnimationFrame(() => {
          const input = addressRef.current;
          if (input) {
            input.focus();
            input.setSelectionRange(inline.typed.length, inline.typed.length);
          }
        });
      }
      return;
    }
    if (
      showSuggestions &&
      (event.key === "ArrowDown" || event.key === "ArrowUp")
    ) {
      event.preventDefault();
      setActiveSuggestionIndex((current) => {
        if (suggestions.length === 0) return -1;
        if (event.key === "ArrowDown")
          return current < suggestions.length - 1 ? current + 1 : 0;
        return current > 0 ? current - 1 : suggestions.length - 1;
      });
      return;
    }
    if (event.key === "Enter" && showSuggestions && activeSuggestionIndex >= 0) {
      const suggestion = suggestions[activeSuggestionIndex];
      if (suggestion) {
        event.preventDefault();
        chooseSuggestion(suggestion);
      }
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const input = inlineCompletionRef.current?.completed ?? address;
    closeSuggestions();
    inlineCompletionRef.current = null;
    if (input.trim()) onNavigate(input);
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

  function openHistoryEntry(url: string) {
    onNavigate(url);
    closeMenu();
  }

  function openHistoryFull() {
    onOpenHistoryFull();
    closeMenu();
  }

  function clearHistory() {
    onClearHistory();
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
      <div
        className="window-controls-clearance no-drag"
        aria-hidden="true"
      />
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
      <div className="browser-address-shell">
        <form
          className={`browser-address ${showSuggestions ? "has-suggestions" : ""}`}
          onSubmit={submit}
        >
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
            role="combobox"
            aria-autocomplete="both"
            aria-controls="browser-address-suggestions"
            aria-expanded={showSuggestions}
            aria-activedescendant={
              activeSuggestionIndex >= 0
                ? `browser-address-suggestion-${activeSuggestionIndex}`
                : undefined
            }
            aria-keyshortcuts="Meta+L"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onFocus={(event) => {
              clearSuggestionsCloseTimer();
              const nextQuery = address === tab.url ? "" : address;
              setSuggestionQuery(nextQuery);
              setSuggestionFilter("all");
              setActiveSuggestionIndex(-1);
              setSuggestionsOpen(addressBarSuggestionsEnabled);
              inlineCompletionRef.current = null;
              event.currentTarget.select();
            }}
            onBlur={scheduleCloseSuggestions}
            onKeyDown={handleAddressKeyDown}
            onChange={handleAddressChange}
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
        {showSuggestions && (
          <div
            className="browser-address-suggestions"
            id="browser-address-suggestions"
            aria-label="Address suggestions"
          >
            <div
              className="browser-address-suggestion-list"
              role="listbox"
              aria-label="Address suggestions"
            >
              {suggestions.length === 0 ? (
                <p className="browser-address-suggestions-empty">
                  No local matches for this filter.
                </p>
              ) : (
                suggestions.map((suggestion, index) => (
                  <button
                    type="button"
                    role="option"
                    id={`browser-address-suggestion-${index}`}
                    className="browser-address-suggestion"
                    data-active={activeSuggestionIndex === index || undefined}
                    aria-selected={activeSuggestionIndex === index}
                    key={suggestion.id}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActiveSuggestionIndex(index)}
                    onClick={() => chooseSuggestion(suggestion)}
                  >
                    <span className="browser-address-suggestion-icon" aria-hidden="true">
                      {suggestion.faviconDataUrl ? (
                        <img src={suggestion.faviconDataUrl} alt="" />
                      ) : (
                        <Icon
                          name={
                            suggestion.kind === "search"
                              ? "search"
                              : suggestion.kind === "history"
                                ? "history"
                                : suggestion.kind === "bookmark"
                                  ? "star"
                                  : suggestion.kind === "tab"
                                    ? "browser"
                                    : "globe"
                          }
                        />
                      )}
                    </span>
                    <span className="browser-address-suggestion-copy">
                      <strong>{suggestion.title}</strong>
                      <small>{suggestion.detail}</small>
                    </span>
                    {suggestion.kind === "tab" && suggestion.tabId !== activeTabId ? (
                      <span className="browser-address-suggestion-action">
                        Switch to this tab
                      </span>
                    ) : suggestion.kind === "tab" ? (
                      <span className="browser-address-suggestion-action">
                        Current tab
                      </span>
                    ) : (
                      <Icon name="chevron" />
                    )}
                  </button>
                ))
              )}
            </div>
            <div className="browser-address-suggestions-footer">
              <span className="browser-address-suggestions-local">
                <Icon name="safety" />
                Local only
              </span>
              <span className="browser-address-suggestions-filter-label">
                Filter your search:
              </span>
              <div className="browser-address-suggestion-filters" role="group" aria-label="Suggestion filters">
                {(
                  [
                    ["history", "History", "history"],
                    ["bookmarks", "Favorites", "star"],
                    ["tabs", "Tabs", "browser"],
                  ] as const
                ).map(([filter, label, icon]) => (
                  <button
                    type="button"
                    className={suggestionFilter === filter ? "active" : ""}
                    aria-pressed={suggestionFilter === filter}
                    key={filter}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setSuggestionFilter(filter);
                      setActiveSuggestionIndex(-1);
                      setSuggestionsOpen(true);
                    }}
                  >
                    <Icon name={icon} />
                    {label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="browser-address-suggestions-settings"
                aria-label="Open browser settings"
                title="Suggestion settings"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  closeSuggestions();
                  onOpenSettings();
                }}
              >
                <Icon name="settings" />
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="browser-toolbar-actions">
        <div className="browser-extension-cluster browser-toolbar-secondary">
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
          ref={historyTriggerRef}
          type="button"
          className={`browser-toolbar-menu-trigger browser-toolbar-secondary ${openMenu === "history" ? "active" : ""}`}
          aria-label="History"
          aria-haspopup="menu"
          aria-expanded={openMenu === "history"}
          aria-keyshortcuts="Meta+H"
          title="History (⌘H)"
          onClick={(event) => toggleMenu("history", event)}
        >
          <Icon name="history" />
        </button>
        <button
          type="button"
          className="browser-toolbar-secondary"
          aria-label="Bookmarks"
          aria-keyshortcuts="Meta+Shift+D"
          title="Bookmarks (⌘⇧D)"
          onClick={onOpenBookmarks}
        >
          <Icon name="star" />
        </button>
        <button
          type="button"
          className="browser-toolbar-secondary"
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
                  : openMenu === "history"
                    ? "History"
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
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      lastTriggerRef.current = historyTriggerRef.current;
                      setOpenMenu("history");
                    }}
                  >
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
            {openMenu === "history" && (
              <BrowserHistoryPopover
                history={history}
                onOpen={openHistoryEntry}
                onOpenFull={openHistoryFull}
                onClear={clearHistory}
              />
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
