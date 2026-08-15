import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";
import type { UserBrowserController } from "../../browser/useUserBrowser";
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
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const addressRef = useRef<HTMLInputElement | null>(null);
  const lastBoundsRef = useRef("");
  const state = browser.state;
  const {
    back,
    closeTab,
    createTab,
    forward,
    navigate,
    reload,
    selectTab,
    setContentBounds,
    stop,
  } = browser;
  const activeTab = state?.tabs.find((tab) => tab.id === state.activeTabId);
  const nativePageVisible = Boolean(activeTab?.url && !activeTab.error);

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
    void setContentBounds(bounds, nativePageVisible)
      .catch(() => undefined);
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
      void setContentBounds({ x: 0, y: 0, width: 0, height: 0 }, false)
        .catch(() => undefined);
    };
  }, [setContentBounds, syncBounds]);

  useEffect(
    () =>
      window.kestrel.onBrowserCommand((command) => {
        if (command === "focus-address") addressRef.current?.focus();
        else if (command === "new-agent") onNewAgent();
        else if (command === "open-commands") onOpenMenu();
      }),
    [onNewAgent, onOpenMenu],
  );

  useEffect(() => {
    function shortcuts(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "l") {
        event.preventDefault();
        addressRef.current?.focus();
      } else if (key === "t") {
        event.preventDefault();
        void createTab();
      } else if (key === "w" && activeTab) {
        event.preventDefault();
        void closeTab(activeTab.id);
      } else if (event.key === "Tab" && state?.tabs.length) {
        event.preventDefault();
        const index = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
        const direction = event.shiftKey ? -1 : 1;
        const next = state.tabs[(index + direction + state.tabs.length) % state.tabs.length];
        if (next) void selectTab(next.id);
      }
    }
    document.addEventListener("keydown", shortcuts);
    return () => document.removeEventListener("keydown", shortcuts);
  }, [activeTab, closeTab, createTab, selectTab, state]);

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
        <p className="browser-inline-error" role="status">{browser.error}</p>
      )}
      <div
        id="browser-viewport"
        ref={viewportRef}
        className="browser-viewport"
        role="tabpanel"
        aria-label={activeTab.title}
      >
        {!activeTab.url && (
          <NewTabPage
            history={state.history}
            background={state.settings.newTabBackground}
            agentName={agentName}
            onNavigate={(input) => void navigate(activeTab.id, input)}
            onNewTab={() => void createTab()}
            onNewAgent={onNewAgent}
            onOpenSettings={onOpenSettings}
          />
        )}
        {activeTab.error && (
          <section className="browser-error-state">
            <span><Icon name="warning" /></span>
            <h1>This page could not be opened.</h1>
            <p>{activeTab.error}</p>
            <div>
              <button type="button" className="button primary" onClick={() => void reload(activeTab.id)}>
                Try again
              </button>
              <button type="button" className="button secondary" onClick={() => void createTab()}>
                New Tab
              </button>
            </div>
          </section>
        )}
      </div>
      {activeTab.loading && <span className="browser-loading-line" aria-label="Page loading" />}
    </main>
  );
}
