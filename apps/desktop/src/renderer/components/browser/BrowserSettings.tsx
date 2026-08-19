import type { UserBrowserController } from "../../browser/useUserBrowser";
import type {
  InstalledExtension,
  UserBrowserSettings,
} from "@kestrel/shared-types";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "../Icon";

const SEARCH_ENGINE_OPTIONS = [
  { value: "google", label: "Google (Default)" },
  { value: "duckduckgo", label: "DuckDuckGo" },
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
  { value: "custom", label: "Custom Search Engine…" },
] as const satisfies ReadonlyArray<{
  value: UserBrowserSettings["searchEngine"];
  label: string;
}>;

const SLEEPING_TAB_TIMEOUT_OPTIONS = [
  { value: 5, label: "5 minutes" },
  { value: 15, label: "15 minutes" },
  { value: 30, label: "30 minutes (recommended)" },
  { value: 60, label: "1 hour" },
  { value: 120, label: "2 hours" },
  { value: 240, label: "4 hours" },
  { value: 480, label: "8 hours" },
  { value: 1440, label: "24 hours" },
] as const;

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
  const [isDefaultBrowser, setIsDefaultBrowser] = useState<boolean | null>(null);
  const [canSetAsDefault, setCanSetAsDefault] = useState<boolean | null>(null);
  const [defaultBrowserBusy, setDefaultBrowserBusy] = useState(false);

  // Custom search engine state
  const [customName, setCustomName] = useState(settings?.customSearchName ?? "");
  const [customUrl, setCustomUrl] = useState(settings?.customSearchUrl ?? "");

  // Sleeping tabs excluded domains input
  const [newExcludedDomain, setNewExcludedDomain] = useState("");
  const [sleepingBusy, setSleepingBusy] = useState(false);

  // Extension management state
  const [extensions, setExtensions] = useState<InstalledExtension[]>([]);
  const [extensionUrlInput, setExtensionUrlInput] = useState("");
  const [extensionLoading, setExtensionLoading] = useState(false);
  const [extensionMessage, setExtensionMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const fetchExtensions = useCallback(async () => {
    try {
      const response = await window.kestrel.request({
        type: "browser-list-extensions",
      });
      if (response.ok && "extensions" in response) {
        setExtensions(response.extensions as InstalledExtension[]);
      }
    } catch {
      // Ignore extension list error
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.kestrel
      .request({ type: "get-default-browser-status" })
      .then((response) => {
        if (!cancelled && response.ok && "isDefault" in response) {
          setIsDefaultBrowser(Boolean(response.isDefault));
          if ("canSetAsDefault" in response)
            setCanSetAsDefault(response.canSetAsDefault);
        }
      })
      .catch(() => undefined);

    void fetchExtensions();

    return () => {
      cancelled = true;
    };
  }, [fetchExtensions]);

  useEffect(() => {
    if (settings?.customSearchName !== undefined) {
      setCustomName(settings.customSearchName);
    }
    if (settings?.customSearchUrl !== undefined) {
      setCustomUrl(settings.customSearchUrl);
    }
  }, [settings?.customSearchName, settings?.customSearchUrl]);

  const handleSetDefault = async () => {
    setDefaultBrowserBusy(true);
    try {
      const response = await window.kestrel.request({
        type: "set-default-browser",
      });
      if (response.ok && "isDefault" in response) {
        setIsDefaultBrowser(Boolean(response.isDefault));
        if ("canSetAsDefault" in response)
          setCanSetAsDefault(response.canSetAsDefault);
      }
    } finally {
      setDefaultBrowserBusy(false);
    }
  };

  const handleSaveCustomSearch = async () => {
    if (!settings) return;
    await browser.updateSettings({
      ...settings,
      searchEngine: "custom",
      customSearchName: customName.trim(),
      customSearchUrl: customUrl.trim(),
    });
  };

  const handleAddExcludedDomain = async () => {
    if (!settings || !newExcludedDomain.trim()) return;
    const cleanDomain = newExcludedDomain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!cleanDomain) return;

    const existing = settings.sleepingTabExcludedDomains ?? [];
    if (!existing.includes(cleanDomain)) {
      await browser.updateSettings({
        ...settings,
        sleepingTabExcludedDomains: [...existing, cleanDomain],
      });
    }
    setNewExcludedDomain("");
  };

  const handleRemoveExcludedDomain = async (domain: string) => {
    if (!settings) return;
    const existing = settings.sleepingTabExcludedDomains ?? [];
    await browser.updateSettings({
      ...settings,
      sleepingTabExcludedDomains: existing.filter((d) => d !== domain),
    });
  };

  const handleSleepInactiveNow = async () => {
    setSleepingBusy(true);
    try {
      await browser.sleepInactiveTabs();
    } finally {
      setTimeout(() => setSleepingBusy(false), 600);
    }
  };

  const handleInstallExtensionFromUrl = async () => {
    if (!extensionUrlInput.trim()) return;
    setExtensionLoading(true);
    setExtensionMessage(null);
    try {
      const response = await window.kestrel.request({
        type: "browser-install-extension-url",
        urlOrId: extensionUrlInput.trim(),
      });
      if (response.ok && "extension" in response) {
        setExtensionMessage({
          type: "success",
          text: `Successfully installed ${(response.extension as InstalledExtension).name}!`,
        });
        setExtensionUrlInput("");
        await fetchExtensions();
      } else {
        setExtensionMessage({
          type: "error",
          text: "error" in response ? String(response.error) : "Failed to install extension.",
        });
      }
    } catch (cause) {
      setExtensionMessage({
        type: "error",
        text: cause instanceof Error ? cause.message : "Failed to download extension.",
      });
    } finally {
      setExtensionLoading(false);
    }
  };

  const handleInstallExtensionFile = async () => {
    setExtensionLoading(true);
    setExtensionMessage(null);
    try {
      const response = await window.kestrel.request({
        type: "browser-install-extension-file",
      });
      if (response.ok && "extension" in response) {
        setExtensionMessage({
          type: "success",
          text: `Successfully installed ${(response.extension as InstalledExtension).name}!`,
        });
        await fetchExtensions();
      } else if (!response.ok && "error" in response && response.error !== "Installation canceled") {
        setExtensionMessage({
          type: "error",
          text: String(response.error),
        });
      }
    } catch (cause) {
      setExtensionMessage({
        type: "error",
        text: cause instanceof Error ? cause.message : "Failed to install extension file.",
      });
    } finally {
      setExtensionLoading(false);
    }
  };

  const handleToggleExtension = async (id: string, enabled: boolean) => {
    try {
      const response = await window.kestrel.request({
        type: "browser-toggle-extension",
        extensionId: id,
        enabled,
      });
      if (response.ok) {
        await fetchExtensions();
      }
    } catch (cause) {
      setExtensionMessage({
        type: "error",
        text: cause instanceof Error ? cause.message : "Failed to toggle extension.",
      });
    }
  };

  const handleUninstallExtension = async (id: string) => {
    try {
      const response = await window.kestrel.request({
        type: "browser-uninstall-extension",
        extensionId: id,
      });
      if (response.ok) {
        await fetchExtensions();
      }
    } catch (cause) {
      setExtensionMessage({
        type: "error",
        text: cause instanceof Error ? cause.message : "Failed to uninstall extension.",
      });
    }
  };

  if (!settings) return <p>Browser settings are loading.</p>;

  return (
    <div className="browser-settings-wrapper">
      {/* 🔍 SECTION 1: SEARCH ENGINE */}
      <section className="settings-stack browser-settings-panel" aria-label="Search engine preferences">
        <header className="settings-panel-header">
          <h3>
            <Icon name="search" /> Search Engine
          </h3>
          <p className="settings-panel-subtitle">
            Configure the default search provider for the omnibox, new tab page, and web lookups.
          </p>
        </header>

        <div className="setting-row browser-setting-row">
          <div className="browser-setting-copy">
            <strong>Default search engine</strong>
            <p>Searches entered into the address bar or new tab page will use this provider.</p>
          </div>
          <select
            aria-label="Search engine"
            value={settings.searchEngine}
            onChange={(event) =>
              void browser.updateSettings({
                ...settings,
                searchEngine: event.target.value as typeof settings.searchEngine,
              })
            }
          >
            {SEARCH_ENGINE_OPTIONS.map((engine) => (
              <option key={engine.value} value={engine.value}>
                {engine.label}
              </option>
            ))}
          </select>
        </div>

        {settings.searchEngine === "custom" && (
          <div className="custom-search-config-box">
            <div className="custom-search-fields">
              <label className="custom-search-label">
                <span>Engine Name</span>
                <input
                  type="text"
                  placeholder="e.g. My Intranet Search"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  className="input-text"
                />
              </label>
              <label className="custom-search-label">
                <span>Search URL Template</span>
                <input
                  type="url"
                  placeholder="https://example.com/search?q=%s"
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                  className="input-text"
                />
                <small className="help-text">Use <code>%s</code> as placeholder for search terms (e.g. <code>https://kagi.com/search?q=%s</code>).</small>
              </label>
            </div>
            <button
              type="button"
              className="button secondary"
              onClick={() => void handleSaveCustomSearch()}
              disabled={!customUrl.trim()}
            >
              Save Custom Engine
            </button>
          </div>
        )}
      </section>

      {/* ⚡ SECTION 2: PERFORMANCE & SLEEPING TABS */}
      <section className="settings-stack browser-settings-panel" aria-label="Performance and sleeping tabs">
        <header className="settings-panel-header">
          <h3>
            <Icon name="sparkles" /> Performance & Memory Saver
          </h3>
          <p className="settings-panel-subtitle">
            Manage background tab memory suspension and responsiveness optimizations.
          </p>
        </header>

        <label className="setting-row browser-setting-row">
          <div className="browser-setting-copy">
            <strong>Sleeping tabs</strong>
            <p>Puts inactive background tabs to sleep to free up system memory and reduce CPU usage.</p>
          </div>
          <input
            type="checkbox"
            checked={settings.sleepingTabsEnabled ?? true}
            onChange={(event) =>
              void browser.updateSettings({
                ...settings,
                sleepingTabsEnabled: event.target.checked,
              })
            }
          />
        </label>

        {settings.sleepingTabsEnabled !== false && (
          <>
            <div className="setting-row browser-setting-row">
              <div className="browser-setting-copy">
                <strong>Put inactive tabs to sleep after</strong>
                <p>Tabs playing audio or in the exclusion list will remain active.</p>
              </div>
              <select
                aria-label="Sleeping tab timeout"
                value={settings.sleepingTabTimeoutMinutes ?? 30}
                onChange={(event) =>
                  void browser.updateSettings({
                    ...settings,
                    sleepingTabTimeoutMinutes: Number(
                      event.target.value,
                    ) as typeof settings.sleepingTabTimeoutMinutes,
                  })
                }
              >
                {SLEEPING_TAB_TIMEOUT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <label className="setting-row browser-setting-row">
              <div className="browser-setting-copy">
                <strong>Memory Saver mode</strong>
                <p>Prioritizes immediate resource release when background tab memory consumption is elevated.</p>
              </div>
              <input
                type="checkbox"
                checked={settings.memorySaverMode ?? true}
                onChange={(event) =>
                  void browser.updateSettings({
                    ...settings,
                    memorySaverMode: event.target.checked,
                  })
                }
              />
            </label>

            <div className="setting-row browser-setting-row">
              <div className="browser-setting-copy">
                <strong>Manual tab hibernation</strong>
                <p>Immediately suspend all inactive background tabs right now.</p>
              </div>
              <button
                type="button"
                className="button secondary"
                onClick={() => void handleSleepInactiveNow()}
                disabled={sleepingBusy}
              >
                {sleepingBusy ? "Suspending..." : "Sleep inactive tabs now"}
              </button>
            </div>

            <div className="excluded-domains-setting">
              <div className="browser-setting-copy">
                <strong>Never put tabs to sleep on these sites</strong>
                <p>Enter domain names that should stay permanently active in the background.</p>
              </div>
              <div className="excluded-domain-input-group">
                <input
                  type="text"
                  placeholder="e.g. youtube.com, spotify.com"
                  value={newExcludedDomain}
                  onChange={(e) => setNewExcludedDomain(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleAddExcludedDomain();
                    }
                  }}
                  className="input-text"
                />
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void handleAddExcludedDomain()}
                  disabled={!newExcludedDomain.trim()}
                >
                  Add Site
                </button>
              </div>

              {(settings.sleepingTabExcludedDomains ?? []).length > 0 && (
                <div className="excluded-domains-list" aria-label="Excluded domains">
                  {(settings.sleepingTabExcludedDomains ?? []).map((domain) => (
                    <span key={domain} className="excluded-domain-chip">
                      <span>{domain}</span>
                      <button
                        type="button"
                        className="chip-remove-btn"
                        title={`Remove ${domain}`}
                        onClick={() => void handleRemoveExcludedDomain(domain)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </section>

      {/* 🧩 SECTION 3: EXTENSIONS & CHROME WEB STORE */}
      <section className="settings-stack browser-settings-panel" aria-label="Web extensions and store">
        <header className="settings-panel-header">
          <h3>
            <Icon name="extensions" /> Web Extensions & Add-ons
          </h3>
          <p className="settings-panel-subtitle">
            Install and manage extensions directly from the Google Chrome Web Store, unpacked folders, or CRX/ZIP files.
          </p>
        </header>

        {extensionMessage && (
          <div className={`extension-alert ${extensionMessage.type}`}>
            <span>{extensionMessage.text}</span>
            <button
              type="button"
              className="quiet-link"
              onClick={() => setExtensionMessage(null)}
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="extension-install-bar">
          <input
            type="text"
            placeholder="Paste Chrome Web Store URL or Extension ID (e.g. https://chromewebstore.google.com/...)"
            value={extensionUrlInput}
            onChange={(e) => setExtensionUrlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleInstallExtensionFromUrl();
              }
            }}
            className="input-text extension-url-input"
            disabled={extensionLoading}
          />
          <button
            type="button"
            className="button primary"
            onClick={() => void handleInstallExtensionFromUrl()}
            disabled={extensionLoading || !extensionUrlInput.trim()}
          >
            {extensionLoading ? "Installing..." : "Install from Web Store"}
          </button>
        </div>

        <div className="extension-actions-row">
          <button
            type="button"
            className="button secondary"
            onClick={() => void handleInstallExtensionFile()}
            disabled={extensionLoading}
          >
            <Icon name="plus" /> Load Unpacked or CRX File…
          </button>
          <a
            href="https://chromewebstore.google.com"
            target="_blank"
            rel="noreferrer"
            className="button quiet-action-link"
            onClick={(e) => {
              e.preventDefault();
              void browser.createTab("https://chromewebstore.google.com");
            }}
          >
            <Icon name="globe" /> Browse Chrome Web Store ↗
          </a>
        </div>

        <div className="installed-extensions-section">
          <h4>Installed Extensions ({extensions.length})</h4>
          {extensions.length === 0 ? (
            <div className="empty-extensions-state">
              <p>No browser extensions installed yet.</p>
              <small>You can install ad blockers, password managers, developer tools, and productivity extensions from the Google Chrome Web Store.</small>
            </div>
          ) : (
            <div className="extensions-grid">
              {extensions.map((ext) => (
                <article key={ext.id} className={`extension-card ${ext.enabled ? "enabled" : "disabled"}`}>
                  <div className="extension-card-header">
                    <div className="extension-card-icon">
                      <Icon name="extensions" />
                    </div>
                    <div className="extension-card-title-group">
                      <strong>{ext.name}</strong>
                      <span className="extension-version">v{ext.version}</span>
                      <span className="extension-source-badge">
                        {ext.source === "chrome_web_store" ? "Chrome Web Store" : ext.source === "unpacked" ? "Unpacked" : "Package File"}
                      </span>
                    </div>
                  </div>
                  {ext.description && (
                    <p className="extension-description">{ext.description}</p>
                  )}
                  <div className="extension-card-actions">
                    <label className="extension-toggle-label">
                      <span>{ext.enabled ? "Enabled" : "Disabled"}</span>
                      <input
                        type="checkbox"
                        checked={ext.enabled}
                        onChange={(e) => void handleToggleExtension(ext.id, e.target.checked)}
                      />
                    </label>
                    <button
                      type="button"
                      className="button danger-subtle"
                      onClick={() => void handleUninstallExtension(ext.id)}
                      title="Uninstall extension"
                    >
                      Remove
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* SECTION 4: TABS & GENERAL */}
      <section className="settings-stack browser-settings-panel" aria-label="General browser preferences">
        <header className="settings-panel-header">
          <h3>
            <Icon name="browser" /> Tabs & General
          </h3>
        </header>

        <div className="setting-row browser-setting-row">
          <div className="browser-setting-copy">
            <strong>Default browser</strong>
          </div>
          {isDefaultBrowser ? (
            <span className="badge success">
              <Icon name="check" /> Default browser
            </span>
          ) : canSetAsDefault === false ? (
            <span className="browser-setting-note">Available in installed Kestrel</span>
          ) : (
            <button
              type="button"
              className="button secondary"
              onClick={() => void handleSetDefault()}
              disabled={defaultBrowserBusy}
            >
              {defaultBrowserBusy ? "Setting..." : "Set as default"}
            </button>
          )}
        </div>

        <div className="setting-row browser-setting-row">
          <div className="browser-setting-copy">
            <strong>Tab layout</strong>
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

        <label className="setting-row browser-setting-row">
          <div className="browser-setting-copy">
            <strong>Restore tabs on startup</strong>
            <p>Re-opens previous open tabs when launching Kestrel.</p>
          </div>
          <input
            type="checkbox"
            checked={settings.restoreSession}
            onChange={(event) =>
              void browser.updateSettings({
                ...settings,
                restoreSession: event.target.checked,
              })
            }
          />
        </label>

      </section>

      {/* 🛡️ SECTION 5: PRIVACY & HISTORY */}
      <section className="settings-stack browser-settings-panel" aria-label="Browser privacy and history">
        <header className="settings-panel-header">
          <h3>
            <Icon name="privacy" /> Privacy & History
          </h3>
        </header>

        <label className="setting-row browser-setting-row">
          <div className="browser-setting-copy">
            <strong>Use current page context with agent</strong>
            <p>Allows Kestrel agent to inspect active tab headings and visible content when requested.</p>
          </div>
          <input
            type="checkbox"
            checked={contextEnabled}
            onChange={onToggleContext}
          />
        </label>

        <div className="setting-row browser-setting-row">
          <div className="browser-setting-copy">
            <strong>Keep browsing history</strong>
          </div>
          <select
            aria-label="Browser history retention"
            value={settings.historyRetentionDays}
            onChange={(event) =>
              void browser.updateSettings({
                ...settings,
                historyRetentionDays: Number(
                  event.target.value,
                ) as typeof settings.historyRetentionDays,
              })
            }
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
            <p>Clears stored history entries and back/forward caches across tabs.</p>
          </div>
          <button
            type="button"
            className="button secondary"
            onClick={() => void browser.clearHistory()}
            disabled={!browser.state?.history.length}
          >
            Clear browsing history
          </button>
        </div>

        <div className="setting-row browser-setting-row">
          <div className="browser-setting-copy">
            <strong>Clear cookies and site data</strong>
            <p>
              Removes cookies, cache, and remembered site permissions for this
              browser profile. Open tabs stay put.
            </p>
          </div>
          <button
            type="button"
            className="button secondary"
            onClick={() =>
              void browser.clearBrowsingData({ cookies: true, cache: true })
            }
          >
            Clear site data
          </button>
        </div>
      </section>
    </div>
  );
}
