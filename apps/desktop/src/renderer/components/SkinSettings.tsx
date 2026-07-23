import { useState, type CSSProperties } from "react";
import type { CoreResponse, SkinDefinition, SkinStatus } from "@kestrel/shared-types";

const properties: Record<keyof SkinDefinition["colors"], string> = {
  canvas: "--canvas", sidebar: "--sidebar", sidebarHover: "--sidebar-hover", surface: "--surface", surfaceStrong: "--surface-strong", panel: "--panel",
  ink: "--ink", muted: "--muted", faint: "--faint", line: "--line", lineStrong: "--line-strong", solid: "--solid", solidHover: "--solid-hover",
  solidText: "--solid-text", signal: "--signal", signalDeep: "--signal-deep", statusSoft: "--status-soft", statusInk: "--status-ink",
  healthy: "--healthy", warning: "--warning", warningSoft: "--warning-soft", warningInk: "--warning-ink",
  danger: "--danger", dangerSoft: "--danger-soft", dangerInk: "--danger-ink", brand: "--brand"
};

export function applySkin(skin: SkinDefinition): void {
  const root = document.documentElement;
  root.dataset.skin = skin.id;
  root.style.colorScheme = skin.mode;
  for (const [key, property] of Object.entries(properties) as Array<[keyof SkinDefinition["colors"], string]>) root.style.setProperty(property, skin.colors[key]);
}

export function SkinSettings({ status, onChange }: { status: SkinStatus | null; onChange(status: SkinStatus): void }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const selected = status?.skins.find((skin) => skin.id === status.selectedId);

  async function mutate(request: { type: "skin-select"; skinId: string } | { type: "skin-import-file" } | { type: "skin-remove"; skinId: string }, success: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await window.kestrel.request(request) as CoreResponse & { cancelled?: boolean };
      if (!response.ok) throw new Error(response.error);
      if (response.cancelled) return;
      if (!response.skinStatus) throw new Error("Skin status was missing.");
      onChange(response.skinStatus);
      setNotice(success);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Skin operation failed."); }
    finally { setBusy(false); }
  }

  return <article className="setting-row skin-setting">
    <div>
      <strong>Visual skin</strong>
      <p>Change desktop and terminal presentation without changing Kestrel’s personality, prompts, tools, memory, or permissions.</p>
      {!status ? <small>Loading visual skins…</small> : <fieldset className="skin-picker" disabled={busy}>
        <legend className="sr-only">Choose a visual skin</legend>
        {status.skins.map((skin) => <button type="button" key={skin.id} className={skin.id === status.selectedId ? "selected" : ""} aria-pressed={skin.id === status.selectedId} onClick={() => void mutate({ type: "skin-select", skinId: skin.id }, "Visual skin changed.")}>
          <span className="skin-swatches" aria-hidden="true" style={{ "--swatch-canvas": skin.colors.canvas, "--swatch-surface": skin.colors.surface, "--swatch-ink": skin.colors.ink, "--swatch-signal": skin.colors.signal, "--swatch-brand": skin.colors.brand } as CSSProperties}><i /><i /><i /><i /><i /></span>
          <span><b>{skin.name}</b><small>{skin.description}</small></span>
          <em>{skin.builtin ? "Built in" : "Yours"}</em>
        </button>)}
      </fieldset>}
      {notice && <small role="status">{notice}</small>}
      {error && <small role="alert">{error}</small>}
      <details className="skin-format">
        <summary>Custom skin format</summary>
        <p>Install bounded JSON that inherits from an installed skin. Unknown keys, scripts, URLs, unreadable combinations, symbolic links, and files over 64 KB are rejected.</p>
        <pre>{`{
  "version": 1,
  "id": "field-notes",
  "name": "Field Notes",
  "description": "My paper-like skin.",
  "base": "daylight",
  "colors": { "signal": "#7b2f12" },
  "terminal": {
    "promptSymbol": "»",
    "thinkingVerbs": ["noting", "checking"]
  }
}`}</pre>
      </details>
    </div>
    <div className="skin-actions">
      <button className="button secondary" disabled={busy} onClick={() => void mutate({ type: "skin-import-file" }, "Custom skin installed and selected.")}>{busy ? "Working…" : "Install JSON skin"}</button>
      {selected && !selected.builtin && <button className="button secondary" disabled={busy} onClick={() => void mutate({ type: "skin-remove", skinId: selected.id }, "Custom skin removed; Kestrel restored.")}>Remove {selected.name}</button>}
    </div>
  </article>;
}
