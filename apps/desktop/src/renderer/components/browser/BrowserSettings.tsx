import type { UserBrowserController } from "../../browser/useUserBrowser";
import type {
  InstalledExtension,
  UserBrowserSettings,
} from "@kestrel/shared-types";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { Icon } from "../Icon";
import { Status } from "../ui";
import { PasswordSettings } from "./PasswordSettings";
import { PaymentSettings } from "./PaymentSettings";
import {
  CUSTOM_BACKGROUND_MAX_BYTES,
  NEW_TAB_BACKGROUND_OPTIONS,
  readBackgroundFile,
  SUPPORTED_BACKGROUND_MIME_TYPES,
} from "./new-tab";

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
  const [backgroundError, setBackgroundError] = useState("");
  const [backgroundBusy, setBackgroundBusy] = useState(false);
  const backgroundInputRef = useRef<HTMLInputElement | null>(null);

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
      searchEngine: "custom",
      customSearchName: customName.trim(),
      customSearchUrl: customUrl.trim(),
    });
  };

  const handleSelectBackground = async (
    background: Exclude<UserBrowserSettings["newTabBackground"], "custom">,
  ) => {
    if (!settings) return;
    setBackgroundError("");
    await browser.updateSettings({
      newTabBackground: background,
    });
  };

  const handleUploadBackground = async (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !settings) return;

    if (
      !SUPPORTED_BACKGROUND_MIME_TYPES.includes(
        file.type as (typeof SUPPORTED_BACKGROUND_MIME_TYPES)[number],
      )
    ) {
      setBackgroundError("Choose a PNG, JPEG, WebP, AVIF, or GIF image.");
      return;
    }
    if (file.size > CUSTOM_BACKGROUND_MAX_BYTES) {
      setBackgroundError("Choose an image smaller than 5 MB.");
      return;
    }

    setBackgroundBusy(true);
    setBackgroundError("");
    try {
      const dataUrl = await readBackgroundFile(file);
      await browser.updateSettings({
        newTabBackground: "custom",
        newTabBackgroundCustomDataUrl: dataUrl,
      });
    } catch (cause) {
      setBackgroundError(
        cause instanceof Error
          ? cause.message
          : "The selected image could not be saved.",
      );
    } finally {
      setBackgroundBusy(false);
    }
  };

  const handleRemoveUploadedBackground = async () => {
    if (!settings) return;
    setBackgroundError("");
    await browser.updateSettings({
      newTabBackground:
        settings.newTabBackground === "custom"
          ? "graphite"
          : settings.newTabBackground,
      newTabBackgroundCustomDataUrl: undefined,
    });
  };

  const handleAddExcludedDomain = async () => {
    if (!settings || !newExcludedDomain.trim()) return;
    const cleanDomain = newExcludedDomain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!cleanDomain) return;

    const existing = settings.sleepingTabExcludedDomains ?? [];
    if (!existing.includes(cleanDomain)) {
      await browser.updateSettings({
        sleepingTabExcludedDomains: [...existing, cleanDomain],
      });
    }
    setNewExcludedDomain("");
  };

  const handleRemoveExcludedDomain = async (domain: string) => {
    if (!settings) return;
    const existing = settings.sleepingTabExcludedDomains ?? [];
    await browser.updateSettings({
      sleepingTabExcludedDomains: existing.filter((d) => d !== domain),
    });
  };

  const handleSleepInactiveNow = async () => {
    setSleepingBusy(true);
		try {
			await browser.sleepInactiveTabs();
		} finally {
			/* Readiness follows the operation, not a cosmetic minimum duration.
			 * Repeated input should never wait for a spinner to finish. */
			setSleepingBusy(false);
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
      <header className="browser-settings-intro">
        <span className="eyebrow">Browser settings</span>
        <h2>Make the browser feel like yours.</h2>
        <p>
          Keep browser controls here. Agent behavior, models, memory, and
          approvals live in the separate Agent settings area.
        </p>
      </header>

      <PasswordSettings browser={browser} />
      <PaymentSettings browser={browser} />

      {/* New tab appearance */}
      <section
        className="settings-stack browser-settings-panel browser-background-panel"
        aria-labelledby="browser-background-title"
      >
        <header className="settings-panel-header">
          <h2 id="browser-background-title">
            <Icon name="artifacts" /> New tab background
          </h2>
          <p>
            Start with Kestrel’s light default, choose a bundled scene, or add
            a local image. Your upload stays in this Kestrel profile.
          </p>
        </header>

        <div
          className="background-option-grid"
          role="radiogroup"
          aria-label="New tab background presets"
        >
          {NEW_TAB_BACKGROUND_OPTIONS.map((option) => (
            <label
              key={option.value}
              className={`background-option ${
                settings.newTabBackground === option.value ? "selected" : ""
              }`}
            >
              <input
                type="radio"
                name="new-tab-background"
                value={option.value}
                checked={settings.newTabBackground === option.value}
                onChange={() => void handleSelectBackground(option.value)}
              />
              <span
                className={`background-option-preview background-option-preview-${option.value}`}
                aria-hidden="true"
              >
                {settings.newTabBackground === option.value && (
                  <span className="background-option-check">
                    <Icon name="check" />
                  </span>
                )}
              </span>
              <span className="background-option-copy">
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
            </label>
          ))}

          <div
            className={`background-upload-card ${
              settings.newTabBackground === "custom" &&
              settings.newTabBackgroundCustomDataUrl
                ? "selected"
                : ""
            }`}
          >
            <span
              className="background-option-preview background-option-preview-custom"
              aria-hidden="true"
              style={
                settings.newTabBackgroundCustomDataUrl
                  ? {
                      backgroundImage: `url("${settings.newTabBackgroundCustomDataUrl}")`,
                    }
                  : undefined
              }
            >
              {settings.newTabBackground === "custom" &&
                settings.newTabBackgroundCustomDataUrl && (
                  <span className="background-option-check">
                    <Icon name="check" />
                  </span>
                )}
            </span>
            <span className="background-upload-copy">
              <strong>Your image</strong>
              <small>PNG, JPEG, WebP, AVIF, or GIF up to 5 MB.</small>
              <span className="background-upload-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => backgroundInputRef.current?.click()}
                  disabled={backgroundBusy}
                  aria-controls="new-tab-background-upload"
                >
                  {backgroundBusy ? "Reading image…" : "Choose image"}
                </button>
                {settings.newTabBackgroundCustomDataUrl && (
                  <button
                    type="button"
                    className="quiet-link"
                    onClick={() => void handleRemoveUploadedBackground()}
                  >
                    Remove upload
                  </button>
                )}
              </span>
              <input
                ref={backgroundInputRef}
                id="new-tab-background-upload"
                className="sr-only"
                type="file"
                accept="image/avif,image/gif,image/jpeg,image/png,image/webp"
                onChange={(event) => void handleUploadBackground(event)}
                disabled={backgroundBusy}
                tabIndex={-1}
                aria-hidden="true"
              />
            </span>
          </div>
        </div>
        {backgroundError && (
          <p className="browser-background-error" role="alert">
            {backgroundError}
          </p>
        )}
      </section>

      {/* Search engine */}
      <section className="settings-stack browser-settings-panel" aria-label="Search engine preferences">
        <header className="settings-panel-header">
          <h2>
            <Icon name="search" /> Search Engine
          </h2>
        </header>

        <div className="setting-row browser-setting-row">
          <div className="browser-setting-copy">
            <strong>Default search engine</strong>
          </div>
          <select
            aria-label="Search engine"
            value={settings.searchEngine}
            onChange={(event) =>
              void browser.updateSettings({
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
                <span>Engine name</span>
                <input
                  type="text"
                  placeholder="e.g. My Intranet Search"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  className="ui-input"
                />
              </label>
              <label className="custom-search-label">
                <span>Search URL Template</span>
                <input
                  type="url"
                  placeholder="https://example.com/search?q=%s"
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                  className="ui-input"
                />
              </label>
            </div>
            <button
              type="button"
              className="button secondary"
              onClick={() => void handleSaveCustomSearch()}
              disabled={!customUrl.trim()}
            >
              Save custom engine
            </button>
          </div>
        )}
      </section>

      {/* Performance and sleeping tabs */}
      <section className="settings-stack browser-settings-panel" aria-label="Performance and sleeping tabs">
        <header className="settings-panel-header">
          <h2>
            <Icon name="sparkles" /> Performance & Memory Saver
          </h2>
        </header>

        <div className="setting-row browser-setting-row">
          <div className="browser-setting-copy">
            <strong>Sleeping tabs</strong>
          </div>
          <button
            type="button"
            className={`switch ${(settings.sleepingTabsEnabled ?? true) ? "on" : ""}`}
            role="switch"
            aria-label="Sleeping tabs"
            aria-checked={settings.sleepingTabsEnabled ?? true}
            onClick={() =>
              void browser.updateSettings({
                sleepingTabsEnabled: !(settings.sleepingTabsEnabled ?? true),
              })
            }
          >
            <span />
          </button>
        </div>

        {settings.sleepingTabsEnabled !== false && (
          <>
            <div className="setting-row browser-setting-row">
              <div className="browser-setting-copy">
                <strong>Put inactive tabs to sleep after</strong>
              </div>
              <select
                aria-label="Sleeping tab timeout"
                value={settings.sleepingTabTimeoutMinutes ?? 30}
                onChange={(event) =>
                  void browser.updateSettings({
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

            <div className="setting-row browser-setting-row">
              <div className="browser-setting-copy">
                <strong>Memory Saver mode</strong>
              </div>
              <button
                type="button"
                className={`switch ${(settings.memorySaverMode ?? true) ? "on" : ""}`}
                role="switch"
                aria-label="Memory Saver mode"
                aria-checked={settings.memorySaverMode ?? true}
                onClick={() =>
                  void browser.updateSettings({
                    memorySaverMode: !(settings.memorySaverMode ?? true),
                  })
                }
              >
                <span />
              </button>
            </div>

            <div className="setting-row browser-setting-row">
              <div className="browser-setting-copy">
                <strong>Manual tab hibernation</strong>
              </div>
              <button
                type="button"
                className="button secondary"
                onClick={() => void handleSleepInactiveNow()}
                disabled={sleepingBusy}
              >
                {sleepingBusy ? "Suspending…" : "Sleep inactive tabs now"}
              </button>
            </div>

            <div className="excluded-domains-setting">
              <div className="browser-setting-copy">
                <strong>Never put tabs to sleep on these sites</strong>
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
                  className="ui-input"
                />
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void handleAddExcludedDomain()}
                  disabled={!newExcludedDomain.trim()}
                >
                  Add site
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

      {/* Web extensions */}
      <section className="settings-stack browser-settings-panel" aria-label="Web extensions and store">
        <header className="settings-panel-header">
          <h2>
            <Icon name="extensions" /> Web Extensions & Add-ons
          </h2>
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
            className="ui-input extension-url-input"
            disabled={extensionLoading}
          />
          <button
            type="button"
            className="button primary"
            onClick={() => void handleInstallExtensionFromUrl()}
            disabled={extensionLoading || !extensionUrlInput.trim()}
          >
            {extensionLoading ? "Installing…" : "Install from Web Store"}
          </button>
        </div>

        <div className="extension-actions-row">
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
        <p className="honest-status">
          Kestrel verifies each store package and keeps it only after Electron
          loads its signed identity. Manifest V3 background workers must also
          start successfully. Some Chrome extension APIs are not available in
          Electron.
        </p>

        <div className="installed-extensions-section">
          <h4>Installed Extensions ({extensions.length})</h4>
          {extensions.length === 0 ? (
            <div className="empty-extensions-state">
              <p>No browser extensions installed yet.</p>
              <small>Install from the Chrome Web Store above.</small>
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
                        {ext.source === "chrome_web_store" ? "Chrome Web Store" : ext.source === "unpacked" ? "Unpacked (development)" : "Local package (development)"}
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

      {/* Tabs and general */}
      <section className="settings-stack browser-settings-panel" aria-label="General browser preferences">
        <header className="settings-panel-header">
          <h2>
            <Icon name="browser" /> Tabs & General
          </h2>
        </header>

        <div className="setting-row browser-setting-row">
          <div className="browser-setting-copy">
            <strong>Default browser</strong>
          </div>
          {isDefaultBrowser ? (
            <Status tone="verified">Default browser</Status>
          ) : canSetAsDefault === false ? (
            <Status tone="neutral">Available in installed Kestrel</Status>
          ) : (
            <button
              type="button"
              className="button secondary"
              onClick={() => void handleSetDefault()}
              disabled={defaultBrowserBusy}
            >
              {defaultBrowserBusy ? "Setting…" : "Set as default"}
            </button>
          )}
        </div>

        <div className="setting-row browser-setting-row">
          <div className="browser-setting-copy">
            <strong>Show bookmarks bar</strong>
            <p>Shows saved pages on New Tab under the address bar. Toggle with ⌘⇧B.</p>
          </div>
          <button
            type="button"
            className={`switch ${settings.showBookmarksBar ? "on" : ""}`}
            role="switch"
            aria-label="Show bookmarks bar"
            aria-checked={settings.showBookmarksBar}
            onClick={() =>
              void browser.updateSettings({
                showBookmarksBar: !settings.showBookmarksBar,
              })
            }
          >
            <span />
          </button>
        </div>

        <div className="setting-row browser-setting-row">
          <div className="browser-setting-copy">
            <strong>Address bar suggestions</strong>
            <p>Suggests only local history, favorites, and open tabs. Typed text is not sent anywhere for suggestions.</p>
          </div>
          <button
            type="button"
            className={`switch ${settings.addressBarSuggestionsEnabled ? "on" : ""}`}
            role="switch"
            aria-label="Address bar suggestions"
            aria-checked={settings.addressBarSuggestionsEnabled}
            onClick={() =>
              void browser.updateSettings({
                addressBarSuggestionsEnabled: !settings.addressBarSuggestionsEnabled,
              })
            }
          >
            <span />
          </button>
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
            <strong>Restore tabs on startup</strong>
          </div>
          <button
            type="button"
            className={`switch ${settings.restoreSession ? "on" : ""}`}
            role="switch"
            aria-label="Restore tabs on startup"
            aria-checked={settings.restoreSession}
            onClick={() =>
              void browser.updateSettings({
                restoreSession: !settings.restoreSession,
              })
            }
          >
            <span />
          </button>
        </div>

      </section>

      {/* Privacy and history */}
      <section className="settings-stack browser-settings-panel" aria-label="Browser privacy and history">
        <header className="settings-panel-header">
          <h2>
            <Icon name="privacy" /> Privacy & History
          </h2>
        </header>

        <div className="setting-row browser-setting-row">
          <div className="browser-setting-copy">
            <strong>Use current page context with agent</strong>
          </div>
          <button
            type="button"
            className={`switch ${contextEnabled ? "on" : ""}`}
            role="switch"
            aria-label="Use current page context with agent"
            aria-checked={contextEnabled}
            onClick={onToggleContext}
          >
            <span />
          </button>
        </div>

        <div className="setting-row browser-setting-row">
          <div className="browser-setting-copy">
            <strong>Keep browsing history</strong>
          </div>
          <select
            aria-label="Browser history retention"
            value={settings.historyRetentionDays}
            onChange={(event) =>
              void browser.updateSettings({
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
          </div>
          <button
            type="button"
            className="button secondary"
            onClick={() => void browser.clearHistory()}
            disabled={
              !browser.state?.history.length &&
              !browser.state?.recentlyClosedTabs.length
            }
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
