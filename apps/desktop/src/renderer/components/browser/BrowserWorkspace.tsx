import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import type { UserBrowserController } from "../../browser/useUserBrowser";
import { parseKestrelAppPage } from "../../../utility/browser-app-pages";
import { BrandMark } from "../BrandMark";
import { Icon } from "../Icon";
import { BrowserToolbar } from "./BrowserToolbar";
import { NewTabPage } from "./NewTabPage";
import { TabStrip } from "./TabStrip";

export function BrowserWorkspace({
  browser,
  agentName,
  agentOpen,
  contextEnabled,
  onToggleContext,
  onToggleAgent,
  onNewAgent,
  onOpenSettings,
  onOpenHistory,
  onOpenDownloads,
  onOpenMenu,
  onShowShortcuts,
  onToggleSidebar,
  appPage,
}: {
  browser: UserBrowserController;
  agentName: string;
  agentOpen: boolean;
  contextEnabled: boolean;
  onToggleContext(): void;
  onToggleAgent(): void;
  onNewAgent(prompt?: string): void;
  onOpenSettings(): void;
  onOpenHistory(): void;
  onOpenDownloads(): void;
  onOpenMenu(): void;
  onShowShortcuts?(): void;
  onToggleSidebar?(): void;
  appPage?: ReactNode;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const addressRef = useRef<HTMLInputElement | null>(null);
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
    stop,
    zoomIn,
    zoomOut,
    zoomReset,
  } = browser;
  const activeTab = state?.tabs.find((tab) => tab.id === state.activeTabId);
  const activeAppPage = activeTab ? parseKestrelAppPage(activeTab.url) : undefined;
  const nativePageVisible = Boolean(
    activeTab?.url && !activeTab.error && !activeAppPage,
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
        else if (command === "open-settings") onOpenSettings?.();
        else if (command === "show-shortcuts") onShowShortcuts?.();
        else if (command === "toggle-sidebar") onToggleSidebar?.();
        else if (command === "reopen-closed-tab") void reopenClosedTab();
      }),
    [
      onNewAgent,
      onOpenMenu,
      onOpenHistory,
      onOpenDownloads,
      onOpenSettings,
      onShowShortcuts,
      onToggleSidebar,
      reopenClosedTab,
    ],
  );

  useEffect(() => {
    function shortcuts(event: KeyboardEvent) {
      if (event.defaultPrevented) return;

      if (event.key === "Escape") {
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
      } else if (key === "k" || (key === "p" && event.shiftKey)) {
        event.preventDefault();
        onOpenMenu();
      } else if (key === ",") {
        event.preventDefault();
        onOpenSettings?.();
      } else if (key === "/" || key === "?") {
        event.preventDefault();
        onShowShortcuts?.();
      } else if (key === "b" || (key === "s" && event.shiftKey)) {
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
    closeTab,
    createTab,
    forward,
    onNewAgent,
    onOpenDownloads,
    onOpenHistory,
    onOpenMenu,
    onOpenSettings,
    onShowShortcuts,
    onToggleSidebar,
    reload,
    reopenClosedTab,
    selectTab,
    state,
    stop,
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
      className={`browser-workspace browser-workspace-${state.settings.tabLayout}`}
      aria-label="Browser"
    >
      <TabStrip
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        orientation={state.settings.tabLayout}
        onSelect={(tabId) => void selectTab(tabId)}
        onClose={(tabId) => void closeTab(tabId)}
        onCreate={() => void createTab()}
        onToggleOrientation={() => {
          void browser.updateSettings({
            ...state.settings,
            tabLayout:
              state.settings.tabLayout === "vertical"
                ? "horizontal"
                : "vertical",
          });
        }}
      />
      <BrowserToolbar
        tab={activeTab}
        agentName={agentName}
        agentOpen={agentOpen}
        addressRef={addressRef as RefObject<HTMLInputElement | null>}
        contextEnabled={contextEnabled}
        onToggleContext={onToggleContext}
        onToggleAgent={onToggleAgent}
        onNavigate={(input) => void navigate(activeTab.id, input)}
        onBack={() => void back(activeTab.id)}
        onForward={() => void forward(activeTab.id)}
        onReload={() => void reload(activeTab.id)}
        onStop={() => void stop(activeTab.id)}
        onOpenHistory={onOpenHistory}
        onOpenDownloads={onOpenDownloads}
        onOpenMenu={onOpenMenu}
      />
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
        {!activeTab.url && (
          <NewTabPage
            history={state.history}
            background={state.settings.newTabBackground}
            agentName={agentName}
            onNavigate={(input) => void navigate(activeTab.id, input)}
            onNewAgent={onNewAgent}
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
    </main>
  );
}
