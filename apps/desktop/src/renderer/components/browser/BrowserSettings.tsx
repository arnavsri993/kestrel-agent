import { useState } from "react";
import type { UserBrowserController } from "../../browser/useUserBrowser";
import type {
  UserBrowserPermission,
  UserBrowserSettings,
} from "@kestrel/shared-types";

const SEARCH_ENGINE_OPTIONS = [
  { value: "duckduckgo", label: "DuckDuckGo" },
  { value: "google", label: "Google" },
  { value: "bing", label: "Bing" },
  { value: "brave", label: "Brave Search" },
  { value: "ecosia", label: "Ecosia" },
  { value: "startpage", label: "Startpage" },
  { value: "yahoo", label: "Yahoo Search" },
  { value: "kagi", label: "Kagi" },
  { value: "qwant", label: "Qwant" },
  { value: "mojeek", label: "Mojeek" },
  { value: "baidu", label: "Baidu" },
  { value: "yandex", label: "Yandex" },
] as const satisfies ReadonlyArray<{
  value: UserBrowserSettings["searchEngine"];
  label: string;
}>;

export function BrowserSettings({
  browser,
  contextEnabled,
  onToggleContext,
}: {
  browser: UserBrowserController;
  contextEnabled: boolean;
  onToggleContext(): void;
}) {
  const settings = browser.state?.settings;
  const activeTab = browser.state?.tabs.find(
    (tab) => tab.id === browser.state?.activeTabId,
  );
  const activeOrigin = (() => {
    try {
      return activeTab?.url ? new URL(activeTab.url).origin : "";
    } catch {
      return "";
    }
  })();
  const [transferNotice, setTransferNotice] = useState("");
  if (!settings) return <p>Browser settings are loading.</p>;
  const permissions: Array<{
    id: UserBrowserPermission["permission"];
    label: string;
  }> = [
    { id: "camera", label: "Camera" },
    { id: "microphone", label: "Microphone" },
    { id: "geolocation", label: "Location" },
    { id: "notifications", label: "Notifications" },
    { id: "clipboard-read", label: "Clipboard read" },
    { id: "fullscreen", label: "Fullscreen" },
    { id: "display-capture", label: "Screen sharing" },
  ];
  async function exportData() {
    setTransferNotice("");
    try {
      const path = await browser.exportData();
      if (path) setTransferNotice("Browser data exported.");
    } catch (cause) {
      setTransferNotice(cause instanceof Error ? cause.message : "Export failed.");
    }
  }
  async function importData() {
    setTransferNotice("");
    try {
      await browser.importData();
      setTransferNotice("Browser data imported.");
    } catch (cause) {
      setTransferNotice(cause instanceof Error ? cause.message : "Import failed.");
    }
  }
  return (
    <section className="settings-stack browser-settings-panel">
      <header className="settings-panel-header">
        <h2>Tabs, search, and history</h2>
      </header>
      <div className="setting-row browser-setting-row">
        <div className="browser-setting-copy">
          <strong>Tab layout</strong>
          <small>Place tabs above the page or in a scrollable side rail.</small>
        </div>
        <select
          aria-label="Tab layout"
          value={settings.tabLayout}
          onChange={(event) =>
            void browser.updateSettings({
              ...settings,
              tabLayout: event.target.value as typeof settings.tabLayout,
            })
          }
        >
          <option value="horizontal">Horizontal tabs</option>
          <option value="vertical">Vertical tabs</option>
        </select>
      </div>
      <div className="setting-row browser-setting-row">
        <div className="browser-setting-copy">
          <strong>Search engine</strong>
          <small>Used when the address bar contains a search.</small>
        </div>
        <select
          aria-label="Search engine"
          value={settings.searchEngine}
          onChange={(event) => void browser.updateSettings({ ...settings, searchEngine: event.target.value as typeof settings.searchEngine })}
        >
          {SEARCH_ENGINE_OPTIONS.map((engine) => (
            <option key={engine.value} value={engine.value}>
              {engine.label}
            </option>
          ))}
        </select>
      </div>
      <label className="setting-row browser-setting-row">
        <span className="browser-setting-copy">
          <strong>Use current page</strong>
          <small>
            Share bounded visible-page context with the active conversation.
            Page content stays untrusted and is not saved to Memory.
          </small>
        </span>
        <input
          type="checkbox"
          checked={contextEnabled}
          onChange={onToggleContext}
        />
      </label>
      <label className="setting-row browser-setting-row">
        <span className="browser-setting-copy">
          <strong>Show bookmarks bar</strong>
          <small>Keep saved pages one click away below the toolbar.</small>
        </span>
        <input
          type="checkbox"
          checked={settings.showBookmarksBar}
          onChange={(event) => void browser.updateSettings({ ...settings, showBookmarksBar: event.target.checked })}
        />
      </label>
      <label className="setting-row browser-setting-row">
        <span className="browser-setting-copy">
          <strong>Restore tabs</strong>
          <small>Reopen safe tab URLs after Kestrel restarts.</small>
        </span>
        <input
          type="checkbox"
          checked={settings.restoreSession}
          onChange={(event) => void browser.updateSettings({ ...settings, restoreSession: event.target.checked })}
        />
      </label>
      <div className="setting-row browser-setting-row">
        <div className="browser-setting-copy">
          <strong>Keep history</strong>
          <small>History stays on this Mac and is searched only when needed.</small>
        </div>
        <select
          aria-label="Browser history retention"
          value={settings.historyRetentionDays}
          onChange={(event) => void browser.updateSettings({ ...settings, historyRetentionDays: Number(event.target.value) as typeof settings.historyRetentionDays })}
        >
          <option value={0}>Don’t keep</option>
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
          <option value={365}>1 year</option>
        </select>
      </div>
      <div className="setting-row browser-setting-row">
        <div className="browser-setting-copy">
          <strong>Clear browsing history</strong>
          <small>Open tabs, downloads, cookies, and site data are not removed.</small>
        </div>
        <button type="button" className="button secondary" onClick={() => void browser.clearHistory()} disabled={!browser.state?.history.length}>Clear history</button>
      </div>
      <section className="browser-settings-subsection" aria-labelledby="browser-permissions-title">
        <header>
          <div className="browser-setting-copy">
            <strong id="browser-permissions-title">Site permissions</strong>
            <small>Requests are blocked unless you explicitly allow them for a site.</small>
          </div>
          {browser.state?.permissions.length ? <button type="button" className="quiet-link" onClick={() => void browser.clearPermissions()}>Clear all</button> : null}
        </header>
        {activeOrigin ? (
          <div className="browser-permission-grid">
            <p className="browser-permission-origin">Current site: <strong>{activeOrigin}</strong></p>
            {permissions.map(({ id, label }) => {
              const entry = browser.state?.permissions.find((item) => item.origin === activeOrigin && item.permission === id);
              return (
                <label className="browser-permission-row" key={id}>
                  <span>{label}</span>
                  <select
                    aria-label={`${label} permission for ${activeOrigin}`}
                    value={entry?.decision ?? "block"}
                    onChange={(event) => void browser.setPermission(activeOrigin, id, event.target.value as UserBrowserPermission["decision"])}
                  >
                    <option value="block">Block</option>
                    <option value="allow">Allow</option>
                  </select>
                </label>
              );
            })}
          </div>
        ) : <p className="browser-security-note">Open an HTTP(S) page to manage its site permissions.</p>}
      </section>
      <section className="browser-settings-subsection" aria-labelledby="browser-extensions-title">
        <header>
          <div className="browser-setting-copy">
            <strong id="browser-extensions-title">Browser extensions</strong>
            <small>Install unpacked extensions in the personal profile. Private tabs never load them.</small>
          </div>
          <button type="button" className="button secondary" onClick={() => void browser.installExtension()}>Install extension</button>
        </header>
        {browser.state?.extensions.length ? (
          <ul className="browser-extension-list">
            {browser.state.extensions.map((extension) => (
              <li key={extension.id}>
                <span><strong>{extension.name}</strong><small>v{extension.version}{extension.permissions.length ? ` · ${extension.permissions.length} permissions` : ""}</small></span>
                <label><span className="sr-only">Enable {extension.name}</span><input type="checkbox" checked={extension.enabled} onChange={(event) => void browser.setExtensionEnabled(extension.id, event.target.checked)} /></label>
                <button type="button" className="quiet-link" onClick={() => void browser.removeExtension(extension.id)}>Remove</button>
              </li>
            ))}
          </ul>
        ) : <p className="browser-security-note">No unpacked extensions installed.</p>}
      </section>
      <section className="browser-settings-subsection" aria-labelledby="browser-transfer-title">
        <header>
          <div className="browser-setting-copy">
            <strong id="browser-transfer-title">Move browser data</strong>
            <small>Export or import bookmarks, history, settings, and permission choices as a local JSON file.</small>
          </div>
          <div className="browser-transfer-actions"><button type="button" className="button secondary" onClick={() => void exportData()}>Export</button><button type="button" className="button secondary" onClick={() => void importData()}>Import</button></div>
        </header>
        {transferNotice && <p className="browser-security-note" role="status">{transferNotice}</p>}
      </section>
      <p className="browser-security-note">User tabs use a persistent browser profile. Autonomous agent browsing remains isolated and does not share these cookies or site storage.</p>
    </section>
  );
}
