import type { UserBrowserController } from "../../browser/useUserBrowser";
import type {
  InstalledExtension,
  UserBrowserSettings,
  UserBrowserSitePermission,
} from "@kestrel/shared-types";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import type { BrowserSettingsSection } from "../../settings-catalog";
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

const SPELLCHECK_LANGUAGES = [
  ["en-US", "English (United States)"],
  ["en-GB", "English (United Kingdom)"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["pt-BR", "Portuguese (Brazil)"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["zh-CN", "Chinese (Simplified)"],
] as const;

const DEFAULT_ZOOM_OPTIONS = [
  75, 80, 90, 100, 110, 125, 150, 175, 200,
] as const;

const FONT_OPTIONS = [
  ["system-ui", "System UI"],
  ["-apple-system, BlinkMacSystemFont, sans-serif", "System sans"],
  ["Arial, sans-serif", "Arial"],
  ["Georgia, serif", "Georgia"],
  ["Verdana, sans-serif", "Verdana"],
] as const;

function sectionIs(
  current: BrowserSettingsSection,
  ...sections: BrowserSettingsSection[]
): boolean {
  return current === "browser" || sections.includes(current);
}

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function formatPath(path: string): string {
  if (!path) return "Kestrel’s default Downloads folder";
  const pieces = path.split(/[\\/]/).filter(Boolean);
  return pieces.length > 2 ? `…/${pieces.slice(-2).join("/")}` : path;
}

function validHomepage(value: string): boolean {
  if (!value.trim()) return true;
  try {
    const url = new URL(value.trim());
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function BrowserSettings({
  browser,
  contextEnabled,
  onToggleContext,
  section = "browser",
}: {
  browser: UserBrowserController;
  contextEnabled: boolean;
  onToggleContext(): void;
  section?: BrowserSettingsSection;
}) {
  const settings = browser.state?.settings;
  const [isDefaultBrowser, setIsDefaultBrowser] = useState<boolean | null>(
    null,
  );
  const [canSetAsDefault, setCanSetAsDefault] = useState<boolean | null>(null);
  const [defaultBrowserBusy, setDefaultBrowserBusy] = useState(false);
  const [backgroundError, setBackgroundError] = useState("");
  const [backgroundBusy, setBackgroundBusy] = useState(false);
  const backgroundInputRef = useRef<HTMLInputElement | null>(null);
  const [customName, setCustomName] = useState(
    settings?.customSearchName ?? "",
  );
  const [customUrl, setCustomUrl] = useState(settings?.customSearchUrl ?? "");
  const [newExcludedDomain, setNewExcludedDomain] = useState("");
  const [sleepingBusy, setSleepingBusy] = useState(false);
  const [extensions, setExtensions] = useState<InstalledExtension[]>([]);
  const [extensionUrlInput, setExtensionUrlInput] = useState("");
  const [extensionLoading, setExtensionLoading] = useState(false);
  const [extensionMessage, setExtensionMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [startupPageInput, setStartupPageInput] = useState("");
  const [homepageInput, setHomepageInput] = useState(
    settings?.homepageUrl ?? "",
  );
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [saveError, setSaveError] = useState("");
  const [restartRequired, setRestartRequired] = useState(false);
  const [dataBusy, setDataBusy] = useState<"import" | "export" | "">("");
  const [dataMessage, setDataMessage] = useState("");
  const [dataError, setDataError] = useState("");
  const [permissionBusy, setPermissionBusy] = useState("");
  const [permissionError, setPermissionError] = useState("");
  const [resetSettingsConfirm, setResetSettingsConfirm] = useState(false);
  const [retryingLoad, setRetryingLoad] = useState(false);

  const persist = useCallback(
    async (next: Partial<UserBrowserSettings>) => {
      setSaveState("saving");
      setSaveError("");
      try {
        if (
          settings &&
          "hardwareAccelerationEnabled" in next &&
          next.hardwareAccelerationEnabled !==
            settings.hardwareAccelerationEnabled
        )
          setRestartRequired(true);
        await browser.updateSettings(next);
        setSaveState("saved");
      } catch (cause) {
        setSaveState("error");
        setSaveError(errorText(cause, "Browser setting could not be saved."));
      }
    },
    [browser, settings?.hardwareAccelerationEnabled],
  );

  const fetchExtensions = useCallback(async () => {
    try {
      const response = await window.kestrel.request({
        type: "browser-list-extensions",
      });
      if (response.ok && "extensions" in response)
        setExtensions(response.extensions as InstalledExtension[]);
    } catch {
      // Extension availability is shown as an empty state if the native manager
      // is unavailable; the rest of Browser settings remains usable.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.kestrel
      .request({ type: "get-default-browser-status" })
      .then((response) => {
        if (cancelled || !response.ok || !("isDefault" in response)) return;
        setIsDefaultBrowser(Boolean(response.isDefault));
        if ("canSetAsDefault" in response)
          setCanSetAsDefault(response.canSetAsDefault);
      })
      .catch(() => undefined);
    void fetchExtensions();
    return () => {
      cancelled = true;
    };
  }, [fetchExtensions]);

  useEffect(() => {
    if (settings?.customSearchName !== undefined)
      setCustomName(settings.customSearchName);
    if (settings?.customSearchUrl !== undefined)
      setCustomUrl(settings.customSearchUrl);
    if (settings?.homepageUrl !== undefined)
      setHomepageInput(settings.homepageUrl);
  }, [
    settings?.customSearchName,
    settings?.customSearchUrl,
    settings?.homepageUrl,
  ]);

  const handleSetDefault = async () => {
    setDefaultBrowserBusy(true);
    try {
      const response = await window.kestrel.request({
        type: "set-default-browser",
      });
      if (!response.ok)
        throw new Error(
          "error" in response
            ? response.error
            : "Kestrel could not become the default browser.",
        );
      if (response.ok && "isDefault" in response) {
        setIsDefaultBrowser(Boolean(response.isDefault));
        if ("canSetAsDefault" in response)
          setCanSetAsDefault(response.canSetAsDefault);
      }
    } catch (cause) {
      setSaveState("error");
      setSaveError(
        errorText(cause, "Kestrel could not become the default browser."),
      );
    } finally {
      setDefaultBrowserBusy(false);
    }
  };

  const handleSaveCustomSearch = async () => {
    await persist({
      searchEngine: "custom",
      customSearchName: customName.trim(),
      customSearchUrl: customUrl.trim(),
    });
  };

  const handleSelectBackground = async (
    background: Exclude<UserBrowserSettings["newTabBackground"], "custom">,
  ) => {
    setBackgroundError("");
    await persist({ newTabBackground: background });
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
      await persist({
        newTabBackground: "custom",
        newTabBackgroundCustomDataUrl: dataUrl,
      });
    } catch (cause) {
      setBackgroundError(
        errorText(cause, "The selected image could not be saved."),
      );
    } finally {
      setBackgroundBusy(false);
    }
  };

  const handleRemoveUploadedBackground = async () => {
    if (!settings) return;
    await persist({
      newTabBackground:
        settings.newTabBackground === "custom"
          ? "graphite"
          : settings.newTabBackground,
      newTabBackgroundCustomDataUrl: undefined,
    });
  };

  const handleAddExcludedDomain = async () => {
    if (!settings || !newExcludedDomain.trim()) return;
    const cleanDomain = newExcludedDomain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
    if (!cleanDomain) return;
    const existing = settings.sleepingTabExcludedDomains ?? [];
    if (!existing.includes(cleanDomain))
      await persist({ sleepingTabExcludedDomains: [...existing, cleanDomain] });
    setNewExcludedDomain("");
  };

  const handleRemoveExcludedDomain = async (domain: string) => {
    if (!settings) return;
    await persist({
      sleepingTabExcludedDomains: (
        settings.sleepingTabExcludedDomains ?? []
      ).filter((item) => item !== domain),
    });
  };

  const handleSleepInactiveNow = async () => {
    setSleepingBusy(true);
    try {
      await browser.sleepInactiveTabs();
    } catch (cause) {
      setSaveState("error");
      setSaveError(
        errorText(cause, "Inactive tabs could not be put to sleep."),
      );
    } finally {
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
          text:
            "error" in response
              ? String(response.error)
              : "Failed to install extension.",
        });
      }
    } catch (cause) {
      setExtensionMessage({
        type: "error",
        text: errorText(cause, "Failed to download extension."),
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
      if (response.ok) await fetchExtensions();
    } catch (cause) {
      setExtensionMessage({
        type: "error",
        text: errorText(cause, "Failed to toggle extension."),
      });
    }
  };

  const handleUninstallExtension = async (id: string) => {
    try {
      const response = await window.kestrel.request({
        type: "browser-uninstall-extension",
        extensionId: id,
      });
      if (response.ok) await fetchExtensions();
    } catch (cause) {
      setExtensionMessage({
        type: "error",
        text: errorText(cause, "Failed to uninstall extension."),
      });
    }
  };

  const handleStartupBehavior = (
    behavior: UserBrowserSettings["startupBehavior"],
  ) => {
    void persist({
      startupBehavior: behavior,
      restoreSession: behavior === "restore",
    });
  };

  const handleSaveHomepage = () => {
    const value = homepageInput.trim();
    if (!validHomepage(value)) {
      setSaveState("error");
      setSaveError(
        "Use a complete HTTP(S) URL without a username or password.",
      );
      return;
    }
    void persist({ homepageUrl: value });
  };

  const handleAddStartupPage = () => {
    if (!settings) return;
    const value = startupPageInput.trim();
    if (!validHomepage(value) || !value) {
      setSaveState("error");
      setSaveError(
        "Add a complete HTTP(S) URL without a username or password.",
      );
      return;
    }
    if (settings.startupPages.includes(value)) return;
    void persist({
      startupPages: [...settings.startupPages, value],
      startupBehavior: "specific_pages",
      restoreSession: false,
    });
    setStartupPageInput("");
  };

  const handleRemoveStartupPage = (url: string) => {
    if (!settings) return;
    void persist({
      startupPages: settings.startupPages.filter((item) => item !== url),
    });
  };

  const handleDownloadLocation = async () => {
    setSaveState("saving");
    setSaveError("");
    try {
      const changed = await browser.selectDownloadDirectory();
      setSaveState(changed ? "saved" : "idle");
    } catch (cause) {
      setSaveState("error");
      setSaveError(errorText(cause, "Download location could not be changed."));
    }
  };

  const handleResetDownloadLocation = async () => {
    try {
      await browser.resetDownloadDirectory();
      setSaveState("saved");
    } catch (cause) {
      setSaveState("error");
      setSaveError(errorText(cause, "Download location could not be reset."));
    }
  };

  const handleExport = async () => {
    setDataBusy("export");
    setDataError("");
    setDataMessage("");
    try {
      const path = await browser.exportBrowserData();
      if (path) setDataMessage(`Browser data exported to ${formatPath(path)}.`);
    } catch (cause) {
      setDataError(errorText(cause, "Browser data could not be exported."));
    } finally {
      setDataBusy("");
    }
  };

  const handleImport = async () => {
    setDataBusy("import");
    setDataError("");
    setDataMessage("");
    try {
      const imported = await browser.importBrowserData();
      if (imported)
        setDataMessage(
          "Bookmarks, history, site permissions, and preferences were imported.",
        );
    } catch (cause) {
      setDataError(
        errorText(cause, "That browser data file could not be imported."),
      );
    } finally {
      setDataBusy("");
    }
  };

  const handleResetSettings = async () => {
    if (!resetSettingsConfirm) {
      setResetSettingsConfirm(true);
      return;
    }
    setResetSettingsConfirm(false);
    setSaveState("saving");
    setSaveError("");
    try {
      await browser.resetBrowserSettings();
      setSaveState("saved");
    } catch (cause) {
      setSaveState("error");
      setSaveError(errorText(cause, "Browser settings could not be reset."));
    }
  };

  const clearPermission = async (permission: UserBrowserSitePermission) => {
    setPermissionBusy(`${permission.origin}:${permission.permission}`);
    setPermissionError("");
    try {
      await browser.clearSitePermission(
        permission.origin,
        permission.permission,
      );
    } catch (cause) {
      setPermissionError(
        errorText(cause, "The site permission could not be revoked."),
      );
    } finally {
      setPermissionBusy("");
    }
  };

  const sitePermissions = useMemo(
    () => browser.state?.sitePermissions ?? [],
    [browser.state?.sitePermissions],
  );

  if (!settings)
    return (
      <div className="browser-settings-loading" role="status" aria-busy="true">
        <p>Browser settings are loading.</p>
        {browser.error && <small role="alert">{browser.error}</small>}
        <button
          type="button"
          className="button secondary"
          disabled={retryingLoad}
          onClick={() => {
            setRetryingLoad(true);
            void browser
              .refresh()
              .catch(() => undefined)
              .finally(() => setRetryingLoad(false));
          }}
        >
          {retryingLoad ? "Retrying…" : "Try again"}
        </button>
      </div>
    );

  const show = (...sections: BrowserSettingsSection[]) =>
    sectionIs(section, ...sections);
  const statusCopy =
    saveState === "saving"
      ? "Saving…"
      : saveState === "saved"
        ? "Saved"
        : saveState === "error"
          ? saveError
          : "";

  return (
    <div className="browser-settings-wrapper" data-settings-section={section}>
      <header className="browser-settings-intro">
        <span className="eyebrow">Browser settings</span>
        <h2>
          {section === "browser"
            ? "Make the browser feel like yours."
            : "Browser"}
        </h2>
        <p>
          {section === "browser"
            ? "Keep browser controls here. Agent behavior, models, memory, and approvals live in the separate Agent settings area."
            : "Focused browser preferences with native behavior and profile-owned persistence."}
        </p>
        {statusCopy && (
          <small
            className={`browser-settings-save-state ${saveState}`}
            role={saveState === "error" ? "alert" : "status"}
          >
            {statusCopy}
          </small>
        )}
      </header>

      {show("browser-startup") && (
        <section
          className="settings-stack browser-settings-panel"
          aria-labelledby="browser-startup-title"
          data-settings-panel="browser-startup"
        >
          <header className="settings-panel-header">
            <h2 id="browser-startup-title">
              <Icon name="reload" /> Startup
            </h2>
            <p>Choose what Kestrel opens when the app starts.</p>
          </header>
          <div
            className="setting-row browser-setting-row"
            id="setting-browser-startup-behavior"
          >
            <div className="browser-setting-copy">
              <strong>When Kestrel starts</strong>
              <p>Restoring a session keeps its tab order and folders.</p>
            </div>
            <select
              aria-label="Startup behavior"
              value={settings.startupBehavior}
              onChange={(event) =>
                handleStartupBehavior(
                  event.target.value as UserBrowserSettings["startupBehavior"],
                )
              }
            >
              <option value="restore">Restore previous session</option>
              <option value="new_tab">Open the new tab page</option>
              <option value="homepage">Open the homepage</option>
              <option value="specific_pages">Open specific pages</option>
            </select>
          </div>
          <div
            className="setting-row browser-setting-row"
            id="setting-browser-homepage"
          >
            <div className="browser-setting-copy">
              <strong>Homepage URL</strong>
              <p>
                Only HTTP(S) pages without embedded credentials are accepted.
                Leave empty for the new tab page.
              </p>
            </div>
            <div className="browser-inline-control">
              <input
                aria-label="Homepage URL"
                type="url"
                value={homepageInput}
                placeholder="https://example.com"
                onChange={(event) => setHomepageInput(event.target.value)}
              />
              <button
                type="button"
                className="button secondary"
                onClick={handleSaveHomepage}
                disabled={!validHomepage(homepageInput)}
              >
                Save homepage
              </button>
            </div>
          </div>
          <div
            className="setting-row browser-setting-row"
            id="setting-browser-startup-pages"
          >
            <div className="browser-setting-copy">
              <strong>Specific startup pages</strong>
              <p>
                Pages are opened in order when this startup mode is selected.
              </p>
            </div>
            <div className="browser-startup-pages-control">
              <div className="browser-inline-control">
                <input
                  aria-label="Add startup page"
                  type="url"
                  value={startupPageInput}
                  placeholder="https://example.com"
                  onChange={(event) => setStartupPageInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      handleAddStartupPage();
                    }
                  }}
                />
                <button
                  type="button"
                  className="button secondary"
                  onClick={handleAddStartupPage}
                  disabled={
                    !validHomepage(startupPageInput) || !startupPageInput.trim()
                  }
                >
                  Add page
                </button>
              </div>
              {settings.startupPages.length > 0 && (
                <ul className="browser-settings-list">
                  {settings.startupPages.map((url) => (
                    <li key={url}>
                      <span>{url}</span>
                      <button
                        type="button"
                        className="quiet-link"
                        onClick={() => handleRemoveStartupPage(url)}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      )}

      {show("browser-appearance") && (
        <>
          <section
            className="settings-stack browser-settings-panel browser-background-panel"
            aria-labelledby="browser-background-title"
            data-settings-panel="browser-appearance"
          >
            <header className="settings-panel-header">
              <h2 id="browser-background-title">
                <Icon name="artifacts" /> New tab background
              </h2>
              <p>
                Start with Kestrel’s light default, choose a bundled scene, or
                add a local image. Your upload stays in this Kestrel profile.
              </p>
            </header>
            <div
              id="setting-browser-new-tab-background"
              className="background-option-grid"
              role="radiogroup"
              aria-label="New tab background presets"
            >
              {NEW_TAB_BACKGROUND_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className={`background-option ${settings.newTabBackground === option.value ? "selected" : ""}`}
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
                className={`background-upload-card ${settings.newTabBackground === "custom" && settings.newTabBackgroundCustomDataUrl ? "selected" : ""}`}
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
          <section
            className="settings-stack browser-settings-panel"
            aria-label="Appearance preferences"
          >
            <header className="settings-panel-header">
              <h2>
                <Icon name="browser" /> Tabs and appearance
              </h2>
              <p>
                These are Kestrel-specific browser surfaces; vertical tabs,
                folders, and the sidebar remain in their existing browser tools.
              </p>
            </header>
            <div
              className="setting-row browser-setting-row"
              id="setting-browser-tab-layout"
            >
              <div className="browser-setting-copy">
                <strong>Tab layout</strong>
                <p>Choose the tab rail that fits your workflow.</p>
              </div>
              <select
                aria-label="Tab layout"
                value={settings.tabLayout}
                onChange={(event) =>
                  void persist({
                    tabLayout: event.target.value as typeof settings.tabLayout,
                  })
                }
              >
                <option value="horizontal">Horizontal tabs</option>
                <option value="vertical">Vertical tabs</option>
              </select>
            </div>
            <div
              className="setting-row browser-setting-row"
              id="setting-browser-bookmarks-bar"
            >
              <div className="browser-setting-copy">
                <strong>Show bookmarks bar</strong>
                <p>Shows saved pages under the address bar. Toggle with ⌘⇧B.</p>
              </div>
              <button
                type="button"
                className={`switch ${settings.showBookmarksBar ? "on" : ""}`}
                role="switch"
                aria-label="Show bookmarks bar"
                aria-checked={settings.showBookmarksBar}
                onClick={() =>
                  void persist({ showBookmarksBar: !settings.showBookmarksBar })
                }
              >
                <span />
              </button>
            </div>
            <div
              className="setting-row browser-setting-row"
              id="setting-browser-default-zoom"
            >
              <div className="browser-setting-copy">
                <strong>Default page zoom</strong>
                <p>
                  Applied to newly opened pages and current pages when changed.
                </p>
              </div>
              <select
                aria-label="Default page zoom"
                value={settings.defaultZoomPercent}
                onChange={(event) =>
                  void persist({
                    defaultZoomPercent: Number(event.target.value),
                  })
                }
              >
                {DEFAULT_ZOOM_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {value}%
                  </option>
                ))}
              </select>
            </div>
          </section>
        </>
      )}

      {show("browser-search") && (
        <section
          className="settings-stack browser-settings-panel"
          aria-label="Search and address bar preferences"
          data-settings-panel="browser-search"
        >
          <header className="settings-panel-header">
            <h2>
              <Icon name="search" /> Search and address bar
            </h2>
            <p>
              Address-bar suggestions are local to this profile; typed text is
              not sent anywhere for suggestions.
            </p>
          </header>
          <div
            className="setting-row browser-setting-row"
            id="setting-browser-search-engine"
          >
            <div className="browser-setting-copy">
              <strong>Default search engine</strong>
            </div>
            <select
              aria-label="Search engine"
              value={settings.searchEngine}
              onChange={(event) =>
                void persist({
                  searchEngine: event.target
                    .value as typeof settings.searchEngine,
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
            <div
              className="custom-search-config-box"
              id="setting-browser-custom-search"
            >
              <div className="custom-search-fields">
                <label className="custom-search-label">
                  <span>Engine name</span>
                  <input
                    type="text"
                    placeholder="e.g. My Intranet Search"
                    value={customName}
                    onChange={(event) => setCustomName(event.target.value)}
                    className="ui-input"
                  />
                </label>
                <label className="custom-search-label">
                  <span>Search URL template</span>
                  <input
                    type="url"
                    placeholder="https://example.com/search?q=%s"
                    value={customUrl}
                    onChange={(event) => setCustomUrl(event.target.value)}
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
          <div
            className="setting-row browser-setting-row"
            id="setting-browser-address-suggestions"
          >
            <div className="browser-setting-copy">
              <strong>Address bar suggestions</strong>
              <p>Suggest only local history, favorites, and open tabs.</p>
            </div>
            <button
              type="button"
              className={`switch ${settings.addressBarSuggestionsEnabled ? "on" : ""}`}
              role="switch"
              aria-label="Address bar suggestions"
              aria-checked={settings.addressBarSuggestionsEnabled}
              onClick={() =>
                void persist({
                  addressBarSuggestionsEnabled:
                    !settings.addressBarSuggestionsEnabled,
                })
              }
            >
              <span />
            </button>
          </div>
        </section>
      )}

      {show("browser-privacy") && (
        <section
          className="settings-stack browser-settings-panel"
          aria-label="Browser privacy and site permissions"
          data-settings-panel="browser-privacy"
        >
          <header className="settings-panel-header">
            <h2>
              <Icon name="privacy" /> Privacy and site permissions
            </h2>
            <p>
              Permission choices are stored per origin and can be revoked here.
              Cookies and cache stay in the native browser partition.
            </p>
          </header>
          <div
            className="setting-row browser-setting-row"
            id="setting-browser-page-context"
          >
            <div
              className="browser-setting-copy"
            >
              <strong>Use current page context with agent</strong>
              <p>
                Share the selected page’s bounded, untrusted context only when
                you ask Kestrel to use it.
              </p>
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
          <div
            className="setting-row browser-setting-row"
            id="setting-browser-history-retention"
          >
            <div className="browser-setting-copy">
              <strong>Keep browsing history</strong>
              <p>History is retained only in this Kestrel profile.</p>
            </div>
            <select
              aria-label="Browser history retention"
              value={settings.historyRetentionDays}
              onChange={(event) =>
                void persist({
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
          <div
            className="setting-row browser-setting-row"
            id="setting-browser-site-permissions"
          >
            <div className="browser-setting-copy">
              <strong>Remembered site permissions</strong>
              <p>
                Allow or deny decisions for camera, microphone, notifications,
                and other web permissions.
              </p>
              {sitePermissions.length === 0 ? (
                <small>No remembered site permissions.</small>
              ) : (
                <ul className="browser-settings-list">
                  {sitePermissions.map((permission) => {
                    const key = `${permission.origin}:${permission.permission}`;
                    return (
                      <li key={key}>
                        <span>
                          {permission.origin} · {permission.permission} ·{" "}
                          {permission.decision}
                        </span>
                        <button
                          type="button"
                          className="quiet-link"
                          disabled={permissionBusy === key}
                          onClick={() => void clearPermission(permission)}
                        >
                          {permissionBusy === key ? "Revoking…" : "Revoke"}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <Status tone="neutral">{sitePermissions.length} saved</Status>
          </div>
          {permissionError && (
            <small className="browser-settings-feedback error" role="alert">
              {permissionError}
            </small>
          )}
        </section>
      )}

      {show("browser-autofill") && (
        <section
          className="settings-stack browser-settings-panel"
          aria-label="Autofill preferences"
          data-settings-panel="browser-autofill"
        >
          <header className="settings-panel-header">
            <h2>
              <Icon name="lock" /> Autofill
            </h2>
            <p>
              Password and payment data stay in protected native vaults. Kestrel
              never includes them in browser exports.
            </p>
          </header>
          <div
            className="setting-row browser-setting-row"
            id="setting-browser-password-autofill"
          >
            <div className="browser-setting-copy">
              <strong>Password autofill and save prompts</strong>
              <p>Offer protected saved passwords and ask before saving new logins on matching HTTPS origins.</p>
            </div>
            <button
              type="button"
              className={`switch ${settings.passwordAutofillEnabled ? "on" : ""}`}
              role="switch"
              aria-label="Password autofill and save prompts"
              aria-checked={settings.passwordAutofillEnabled}
              onClick={() =>
                void persist({
                  passwordAutofillEnabled: !settings.passwordAutofillEnabled,
                })
              }
            >
              <span />
            </button>
          </div>
          <div
            className="setting-row browser-setting-row"
            id="setting-browser-payment-autofill"
          >
            <div className="browser-setting-copy">
              <strong>Payment autofill</strong>
              <p>
                Offer protected saved payment cards only after explicit
                confirmation.
              </p>
            </div>
            <button
              type="button"
              className={`switch ${settings.paymentAutofillEnabled ? "on" : ""}`}
              role="switch"
              aria-label="Payment autofill"
              aria-checked={settings.paymentAutofillEnabled}
              onClick={() =>
                void persist({
                  paymentAutofillEnabled: !settings.paymentAutofillEnabled,
                })
              }
            >
              <span />
            </button>
          </div>
          <PasswordSettings browser={browser} />
          <PaymentSettings browser={browser} />
        </section>
      )}

      {show("browser-performance") && (
        <section
          className="settings-stack browser-settings-panel"
          aria-label="Performance and sleeping tabs"
          data-settings-panel="browser-performance"
        >
          <header className="settings-panel-header">
            <h2>
              <Icon name="sparkles" /> Performance and memory saver
            </h2>
            <p>
              Sleeping tabs discard inactive page views while keeping the tab
              record and URL.
            </p>
          </header>
          <div
            className="setting-row browser-setting-row"
            id="setting-browser-sleeping-tabs"
          >
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
                void persist({
                  sleepingTabsEnabled: !(settings.sleepingTabsEnabled ?? true),
                })
              }
            >
              <span />
            </button>
          </div>
          {settings.sleepingTabsEnabled !== false && (
            <>
              <div
                className="setting-row browser-setting-row"
                id="setting-browser-sleeping-timeout"
              >
                <div className="browser-setting-copy">
                  <strong>Put inactive tabs to sleep after</strong>
                </div>
                <select
                  aria-label="Sleeping tab timeout"
                  value={settings.sleepingTabTimeoutMinutes ?? 30}
                  onChange={(event) =>
                    void persist({
                      sleepingTabTimeoutMinutes: Number(
                        event.target.value,
                      ) as typeof settings.sleepingTabTimeoutMinutes,
                    })
                  }
                >
                  {SLEEPING_TAB_TIMEOUT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div
                className="setting-row browser-setting-row"
                id="setting-browser-memory-saver"
              >
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
                    void persist({
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
                    onChange={(event) =>
                      setNewExcludedDomain(event.target.value)
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
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
                  <div
                    className="excluded-domains-list"
                    aria-label="Excluded domains"
                  >
                    {(settings.sleepingTabExcludedDomains ?? []).map(
                      (domain) => (
                        <span key={domain} className="excluded-domain-chip">
                          <span>{domain}</span>
                          <button
                            type="button"
                            className="chip-remove-btn"
                            title={`Remove ${domain}`}
                            onClick={() =>
                              void handleRemoveExcludedDomain(domain)
                            }
                          >
                            ×
                          </button>
                        </span>
                      ),
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      )}

      {show("browser-downloads") && (
        <section
          className="settings-stack browser-settings-panel"
          aria-label="Download preferences"
          data-settings-panel="browser-downloads"
        >
          <header className="settings-panel-header">
            <h2>
              <Icon name="downloads" /> Downloads
            </h2>
            <p>
              Choose a profile-owned folder or review every download before it
              starts.
            </p>
          </header>
          <div
            className="setting-row browser-setting-row"
            id="setting-browser-download-location"
          >
            <div className="browser-setting-copy">
              <strong>Download behavior</strong>
              <p>
                {settings.downloadBehavior === "ask"
                  ? "Ask where to save each file."
                  : `Save automatically to ${formatPath(settings.downloadDirectory)}.`}
              </p>
            </div>
            <select
              aria-label="Download behavior"
              value={settings.downloadBehavior}
              onChange={(event) =>
                void persist({
                  downloadBehavior: event.target
                    .value as UserBrowserSettings["downloadBehavior"],
                })
              }
            >
              <option value="automatic">Save automatically</option>
              <option value="ask">Ask where to save each file</option>
            </select>
          </div>
          <div className="setting-row browser-setting-row">
            <div className="browser-setting-copy">
              <strong>Download folder</strong>
              <p>{formatPath(settings.downloadDirectory)}</p>
            </div>
            <div className="button-row">
              <button
                type="button"
                className="button secondary"
                onClick={() => void handleDownloadLocation()}
                disabled={saveState === "saving"}
              >
                {saveState === "saving" ? "Choosing…" : "Choose folder"}
              </button>
              {settings.downloadDirectory && (
                <button
                  type="button"
                  className="quiet-link"
                  onClick={() => void handleResetDownloadLocation()}
                >
                  Use default
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      {show("browser-languages") && (
        <section
          className="settings-stack browser-settings-panel"
          aria-label="Languages and accessibility preferences"
          data-settings-panel="browser-languages"
        >
          <header className="settings-panel-header">
            <h2>
              <Icon name="writing" /> Languages and accessibility
            </h2>
            <p>
              Native spellcheck, font, and minimum-size preferences apply to
              pages opened by Kestrel. Font changes reopen native page views so
              the setting is real, not cosmetic.
            </p>
          </header>
          <div
            className="setting-row browser-setting-row"
            id="setting-browser-spellcheck"
          >
            <div className="browser-setting-copy">
              <strong>Spellcheck</strong>
              <p>
                Use the operating system or Chromium spellchecker where
                supported.
              </p>
            </div>
            <button
              type="button"
              className={`switch ${settings.spellcheckEnabled ? "on" : ""}`}
              role="switch"
              aria-label="Spellcheck"
              aria-checked={settings.spellcheckEnabled}
              onClick={() =>
                void persist({ spellcheckEnabled: !settings.spellcheckEnabled })
              }
            >
              <span />
            </button>
          </div>
          <div className="setting-row browser-setting-row">
            <div className="browser-setting-copy">
              <strong>Spellcheck language</strong>
            </div>
            <select
              aria-label="Spellcheck language"
              value={settings.spellcheckLanguage}
              onChange={(event) =>
                void persist({ spellcheckLanguage: event.target.value })
              }
            >
              {SPELLCHECK_LANGUAGES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div
            className="setting-row browser-setting-row"
            id="setting-browser-fonts"
          >
            <div className="browser-setting-copy">
              <strong>Default font</strong>
              <p>
                Sets the native default for pages that do not provide their own
                font.
              </p>
            </div>
            <select
              aria-label="Default font"
              value={settings.defaultFontFamily}
              onChange={(event) =>
                void persist({ defaultFontFamily: event.target.value })
              }
            >
              {FONT_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="setting-row browser-setting-row">
            <div className="browser-setting-copy">
              <strong>Minimum text size</strong>
              <p>0 keeps the page’s chosen size.</p>
            </div>
            <select
              aria-label="Minimum text size"
              value={settings.minimumFontSize}
              onChange={(event) =>
                void persist({ minimumFontSize: Number(event.target.value) })
              }
            >
              <option value={0}>Default</option>
              <option value={10}>10 px</option>
              <option value={12}>12 px</option>
              <option value={14}>14 px</option>
              <option value={16}>16 px</option>
              <option value={18}>18 px</option>
              <option value={20}>20 px</option>
            </select>
          </div>
        </section>
      )}

      {show("browser-extensions") && (
        <section
          className="settings-stack browser-settings-panel"
          aria-label="Web extensions and store"
          data-settings-panel="browser-extensions"
          id="setting-browser-extensions"
        >
          <header className="settings-panel-header">
            <h2>
              <Icon name="extensions" /> Web extensions and add-ons
            </h2>
            <p>
              Only verified store packages or explicitly enabled development
              packages are loaded.
            </p>
          </header>
          {extensionMessage && (
            <div
              className={`extension-alert ${extensionMessage.type}`}
              role={extensionMessage.type === "error" ? "alert" : "status"}
            >
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
              placeholder="Paste Chrome Web Store URL or Extension ID"
              value={extensionUrlInput}
              onChange={(event) => setExtensionUrlInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
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
              onClick={(event) => {
                event.preventDefault();
                void browser.createTab("https://chromewebstore.google.com");
              }}
            >
              <Icon name="globe" /> Browse Chrome Web Store ↗
            </a>
          </div>
          <p className="honest-status">
            Kestrel verifies each package and keeps it only after Electron loads
            its signed identity. Some Chrome extension APIs are not available in
            Electron.
          </p>
          <div className="installed-extensions-section">
            <h4>Installed extensions ({extensions.length})</h4>
            {extensions.length === 0 ? (
              <div className="empty-extensions-state">
                <p>No browser extensions installed yet.</p>
                <small>Install from the Chrome Web Store above.</small>
              </div>
            ) : (
              <div className="extensions-grid">
                {extensions.map((extension) => (
                  <article
                    key={extension.id}
                    className={`extension-card ${extension.enabled ? "enabled" : "disabled"}`}
                  >
                    <div className="extension-card-header">
                      <div className="extension-card-icon">
                        <Icon name="extensions" />
                      </div>
                      <div className="extension-card-title-group">
                        <strong>{extension.name}</strong>
                        <span className="extension-version">
                          v{extension.version}
                        </span>
                        <span className="extension-source-badge">
                          {extension.source === "chrome_web_store"
                            ? "Chrome Web Store"
                            : extension.source === "unpacked"
                              ? "Unpacked (development)"
                              : "Local package (development)"}
                        </span>
                      </div>
                    </div>
                    {extension.description && (
                      <p className="extension-description">
                        {extension.description}
                      </p>
                    )}
                    <div className="extension-card-actions">
                      <label className="extension-toggle-label">
                        <span>
                          {extension.enabled ? "Enabled" : "Disabled"}
                        </span>
                        <input
                          type="checkbox"
                          checked={extension.enabled}
                          onChange={(event) =>
                            void handleToggleExtension(
                              extension.id,
                              event.target.checked,
                            )
                          }
                        />
                      </label>
                      <button
                        type="button"
                        className="button danger-subtle"
                        onClick={() =>
                          void handleUninstallExtension(extension.id)
                        }
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
      )}

      {show("browser-system") && (
        <section
          className="settings-stack browser-settings-panel"
          aria-label="Browser system integration"
          data-settings-panel="browser-system"
        >
          <header className="settings-panel-header">
            <h2>
              <Icon name="system" /> System integration
            </h2>
            <p>
              These actions use native macOS or Windows registration instead of
              exposing Electron internals to the renderer.
            </p>
          </header>
          <div
            className="setting-row browser-setting-row"
            id="setting-browser-default-browser"
          >
            <div className="browser-setting-copy">
              <strong>Default browser</strong>
              <p>
                Register Kestrel for supported web links and check the operating
                system’s current choice.
              </p>
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
          <div
            className="setting-row browser-setting-row"
            id="setting-browser-hardware-acceleration"
          >
            <div className="browser-setting-copy">
              <strong>Hardware acceleration</strong>
              <p>
                Native rendering is enabled by default. Changing this requires a
                Kestrel restart and is persisted in the browser profile.
              </p>
            </div>
            <button
              type="button"
              className={`switch ${settings.hardwareAccelerationEnabled ? "on" : ""}`}
              role="switch"
              aria-label="Hardware acceleration"
              aria-checked={settings.hardwareAccelerationEnabled}
              onClick={() =>
                void persist({
                  hardwareAccelerationEnabled:
                    !settings.hardwareAccelerationEnabled,
                })
              }
            >
              <span />
            </button>
          </div>
          {restartRequired && (
            <small className="settings-restart-notice" role="status">
              Restart Kestrel to apply the hardware acceleration change.
            </small>
          )}
        </section>
      )}

      {show("browser-reset") && (
        <section
          className="settings-stack browser-settings-panel"
          aria-label="Browser data and reset"
          data-settings-panel="browser-reset"
        >
          <header className="settings-panel-header">
            <h2>
              <Icon name="reset" /> Data and reset
            </h2>
            <p>
              Move safe browser preferences or clear local data. Cookies,
              passwords, payment cards, extension packages, and native sessions
              are never exported.
            </p>
          </header>
          <div
            className="setting-row browser-setting-row"
            id="setting-browser-data-transfer"
          >
            <div className="browser-setting-copy">
              <strong>Import and export browser data</strong>
              <p>
                Bookmarks, history, remembered site permissions, and browser
                preferences are merged from a reviewed JSON file.
              </p>
              <small>
                Transfers never include protected credentials or cookies.
              </small>
            </div>
            <div className="button-row">
              <button
                type="button"
                className="button secondary"
                onClick={() => void handleExport()}
                disabled={Boolean(dataBusy)}
              >
                {dataBusy === "export" ? "Exporting…" : "Export data"}
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() => void handleImport()}
                disabled={Boolean(dataBusy)}
              >
                {dataBusy === "import" ? "Importing…" : "Import data"}
              </button>
            </div>
          </div>
          <div
            className="setting-row browser-setting-row"
            id="setting-browser-clear-history"
          >
            <div className="browser-setting-copy">
              <strong>Clear browsing history</strong>
              <p>
                Removes history, favicons, recently closed tabs, and new-tab
                activity. Open tabs stay put.
              </p>
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
              Clear history
            </button>
          </div>
          <div
            className="setting-row browser-setting-row"
            id="setting-browser-clear-site-data"
          >
            <div className="browser-setting-copy">
              <strong>Clear cookies and site data</strong>
              <p>
                Removes cookies, cache, and remembered site permissions for this
                browser profile.
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
          <div
            className="setting-row browser-setting-row danger"
            id="setting-browser-reset-settings"
          >
            <div className="browser-setting-copy">
              <strong>Reset browser settings</strong>
              <p>
                Restore Kestrel’s browser preferences without deleting history,
                bookmarks, credentials, or extensions.
              </p>
            </div>
            <div className="button-row">
              {resetSettingsConfirm && (
                <button
                  type="button"
                  className="quiet-link"
                  onClick={() => setResetSettingsConfirm(false)}
                >
                  Cancel
                </button>
              )}
              <button
                type="button"
                className="button secondary"
                onClick={() => void handleResetSettings()}
                disabled={Boolean(dataBusy) || saveState === "saving"}
              >
                {resetSettingsConfirm ? "Confirm reset" : "Reset settings"}
              </button>
            </div>
          </div>
          {dataMessage && (
            <small className="browser-settings-feedback" role="status">
              {dataMessage}
            </small>
          )}
          {dataError && (
            <small className="browser-settings-feedback error" role="alert">
              {dataError}
            </small>
          )}
        </section>
      )}

      {section === "browser" && (
        <p className="browser-settings-compatibility" role="note">
          This overview keeps existing deep links working. Use the Basic and
          Advanced sections in the settings rail for the focused layout.
        </p>
      )}
    </div>
  );
}
