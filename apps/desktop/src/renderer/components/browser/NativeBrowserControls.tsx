import { useEffect, useId, useRef, useState } from "react";
import type { NativeBrowserStatus } from "@kestrel/shared-types";
import { Icon } from "../Icon";
import "./native-browser-controls.css";

type NativeBrowserAction = "browser-native-status" | "browser-open-native" | "browser-open-native-extensions";

export function NativeBrowserControls({
  currentUrl,
  menu = false,
  onOpened,
}: {
  currentUrl?: string | undefined;
  menu?: boolean;
  onOpened?(): void;
}) {
  const [status, setStatus] = useState<NativeBrowserStatus | null>(null);
  const [busy, setBusy] = useState<NativeBrowserAction | null>("browser-native-status");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(false);
  const pending = useRef(false);
  const descriptionId = useId();
  const statusId = useId();
  let pageUrl: string | undefined;
  try {
    const url = new URL(currentUrl ?? "");
    if (url.protocol === "http:" || url.protocol === "https:") pageUrl = url.href;
  } catch { /* Internal pages cannot be opened in the native browser. */ }

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void window.kestrel.request({ type: "browser-native-status" }).then((response) => {
      if (cancelled) return;
      if (response.ok && "nativeBrowser" in response) {
        setStatus(response.nativeBrowser);
      } else {
        setError(response.ok ? "Native browser status is unavailable." : response.error);
      }
    }).catch(() => {
      if (!cancelled) setError("Could not check native browser availability.");
    }).finally(() => {
      if (!cancelled) setBusy(null);
    });
    return () => { cancelled = true; mounted.current = false; };
  }, []);

  async function run(type: NativeBrowserAction, input?: string) {
    if (pending.current || busy) return;
    pending.current = true;
    setBusy(type);
    setError("");
    setNotice("");
    try {
      const response = await window.kestrel.request(
        type === "browser-open-native" ? { type, ...(input ? { input } : {}) } : { type },
      );
      if (!mounted.current) return;
      if (!response.ok) {
        setError(response.error);
        return;
      }
      if ("nativeBrowser" in response) {
        setStatus(response.nativeBrowser);
        if (!response.nativeBrowser.available || response.nativeBrowser.error) {
          setError(response.nativeBrowser.error ?? "Native browser is unavailable in this installation.");
          return;
        }
      } else if (type === "browser-native-status") {
        setError("Native browser status is unavailable.");
        return;
      }
      if (type !== "browser-native-status") {
        setNotice(type === "browser-open-native-extensions" ? "Opened Chrome extensions in the native browser." : "Opened the native browser.");
        onOpened?.();
      }
    } catch {
      if (mounted.current) setError("Could not open the native browser. Check availability and try again.");
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  const unavailable = !status?.available;
  const disabled = busy !== null || unavailable;
  const buttonClass = menu ? "browser-toolbar-menu-link" : "button";
  const buttonRole = menu ? "menuitem" : undefined;
  return (
    <div className={`native-browser-controls${menu ? " is-menu" : ""}`}>
      {menu ? <strong className="native-browser-heading">Native browser</strong>
        : <h3 className="native-browser-heading">Native browser</h3>}
      <p id={descriptionId} className="native-browser-description">
        {menu
          ? "Chrome extensions use a separate, persistent browser profile."
          : "Use Chrome extensions in a separate, persistent browser profile. Existing embedded browser data and extensions are not transferred. macOS may ask for Keychain access; credential storage has not been verified."}
      </p>
      <p id={statusId} className="native-browser-status" role="status">
        {busy === "browser-native-status" ? "Checking availability…" : unavailable
          ? status?.error ?? "Native browser is unavailable in this installation."
          : status.running ? "Native browser is running." : "Native browser is available."}
      </p>
      <div className="native-browser-actions" aria-busy={busy !== null}>
        <button type="button" role={buttonRole} className={buttonClass} disabled={disabled}
          aria-describedby={`${descriptionId} ${statusId}`} onClick={() => void run("browser-open-native")}>
          <Icon name="globe" /><span>{busy === "browser-open-native" ? "Opening native browser…" : "Open native browser"}</span>
        </button>
        <button type="button" role={buttonRole} className={buttonClass} disabled={disabled}
          onClick={() => void run("browser-open-native-extensions")}>
          <Icon name="extensions" /><span>{busy === "browser-open-native-extensions" ? "Opening extensions…" : "Manage Chrome extensions"}</span>
        </button>
        {pageUrl && <button type="button" role={buttonRole} className={buttonClass} disabled={disabled}
          onClick={() => void run("browser-open-native", pageUrl)}>
          <Icon name="expand" /><span>Open current page in native browser</span>
        </button>}
        {(unavailable || error) && <button type="button" role={buttonRole} className={buttonClass}
          disabled={busy !== null} onClick={() => void run("browser-native-status")}>
          <Icon name="reload" /><span>Check availability again</span>
        </button>}
      </div>
      {error && <p className="native-browser-feedback" role="alert">{error}</p>}
      {notice && <p className="native-browser-feedback" role="status">{notice}</p>}
    </div>
  );
}
