import {
	useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
	parseChromeWebStoreListingUrl,
	type FilePreview,
	type MemoryRecord,
	type MemoryRecallStatus,
	type RuntimeSession,
	type UserBrowserFile,
	type UserBrowserTabOrganizationPreview,
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
import { BookmarkDialog, type BookmarkDialogSaveInput } from "./BookmarkDialog";
import { ChromeWebStoreInstallBar } from "./ChromeWebStoreInstallBar";
import { NewTabPage } from "./NewTabPage";
import { OrganizeTabsDialog } from "./OrganizeTabsDialog";
import { TabStrip } from "./TabStrip";
import { recordNewTabGreetingVisit } from "./new-tab";
import { KESTREL_STATE_TRANSITION } from "../../motion-contract";

export function BrowserWorkspace({
  browser,
  agentName,
	greetingName,
  navigationSidebar,
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
	organizeTabsRequestId = 0,
	memories = [],
	memoryRecall,
	onOpenLifeMemory,
}: {
  browser: UserBrowserController;
  agentName: string;
	greetingName?: string | undefined;
  navigationSidebar?: ReactNode;
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
	organizeTabsRequestId?: number;
	memories?: MemoryRecord[];
	memoryRecall: MemoryRecallStatus;
	onOpenLifeMemory?(): void;
}) {
  const reducedMotion = useReducedMotion() ?? false;
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const addressRef = useRef<HTMLInputElement | null>(null);
  const findRef = useRef<HTMLInputElement | null>(null);
  const findTabIdRef = useRef<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [openChromeMenus, setOpenChromeMenus] = useState({
    tab: false,
    toolbar: false,
  });
  const [organizeTabsPreview, setOrganizeTabsPreview] =
    useState<UserBrowserTabOrganizationPreview | null>(null);
  const [organizeTabsOpening, setOrganizeTabsOpening] = useState(false);
  const [organizeTabsPresent, setOrganizeTabsPresent] = useState(false);
  const [historyPopoverRequestId, setHistoryPopoverRequestId] = useState(0);
  const [nativePagePreview, setNativePagePreview] = useState<{
    tabId: string;
    dataUrl: string;
  } | null>(null);
  const [bookmarkDialog, setBookmarkDialog] = useState<{
    tabId: string;
    bookmarkId?: string;
  } | null>(null);
  const [bookmarkDialogPresent, setBookmarkDialogPresent] = useState(false);
  const organizeTabsRequestRef = useRef(0);
  const pagePreviewRequestRef = useRef(0);
  const lastBoundsRef = useRef("");
  const syncBoundsRef = useRef<() => void>(() => undefined);
  const scheduleBoundsSyncRef = useRef<() => void>(() => undefined);
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
    saveBookmark,
    updateBookmark,
    removeBookmark,
    createBookmarkFolder,
    pinTab,
    muteTab,
    duplicateTab,
    closeOtherTabs,
    findInPage,
    stopFindInPage,
    printTab,
    openDevTools,
    saveScreenshot,
    moveTab,
    applyTabOrganization,
    detachTab,
    reattachTab,
    isDetachedWindow,
    previewOrganizeTabs,
  } = browser;

  const openOrganizeTabs = useCallback(async () => {
    if (organizeTabsOpening || organizeTabsPreview) return;
    setOrganizeTabsOpening(true);
    try {
      const preview = await previewOrganizeTabs();
      setOrganizeTabsPresent(true);
      setOrganizeTabsPreview(preview);
    } catch {
      // The browser controller reports request failures in its own error area;
      // avoid leaving a partially opened dialog behind.
    } finally {
      setOrganizeTabsOpening(false);
    }
  }, [organizeTabsOpening, organizeTabsPreview, previewOrganizeTabs]);

  const openHistoryPopover = useCallback(() => {
    setHistoryPopoverRequestId((current) => current + 1);
  }, []);

  useEffect(() => {
    if (
      organizeTabsRequestId <= 0 ||
      organizeTabsRequestRef.current === organizeTabsRequestId
    )
      return;
    organizeTabsRequestRef.current = organizeTabsRequestId;
    void openOrganizeTabs();
  }, [openOrganizeTabs, organizeTabsRequestId]);

  const activeTab = state?.tabs.find((tab) => tab.id === state.activeTabId);
  const activeAppPage = activeTab ? parseKestrelAppPage(activeTab.url) : undefined;
  const activeFilePage = activeTab ? parseKestrelFilePage(activeTab.url) : undefined;
  const openBookmarkDialog = useCallback(() => {
    if (!activeTab?.url || activeAppPage || activeFilePage) {
      return;
    }
    setBookmarkDialogPresent(true);
    setBookmarkDialog({ tabId: activeTab.id });
  }, [
    activeAppPage,
    activeFilePage,
    activeTab?.error,
    activeTab?.id,
    activeTab?.url,
  ]);
  const closeBookmarkDialog = useCallback(() => {
    setBookmarkDialog(null);
  }, []);
  const toggleBookmarkFromChrome = useCallback(() => {
    const existing = activeTab?.url
      ? state?.bookmarks.find((bookmark) => bookmark.url === activeTab.url)
      : undefined;
    if (existing) {
      void removeBookmark(existing.id);
      return;
    }
    openBookmarkDialog();
  }, [activeTab?.url, openBookmarkDialog, removeBookmark, state?.bookmarks]);
  const editBookmark = useCallback(
    (bookmarkId: string) => {
      if (
        !activeTab ||
        !state?.bookmarks.some((bookmark) => bookmark.id === bookmarkId)
      )
        return;
      setBookmarkDialogPresent(true);
      setBookmarkDialog({ tabId: activeTab.id, bookmarkId });
    },
    [activeTab, state?.bookmarks],
  );
  const saveBookmarkDialog = useCallback(
    async (input: BookmarkDialogSaveInput) => {
      if (!bookmarkDialog) return;
      if (state?.activeTabId !== bookmarkDialog.tabId) {
        throw new Error("The active page changed. Close this dialog and try again.");
      }
      if (bookmarkDialog.bookmarkId) {
        await updateBookmark({
          bookmarkId: bookmarkDialog.bookmarkId,
          title: input.title,
          displayMode: input.displayMode,
          folderId: input.folderId,
        });
      } else {
        await saveBookmark({
          title: input.title,
          displayMode: input.displayMode,
          folderId: input.folderId,
        });
      }
      setBookmarkDialog(null);
    }, [bookmarkDialog, saveBookmark, state?.activeTabId, updateBookmark],
  );
  const bookmarkDialogBookmark = bookmarkDialog?.bookmarkId
    ? state?.bookmarks.find((bookmark) => bookmark.id === bookmarkDialog.bookmarkId)
    : undefined;
  const bookmarkDialogSourceTab = bookmarkDialog
    ? state?.tabs.find((tab) => tab.id === bookmarkDialog.tabId)
    : undefined;
  const bookmarkDialogTab =
    bookmarkDialogBookmark && bookmarkDialogSourceTab
      ? {
          ...bookmarkDialogSourceTab,
          url: bookmarkDialogBookmark.url,
          title: bookmarkDialogBookmark.title,
          faviconDataUrl: bookmarkDialogBookmark.faviconDataUrl,
        }
      : bookmarkDialogSourceTab;
  useEffect(() => {
    if (!bookmarkDialog) return;
    const tabStillExists = state?.tabs.some((tab) => tab.id === bookmarkDialog.tabId);
    const bookmarkStillExists = bookmarkDialog.bookmarkId
      ? state?.bookmarks.some((bookmark) => bookmark.id === bookmarkDialog.bookmarkId)
      : true;
    if (tabStillExists === false || bookmarkStillExists === false)
      setBookmarkDialog(null);
  }, [bookmarkDialog, state?.bookmarks, state?.tabs]);
  const nativePageEligible = Boolean(
    activeTab?.url && !activeTab.error && !activeAppPage && !activeFilePage,
  );
  const nativePageVisible =
    nativePageEligible &&
    !openChromeMenus.tab &&
    !openChromeMenus.toolbar &&
    !organizeTabsOpening &&
    !organizeTabsPreview &&
    !organizeTabsPresent &&
    !bookmarkDialogPresent;
  const showChromeWebStoreInstall = Boolean(
    nativePageEligible &&
      activeTab?.url &&
      parseChromeWebStoreListingUrl(activeTab.url),
  );

  const openFind = useCallback(() => {
    findTabIdRef.current = activeTab?.id ?? null;
    setFindOpen(true);
    window.requestAnimationFrame(() => {
      findRef.current?.focus();
      findRef.current?.select();
    });
  }, [activeTab?.id]);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery("");
    const searchedTabId = findTabIdRef.current ?? activeTab?.id;
    findTabIdRef.current = null;
    if (searchedTabId) void stopFindInPage(searchedTabId);
    // The native page cannot reliably receive renderer focus, so return to the
    // nearest stable browser control instead of leaving focus in an exiting row.
    window.requestAnimationFrame(() => addressRef.current?.focus());
  }, [activeTab, stopFindInPage]);

  useEffect(() => {
    const searchedTabId = findTabIdRef.current;
    if (!findOpen || !searchedTabId || searchedTabId === activeTab?.id) return;
    setFindOpen(false);
    setFindQuery("");
    findTabIdRef.current = null;
    void stopFindInPage(searchedTabId);
  }, [activeTab?.id, findOpen, stopFindInPage]);

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
    const targetTabId = activeTab?.id ?? null;
    const key = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}:${nativePageVisible}:${targetTabId ?? ""}`;
    if (lastBoundsRef.current === key) return;
    lastBoundsRef.current = key;
    const requestId = ++pagePreviewRequestRef.current;
    void setContentBounds(bounds, nativePageVisible)
      .then((browserPagePreview) => {
        if (requestId !== pagePreviewRequestRef.current) return;
        if (nativePageVisible) {
          setNativePagePreview(null);
          return;
        }
        if (browserPagePreview && targetTabId) {
          setNativePagePreview({
            tabId: targetTabId,
            dataUrl: browserPagePreview,
          });
        }
      })
      .catch(() => undefined);
  }, [activeTab?.id, nativePageVisible, setContentBounds]);

  const scheduleBoundsSync = useCallback(() => {
    syncBoundsRef.current();
    window.requestAnimationFrame(() => {
      syncBoundsRef.current();
      for (const delay of [100, 320, 400]) {
        window.setTimeout(() => syncBoundsRef.current(), delay);
      }
    });
  }, []);

  syncBoundsRef.current = syncBounds;
  scheduleBoundsSyncRef.current = scheduleBoundsSync;

  useLayoutEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const syncFromRef = () => syncBoundsRef.current();
    const scheduleFromRef = () => scheduleBoundsSyncRef.current();
    const observer = new ResizeObserver(syncFromRef);
    observer.observe(node);
    const root = document.getElementById("root");
    const mutationObserver = new MutationObserver(syncFromRef);
    if (root) mutationObserver.observe(root, { childList: true });
    const appShell = node.closest(".ai-browser-app");
    const shellObserver = new MutationObserver(scheduleFromRef);
    if (appShell) {
      shellObserver.observe(appShell, {
        attributes: true,
        attributeFilter: ["class"],
        childList: true,
        subtree: true,
      });
    }
    const onTransitionEnd = (event: TransitionEvent) => {
      if (
        event.target === node &&
        (event.propertyName === "width" || event.propertyName === "margin-left")
      ) {
        scheduleFromRef();
      }
    };
    node.addEventListener("transitionend", onTransitionEnd);
    window.addEventListener("resize", syncFromRef);
    const frame = window.requestAnimationFrame(syncFromRef);
    const settleTimer = window.setTimeout(syncFromRef, 320);
    syncFromRef();
    return () => {
      observer.disconnect();
      mutationObserver.disconnect();
      shellObserver.disconnect();
      node.removeEventListener("transitionend", onTransitionEnd);
      window.removeEventListener("resize", syncFromRef);
      window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
    };
  }, []);

  useEffect(
    () => () => {
      pagePreviewRequestRef.current += 1;
      lastBoundsRef.current = "";
      void setContentBounds({ x: 0, y: 0, width: 0, height: 0 }, false).catch(
        () => undefined,
      );
    },
    [setContentBounds],
  );

  useEffect(() => {
    scheduleBoundsSync();
  }, [nativePageVisible, scheduleBoundsSync]);

  useLayoutEffect(() => {
    syncBounds();
  }, [openChromeMenus, organizeTabsPreview, syncBounds]);

  useEffect(
    () =>
      window.kestrel.onBrowserCommand((command) => {
        if (command === "focus-address") addressRef.current?.focus();
        else if (command === "new-agent") onNewAgent();
        else if (command === "open-commands") onOpenMenu();
        else if (command === "open-history") openHistoryPopover();
        else if (command === "open-downloads") setDownloadsOpen(true);
        else if (command === "open-bookmarks") onOpenBookmarks();
        else if (command === "bookmark-page") openBookmarkDialog();
        else if (command === "open-settings") onOpenSettings?.();
        else if (command === "show-shortcuts") onShowShortcuts?.();
        else if (command === "toggle-sidebar") onToggleSidebar?.();
        else if (command === "reopen-closed-tab") void reopenClosedTab();
        else if (command === "find-in-page") openFind();
        else if (command === "print-page" && activeTab?.url)
          void printTab(activeTab.id);
        else if (command === "save-screenshot" && activeTab?.url)
          void saveScreenshot(activeTab.id).catch(() => undefined);
      }),
    [
      activeTab,
      onNewAgent,
      onOpenMenu,
      openHistoryPopover,
      setDownloadsOpen,
      onOpenBookmarks,
      openBookmarkDialog,
      onOpenSettings,
      onShowShortcuts,
      onToggleSidebar,
      openFind,
      printTab,
      saveScreenshot,
      reopenClosedTab,
    ],
  );

  useEffect(() => {
    function shortcuts(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (bookmarkDialogPresent) return;

      if (event.key === "Escape") {
		const foregroundOverlay = document.querySelector(
			'[aria-modal="true"], .model-selector-menu, [role="menu"], .browser-address-suggestions',
		);
		if (foregroundOverlay) return;
        if (findOpen) {
          event.preventDefault();
          closeFind();
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
        void closeTab(activeTab.id).catch(() => undefined);
      } else if (key === "r" && activeTab) {
        event.preventDefault();
        void reload(activeTab.id, event.shiftKey);
      } else if (key === "h" || key === "y") {
        event.preventDefault();
        openHistoryPopover();
      } else if (key === "j") {
        event.preventDefault();
        setDownloadsOpen(true);
      } else if (key === "f") {
        const target = event.target as HTMLElement | null;
        if (target?.closest("#runtime-prompt, textarea, input")) return;
        event.preventDefault();
        openFind();
      } else if (key === "d") {
        event.preventDefault();
        if (event.shiftKey) onOpenBookmarks();
        else toggleBookmarkFromChrome();
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
    closeFind,
    createTab,
    forward,
    onNewAgent,
    onOpenBookmarks,
    openHistoryPopover,
    openFind,
    setDownloadsOpen,
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
    bookmarkDialogPresent,
    toggleBookmarkFromChrome,
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

  const showBookmarksBar = state.settings.showBookmarksBar && !activeTab.url;
  const closeOrganizeTabs = useCallback(() => {
    setOrganizeTabsPreview(null);
  }, []);
  const applyOrganizeTabs = useCallback(
    async (
      organization: UserBrowserTabOrganizationPreview,
      closeTabIds: readonly string[],
    ) => {
      await applyTabOrganization({
        tabOrder: organization.tabs.map((tab) => tab.id),
        assignments: organization.tabs.map(({ id, tabFolderId }) => ({
          tabId: id,
          ...(tabFolderId ? { tabFolderId } : {}),
        })),
        tabFolders: organization.tabFolders,
        ...(closeTabIds.length > 0 ? { closeTabIds: [...closeTabIds] } : {}),
      });
      setOrganizeTabsPreview(null);
    },
    [applyTabOrganization],
  );

  return (
    <main
      className={`browser-workspace browser-workspace-${state.settings.tabLayout}${
        showBookmarksBar ? " browser-workspace-bookmarks" : ""
      }${showChromeWebStoreInstall ? " browser-workspace-store-install" : ""}`}
      aria-label="Browser"
    >
      {navigationSidebar}
      <TabStrip
        tabs={state.tabs}
        originFavicons={state.originFavicons}
        tabFolders={state.tabFolders}
        activeTabId={state.activeTabId}
        orientation={state.settings.tabLayout}
        onSelect={(tabId) => void selectTab(tabId)}
        onClose={(tabId) => closeTab(tabId)}
        onCreate={() => void createTab()}
        onPin={(tabId, pinned) => void pinTab(tabId, pinned)}
        onMute={(tabId, muted) => void muteTab(tabId, muted)}
        onDuplicate={(tabId) => void duplicateTab(tabId)}
        onCloseOthers={(tabId) => closeOtherTabs(tabId)}
        onMoveTab={(tabId, toIndex) => moveTab(tabId, toIndex)}
        {...(!isDetachedWindow
          ? { onDetachTab: (tabId: string) => detachTab(tabId) }
          : {})}
        {...(isDetachedWindow
          ? { onReattachTab: (tabId: string) => reattachTab(tabId) }
          : {})}
        onReopenClosedTab={(index) => void reopenClosedTab(index)}
        recentlyClosedTabs={state.recentlyClosedTabs}
        onOrganizeTabs={openOrganizeTabs}
        onOpenWorkspaces={onOpenWorkspaces}
        onMenuOpenChange={handleTabMenuOpenChange}
        tabSizing={state.settings.tabSizing}
        onTabSizingChange={(tabSizing) => {
          void browser.updateSettings({ tabSizing });
        }}
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
        history={state.history}
        bookmarks={state.bookmarks}
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        originFavicons={state.originFavicons}
        searchEngine={state.settings.searchEngine}
        {...(state.settings.customSearchName !== undefined
          ? { customSearchName: state.settings.customSearchName }
          : {})}
        addressBarSuggestionsEnabled={state.settings.addressBarSuggestionsEnabled}
        agentName={agentName}
        agentOpen={agentOpen}
        addressRef={addressRef as RefObject<HTMLInputElement | null>}
        showBookmarksBar={state.settings.showBookmarksBar}
        sleepingTabsEnabled={state.settings.sleepingTabsEnabled}
        downloads={[...state.downloads].reverse()}
        downloadsOpen={downloadsOpen}
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
        onNewTab={() => void createTab()}
        onOrganizeTabs={() => void openOrganizeTabs()}
        onZoomIn={() => void zoomIn(activeTab.id)}
        onZoomOut={() => void zoomOut(activeTab.id)}
        onZoomReset={() => void zoomReset(activeTab.id)}
        bookmarked={state.bookmarks.some((item) => item.url === activeTab.url)}
        onToggleAgent={onToggleAgent}
        onNavigate={(input) => void navigate(activeTab.id, input)}
        onSelectTab={(tabId) => void selectTab(tabId)}
        onBack={() => void back(activeTab.id)}
        onForward={() => void forward(activeTab.id)}
        onReload={() => void reload(activeTab.id)}
        onStop={() => void stop(activeTab.id)}
        onOpenHistoryFull={onOpenHistory}
        onClearHistory={() => void browser.clearHistory()}
        historyPopoverRequestId={historyPopoverRequestId}
        onDownloadsOpenChange={setDownloadsOpen}
        onStartDownloadDrag={(downloadId) => {
          void browser.startDownloadDrag(downloadId).catch(() => undefined);
        }}
        onOpenDownload={(downloadId) => {
          setDownloadsOpen(false);
          void browser.openDownload(downloadId).catch(() => undefined);
        }}
        onRevealDownload={(downloadId) => {
          setDownloadsOpen(false);
          void browser.revealDownload(downloadId).catch(() => undefined);
        }}
        onCancelDownload={(downloadId) => {
          void browser.cancelDownload(downloadId).catch(() => undefined);
        }}
        onOpenBookmarks={onOpenBookmarks}
        onOpenFind={() => {
          openFind();
        }}
        onPrint={() => void printTab(activeTab.id)}
        onOpenDevTools={() => void openDevTools(activeTab.id)}
        onSaveScreenshot={() => browser.saveScreenshot(activeTab.id)}
        onMenuOpenChange={handleToolbarMenuOpenChange}
        onToggleBookmark={toggleBookmarkFromChrome}
        onOpenSettings={onOpenSettings}
        onOpenExtensionStore={() =>
          void browser.createTab("https://chromewebstore.google.com")
        }
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
      {showBookmarksBar && (
        <BookmarksBar
          bookmarks={state.bookmarks}
          bookmarkFolders={state.bookmarkFolders}
          originFavicons={state.originFavicons}
          onOpen={(url) => void navigate(activeTab.id, url)}
          onOpenInNewTab={(url) => void createTab(url)}
          onRemove={(bookmarkId) => void removeBookmark(bookmarkId)}
          onEdit={editBookmark}
          onManage={onOpenBookmarks}
        />
      )}
      {showChromeWebStoreInstall && (
        <ChromeWebStoreInstallBar url={activeTab.url} />
      )}
      <AnimatePresence initial={false}>
      {findOpen && (
        <motion.form
          key="browser-find-bar"
          className="browser-find-bar"
          initial={
            reducedMotion
              ? false
              : { height: 0, opacity: 0, y: -4, pointerEvents: "none" }
          }
          animate={{ height: 40, opacity: 1, y: 0, pointerEvents: "auto" }}
          exit={
            reducedMotion
              ? { height: 0, opacity: 1, y: 0, pointerEvents: "none" }
              : { height: 0, opacity: 0, y: -4, pointerEvents: "none" }
          }
          transition={reducedMotion ? { duration: 0 } : KESTREL_STATE_TRANSITION}
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
            onClick={closeFind}
          >
            <Icon name="close" />
          </button>
        </motion.form>
      )}
      </AnimatePresence>
			<AnimatePresence initial={false}>
				{browser.error && (
          <motion.p
            key="browser-inline-error"
            className="browser-inline-error"
            role="status"
            initial={reducedMotion ? false : { opacity: 0, x: "-50%", y: -4 }}
            animate={{ opacity: 1, x: "-50%", y: 0 }}
            exit={
              reducedMotion
                ? { opacity: 1, x: "-50%", y: 0, pointerEvents: "none" }
                : { opacity: 0, x: "-50%", y: -4, pointerEvents: "none" }
            }
            transition={reducedMotion ? { duration: 0 } : KESTREL_STATE_TRANSITION}
          >
            {browser.error}
          </motion.p>
        )}
      </AnimatePresence>
      <div
        id="browser-viewport"
        ref={viewportRef}
        className="browser-viewport"
        role="tabpanel"
        aria-label={activeTab.title}
      >
		{!nativePageVisible &&
			nativePageEligible &&
			nativePagePreview?.tabId === activeTab.id && (
			<img
				className="browser-native-page-preview"
				src={nativePagePreview.dataUrl}
				alt=""
				aria-hidden="true"
				draggable={false}
			/>
		)}
		<AnimatePresence initial={false} mode="sync">
			{activeAppPage && appPage}
		</AnimatePresence>
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
            memories={memories}
            memoryRecall={memoryRecall}
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
            {...(onOpenLifeMemory ? { onOpenLifeMemory } : {})}
            onOpenHistory={openHistoryPopover}
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
      {activeTab.loading && (
        <span className="browser-loading-line" aria-label="Page loading" />
      )}
      <AnimatePresence
        initial={false}
        onExitComplete={() => setBookmarkDialogPresent(false)}
      >
        {bookmarkDialog && bookmarkDialogTab && (
          <BookmarkDialog
            key={`bookmark-dialog-${bookmarkDialog.tabId}-${bookmarkDialog.bookmarkId ?? "new"}`}
            tab={bookmarkDialogTab}
            {...(bookmarkDialogBookmark
              ? { bookmark: bookmarkDialogBookmark }
              : {})}
            bookmarkFolders={state.bookmarkFolders}
            originFavicons={state.originFavicons}
            onCancel={closeBookmarkDialog}
            onSave={saveBookmarkDialog}
            onCreateFolder={createBookmarkFolder}
          />
        )}
      </AnimatePresence>
      <AnimatePresence
        initial={false}
        onExitComplete={() => setOrganizeTabsPresent(false)}
      >
        {organizeTabsPreview && (
          <OrganizeTabsDialog
            key="organize-tabs-dialog"
            preview={organizeTabsPreview}
            originFavicons={state.originFavicons}
            onCancel={closeOrganizeTabs}
            onApply={applyOrganizeTabs}
          />
        )}
      </AnimatePresence>
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
