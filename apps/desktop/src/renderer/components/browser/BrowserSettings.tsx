import type { UserBrowserController } from "../../browser/useUserBrowser";

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
  if (!settings) return <p>Browser settings are loading.</p>;
  return (
    <section className="settings-stack browser-settings-panel">
      <header className="settings-panel-header">
        <h2>Browser</h2>
        <p>Search, session restore, and local history.</p>
      </header>
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
          <option value="duckduckgo">DuckDuckGo</option>
          <option value="google">Google</option>
          <option value="brave">Brave Search</option>
          <option value="bing">Bing</option>
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
      <p className="browser-security-note">User tabs use a persistent browser profile. Autonomous agent browsing remains isolated and does not share these cookies or site storage.</p>
    </section>
  );
}
