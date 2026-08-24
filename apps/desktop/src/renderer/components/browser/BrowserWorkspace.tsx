import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type {
	FilePreview,
	RuntimeSession,
	UserBrowserFile,
	UserBrowserTab,
} from "@kestrel/shared-types";
import type { UserBrowserController } from "../../browser/useUserBrowser";
import {
  parseKestrelAppPage,
  parseKestrelFilePage,
} from "../../../utility/browser-app-pages";
import { BrandMark } from "../BrandMark";
import { Icon } from "../Icon";
import { BookmarksBar } from "./BookmarksBar";
import { BrowserToolbar } from "./BrowserToolbar";
import { NewTabPage } from "./NewTabPage";
import { TabStrip } from "./TabStrip";
import { recordNewTabGreetingVisit } from "./new-tab";

function tabOrganizationCompare(
  left: UserBrowserTab,
  right: UserBrowserTab,
): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  const hostname = (tab: UserBrowserTab) => {
    try {
      return new URL(tab.url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return "kestrel";
    }
  };
  return (
    hostname(left).localeCompare(hostname(right)) ||
    left.title.localeCompare(right.title) ||
    left.createdAt.localeCompare(right.createdAt)
  );
}

export function BrowserWorkspace({
  browser,
  agentName,
	greetingName,
  agentOpen,
  onToggleAgent,
  onNewAgent,
	onOpenTaskSettings,
  onOpenSettings,
  onOpenWorkspaces,
  onOpenHistory,
  onOpenDownloads,
  onOpenBookmarks,
  onOpenMenu,
  onShowShortcuts,
	onToggleSidebar,
	onAskFile,
	appPage,
	sessions = [],
	onOpenSession,
}: {
  browser: UserBrowserController;
  agentName: string;
	greetingName?: string | undefined;
  agentOpen: boolean;
  onToggleAgent(): void;
  onNewAgent(prompt?: string): void;
	onOpenTaskSettings(): void;
  onOpenSettings(): void;
  onOpenWorkspaces?(): void;
  onOpenHistory(): void;
  onOpenDownloads(): void;
  onOpenBookmarks(): void;
  onOpenMenu(): void;
  onShowShortcuts?(): void;
  onToggleSidebar?(): void;
	onAskFile(file: UserBrowserFile): void;
	appPage?: ReactNode;
	sessions?: RuntimeSession[];
	onOpenSession?(sessionId: string): void;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const addressRef = useRef<HTMLInputElement | null>(null);
  const findRef = useRef<HTMLInputElement | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [fileDragActive, setFileDragActive] = useState(false);
  const [openChromeMenus, setOpenChromeMenus] = useState({
    tab: false,
    toolbar: false,
  });
  const lastBoundsRef = useRef("");
  const state = browser.state;
  const {
    back,
    closeTab,
    createTab,
    reopenClosedTab,
    forward,
    navigate,
    reload,
    selectTab,
    setContentBounds,
    toggleCalculator,
    updateSettings,
    stop,
    zoomIn,
    zoomOut,
    zoomReset,
    toggleBookmark,
    pinTab,
    muteTab,
    duplicateTab,
    closeOtherTabs,
    findInPage,
    stopFindInPage,
    printTab,
    openDevTools,
    moveTab,
    detachTab,
  } = browser;

  const organizeTabs = useCallback(async () => {
    if (!state || state.tabs.length < 2) return;
    const order = state.tabs.map((tab) => tab.id);
    const sortedIds = [...state.tabs]
      .sort(tabOrganizationCompare)
      .map((tab) => tab.id);
    for (let targetIndex = 0; targetIndex < sortedIds.length; targetIndex += 1) {
      const tabId = sortedIds[targetIndex];
      if (!tabId) continue;
      const currentIndex = order.indexOf(tabId);
      if (currentIndex < 0 || currentIndex === targetIndex) continue;
      await moveTab(tabId, targetIndex);
      order.splice(currentIndex, 1);
      order.splice(targetIndex, 0, tabId);
    }
  }, [moveTab, state]);
  const activeTab = state?.tabs.find((tab) => tab.id === state.activeTabId);
  const activeAppPage = activeTab ? parseKestrelAppPage(activeTab.url) : undefined;
  const activeFilePage = activeTab ? parseKestrelFilePage(activeTab.url) : undefined;
  const nativePageEligible = Boolean(
    activeTab?.url && !activeTab.error && !activeAppPage && !activeFilePage,
  );
  const nativePageVisible =
    nativePageEligible && !openChromeMenus.tab && !openChromeMenus.toolbar;

  const handleTabMenuOpenChange = useCallback((open: boolean) => {
    setOpenChromeMenus((current) =>
      current.tab === open ? current : { ...current, tab: open },
    );
  }, []);
  const handleToolbarMenuOpenChange = useCallback((open: boolean) => {
    setOpenChromeMenus((current) =>
      current.toolbar === open ? current : { ...current, toolbar: open },
    );
  }, []);

  useEffect(
    () => window.kestrel.onFileDrag(({ active }) => setFileDragActive(active)),
    [],
  );

  const syncBounds = useCallback(() => {
    const node = viewportRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const bounds = {
      x: Math.max(0, Math.round(rect.left)),
      y: Math.max(0, Math.round(rect.top)),
      width: Math.max(0, Math.round(rect.width)),
      height: Math.max(0, Math.round(rect.height)),
    };
    const key = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}:${nativePageVisible}`;
    if (lastBoundsRef.current === key) return;
    lastBoundsRef.current = key;
    void setContentBounds(bounds, nativePageVisible).catch(() => undefined);
  }, [nativePageVisible, setContentBounds]);

  useLayoutEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const observer = new ResizeObserver(syncBounds);
    observer.observe(node);
    const root = document.getElementById("root");
    const mutationObserver = new MutationObserver(syncBounds);
    if (root) mutationObserver.observe(root, { childList: true });
    window.addEventListener("resize", syncBounds);
    const frame = window.requestAnimationFrame(syncBounds);
    const settleTimer = window.setTimeout(syncBounds, 320);
    syncBounds();
    return () => {
      observer.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", syncBounds);
      window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
      lastBoundsRef.current = "";
      void setContentBounds({ x: 0, y: 0, width: 0, height: 0 }, false).catch(
        () => undefined,
      );
    };
  }, [setContentBounds, syncBounds]);

  useEffect(
    () =>
      window.kestrel.onBrowserCommand((command) => {
        if (command === "focus-address") addressRef.current?.focus();
        else if (command === "new-agent") onNewAgent();
        else if (command === "open-commands") onOpenMenu();
        else if (command === "open-history") onOpenHistory();
        else if (command === "open-downloads") onOpenDownloads();
        else if (command === "open-bookmarks") onOpenBookmarks();
        else if (command === "open-settings") onOpenSettings?.();
        else if (command === "show-shortcuts") onShowShortcuts?.();
        else if (command === "toggle-sidebar") onToggleSidebar?.();
        else if (command === "reopen-closed-tab") void reopenClosedTab();
        else if (command === "find-in-page") {
          setFindOpen(true);
          window.requestAnimationFrame(() => findRef.current?.focus());
        }
        else if (command === "print-page" && activeTab?.url)
          void printTab(activeTab.id);
      }),
    [
      activeTab,
      onNewAgent,
      onOpenMenu,
      onOpenHistory,
      onOpenDownloads,
      onOpenBookmarks,
      onOpenSettings,
      onShowShortcuts,
      onToggleSidebar,
      printTab,
      reopenClosedTab,
    ],
  );

  useEffect(() => {
    function shortcuts(event: KeyboardEvent) {
      if (event.defaultPrevented) return;

      if (event.key === "Escape") {
        if (findOpen && activeTab) {
          event.preventDefault();
          setFindOpen(false);
          setFindQuery("");
          void stopFindInPage(activeTab.id);
          return;
        }
        if (activeTab?.loading) {
          event.preventDefault();
          void stop(activeTab.id);
        } else if (document.activeElement === addressRef.current) {
          addressRef.current?.blur();
        }
        return;
      }

      if (event.key === "F5") {
        event.preventDefault();
        if (activeTab) void reload(activeTab.id, event.shiftKey);
        return;
      }

      if (event.key === "F1") {
        event.preventDefault();
        onShowShortcuts?.();
        return;
      }

      if (event.altKey && !event.metaKey && !event.ctrlKey) {
        if (event.key === "ArrowLeft" && activeTab?.canGoBack) {
          event.preventDefault();
          void back(activeTab.id);
          return;
        }
        if (event.key === "ArrowRight" && activeTab?.canGoForward) {
          event.preventDefault();
          void forward(activeTab.id);
          return;
        }
        if (event.key.toLowerCase() === "d") {
          event.preventDefault();
          addressRef.current?.focus();
          return;
        }
      }

      const command = event.metaKey || event.ctrlKey;
      if (!command) return;
      const key = event.key.toLowerCase();

      if (/^[1-8]$/.test(event.key) && state?.tabs.length) {
        event.preventDefault();
        const targetIndex = parseInt(event.key, 10) - 1;
        const targetTab = state.tabs[targetIndex];
        if (targetTab) void selectTab(targetTab.id);
        return;
      }
      if (event.key === "9" && state?.tabs.length) {
        event.preventDefault();
        const lastTab = state.tabs[state.tabs.length - 1];
        if (lastTab) void selectTab(lastTab.id);
        return;
      }

      if (
        (((key === "tab" && !event.shiftKey) ||
          key === "pagedown" ||
          (key === "]" && event.shiftKey)) &&
          state?.tabs.length) ||
        (event.altKey && event.key === "ArrowRight" && state?.tabs.length)
      ) {
        event.preventDefault();
        const index = state.tabs.findIndex(
          (tab) => tab.id === state.activeTabId,
        );
        const next =
          state.tabs[(index + 1 + state.tabs.length) % state.tabs.length];
        if (next) void selectTab(next.id);
        return;
      }
      if (
        ((key === "pageup" || (key === "[" && event.shiftKey)) &&
          state?.tabs.length) ||
        (key === "tab" && event.shiftKey && state?.tabs.length) ||
        (event.altKey && event.key === "ArrowLeft" && state?.tabs.length)
      ) {
        event.preventDefault();
        const index = state.tabs.findIndex(
          (tab) => tab.id === state.activeTabId,
        );
        const prev =
          state.tabs[(index - 1 + state.tabs.length) % state.tabs.length];
        if (prev) void selectTab(prev.id);
        return;
      }

      if (["=", "+"].includes(event.key)) {
        event.preventDefault();
        void zoomIn(activeTab?.id);
        return;
      }
      if (["-", "_"].includes(event.key)) {
        event.preventDefault();
        void zoomOut(activeTab?.id);
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        void zoomReset(activeTab?.id);
        return;
      }

      if (key === "l" || (event.ctrlKey && key === "e")) {
        event.preventDefault();
        addressRef.current?.focus();
      } else if (key === "t") {
        event.preventDefault();
        if (event.shiftKey) {
          void reopenClosedTab();
        } else {
          void createTab();
        }
      } else if (key === "w" && activeTab) {
        event.preventDefault();
        void closeTab(activeTab.id);
      } else if (key === "r" && activeTab) {
        event.preventDefault();
        void reload(activeTab.id, event.shiftKey);
      } else if (key === "h" || key === "y") {
        event.preventDefault();
        onOpenHistory();
      } else if (key === "j") {
        event.preventDefault();
        onOpenDownloads();
      } else if (key === "f") {
        const target = event.target as HTMLElement | null;
        if (target?.closest("#runtime-prompt, textarea, input")) return;
        event.preventDefault();
        setFindOpen(true);
        window.requestAnimationFrame(() => findRef.current?.focus());
      } else if (key === "d") {
        event.preventDefault();
        if (event.shiftKey) onOpenBookmarks();
        else void toggleBookmark();
      } else if (key === "p" && !event.shiftKey && activeTab?.url) {
        event.preventDefault();
        void printTab(activeTab.id);
      } else if (key === "i" && event.shiftKey && activeTab?.url) {
        event.preventDefault();
        void openDevTools(activeTab.id);
      } else if (key === "k" || (key === "p" && event.shiftKey)) {
        event.preventDefault();
        onOpenMenu();
      } else if (key === ",") {
        event.preventDefault();
        onOpenSettings?.();
      } else if (key === "/" || key === "?") {
        event.preventDefault();
        onShowShortcuts?.();
      } else if (key === "b") {
        event.preventDefault();
        if (event.shiftKey && state) {
          void browser.updateSettings({
            showBookmarksBar: !state.settings.showBookmarksBar,
          });
        } else {
          onToggleSidebar?.();
        }
      } else if (key === "s" && event.shiftKey) {
        event.preventDefault();
        onToggleSidebar?.();
      } else if (event.key === "[" && activeTab?.canGoBack) {
        event.preventDefault();
        void back(activeTab.id);
      } else if (event.key === "]" && activeTab?.canGoForward) {
        event.preventDefault();
        void forward(activeTab.id);
      }
    }
    document.addEventListener("keydown", shortcuts);
    return () => document.removeEventListener("keydown", shortcuts);
  }, [
    activeTab,
    back,
    browser,
    closeTab,
    createTab,
    forward,
    onNewAgent,
    onOpenBookmarks,
    onOpenDownloads,
    onOpenHistory,
    onOpenMenu,
    onOpenSettings,
    onShowShortcuts,
    onToggleSidebar,
    openDevTools,
    printTab,
    reload,
    reopenClosedTab,
    selectTab,
    state,
    stop,
    stopFindInPage,
    findOpen,
    toggleBookmark,
    zoomIn,
    zoomOut,
    zoomReset,
  ]);

  if (!state || !activeTab) {
    return (
      <main className="browser-workspace browser-starting">
        <BrandMark />
        <p>{browser.error || "Opening your browser…"}</p>
      </main>
    );
  }

  return (
    <main
      className={`browser-workspace browser-workspace-${state.settings.tabLayout}${
        state.settings.showBookmarksBar ? " browser-workspace-bookmarks" : ""
      }`}
      aria-label="Browser"
    >
      <TabStrip
        tabs={state.tabs}
        originFavicons={state.originFavicons}
        activeTabId={state.activeTabId}
        orientation={state.settings.tabLayout}
        onSelect={(tabId) => void selectTab(tabId)}
        onClose={(tabId) => void closeTab(tabId)}
        onCreate={() => void createTab()}
        onPin={(tabId, pinned) => void pinTab(tabId, pinned)}
        onMute={(tabId, muted) => void muteTab(tabId, muted)}
        onDuplicate={(tabId) => void duplicateTab(tabId)}
        onCloseOthers={(tabId) => void closeOtherTabs(tabId)}
        onMoveTab={(tabId, toIndex) => void moveTab(tabId, toIndex)}
        onDetachTab={(tabId) => void detachTab(tabId)}
        onReopenClosedTab={(index) => void reopenClosedTab(index)}
        recentlyClosedTabs={state.recentlyClosedTabs}
        onOrganizeTabs={organizeTabs}
        onOpenWorkspaces={onOpenWorkspaces}
        onMenuOpenChange={handleTabMenuOpenChange}
        onToggleOrientation={() => {
          void browser.updateSettings({
            tabLayout:
              state.settings.tabLayout === "vertical"
                ? "horizontal"
                : "vertical",
          });
        }}
      />
      <BrowserToolbar
        tab={activeTab}
        agentOpen={agentOpen}
        addressRef={addressRef as RefObject<HTMLInputElement | null>}
        showBookmarksBar={state.settings.showBookmarksBar}
        sleepingTabsEnabled={state.settings.sleepingTabsEnabled}
        onToggleBookmarksBar={() =>
          void browser.updateSettings({
            showBookmarksBar: !state.settings.showBookmarksBar,
          })
        }
        onToggleSleepingTabs={() =>
          void browser.updateSettings({
            sleepingTabsEnabled: !state.settings.sleepingTabsEnabled,
          })
        }
        bookmarked={state.bookmarks.some((item) => item.url === activeTab.url)}
        onToggleAgent={onToggleAgent}
        onNavigate={(input) => void navigate(activeTab.id, input)}
        onBack={() => void back(activeTab.id)}
        onForward={() => void forward(activeTab.id)}
        onReload={() => void reload(activeTab.id)}
        onStop={() => void stop(activeTab.id)}
        onOpenHistory={onOpenHistory}
        onOpenDownloads={onOpenDownloads}
        onOpenBookmarks={onOpenBookmarks}
        onOpenFind={() => {
          setFindOpen(true);
          window.requestAnimationFrame(() => findRef.current?.focus());
        }}
        onPrint={() => void printTab(activeTab.id)}
        onOpenDevTools={() => void openDevTools(activeTab.id)}
        onSaveScreenshot={() => browser.saveScreenshot(activeTab.id)}
        onMenuOpenChange={handleToolbarMenuOpenChange}
        onToggleBookmark={() => void toggleBookmark()}
        onOpenSettings={onOpenSettings}
        onToggleCalculator={() => {
          const node = viewportRef.current;
          if (!node) return;
          const rect = node.getBoundingClientRect();
          void toggleCalculator({
            x: Math.max(0, Math.round(rect.left)),
            y: Math.max(0, Math.round(rect.top)),
            width: Math.max(0, Math.round(rect.width)),
            height: Math.max(0, Math.round(rect.height)),
          }).catch(() => undefined);
        }}
        onOpenMenu={onOpenMenu}
      />
      {state.settings.showBookmarksBar && (
        <BookmarksBar
          bookmarks={state.bookmarks}
          originFavicons={state.originFavicons}
          onOpen={(url) => void navigate(activeTab.id, url)}
          onOpenInNewTab={(url) => void createTab(url)}
          onRemove={(bookmarkId) => void browser.removeBookmark(bookmarkId)}
          onManage={onOpenBookmarks}
        />
      )}
      {findOpen && (
        <form
          className="browser-find-bar"
          onSubmit={(event) => {
            event.preventDefault();
            if (activeTab?.url)
              void findInPage(activeTab.id, findQuery, { findNext: true });
          }}
        >
          <label className="sr-only" htmlFor="browser-find-input">
            Find in page
          </label>
          <input
            id="browser-find-input"
            ref={findRef}
            value={findQuery}
            placeholder="Find in page"
            onChange={(event) => {
              const value = event.target.value;
              setFindQuery(value);
              if (activeTab?.url) void findInPage(activeTab.id, value);
            }}
          />
          <span>
            {browser.findMatch && findQuery
              ? `${browser.findMatch.activeMatchOrdinal} of ${browser.findMatch.matches}`
              : "Find"}
          </span>
          <button
            type="button"
            aria-label="Previous match"
            onClick={() =>
              activeTab?.url &&
              void findInPage(activeTab.id, findQuery, {
                findNext: true,
                forward: false,
              })
            }
          >
            <Icon name="back" />
          </button>
          <button type="submit" aria-label="Next match">
            <Icon name="forward" />
          </button>
          <button
            type="button"
            aria-label="Close find"
            onClick={() => {
              setFindOpen(false);
              setFindQuery("");
              if (activeTab) void stopFindInPage(activeTab.id);
            }}
          >
            <Icon name="close" />
          </button>
        </form>
      )}
      {browser.error && (
        <p className="browser-inline-error" role="status">
          {browser.error}
        </p>
      )}
      <div
        id="browser-viewport"
        ref={viewportRef}
        className="browser-viewport"
        role="tabpanel"
        aria-label={activeTab.title}
      >
        {activeAppPage && appPage}
        {activeFilePage && activeTab.file && (
          <FileTabView
            tabId={activeFilePage.tabId}
            file={activeTab.file}
            browser={browser}
            onAskFile={onAskFile}
          />
        )}
        {!activeTab.url && (
          <NewTabPage
            tabId={activeTab.id}
            history={state.history}
            bookmarks={state.bookmarks}
            downloads={state.downloads}
            tabs={state.tabs}
            originFavicons={state.originFavicons}
            background={state.settings.newTabBackground}
            backgroundCustomDataUrl={state.settings.newTabBackgroundCustomDataUrl}
            agentName={agentName}
			greetingName={greetingName}
			greetingActivity={state.settings.newTabGreetingActivity}
            sessions={sessions}
            widgetSettings={state.settings.newTabWidgets}
            onUpdateWidgetSettings={(newTabWidgets) =>
              void updateSettings({ newTabWidgets })
            }
			onRecordGreetingVisit={(now) =>
				void updateSettings({
					...state.settings,
					newTabGreetingActivity: recordNewTabGreetingVisit(
						state.settings.newTabGreetingActivity,
						now,
					),
				})
			}
            onNavigate={(input) => void navigate(activeTab.id, input)}
			onOpenTab={(tabId) => void selectTab(tabId)}
            onNewAgent={onNewAgent}
			onOpenTaskSettings={onOpenTaskSettings}
            onOpenHistory={onOpenHistory}
            onOpenDownloads={onOpenDownloads}
            onOpenBookmarks={onOpenBookmarks}
            onOpenSession={onOpenSession}
          />
        )}
        {activeTab.error && (
          <section className="browser-error-state">
            <span>
              <Icon name="warning" />
            </span>
            <h1>This page could not be opened.</h1>
            <p>{activeTab.error}</p>
            <div>
              <button
                type="button"
                className="button primary"
                onClick={() => void reload(activeTab.id)}
              >
                Try again
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() => void createTab()}
              >
                New Tab
              </button>
            </div>
          </section>
        )}
      </div>
      {fileDragActive && (
        <div className="browser-file-drop-veil" aria-hidden="true">
          <span className="browser-file-drop-mark">
            <span className="browser-file-drop-triangle browser-file-drop-triangle-back" />
            <span className="browser-file-drop-triangle browser-file-drop-triangle-mid" />
            <span className="browser-file-drop-triangle browser-file-drop-triangle-front" />
          </span>
          <strong>Release to open in Kestrel</strong>
          <small>Files become tabs and task context</small>
        </div>
      )}
      {activeTab.loading && (
        <span className="browser-loading-line" aria-label="Page loading" />
      )}
    </main>
  );
}

function fileSizeLabel(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1_000 && unit < units.length - 1) {
    value /= 1_000;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function FileTabView({
  tabId,
  file,
  browser,
  onAskFile,
}: {
  tabId: string;
  file: UserBrowserFile;
  browser: UserBrowserController;
  onAskFile(file: UserBrowserFile): void;
}) {
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const { filePreview, openFileDefault } = browser;
  const askable = file.status === "available" && file.size <= 10 * 1024 * 1024;

  useEffect(() => {
    let active = true;
    setPreview(null);
    setError("");
    void filePreview(tabId)
      .then((next) => {
        if (active) setPreview(next ?? null);
      })
      .catch((cause) => {
        if (active)
          setError(cause instanceof Error ? cause.message : "Preview unavailable.");
      });
    return () => {
      active = false;
    };
  }, [file.path, file.modifiedAt, filePreview, tabId]);

  async function openDefaultApp() {
    setNotice("");
    try {
      await openFileDefault(tabId);
      setNotice("Opened in the default app.");
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Could not open the default app.");
    }
  }

  return (
    <section className="file-tab-view" aria-label={`File ${file.name}`}>
      <header className="file-tab-header">
        <div className="file-tab-heading">
          <span className="file-tab-mark" aria-hidden="true">
            <Icon name="artifacts" />
          </span>
          <div>
            <h1>{file.name}</h1>
            <p>
              {file.extension ? `${file.extension.toUpperCase()} · ` : ""}
              {fileSizeLabel(file.size)} · {file.mediaType}
            </p>
          </div>
        </div>
        <div className="file-tab-actions">
          <button
            type="button"
            className="button primary"
            disabled={!askable}
            title={
              askable
                ? "Attach this file to the Kestrel composer"
                : "Files over 10 MB cannot be attached through this composer yet"
            }
            onClick={() => onAskFile(file)}
          >
            Ask Kestrel
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={file.status !== "available"}
            onClick={() => void openDefaultApp()}
          >
            Open with Default App
          </button>
        </div>
      </header>
      {file.status === "missing" && (
        <p className="file-tab-notice" role="status">
          This file is no longer at its original location. The tab is retained so
          you can recover the context when it becomes available again.
        </p>
      )}
      {notice && (
        <p className="file-tab-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="file-tab-notice" role="alert">
          {error}
        </p>
      )}
      {!preview && !error && file.status === "available" && (
        <p className="file-tab-loading" role="status">
          Preparing a bounded preview…
        </p>
      )}
      {preview && <FilePreviewBody preview={preview} fileName={file.name} />}
      <dl className="file-tab-metadata">
        <div>
          <dt>Location</dt>
          <dd>{file.path}</dd>
        </div>
        <div>
          <dt>Modified</dt>
          <dd>{file.modifiedAt ? new Date(file.modifiedAt).toLocaleString() : "Unknown"}</dd>
        </div>
      </dl>
    </section>
  );
}

function FilePreviewBody({
  preview,
  fileName,
}: {
  preview: FilePreview;
  fileName: string;
}) {
  if (preview.kind === "text")
    return (
      <div className="file-tab-preview file-tab-text-preview">
        <pre>{preview.text || "(empty file)"}</pre>
      </div>
    );
  if (preview.kind === "image" && preview.dataUrl)
    return (
      <div className="file-tab-preview file-tab-image-preview">
        <img src={preview.dataUrl} alt={fileName} />
      </div>
    );
  if (preview.kind === "pdf" && preview.dataUrl)
    return (
      <div className="file-tab-preview file-tab-pdf-preview">
        <iframe title={`Preview of ${fileName}`} src={preview.dataUrl} />
      </div>
    );
  if (preview.kind === "audio" && preview.dataUrl)
    return (
      <div className="file-tab-preview file-tab-media-preview">
        <audio controls preload="metadata" src={preview.dataUrl} />
      </div>
    );
  if (preview.kind === "video" && preview.dataUrl)
    return (
      <div className="file-tab-preview file-tab-media-preview">
        <video controls preload="metadata" src={preview.dataUrl} />
      </div>
    );
  return (
    <div className="file-tab-preview file-tab-metadata-preview">
      <span className="file-tab-fallback-mark" aria-hidden="true">
        <Icon name="artifacts" />
      </span>
      <strong>Kestrel can keep this file as an object.</strong>
      <p>{preview.detail || "This format is available to compatible agent routes and the default app."}</p>
    </div>
  );
}
